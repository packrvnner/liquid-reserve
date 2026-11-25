// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IRateProvider} from "./interfaces/IRateProvider.sol";

/// @title LockedReserve
/// @notice The Liquid Reserve treasury. It holds one to three assets and can
/// never be withdrawn from. Only yield ever leaves, and only to the immutable
/// `yieldRouter`. Deployed twice: on Elysium (kHYPE, $liquid) and on HyperEVM (sKNTQ,
/// staked natively there).
///
/// How "locked" is enforced:
/// - No owner, no admin, no upgrade proxy, no withdraw function. Every setting is
///   an immutable fixed at deployment.
/// - Principal is tracked per asset in underlying units (HYPE for kHYPE, KNTQ for
///   staked KNTQ, $liquid for $liquid). It only increases, through `deposit`.
/// - `harvest` can send out only the value above principal.
/// - The reported exchange rate is capped to grow at most
///   MAX_RATE_GROWTH_BPS_PER_YEAR, so even a faulty or compromised rate provider
///   can't make principal look like yield.
/// - `sweep` sends unsolicited non-reserve tokens (e.g. holder rewards paid in
///   KNTQ) to the yield router; it can't touch reserve assets.
contract LockedReserve is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_ASSETS = 3;
    /// @notice Number of assets this reserve holds (1-3).
    uint256 public immutable assetCount;
    /// @notice Ceiling on how fast the exchange rate used here can grow (25%/yr).
    uint256 public constant MAX_RATE_GROWTH_BPS_PER_YEAR = 2_500;
    uint256 private constant ONE = 1e18;
    uint256 private constant BPS = 10_000;

    /// @notice The only address that ever receives assets from this contract.
    address public immutable yieldRouter;

    address private immutable _asset0;
    address private immutable _asset1;
    address private immutable _asset2;
    IRateProvider private immutable _rate0;
    IRateProvider private immutable _rate1;
    IRateProvider private immutable _rate2;

    struct Checkpoint {
        uint192 rate;
        uint64 time;
    }

    /// @notice Principal per asset, in underlying units. Never decreases.
    mapping(address asset => uint256) public principal;
    /// @notice Last exchange rate used per asset (the base for the growth ceiling).
    mapping(address asset => Checkpoint) public checkpoints;

    event Deposited(address indexed asset, address indexed from, uint256 shares, uint256 underlying);
    event Harvested(address indexed asset, uint256 shares, uint256 underlying);
    event Swept(address indexed token, uint256 amount);

    error ZeroAddress();
    error DuplicateAsset();
    error BadAssetList();
    error NotReserveAsset(address token);
    error IsReserveAsset(address token);
    error ZeroAmount();
    error ZeroRate(address asset);

    /// @param assets_ reserve assets; unused trailing slots are address(0)
    ///        (e.g. [kHYPE, $liquid, 0] on Elysium, [sKNTQ, 0, 0] on HyperEVM)
    /// @param rateProviders_ rate provider per asset; address(0) means 1:1
    /// @param yieldRouter_ the only recipient of harvested yield
    constructor(address[3] memory assets_, IRateProvider[3] memory rateProviders_, address yieldRouter_) {
        if (yieldRouter_ == address(0) || assets_[0] == address(0)) revert ZeroAddress();
        uint256 count;
        for (uint256 i; i < MAX_ASSETS; ++i) {
            if (assets_[i] == address(0)) {
                if (address(rateProviders_[i]) != address(0)) revert BadAssetList();
                continue;
            }
            if (count != i) revert BadAssetList(); // no gaps
            ++count;
            for (uint256 j = i + 1; j < MAX_ASSETS; ++j) {
                if (assets_[i] == assets_[j]) revert DuplicateAsset();
            }
        }
        assetCount = count;
        _asset0 = assets_[0];
        _asset1 = assets_[1];
        _asset2 = assets_[2];
        _rate0 = rateProviders_[0];
        _rate1 = rateProviders_[1];
        _rate2 = rateProviders_[2];
        yieldRouter = yieldRouter_;
    }

    // ---------------------------------------------------------------------
    // Inflows
    // ---------------------------------------------------------------------

    /// @notice Adds `amount` of a reserve asset to principal. Anyone may deposit;
    /// whatever is deposited is locked forever.
    /// @return underlying principal added, in underlying units
    function deposit(address asset, uint256 amount) external nonReentrant returns (uint256 underlying) {
        if (amount == 0) revert ZeroAmount();
        _requireAsset(asset);
        uint256 rate = _checkpointRate(asset);

        uint256 before = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(asset).balanceOf(address(this)) - before;

        underlying = received * rate / ONE;
        principal[asset] += underlying;
        emit Deposited(asset, msg.sender, received, underlying);
    }

    // ---------------------------------------------------------------------
    // Outflows: yield only
    // ---------------------------------------------------------------------

    /// @notice Sends the yield on one asset (value above principal) to the yield router.
    /// @return shares amount of the asset sent
    function harvest(address asset) external nonReentrant returns (uint256 shares) {
        _requireAsset(asset);
        shares = _harvest(asset);
    }

    /// @notice Harvests every asset.
    function harvestAll() external nonReentrant returns (uint256[3] memory shares) {
        shares[0] = _harvest(_asset0);
        if (assetCount > 1) shares[1] = _harvest(_asset1);
        if (assetCount > 2) shares[2] = _harvest(_asset2);
    }

    /// @notice Sends any non-reserve token held here (e.g. holder rewards paid in
    /// KNTQ) to the yield router.
    function sweep(address token) external nonReentrant returns (uint256 amount) {
        if (_isAsset(token)) revert IsReserveAsset(token);
        amount = IERC20(token).balanceOf(address(this));
        if (amount > 0) {
            IERC20(token).safeTransfer(yieldRouter, amount);
            emit Swept(token, amount);
        }
    }

    function _harvest(address asset) private returns (uint256 shares) {
        uint256 rate = _checkpointRate(asset);
        uint256 value = IERC20(asset).balanceOf(address(this)) * rate / ONE;
        uint256 p = principal[asset];
        if (value <= p) return 0;

        // Rounds down, so value after the transfer stays >= principal.
        shares = (value - p) * ONE / rate;
        if (shares == 0) return 0;
        IERC20(asset).safeTransfer(yieldRouter, shares);
        emit Harvested(asset, shares, value - p);
    }

    // ---------------------------------------------------------------------
    // Views (for the dashboard)
    // ---------------------------------------------------------------------

    function assetAt(uint256 i) public view returns (address) {
        if (i >= assetCount) revert NotReserveAsset(address(0));
        if (i == 0) return _asset0;
        if (i == 1) return _asset1;
        return _asset2;
    }

    function rateProviderOf(address asset) public view returns (IRateProvider) {
        if (asset == address(0)) revert NotReserveAsset(asset);
        if (asset == _asset0) return _rate0;
        if (asset == _asset1) return _rate1;
        if (asset == _asset2) return _rate2;
        revert NotReserveAsset(asset);
    }

    function isReserveAsset(address token) external view returns (bool) {
        return _isAsset(token);
    }

    /// @notice Exchange rate used for accounting: the reported rate, capped at
    /// MAX_RATE_GROWTH_BPS_PER_YEAR growth since the last checkpoint.
    function effectiveRate(address asset) public view returns (uint256) {
        uint256 reported = _reportedRate(asset);
        Checkpoint memory c = checkpoints[asset];
        if (c.rate == 0) return reported;
        uint256 ceiling = uint256(c.rate)
            + uint256(c.rate) * MAX_RATE_GROWTH_BPS_PER_YEAR * (block.timestamp - c.time) / (BPS * 365 days);
        return reported < ceiling ? reported : ceiling;
    }

    /// @notice Current value of the holdings of `asset`, in underlying units.
    function valueOf(address asset) public view returns (uint256) {
        _requireAsset(asset);
        return IERC20(asset).balanceOf(address(this)) * effectiveRate(asset) / ONE;
    }

    /// @notice Yield on `asset` that `harvest` would send right now, in underlying units.
    function pendingYield(address asset) external view returns (uint256) {
        uint256 value = valueOf(asset);
        uint256 p = principal[asset];
        return value > p ? value - p : 0;
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _reportedRate(address asset) private view returns (uint256) {
        IRateProvider provider = rateProviderOf(asset);
        return address(provider) == address(0) ? ONE : provider.getRate();
    }

    function _checkpointRate(address asset) private returns (uint256 rate) {
        rate = effectiveRate(asset);
        if (rate == 0) revert ZeroRate(asset);
        // toUint192 reverts instead of truncating if a broken provider reports a huge rate.
        // forge-lint: disable-next-line(unsafe-typecast)
        checkpoints[asset] = Checkpoint(SafeCast.toUint192(rate), uint64(block.timestamp));
    }

    function _isAsset(address token) private view returns (bool) {
        return token != address(0) && (token == _asset0 || token == _asset1 || token == _asset2);
    }

    function _requireAsset(address token) private view {
        if (!_isAsset(token)) revert NotReserveAsset(token);
    }
}
