// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title KntqStakingVault
/// @notice HyperEVM. Holds sKNTQ (Kinetiq's staked KNTQ) and gives out shares in it: liquidKNTQ.
///
/// - It is a standard ERC-4626 vault whose asset is sKNTQ: `deposit`/`mint`/`withdraw`/`redeem` move
///   sKNTQ. `depositKntq` adds the staking step, so a depositor only needs KNTQ. Leaving is in sKNTQ:
///   turning sKNTQ back into KNTQ is Kinetiq's own 7-day withdrawal, which the holder (or the Elysium
///   exit agent, for people who came in from Elysium) starts for themselves.
/// - Fee: 20% of the yield, nothing else. Yield is the rise of sKNTQ's own rate (the KNTQ one sKNTQ
///   redeems for, read from sKNTQ itself). The fee is only taken above a high-water mark, and the rate
///   it accepts can grow at most 25% a year. While sKNTQ pays nothing, as it does at the time of
///   writing (Kinetiq's KIP-5 ended staker distributions in September 2026), no fee is taken at all.
///   The fee is set aside in sKNTQ and sent to one fixed address by `collectFees`, which anyone may call.
/// - Withdrawing sKNTQ is always possible: it needs no price and no permission.
/// - The owner can pause new deposits and set a deposit cap. Nothing else: it cannot touch deposits,
///   withdrawals, the fee or the fee address. There is no upgrade path.
/// - Whatever benefits Kinetiq attaches to holding sKNTQ (governance, tiers) belong to the address that
///   holds it, which is this vault. Depositors do not get them.
/// @dev Unaudited.
contract KntqStakingVault is ERC4626, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Math for uint256;

    /// @notice Share of the yield taken as the fee (20%).
    uint256 public constant FEE_BPS = 2_000;
    /// @notice Ceiling on how fast the rate used for the fee may grow: 25% a year, about twice the most sKNTQ
    /// has paid (roughly 13% a year in mid-2026). sKNTQ's rate is its own accounting, not a market price, so
    /// it cannot be pushed up and let fall again; the ceiling is a backstop in case sKNTQ ever reports a
    /// wrong rate. It bounds the fee at 20% of 25% of deposits a year.
    uint256 public constant MAX_RATE_GROWTH_BPS_PER_YEAR = 2_500;
    /// @notice Shares minted to a dead address at the first deposit, so the share price cannot be inflated by a donation.
    uint256 public constant DEAD_SHARES = 1_000;
    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 private constant BPS = 10_000;
    uint256 private constant ONE = 1e18;

    /// @notice KNTQ, the token sKNTQ is staked from.
    IERC20 public immutable kntq;
    /// @notice The only address fees are ever sent to.
    address public immutable feeRecipient;

    /// @notice The rate at which fees were last taken (the high-water mark), and when.
    uint192 public markRate;
    uint64 public markTime;
    /// @notice sKNTQ set aside for the fee address and not yet sent. It is not part of `totalAssets`.
    uint256 public feesOwed;

    bool public depositsPaused;
    /// @notice Most sKNTQ the vault accepts in total. `type(uint256).max` means no cap.
    uint256 public depositCap;

    event FeeAccrued(uint256 rate, uint256 fee);
    event FeesCollected(uint256 amount);
    event DepositsPausedSet(bool paused);
    event DepositCapSet(uint256 cap);

    error ZeroAddress();
    error ZeroAmount();
    error ZeroRate();
    error RateUnavailable();
    error FirstDepositTooSmall();

    /// @param skntq Kinetiq's staked KNTQ, an ERC-4626 vault over KNTQ
    constructor(string memory name_, string memory symbol_, address owner_, IERC4626 skntq, address feeRecipient_, uint256 depositCap_)
        ERC4626(IERC20(address(skntq)))
        ERC20(name_, symbol_)
        Ownable(owner_)
    {
        if (address(skntq) == address(0) || feeRecipient_ == address(0)) revert ZeroAddress();
        kntq = IERC20(skntq.asset());
        feeRecipient = feeRecipient_;
        depositCap = depositCap_;
        uint256 rate = skntq.convertToAssets(ONE);
        if (rate == 0) revert ZeroRate();
        markRate = SafeCast.toUint192(rate);
        markTime = uint64(block.timestamp);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice sKNTQ that belongs to depositors: the balance, less fees set aside and fees due right now.
    function totalAssets() public view override returns (uint256) {
        (uint256 fee,) = _pending();
        return IERC20(asset()).balanceOf(address(this)) - feesOwed - fee;
    }

    /// @notice The rate fees are measured against right now: sKNTQ's rate, held under the growth ceiling.
    /// Falls back to the high-water mark when sKNTQ cannot be read.
    function currentRate() public view returns (uint256 rate) {
        (, rate) = _pending();
    }

    /// @notice sKNTQ owed to the fee address in total: set aside already, plus due right now.
    function pendingFees() external view returns (uint256) {
        (uint256 fee,) = _pending();
        return feesOwed + fee;
    }

    /// @notice What the vault's sKNTQ is worth in KNTQ at the current rate.
    function totalKntq() external view returns (uint256) {
        return totalAssets().mulDiv(currentRate(), ONE);
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

    /// @notice Stakes `amount` of the caller's KNTQ into sKNTQ and gives `receiver` the shares.
    function depositKntq(uint256 amount, address receiver) external nonReentrant returns (uint256 shares) {
        if (amount == 0) revert ZeroAmount();
        _accrue(true);
        uint256 supply = totalSupply();
        uint256 held = totalAssets();
        IERC20 skntq = IERC20(asset());
        uint256 before = skntq.balanceOf(address(this));
        kntq.safeTransferFrom(msg.sender, address(this), amount);
        kntq.forceApprove(address(skntq), amount);
        IERC4626(address(skntq)).deposit(amount, address(this));
        uint256 got = skntq.balanceOf(address(this)) - before;
        uint256 room = _room(held);
        if (got > room) revert ERC4626ExceededMaxDeposit(receiver, got, room);
        // the same formula as ERC4626.previewDeposit, on what the vault held before this sKNTQ arrived
        shares = _mintShares(receiver, got.mulDiv(supply + 1, held + 1, Math.Rounding.Floor));
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

    // ---------------------------------------------------------------------
    // The fee
    // ---------------------------------------------------------------------

    /// @notice Sets aside the fee on any new yield and sends everything set aside to the fee address.
    /// Anyone may call this; the sKNTQ can only go to `feeRecipient`.
    function collectFees() external nonReentrant returns (uint256 amount) {
        _accrue(false);
        amount = feesOwed;
        if (amount == 0) return 0;
        feesOwed = 0;
        IERC20(asset()).safeTransfer(feeRecipient, amount);
        emit FeesCollected(amount);
    }

    /// @dev sKNTQ's own rate: the KNTQ that 1e18 sKNTQ redeems for. Zero when it cannot be read.
    function _skntqRate() private view returns (uint256 rate) {
        try IERC4626(asset()).convertToAssets(ONE) returns (uint256 r) {
            rate = r;
        } catch {}
    }

    /// @dev The fee due right now, and the rate it is measured at. No fee unless the rate is above the mark.
    function _pending() private view returns (uint256 fee, uint256 rate) {
        uint256 mark = markRate;
        rate = mark;
        uint256 reported = _skntqRate();
        uint256 ceiling = mark + mark * MAX_RATE_GROWTH_BPS_PER_YEAR * (block.timestamp - markTime) / (BPS * 365 days);
        if (reported > ceiling) reported = ceiling;
        if (reported <= mark) return (0, mark);
        rate = reported;
        // Depositors' sKNTQ is worth `held * rate` KNTQ; it was worth `held * mark` at the mark. The gain, put
        // back into sKNTQ, is `held * (rate - mark) / rate`.
        uint256 held = IERC20(asset()).balanceOf(address(this)) - feesOwed;
        fee = held.mulDiv(rate - mark, rate).mulDiv(FEE_BPS, BPS);
    }

    /// @dev Takes the fee due and moves the mark up. Run before anything that changes what the vault holds, so
    /// a new depositor never pays for yield from before they came.
    /// @param strict revert when the rate cannot be read (deposits need it; withdrawals must not)
    function _accrue(bool strict) private {
        if (strict && _skntqRate() == 0) revert RateUnavailable();
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
}

/// @notice The part of the HyperEVM Locked Reserve this file uses.
interface ILockedReserveDeposit {
    function deposit(address asset, uint256 amount) external returns (uint256 underlying);
}

/// @title SkntqLock
/// @notice HyperEVM. The reserve's side of the staking fee. sKNTQ that arrives here is added to the Locked
/// Reserve as principal, which nobody can withdraw. (Sent to the reserve as a plain transfer it would count as
/// yield and flow out again; `deposit` is what locks it.)
/// @dev No owner. Everything is immutable. Anyone may call `lock`.
contract SkntqLock is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable skntq;
    ILockedReserveDeposit public immutable reserve;

    event Locked(uint256 amount, uint256 kntqValue);

    error ZeroAddress();
    error NothingToLock();

    constructor(IERC20 skntq_, ILockedReserveDeposit reserve_) {
        if (address(skntq_) == address(0) || address(reserve_) == address(0)) revert ZeroAddress();
        skntq = skntq_;
        reserve = reserve_;
    }

    function lock() external nonReentrant returns (uint256 amount) {
        amount = skntq.balanceOf(address(this));
        if (amount == 0) revert NothingToLock();
        skntq.forceApprove(address(reserve), amount);
        emit Locked(amount, reserve.deposit(address(skntq), amount));
    }
}
