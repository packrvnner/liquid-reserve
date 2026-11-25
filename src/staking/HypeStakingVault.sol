// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {IRateProvider} from "../interfaces/IRateProvider.sol";

interface IWHYPEStake {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/// @title HypeStakingVault
/// @notice Stake HYPE on Elysium in one step. The vault holds kHYPE (Kinetiq's staked HYPE, which
/// gains value against HYPE as staking rewards accrue) and gives out shares in it.
///
/// - It is a standard ERC-4626 vault whose asset is kHYPE: `deposit`/`mint`/`withdraw`/`redeem` move
///   kHYPE. `depositHype` and `redeemToHype` add the HYPE <-> kHYPE swap in one fixed Uniswap v4 pool,
///   so a depositor only ever handles HYPE.
/// - Fee: 20% of the yield, nothing else. Yield is the rise of kHYPE's value in HYPE, read from a fixed
///   rate provider (the same 30-minute average price feed the Locked Reserve uses). The fee is only taken
///   above a high-water mark, so a dip and recovery is never charged twice, and the rate it accepts can
///   grow at most 5% a year, so a mispriced market cannot turn deposits into "yield". The fee is set
///   aside in kHYPE and sent to one fixed address by `collectFees`, which anyone may call.
/// - Withdrawing in kHYPE is always possible: it needs no pool, no price and no permission.
/// - The owner can pause new deposits and set a deposit cap. Nothing else: it cannot touch deposits,
///   withdrawals, the fee, the fee address, the pool or the rate provider. There is no upgrade path.
/// @dev Unaudited.
contract HypeStakingVault is ERC4626, Ownable2Step, ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;
    using Math for uint256;

    /// @notice Share of the yield taken as the fee (20%).
    uint256 public constant FEE_BPS = 2_000;
    /// @notice Ceiling on how fast the rate used for the fee may grow: 5% a year, a little over twice kHYPE's
    /// yield so far (about 2% a year). The rate comes from a pool price that only moves when a reading is taken,
    /// and a reading can be taken at a moment the price is pushed up. The ceiling bounds what that can cost
    /// depositors: the fee can never exceed 20% of 5% of deposits a year (1%), less than the yield itself, and a
    /// fee taken early on a false price is not taken again when the real rate catches up (the high-water mark).
    /// If the true yield ever ran above the ceiling, the fee on the excess would simply come later or not at all.
    uint256 public constant MAX_RATE_GROWTH_BPS_PER_YEAR = 500;
    /// @notice Shares minted to a dead address at the first deposit, so the share price cannot be inflated by a donation.
    uint256 public constant DEAD_SHARES = 1_000;
    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 private constant BPS = 10_000;

    IPoolManager public immutable poolManager;
    address public immutable whype;
    /// @notice HYPE (as WHYPE) that 1e18 kHYPE is worth.
    IRateProvider public immutable rateProvider;
    /// @notice The only address fees are ever sent to.
    address public immutable feeRecipient;

    // the kHYPE / WHYPE pool the HYPE entry and exit swap in (a PoolKey cannot be immutable, so its parts are)
    Currency private immutable _currency0;
    Currency private immutable _currency1;
    uint24 private immutable _poolFee;
    int24 private immutable _tickSpacing;
    address private immutable _hooks;
    /// @notice True when kHYPE is the pool's first token.
    bool public immutable assetIsCurrency0;

    /// @notice The rate at which fees were last taken (the high-water mark), and when.
    uint192 public markRate;
    uint64 public markTime;
    /// @notice kHYPE set aside for the fee address and not yet sent. It is not part of `totalAssets`.
    uint256 public feesOwed;

    bool public depositsPaused;
    /// @notice Most kHYPE the vault accepts in total. `type(uint256).max` means no cap.
    uint256 public depositCap;

    bool private _swapping;

    event FeeAccrued(uint256 rate, uint256 fee);
    event FeesCollected(uint256 amount);
    event DepositsPausedSet(bool paused);
    event DepositCapSet(uint256 cap);

    error ZeroAddress();
    error ZeroAmount();
    error BadPool();
    error ZeroRate();
    error RateUnavailable();
    error FirstDepositTooSmall();
    error Slippage(uint256 got, uint256 wanted);
    error NotPoolManager();
    error UnexpectedNative();
    error UnexpectedDelta();
    error PartialFill(uint256 paid, uint256 expected);
    error SendFailed();

    struct Params {
        string name;
        string symbol;
        address owner;
        IPoolManager poolManager;
        address whype;
        IERC20 khype;
        PoolKey pool; // the kHYPE / WHYPE pool
        IRateProvider rateProvider;
        address feeRecipient;
        uint256 depositCap;
    }

    constructor(Params memory p) ERC4626(p.khype) ERC20(p.name, p.symbol) Ownable(p.owner) {
        if (
            address(p.poolManager) == address(0) || p.whype == address(0) || address(p.khype) == address(0)
                || address(p.rateProvider) == address(0) || p.feeRecipient == address(0)
        ) revert ZeroAddress();
        address c0 = Currency.unwrap(p.pool.currency0);
        address c1 = Currency.unwrap(p.pool.currency1);
        bool is0 = c0 == address(p.khype) && c1 == p.whype;
        if (!is0 && !(c1 == address(p.khype) && c0 == p.whype)) revert BadPool();
        poolManager = p.poolManager;
        whype = p.whype;
        rateProvider = p.rateProvider;
        feeRecipient = p.feeRecipient;
        _currency0 = p.pool.currency0;
        _currency1 = p.pool.currency1;
        _poolFee = p.pool.fee;
        _tickSpacing = p.pool.tickSpacing;
        _hooks = address(p.pool.hooks);
        assetIsCurrency0 = is0;
        depositCap = p.depositCap;

        uint256 rate = p.rateProvider.getRate();
        if (rate == 0) revert ZeroRate();
        markRate = SafeCast.toUint192(rate);
        markTime = uint64(block.timestamp);
    }

    /// @dev Native HYPE only ever arrives from unwrapping WHYPE during `redeemToHype`.
    receive() external payable {
        if (msg.sender != whype) revert UnexpectedNative();
    }

    // ---------------------------------------------------------------------
    // What the vault holds
    // ---------------------------------------------------------------------

    /// @notice kHYPE that belongs to depositors: the balance, less fees set aside and fees due right now.
    function totalAssets() public view override returns (uint256) {
        (uint256 fee,) = _pending();
        return IERC20(asset()).balanceOf(address(this)) - feesOwed - fee;
    }

    /// @notice The rate fees are measured against right now: the provider's rate, held under the growth
    /// ceiling. Falls back to the high-water mark when the provider cannot be read.
    function currentRate() public view returns (uint256 rate) {
        (, rate) = _pending();
    }

    /// @notice kHYPE owed to the fee address in total: set aside already, plus due right now.
    function pendingFees() external view returns (uint256) {
        (uint256 fee,) = _pending();
        return feesOwed + fee;
    }

    /// @notice What the vault's kHYPE is worth in HYPE at the current rate.
    function totalHype() external view returns (uint256) {
        return totalAssets().mulDiv(currentRate(), 1e18);
    }

    /// @notice The pool the HYPE entry and exit swap in.
    function pool() public view returns (PoolKey memory) {
        return PoolKey(_currency0, _currency1, _poolFee, _tickSpacing, IHooks(_hooks));
    }

    // ---------------------------------------------------------------------
    // Deposits
    // ---------------------------------------------------------------------

    function maxDeposit(address) public view override returns (uint256) {
        return _room(totalAssets());
    }

    function maxMint(address) public view override returns (uint256) {
        uint256 room = _room(totalAssets());
        return room > type(uint128).max ? type(uint256).max : convertToShares(room);
    }

    /// @inheritdoc ERC4626
    function deposit(uint256 assets, address receiver) public override nonReentrant returns (uint256) {
        _accrue(true);
        return super.deposit(assets, receiver);
    }

    /// @inheritdoc ERC4626
    function mint(uint256 shares, address receiver) public override nonReentrant returns (uint256) {
        _accrue(true);
        return super.mint(shares, receiver);
    }

    /// @notice Stakes the HYPE sent with the call: swaps it for kHYPE in the pool and gives `receiver` the shares.
    /// @param minShares fewest shares to accept (protects against the pool price moving before this lands)
    function depositHype(uint256 minShares, address receiver) external payable nonReentrant returns (uint256 shares) {
        if (msg.value == 0) revert ZeroAmount();
        _accrue(true);
        uint256 supply = totalSupply();
        uint256 held = totalAssets();
        IWHYPEStake(whype).deposit{value: msg.value}();
        uint256 got = _swap(false, msg.value);
        uint256 room = _room(held);
        if (got > room) revert ERC4626ExceededMaxDeposit(receiver, got, room);
        // the same formula as ERC4626.previewDeposit, on what the vault held before this kHYPE arrived
        shares = _mintShares(receiver, got.mulDiv(supply + 1, held + 1, Math.Rounding.Floor));
        if (shares < minShares) revert Slippage(shares, minShares);
        emit Deposit(msg.sender, receiver, got, shares);
    }

    /// @dev Like ERC4626._deposit, with the first-deposit lock.
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        IERC20(asset()).safeTransferFrom(caller, address(this), assets);
        emit Deposit(caller, receiver, assets, _mintShares(receiver, shares));
    }

    /// @dev Mints `shares` to `receiver`. The very first deposit also mints DEAD_SHARES to a dead address,
    /// locked forever: the depositor still receives exactly `shares`, and gives up 1000 wei of value to them.
    function _mintShares(address receiver, uint256 shares) private returns (uint256) {
        if (totalSupply() == 0) {
            if (shares <= DEAD_SHARES) revert FirstDepositTooSmall();
            _mint(DEAD, DEAD_SHARES);
        }
        _mint(receiver, shares);
        return shares;
    }

    function _room(uint256 held) private view returns (uint256) {
        if (depositsPaused) return 0;
        return depositCap > held ? depositCap - held : 0;
    }

    // ---------------------------------------------------------------------
    // Withdrawals (never paused)
    // ---------------------------------------------------------------------

    /// @inheritdoc ERC4626
    function withdraw(uint256 assets, address receiver, address holder) public override nonReentrant returns (uint256) {
        _accrue(false);
        return super.withdraw(assets, receiver, holder);
    }

    /// @inheritdoc ERC4626
    function redeem(uint256 shares, address receiver, address holder) public override nonReentrant returns (uint256) {
        _accrue(false);
        return super.redeem(shares, receiver, holder);
    }

    /// @notice Unstakes the caller's `shares` to HYPE: swaps their kHYPE in the pool and pays `receiver` native HYPE.
    /// @param minHype least HYPE to accept
    function redeemToHype(uint256 shares, uint256 minHype, address receiver)
        external
        nonReentrant
        returns (uint256 hypeOut)
    {
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        _accrue(false);
        uint256 assets = previewRedeem(shares);
        _burn(msg.sender, shares);
        hypeOut = _swap(true, assets);
        if (hypeOut < minHype) revert Slippage(hypeOut, minHype);
        IWHYPEStake(whype).withdraw(hypeOut);
        (bool ok,) = receiver.call{value: hypeOut}("");
        if (!ok) revert SendFailed();
        emit Withdraw(msg.sender, receiver, msg.sender, assets, shares);
    }

    // ---------------------------------------------------------------------
    // The fee
    // ---------------------------------------------------------------------

    /// @notice Sets aside the fee on any new yield and sends everything set aside to the fee address.
    /// Anyone may call this; the kHYPE can only go to `feeRecipient`.
    function collectFees() external nonReentrant returns (uint256 amount) {
        _accrue(false);
        amount = feesOwed;
        if (amount == 0) return 0;
        feesOwed = 0;
        IERC20(asset()).safeTransfer(feeRecipient, amount);
        emit FeesCollected(amount);
    }

    /// @dev The fee due right now, and the rate it is measured at. No fee unless the rate is above the mark.
    function _pending() private view returns (uint256 fee, uint256 rate) {
        uint256 mark = markRate;
        rate = mark;
        uint256 reported;
        try rateProvider.getRate() returns (uint256 r) {
            reported = r;
        } catch {
            return (0, mark);
        }
        uint256 ceiling = mark + mark * MAX_RATE_GROWTH_BPS_PER_YEAR * (block.timestamp - markTime) / (BPS * 365 days);
        if (reported > ceiling) reported = ceiling;
        if (reported <= mark) return (0, mark);
        rate = reported;
        // Depositors' kHYPE is worth `held * rate` HYPE; it was worth `held * mark` at the mark. The gain, put
        // back into kHYPE, is `held * (rate - mark) / rate`.
        uint256 held = IERC20(asset()).balanceOf(address(this)) - feesOwed;
        fee = held.mulDiv(rate - mark, rate).mulDiv(FEE_BPS, BPS);
    }

    /// @dev Takes the fee due and moves the mark up. Run before anything that changes what the vault holds, so
    /// a new depositor never pays for yield from before they came.
    /// @param strict revert when the rate cannot be read (deposits need it; withdrawals must not)
    function _accrue(bool strict) private {
        if (strict) {
            try rateProvider.getRate() returns (uint256) {}
            catch {
                revert RateUnavailable();
            }
        }
        (uint256 fee, uint256 rate) = _pending();
        if (rate > markRate) {
            feesOwed += fee;
            markRate = SafeCast.toUint192(rate);
            markTime = uint64(block.timestamp);
            emit FeeAccrued(rate, fee);
        }
    }

    // ---------------------------------------------------------------------
    // Owner: new deposits only
    // ---------------------------------------------------------------------

    function setDepositsPaused(bool paused) external onlyOwner {
        depositsPaused = paused;
        emit DepositsPausedSet(paused);
    }

    function setDepositCap(uint256 cap) external onlyOwner {
        depositCap = cap;
        emit DepositCapSet(cap);
    }

    // ---------------------------------------------------------------------
    // The swap (one fixed pool, exact input)
    // ---------------------------------------------------------------------

    /// @dev Swaps `amountIn` in the pool: kHYPE for WHYPE when `khypeIn`, WHYPE for kHYPE otherwise.
    function _swap(bool khypeIn, uint256 amountIn) private returns (uint256 amountOut) {
        _swapping = true;
        amountOut = abi.decode(poolManager.unlock(abi.encode(khypeIn, amountIn)), (uint256));
        _swapping = false;
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || !_swapping) revert NotPoolManager();
        (bool khypeIn, uint256 amountIn) = abi.decode(data, (bool, uint256));
        bool zeroForOne = khypeIn == assetIsCurrency0;
        BalanceDelta delta = poolManager.swap(
            pool(),
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn), // negative = exact input
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        (int128 inDelta, int128 outDelta) =
            zeroForOne ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());
        if (inDelta >= 0 || outDelta <= 0) revert UnexpectedDelta();
        uint256 paid = uint256(uint128(-inDelta));
        if (paid != amountIn) revert PartialFill(paid, amountIn);
        uint256 out = uint256(uint128(outDelta));
        (Currency cin, Currency cout) = zeroForOne ? (_currency0, _currency1) : (_currency1, _currency0);
        poolManager.sync(cin);
        IERC20(Currency.unwrap(cin)).safeTransfer(address(poolManager), paid);
        poolManager.settle();
        poolManager.take(cout, address(this), out);
        return abi.encode(out);
    }

}
