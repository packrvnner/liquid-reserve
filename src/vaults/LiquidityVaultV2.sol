// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {LiquidityMath} from "./LiquidityMath.sol";

interface IWHYPEVault {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/// @title LiquidityVaultV2
/// @notice Auto-compounding concentrated liquidity for one Uniswap v4 pool on
/// Elysium. It needs no oracle and no bot to keep working.
///
/// Version 2: whenever it opens fresh ranges (the first deposit, and every keeper
/// rebalance) it first swaps its surplus token in its own pool, within a 1% price
/// limit, so the main range holds both tokens instead of the vault ending up
/// holding one token beside the price. Everything else is as in LiquidityVault.
///
/// - Deposit both tokens in the vault's current ratio; receive shares. HYPE can
///   be sent as native HYPE. Whatever is not needed is refunded in the same call.
/// - Withdraw any time, pro-rata. Withdrawals can never be paused.
/// - The vault keeps a "main" range around the price and an "alt" range for the
///   leftover token. Every deposit and every `harvest()` collects trading fees
///   and adds them back to those ranges, so fees compound. Anyone can harvest.
/// - A deposit only ever adds liquidity in proportion to what is already there,
///   so the pool price at that moment cannot be used to buy shares cheaply.
/// - Moving the ranges to a new price (`rebalance`) is the one action where the
///   pool price matters, so only the keeper can do it, it states the price it
///   expects, and it is rate-limited.
/// - 20% of collected trading fees go to `feeRecipient`.
/// - The owner can only tune range widths, pick the keeper, pause deposits and
///   cap TVL, within hard bounds. Neither owner nor keeper can move funds out.
/// - Hookless pools only. HYPE is held as WHYPE.
contract LiquidityVaultV2 is ERC20, IUnlockCallback, ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;
    using TransientStateLibrary for IPoolManager;

    uint256 public constant PERFORMANCE_FEE_BPS = 2_000;
    uint256 public constant MINIMUM_SHARES = 1_000;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    int24 public constant MIN_WIDTH = 2; // in tick spacings
    int24 public constant MAX_WIDTH = 2_000;
    /// @notice Largest gap the keeper may allow between the price it expects and the pool price (~2%).
    int24 public constant MAX_DRIFT = 200;
    uint256 public constant REBALANCE_COOLDOWN = 15 minutes;

    IPoolManager public immutable poolManager;
    address public immutable feeRecipient;
    address public immutable whype;
    IERC20 public immutable token0;
    IERC20 public immutable token1;
    PoolId public immutable poolId;
    int24 public immutable tickSpacing;
    /// @notice True when the pool's token0 is native HYPE (the vault holds it as WHYPE).
    bool public immutable nativePool;
    Currency private immutable _currency0;
    Currency private immutable _currency1;
    uint24 private immutable _fee;
    uint8 private immutable _decimals;

    address public keeper;
    int24 public mainWidth;
    int24 public altWidth;
    bool public depositsPaused;
    /// @notice Max vault value in token1 units (0 = no cap).
    uint256 public depositCap;

    struct Range {
        int24 lower;
        int24 upper;
        uint128 liquidity;
    }

    Range public main;
    Range public alt;
    uint256 public lastHarvest;
    uint256 public lastRebalance;
    /// @notice All trading fees ever collected, before the performance fee.
    uint256 public totalFees0;
    uint256 public totalFees1;

    /// @notice Most a rebalance swap may move the pool price, in ticks (100 is about 1%).
    int24 public constant MAX_SWAP_IMPACT_TICKS = 100;
    /// @notice A rebalance only swaps when the surplus is at least this share of the vault's value.
    uint256 public constant MIN_SWAP_BPS = 50;

    event Swapped(bool zeroForOne, int256 amount0, int256 amount1);

    enum Op {
        COMPOUND, // collect fees, add idle tokens to the existing ranges
        RESET, // collect fees, pull everything, open fresh ranges around the price
        ADD, // add a/b of the current liquidity to both ranges
        REMOVE // remove a/b of the current liquidity from both ranges
    }

    event Deposit(address indexed sender, address indexed receiver, uint256 amount0, uint256 amount1, uint256 shares);
    event Withdraw(address indexed owner, address indexed receiver, uint256 shares, uint256 amount0, uint256 amount1);
    event FeesCollected(uint256 fee0, uint256 fee1, uint256 performanceFee0, uint256 performanceFee1);
    event Rebalanced(int24 tick, int24 mainLower, int24 mainUpper, int24 altLower, int24 altUpper);
    /// @notice Emitted after every action, for charts: holdings, share supply and pool price.
    event Snapshot(uint256 total0, uint256 total1, uint256 totalSupply, uint160 sqrtPriceX96);
    event RangesSet(int24 mainWidth, int24 altWidth);
    event KeeperSet(address indexed keeper);
    event DepositsPaused(bool paused);
    event DepositCapSet(uint256 cap);

    error ZeroAddress();
    error BadParams();
    error NotKeeper();
    error PriceMoved(int24 tick, int24 expectedTick);
    error TooSoon(uint256 availableAt);
    error DepositsArePaused();
    error CapExceeded(uint256 value, uint256 cap);
    error ZeroShares();
    error Slippage();
    error NotPoolManager();
    error UnexpectedNative();
    error NativeTransferFailed();

    struct Params {
        PoolKey key;
        IPoolManager poolManager;
        address feeRecipient;
        address whype;
        address owner;
        address keeper;
        string name;
        string symbol;
        int24 mainWidth;
        int24 altWidth;
        uint256 depositCap;
    }

    constructor(Params memory p) ERC20(p.name, p.symbol) Ownable(p.owner) {
        if (
            address(p.poolManager) == address(0) || p.feeRecipient == address(0) || p.whype == address(0)
                || p.keeper == address(0)
        ) revert ZeroAddress();
        if (address(p.key.hooks) != address(0)) revert BadParams(); // hookless pools only
        poolManager = p.poolManager;
        feeRecipient = p.feeRecipient;
        whype = p.whype;
        poolId = p.key.toId();
        tickSpacing = p.key.tickSpacing;
        _currency0 = p.key.currency0;
        _currency1 = p.key.currency1;
        _fee = p.key.fee;
        nativePool = p.key.currency0.isAddressZero();
        token0 = IERC20(p.key.currency0.isAddressZero() ? p.whype : Currency.unwrap(p.key.currency0));
        token1 = IERC20(Currency.unwrap(p.key.currency1));
        _decimals = IERC20Metadata(Currency.unwrap(p.key.currency1)).decimals();
        (uint160 sqrtP,,,) = p.poolManager.getSlot0(p.key.toId());
        if (sqrtP == 0) revert BadParams(); // pool must exist
        _setRanges(p.mainWidth, p.altWidth);
        keeper = p.keeper;
        depositCap = p.depositCap;
        emit KeeperSet(p.keeper);
        emit DepositCapSet(p.depositCap);
    }

    receive() external payable {
        if (msg.sender != whype && msg.sender != address(poolManager)) revert UnexpectedNative();
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function poolKey() public view returns (PoolKey memory) {
        return PoolKey(_currency0, _currency1, _fee, tickSpacing, IHooks(address(0)));
    }

    function price() public view returns (uint160 sqrtPriceX96, int24 tick) {
        (sqrtPriceX96, tick,,) = poolManager.getSlot0(poolId);
    }

    /// @notice Tokens in both ranges at the current price (fees not yet collected excluded).
    function positionAmounts() public view returns (uint256 amount0, uint256 amount1) {
        (uint160 p,) = price();
        (uint256 a0, uint256 a1) = _rangeAmounts(main, p);
        (uint256 b0, uint256 b1) = _rangeAmounts(alt, p);
        return (a0 + b0, a1 + b1);
    }

    /// @notice Everything the vault holds: ranges plus idle tokens (fees not yet collected excluded).
    function balances() public view returns (uint256 total0, uint256 total1) {
        (total0, total1) = positionAmounts();
        total0 += token0.balanceOf(address(this));
        total1 += token1.balanceOf(address(this));
    }

    /// @notice Vault value in token1 units at the current pool price.
    function totalValue() public view returns (uint256) {
        (uint256 t0, uint256 t1) = balances();
        (uint160 p,) = price();
        return t1 + LiquidityMath.quote0In1(t0, p);
    }

    /// @notice Trading fees earned but not yet collected, before the performance fee.
    function pendingFees() public view returns (uint256 fee0, uint256 fee1) {
        (uint256 a0, uint256 a1) = _pendingFees(main);
        (uint256 b0, uint256 b1) = _pendingFees(alt);
        return (a0 + b0, a1 + b1);
    }

    /// @notice The most shares that `amount0Max`/`amount1Max` can pay for right now,
    /// and what those shares cost. Counts fees waiting to be collected. Pass the
    /// result to `deposit` with maximums a little above the amounts returned.
    function previewDeposit(uint256 amount0Max, uint256 amount1Max)
        external
        view
        returns (uint256 shares, uint256 amount0, uint256 amount1)
    {
        uint256 supply = totalSupply();
        if (supply <= MINIMUM_SHARES) {
            (uint160 p,) = price();
            shares = amount1Max + LiquidityMath.quote0In1(amount0Max, p);
            if (supply == 0) shares = shares > MINIMUM_SHARES ? shares - MINIMUM_SHARES : 0;
            return (shares, amount0Max, amount1Max);
        }
        (uint256 t0, uint256 t1) = balances();
        (uint256 f0, uint256 f1) = pendingFees();
        t0 += f0 - f0 * PERFORMANCE_FEE_BPS / 10_000;
        t1 += f1 - f1 * PERFORMANCE_FEE_BPS / 10_000;
        if (t0 == 0 && t1 == 0) return (0, 0, 0);
        uint256 s0 = t0 == 0 ? type(uint256).max : amount0Max * supply / t0;
        uint256 s1 = t1 == 0 ? type(uint256).max : amount1Max * supply / t1;
        shares = s0 < s1 ? s0 : s1;
        amount0 = Math.mulDiv(t0, shares, supply, Math.Rounding.Ceil);
        amount1 = Math.mulDiv(t1, shares, supply, Math.Rounding.Ceil);
    }

    // ---------------------------------------------------------------------
    // Deposit / withdraw / harvest
    // ---------------------------------------------------------------------

    /// @notice Mint exactly `shares` by paying both tokens in the vault's current
    /// ratio, never more than `amount0Max`/`amount1Max`. HYPE can be sent as native
    /// HYPE (`msg.value` then replaces `amount0Max`). Anything not needed is refunded.
    ///
    /// While the vault is empty the first depositor sets the ratio: both maximums
    /// are used in full and `shares` is the minimum to mint.
    function deposit(uint256 shares, uint256 amount0Max, uint256 amount1Max, address receiver)
        external
        payable
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        if (depositsPaused) revert DepositsArePaused();
        if (receiver == address(0)) revert ZeroAddress();
        if (shares == 0) revert ZeroShares();
        if (msg.value > 0 && !nativePool) revert UnexpectedNative();

        uint256 supply = totalSupply();
        uint256 minted = shares;
        if (supply <= MINIMUM_SHARES) {
            // Nobody else is in the vault: take any ratio and open ranges around the price.
            amount0 = _pull0(amount0Max);
            amount1 = _pull(token1, amount1Max);
            (uint160 p,) = price();
            minted = amount1 + LiquidityMath.quote0In1(amount0, p);
            if (supply == 0) {
                if (minted <= MINIMUM_SHARES) revert ZeroShares();
                minted -= MINIMUM_SHARES;
                _mint(DEAD, MINIMUM_SHARES); // makes share-price inflation attacks uneconomic
            }
            if (minted < shares) revert Slippage();
            _mint(receiver, minted);
            poolManager.unlock(abi.encode(Op.RESET, uint256(0), uint256(0)));
        } else {
            // Collect and compound fees first so existing holders keep everything earned so far.
            poolManager.unlock(abi.encode(Op.COMPOUND, uint256(0), uint256(0)));
            uint256 idle0 = token0.balanceOf(address(this));
            uint256 idle1 = token1.balanceOf(address(this));
            uint256 in0 = _pull0(amount0Max);
            uint256 in1 = _pull(token1, amount1Max);

            // Add the same fraction of every range, then leave the same fraction of idle tokens.
            poolManager.unlock(abi.encode(Op.ADD, shares, supply));
            amount0 = idle0 + in0 - token0.balanceOf(address(this)) + Math.mulDiv(idle0, shares, supply, Math.Rounding.Ceil);
            amount1 = idle1 + in1 - token1.balanceOf(address(this)) + Math.mulDiv(idle1, shares, supply, Math.Rounding.Ceil);
            if (amount0 > in0 || amount1 > in1) revert Slippage();
            _mint(receiver, shares);
            if (in1 > amount1) token1.safeTransfer(msg.sender, in1 - amount1);
            if (in0 > amount0) _send0(msg.sender, in0 - amount0, msg.value > 0);
        }

        uint256 cap = depositCap;
        if (cap != 0) {
            uint256 value = totalValue();
            if (value > cap) revert CapExceeded(value, cap);
        }
        emit Deposit(msg.sender, receiver, amount0, amount1, minted);
        _snapshot();
    }

    /// @notice Burn `shares` for a pro-rata share of everything. Never paused.
    /// `min0`/`min1` protect against price moves. `unwrapHype` pays HYPE as native HYPE.
    function withdraw(uint256 shares, uint256 min0, uint256 min1, address receiver, bool unwrapHype)
        external
        nonReentrant
        returns (uint256 out0, uint256 out1)
    {
        if (shares == 0 || receiver == address(0)) revert BadParams();
        uint256 supply = totalSupply();
        _burn(msg.sender, shares);

        bytes memory r = poolManager.unlock(abi.encode(Op.REMOVE, shares, supply));
        (uint256 removed0, uint256 removed1) = abi.decode(r, (uint256, uint256));

        // Removed liquidity is the owner's; idle tokens (incl. fees) are shared pro-rata.
        uint256 idle0 = token0.balanceOf(address(this)) - removed0;
        uint256 idle1 = token1.balanceOf(address(this)) - removed1;
        out0 = removed0 + idle0 * shares / supply;
        out1 = removed1 + idle1 * shares / supply;
        if (out0 < min0 || out1 < min1) revert Slippage();

        if (out1 > 0) token1.safeTransfer(receiver, out1);
        if (out0 > 0) _send0(receiver, out0, unwrapHype && nativePool);
        emit Withdraw(msg.sender, receiver, shares, out0, out1);
        _snapshot();
    }

    /// @notice Collects trading fees (20% performance fee) and adds the rest back
    /// to the ranges. Anyone can call it, any time.
    function harvest() external nonReentrant {
        poolManager.unlock(abi.encode(Op.COMPOUND, uint256(0), uint256(0)));
        lastHarvest = block.timestamp;
        _snapshot();
    }

    // ---------------------------------------------------------------------
    // Keeper: move the ranges to the current price
    // ---------------------------------------------------------------------

    /// @notice Collects fees, pulls all liquidity and opens fresh ranges around
    /// the pool price. Reverts unless the pool tick is within `maxDrift` of
    /// `expectedTick`, so the price cannot be pushed just before this lands.
    function rebalance(int24 expectedTick, int24 maxDrift) external nonReentrant {
        if (msg.sender != keeper) revert NotKeeper();
        if (maxDrift < 0 || maxDrift > MAX_DRIFT) revert BadParams();
        uint256 availableAt = lastRebalance + REBALANCE_COOLDOWN;
        if (lastRebalance != 0 && block.timestamp < availableAt) revert TooSoon(availableAt);
        (, int24 tick) = price();
        int24 diff = tick > expectedTick ? tick - expectedTick : expectedTick - tick;
        if (diff > maxDrift) revert PriceMoved(tick, expectedTick);

        poolManager.unlock(abi.encode(Op.RESET, uint256(0), uint256(0)));
        lastRebalance = block.timestamp;
        lastHarvest = block.timestamp;
        _snapshot();
    }

    // ---------------------------------------------------------------------
    // Owner: parameters only, within hard bounds
    // ---------------------------------------------------------------------

    /// @notice Range widths in tick spacings. Takes effect at the next rebalance.
    function setRanges(int24 mainWidth_, int24 altWidth_) external onlyOwner {
        _setRanges(mainWidth_, altWidth_);
    }

    function setKeeper(address keeper_) external onlyOwner {
        if (keeper_ == address(0)) revert ZeroAddress();
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    function setDepositsPaused(bool paused) external onlyOwner {
        depositsPaused = paused;
        emit DepositsPaused(paused);
    }

    function setDepositCap(uint256 cap) external onlyOwner {
        depositCap = cap;
        emit DepositCapSet(cap);
    }

    function _setRanges(int24 mainWidth_, int24 altWidth_) private {
        if (mainWidth_ < MIN_WIDTH || mainWidth_ > MAX_WIDTH || altWidth_ < MIN_WIDTH || altWidth_ > MAX_WIDTH) {
            revert BadParams();
        }
        mainWidth = mainWidth_;
        altWidth = altWidth_;
        emit RangesSet(mainWidth_, altWidth_);
    }

    // ---------------------------------------------------------------------
    // Pool interaction
    // ---------------------------------------------------------------------

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (Op op, uint256 a, uint256 b) = abi.decode(data, (Op, uint256, uint256));
        if (op == Op.COMPOUND) {
            _collect();
            _compound();
        } else if (op == Op.RESET) {
            _removeFraction(1, 1);
            _balanceForMain();
            _openRanges();
        } else if (op == Op.ADD) {
            _addFraction(a, b);
        } else {
            (uint256 r0, uint256 r1) = _removeFraction(a, b);
            return abi.encode(r0, r1);
        }
        return "";
    }

    /// @dev Collects fees on both ranges without changing liquidity.
    function _collect() private {
        uint256 fee0;
        uint256 fee1;
        Range[2] memory ranges = [main, alt];
        for (uint256 i; i < 2; ++i) {
            if (ranges[i].liquidity == 0) continue;
            (, BalanceDelta fees) = poolManager.modifyLiquidity(
                poolKey(),
                IPoolManager.ModifyLiquidityParams({
                    tickLower: ranges[i].lower, tickUpper: ranges[i].upper, liquidityDelta: 0, salt: bytes32(0)
                }),
                ""
            );
            fee0 += uint256(uint128(fees.amount0()));
            fee1 += uint256(uint128(fees.amount1()));
        }
        _settleAll();
        _payPerformanceFee(fee0, fee1);
    }

    /// @dev Adds idle tokens to the existing ranges: main first, then alt.
    function _compound() private {
        (uint160 p,) = price();
        uint128 l = _addRange(p, main.lower, main.upper);
        if (l > 0) main.liquidity += l;
        l = _addRange(p, alt.lower, alt.upper);
        if (l > 0) alt.liquidity += l;
    }

    /// @dev Adds `num/den` of each range's liquidity, rounded up.
    function _addFraction(uint256 num, uint256 den) private {
        Range[2] memory ranges = [main, alt];
        for (uint256 i; i < 2; ++i) {
            Range memory r = ranges[i];
            if (r.liquidity == 0) continue;
            uint128 dl = uint128(Math.mulDiv(r.liquidity, num, den, Math.Rounding.Ceil));
            _modify(r.lower, r.upper, int256(uint256(dl)));
            if (i == 0) main.liquidity += dl;
            else alt.liquidity += dl;
        }
        _settleAll();
    }

    /// @dev Removes `num/den` of both ranges, settles, and pays the performance
    /// fee on all fees collected. Returns the principal removed (excluding fees).
    function _removeFraction(uint256 num, uint256 den) private returns (uint256 removed0, uint256 removed1) {
        uint256 fee0;
        uint256 fee1;
        Range[2] memory ranges = [main, alt];
        for (uint256 i; i < 2; ++i) {
            Range memory r = ranges[i];
            if (r.liquidity == 0) continue;
            uint128 dl = num == den ? r.liquidity : uint128(uint256(r.liquidity) * num / den);
            (BalanceDelta delta, BalanceDelta fees) = _modify(r.lower, r.upper, -int256(uint256(dl)));
            uint256 f0 = uint256(uint128(fees.amount0()));
            uint256 f1 = uint256(uint128(fees.amount1()));
            fee0 += f0;
            fee1 += f1;
            removed0 += uint256(uint128(delta.amount0())) - f0;
            removed1 += uint256(uint128(delta.amount1())) - f1;
            if (i == 0) main.liquidity -= dl;
            else alt.liquidity -= dl;
        }
        _settleAll();
        _payPerformanceFee(fee0, fee1);
    }

    function _payPerformanceFee(uint256 fee0, uint256 fee1) private {
        if (fee0 == 0 && fee1 == 0) return;
        uint256 perf0 = fee0 * PERFORMANCE_FEE_BPS / 10_000;
        uint256 perf1 = fee1 * PERFORMANCE_FEE_BPS / 10_000;
        totalFees0 += fee0;
        totalFees1 += fee1;
        if (perf0 > 0) token0.safeTransfer(feeRecipient, perf0);
        if (perf1 > 0) token1.safeTransfer(feeRecipient, perf1);
        emit FeesCollected(fee0, fee1, perf0, perf1);
    }

    /// @dev Puts every idle token into a main range around the price, then the
    /// leftover token into a one-sided alt range next to it.
    function _openRanges() private {
        (uint160 p, int24 tick) = price();
        int24 center = _floorTick(tick);
        (int24 lo, int24 hi) = _bounds(center - mainWidth * tickSpacing, center + mainWidth * tickSpacing);
        main = Range(lo, hi, _addRange(p, lo, hi));

        // Leftover: token0 sits in a range above the price, token1 below it.
        (int24 aLo, int24 aHi) = LiquidityMath.quote0In1(token0.balanceOf(address(this)), p)
            >= token1.balanceOf(address(this))
            ? _bounds(center + tickSpacing, center + tickSpacing + altWidth * tickSpacing)
            : _bounds(center - altWidth * tickSpacing, center);
        alt = Range(aLo, aHi, _addRange(p, aLo, aHi));
        emit Rebalanced(tick, lo, hi, aLo, aHi);
    }

    /// @dev Before fresh ranges open: swaps the surplus token in the vault's own pool so that the
    /// main range can hold (nearly) everything, instead of the surplus sitting idle beside the price.
    /// Bounded: the swap may move the price by at most MAX_SWAP_IMPACT_TICKS (any rest goes to the
    /// alt range as before), small surpluses are left alone, and nothing is swapped when there is no
    /// other liquidity at the price to trade with.
    function _balanceForMain() private {
        if (poolManager.getLiquidity(poolId) == 0) return;
        (bool zeroForOne, uint256 amountIn, int24 tick) = _surplus();
        if (amountIn == 0) return;
        int24 limitTick = zeroForOne ? tick - MAX_SWAP_IMPACT_TICKS : tick + MAX_SWAP_IMPACT_TICKS;
        if (limitTick <= TickMath.MIN_TICK) limitTick = TickMath.MIN_TICK + 1;
        if (limitTick >= TickMath.MAX_TICK) limitTick = TickMath.MAX_TICK - 1;
        BalanceDelta delta = poolManager.swap(
            poolKey(),
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(limitTick)
            }),
            ""
        );
        _settleAll();
        emit Swapped(zeroForOne, delta.amount0(), delta.amount1());
    }

    /// @dev Which token is in surplus for a main range opened at the current price, and how much
    /// of it to sell so both sides match after the pool fee. Zero when the surplus is too small.
    function _surplus() private view returns (bool zeroForOne, uint256 amountIn, int24 tick) {
        uint160 p;
        (p, tick) = price();
        (uint256 w0, uint256 u1) = _unitValues(p, tick);
        if (w0 == 0 || u1 == 0) return (false, 0, tick);
        uint256 b0 = token0.balanceOf(address(this));
        uint256 b1 = token1.balanceOf(address(this));
        uint256 v0 = LiquidityMath.quote0In1(b0, p);
        uint256 keep = 1e6 - _fee; // hookless pools charge a fixed fee
        // Sell value d of token0 so (v0 - d) : (b1 + d * fee-adjusted) = w0 : u1, or the mirror image.
        uint256 den = u1 + w0 * keep / 1e6;
        uint256 x = FullMath.mulDiv(u1, v0, den);
        uint256 y = FullMath.mulDiv(w0, b1, den);
        zeroForOne = x > y;
        uint256 d;
        if (zeroForOne) {
            d = x - y;
        } else {
            den = w0 + u1 * keep / 1e6;
            d = FullMath.mulDiv(w0, b1, den) - FullMath.mulDiv(u1, v0, den);
        }
        if (d * 10_000 < (v0 + b1) * MIN_SWAP_BPS) return (zeroForOne, 0, tick);
        amountIn = zeroForOne ? FullMath.mulDiv(d, b0, v0) : d;
    }

    /// @dev What one unit of liquidity in a main range opened at this price holds, both sides in token1.
    function _unitValues(uint160 p, int24 tick) private view returns (uint256 w0, uint256 u1) {
        int24 center = _floorTick(tick);
        (int24 lo, int24 hi) = _bounds(center - mainWidth * tickSpacing, center + mainWidth * tickSpacing);
        uint256 u0;
        (u0, u1) = LiquidityMath.amountsForLiquidity(p, TickMath.getSqrtPriceAtTick(lo), TickMath.getSqrtPriceAtTick(hi), 1e18);
        w0 = LiquidityMath.quote0In1(u0, p);
    }

    function _floorTick(int24 tick) private view returns (int24 center) {
        center = tick / tickSpacing * tickSpacing;
        if (tick < 0 && tick % tickSpacing != 0) center -= tickSpacing;
    }

    function _bounds(int24 lo, int24 hi) private view returns (int24, int24) {
        int24 minTick = TickMath.minUsableTick(tickSpacing);
        int24 maxTick = TickMath.maxUsableTick(tickSpacing);
        return (_clamp(lo, minTick, maxTick), _clamp(hi, minTick, maxTick));
    }

    /// @dev Adds as much liquidity as the idle balances can fund in [lo, hi].
    function _addRange(uint160 p, int24 lo, int24 hi) private returns (uint128 liquidity) {
        if (lo >= hi) return 0;
        // Keep 1 wei back per token so rounding up in the pool never exceeds our balance.
        uint256 b0 = token0.balanceOf(address(this));
        uint256 b1 = token1.balanceOf(address(this));
        liquidity = LiquidityMath.liquidityForAmounts(
            p, TickMath.getSqrtPriceAtTick(lo), TickMath.getSqrtPriceAtTick(hi), b0 > 0 ? b0 - 1 : 0, b1 > 0 ? b1 - 1 : 0
        );
        if (liquidity == 0) return 0;
        _modify(lo, hi, int256(uint256(liquidity)));
        _settleAll();
    }

    function _modify(int24 lo, int24 hi, int256 liquidityDelta) private returns (BalanceDelta, BalanceDelta) {
        return poolManager.modifyLiquidity(
            poolKey(),
            IPoolManager.ModifyLiquidityParams({
                tickLower: lo, tickUpper: hi, liquidityDelta: liquidityDelta, salt: bytes32(0)
            }),
            ""
        );
    }

    /// @dev Pays what the vault owes the PoolManager and takes what it is owed.
    function _settleAll() private {
        Currency[2] memory cs = [_currency0, _currency1];
        for (uint256 i; i < 2; ++i) {
            Currency c = cs[i];
            int256 d = poolManager.currencyDelta(address(this), c);
            if (d > 0) {
                poolManager.take(c, address(this), uint256(d));
                if (c.isAddressZero()) IWHYPEVault(whype).deposit{value: uint256(d)}();
            } else if (d < 0) {
                uint256 owed = uint256(-d);
                if (c.isAddressZero()) {
                    IWHYPEVault(whype).withdraw(owed);
                    poolManager.settle{value: owed}();
                } else {
                    poolManager.sync(c);
                    IERC20(Currency.unwrap(c)).safeTransfer(address(poolManager), owed);
                    poolManager.settle();
                }
            }
        }
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _snapshot() private {
        (uint256 t0, uint256 t1) = balances();
        (uint160 p,) = price();
        emit Snapshot(t0, t1, totalSupply(), p);
    }

    /// @dev Takes token0 from the caller: wraps `msg.value` if any, else pulls WHYPE / the ERC-20.
    function _pull0(uint256 amount) private returns (uint256) {
        if (msg.value == 0) return _pull(token0, amount);
        IWHYPEVault(whype).deposit{value: msg.value}();
        return msg.value;
    }

    /// @dev Sends token0, as native HYPE when asked.
    function _send0(address to, uint256 amount, bool asNative) private {
        if (!asNative) {
            token0.safeTransfer(to, amount);
            return;
        }
        IWHYPEVault(whype).withdraw(amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
    }

    function _pull(IERC20 token, uint256 amount) private returns (uint256 received) {
        if (amount == 0) return 0;
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        received = token.balanceOf(address(this)) - before;
    }

    function _rangeAmounts(Range memory r, uint160 p) private pure returns (uint256, uint256) {
        if (r.liquidity == 0) return (0, 0);
        return LiquidityMath.amountsForLiquidity(
            p, TickMath.getSqrtPriceAtTick(r.lower), TickMath.getSqrtPriceAtTick(r.upper), r.liquidity
        );
    }

    function _pendingFees(Range memory r) private view returns (uint256 fee0, uint256 fee1) {
        if (r.liquidity == 0) return (0, 0);
        (, uint256 last0, uint256 last1) = poolManager.getPositionInfo(poolId, address(this), r.lower, r.upper, bytes32(0));
        (uint256 now0, uint256 now1) = poolManager.getFeeGrowthInside(poolId, r.lower, r.upper);
        unchecked {
            fee0 = FullMath.mulDiv(now0 - last0, r.liquidity, 1 << 128);
            fee1 = FullMath.mulDiv(now1 - last1, r.liquidity, 1 << 128);
        }
    }

    function _clamp(int24 t, int24 lo, int24 hi) private pure returns (int24) {
        return t < lo ? lo : (t > hi ? hi : t);
    }
}
