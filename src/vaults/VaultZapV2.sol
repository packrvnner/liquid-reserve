// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {LiquidityMath} from "./LiquidityMath.sol";

interface IZapVaultV2 {
    function poolKey() external view returns (PoolKey memory);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function nativePool() external view returns (bool);
    function balances() external view returns (uint256 total0, uint256 total1);
    function price() external view returns (uint160 sqrtPriceX96, int24 tick);
    function balanceOf(address) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function MINIMUM_SHARES() external view returns (uint256);
    function previewDeposit(uint256 amount0Max, uint256 amount1Max)
        external
        view
        returns (uint256 shares, uint256 amount0, uint256 amount1);
    function deposit(uint256 shares, uint256 amount0Max, uint256 amount1Max, address receiver)
        external
        payable
        returns (uint256 amount0, uint256 amount1);
}

/// @title VaultZapV2
/// @notice Deposit into a Liquid Reserve vault with ONE token, also where the vault is the
/// only liquidity in its own pool. Like the first zap it swaps part of the token for the
/// other one in the vault's pool, deposits both and sends back what is left over, in one
/// transaction, with no owner and nothing kept between transactions.
///
/// What is different from the first zap:
/// - The first zap worked out how much to swap from the vault's mix BEFORE the swap. In a
///   pool where the vault itself is the other side of that swap, the swap changes the
///   vault's mix, so that sum was wrong there: paying with the token the vault held none
///   of left nothing to deposit, and other deposits sent a good part back as change. This
///   one counts the vault as the other side of its own swap. Where other liquidity takes
///   part of the swap it then swaps a little too little rather than too much, and a second
///   pass puts the remainder in.
/// - A zap never moves the pool's price by more than MAX_IMPACT_TICKS, and its swap must be
///   filled in full within that limit, or the whole deposit reverts. A zap can therefore
///   not empty one side of a thin pool and leave its price stranded far from the market.
/// - An empty vault in a pool with no liquidity at its price gets the one token as it is:
///   there is nobody to swap with.
///
/// As before, `minShares` protects the depositor against a price that moved or a pool that
/// was pushed, and the vault's shares go straight to `receiver`.
contract VaultZapV2 is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    /// @notice The most a zap's swap may move the pool price, in ticks (300 is about 3%).
    int24 public constant MAX_IMPACT_TICKS = 300;
    /// @notice Swap-and-deposit rounds. The second only runs when the first left more than 0.2% over.
    uint256 public constant PASSES = 2;
    /// @dev Wei kept back from each token when sizing a deposit, for the vault's rounding.
    uint256 private constant ROUNDING = 4;

    IPoolManager public immutable poolManager;

    event Zapped(
        address indexed vault, address indexed sender, address indexed receiver, bool token0In, uint256 amountIn, uint256 shares
    );

    error ZeroAddress();
    error ZeroAmount();
    error WrongValue();
    error Slippage(uint256 shares, uint256 minShares);
    error TooMuchForPool(uint256 filled, uint256 wanted);
    error NotPoolManager();
    error NativeTransferFailed();

    constructor(IPoolManager poolManager_) {
        if (address(poolManager_) == address(0)) revert ZeroAddress();
        poolManager = poolManager_;
    }

    /// @dev Native HYPE arrives from the pool (swap output) and from the vault (refund).
    receive() external payable {}

    /// @dev One zap's fixed facts, kept together so the steps below can share them.
    struct Zap {
        IZapVaultV2 vault;
        PoolKey key;
        bool native;
        IERC20 t0;
        IERC20 t1;
        bool token0In;
        address receiver;
    }

    /// @notice Deposit `amountIn` of one of the vault's two tokens.
    /// @param token0In True to pay in token0 (native HYPE on HYPE pools: send it as
    /// `msg.value`), false to pay in token1 (approve this contract first).
    /// @param minShares Fewest vault shares to accept.
    /// @return shares Vault shares minted to `receiver`.
    /// @return refund0 Token0 returned to the caller (native HYPE on HYPE pools).
    /// @return refund1 Token1 returned to the caller.
    function zapIn(IZapVaultV2 vault, bool token0In, uint256 amountIn, uint256 minShares, address receiver)
        external
        payable
        nonReentrant
        returns (uint256 shares, uint256 refund0, uint256 refund1)
    {
        if (receiver == address(0)) revert ZeroAddress();
        if (amountIn == 0) revert ZeroAmount();
        Zap memory z = Zap({
            vault: vault,
            key: vault.poolKey(),
            native: vault.nativePool(),
            t0: IERC20(vault.token0()),
            t1: IERC20(vault.token1()),
            token0In: token0In,
            receiver: receiver
        });

        // 1. Take the one token.
        if (token0In && z.native) {
            if (msg.value != amountIn) revert WrongValue();
        } else {
            if (msg.value != 0) revert WrongValue();
            (token0In ? z.t0 : z.t1).safeTransferFrom(msg.sender, address(this), amountIn);
        }

        // 2. Swap the right share of it and deposit; once more for what is left, if that is worth it.
        shares = vault.balanceOf(receiver);
        _swapAndDeposit(z, amountIn);
        shares = vault.balanceOf(receiver) - shares;
        if (shares < minShares || shares == 0) revert Slippage(shares, minShares);

        // 3. Send back whatever was not needed.
        (refund0, refund1) = _refund(z.native, z.t0, z.t1);
        emit Zapped(address(vault), msg.sender, receiver, token0In, amountIn, shares);
    }

    function _swapAndDeposit(Zap memory z, uint256 amountIn) private {
        // The furthest this zap may push the price, fixed once from where the price is now:
        // every pass swaps against the same limit, so two passes cannot add up to more.
        (, int24 tick,,) = poolManager.getSlot0(z.key.toId());
        int24 limitTick = z.token0In ? tick - MAX_IMPACT_TICKS : tick + MAX_IMPACT_TICKS;
        if (limitTick <= TickMath.MIN_TICK) limitTick = TickMath.MIN_TICK + 1;
        if (limitTick >= TickMath.MAX_TICK) limitTick = TickMath.MAX_TICK - 1;
        uint160 limit = TickMath.getSqrtPriceAtTick(limitTick);

        uint256 left = amountIn;
        for (uint256 pass; pass < PASSES; ++pass) {
            uint256 toSwap = _swapAmount(z, left);
            // The first swap must be filled in full. A later one only tidies up what is left
            // over: if the limit stops it short, the rest simply goes back to the depositor.
            if (toSwap > 0) poolManager.unlock(abi.encode(z.key, z.token0In, toSwap, limit, pass == 0));
            _deposit(z);
            left = z.token0In ? _held0(z) : z.t1.balanceOf(address(this));
            if (left * 500 < amountIn) break; // under 0.2% of the payment is left over
        }
    }

    function _held0(Zap memory z) private view returns (uint256) {
        return z.native ? address(this).balance : z.t0.balanceOf(address(this));
    }

    /// @dev Deposits as much of what this contract holds as the vault's mix allows.
    function _deposit(Zap memory z) private {
        uint256 have0 = _held0(z);
        uint256 have1 = z.t1.balanceOf(address(this));
        // The vault rounds what it takes up, by a wei or two for each of its ranges. Ask for the shares
        // that a few wei less would pay for, then a thousandth fewer: the first matters when one side
        // is tiny, the second when the price drifts between the preview and the deposit.
        (uint256 want,,) = z.vault.previewDeposit(have0 > ROUNDING ? have0 - ROUNDING : 0, have1 > ROUNDING ? have1 - ROUNDING : 0);
        want = want * 999 / 1000;
        if (want == 0) return;
        if (have1 > 0) z.t1.forceApprove(address(z.vault), have1);
        if (z.native) {
            z.vault.deposit{value: have0}(want, 0, have1, z.receiver);
        } else {
            if (have0 > 0) z.t0.forceApprove(address(z.vault), have0);
            z.vault.deposit(want, have0, have1, z.receiver);
            z.t0.forceApprove(address(z.vault), 0);
        }
        z.t1.forceApprove(address(z.vault), 0);
    }

    function _refund(bool native, IERC20 t0, IERC20 t1) private returns (uint256 refund0, uint256 refund1) {
        refund1 = t1.balanceOf(address(this));
        if (refund1 > 0) t1.safeTransfer(msg.sender, refund1);
        if (native) {
            refund0 = address(this).balance;
            if (refund0 > 0) {
                (bool ok,) = msg.sender.call{value: refund0}("");
                if (!ok) revert NativeTransferFailed();
            }
        } else {
            refund0 = t0.balanceOf(address(this));
            if (refund0 > 0) t0.safeTransfer(msg.sender, refund0);
        }
    }

    /// @dev How much of `amount` (the token being paid) to swap for the other token.
    ///
    /// Counting everything in token1: the vault holds `mine` of the paid token and `other`
    /// of the other one, the payment is worth `a`, and a swap keeps `keep` after the pool
    /// fee. If the vault is the other side of the swap, swapping x leaves the depositor
    /// with (a - x) and x*keep, and the vault with (mine + x) and (other - x*keep). Those
    /// match when
    ///     (a - x) / (mine + x) = x*keep / (other - x*keep)
    /// which gives   x = a * other / (other + keep * (mine + a)).
    /// Where other liquidity takes part of the swap the vault's mix moves less than that,
    /// so this x is a little too small, never too large: what is left over is the token
    /// that was paid, and no pool fee was spent on swapping too much.
    function _swapAmount(Zap memory z, uint256 amount) private view returns (uint256) {
        if (amount == 0) return 0;
        if (z.vault.totalSupply() <= z.vault.MINIMUM_SHARES()) {
            // Nobody is in the vault and it takes any mix. Swap half where there is someone to
            // swap with; where the pool has no liquidity at its price, the token goes in as it is.
            return poolManager.getLiquidity(z.key.toId()) == 0 ? 0 : amount / 2;
        }
        (uint256 total0, uint256 total1) = z.vault.balances();
        (uint160 sqrtP,) = z.vault.price();
        uint256 value0 = LiquidityMath.quote0In1(total0, sqrtP); // the vault's token0, counted in token1
        (uint256 mine, uint256 other) = z.token0In ? (value0, total1) : (total1, value0);
        if (other == 0) return 0; // the vault holds only the token being paid: nothing to swap for
        uint256 a = z.token0In ? LiquidityMath.quote0In1(amount, sqrtP) : amount;
        uint256 keep = z.key.fee < 1e6 ? 1e6 - z.key.fee : 1e6; // hookless pools charge a fixed fee
        return FullMath.mulDiv(amount, other, other + FullMath.mulDiv(mine + a, keep, 1e6));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, bool zeroForOne, uint256 amountIn, uint160 limit, bool mustFill) =
            abi.decode(data, (PoolKey, bool, uint256, uint160, bool));
        (uint256 paid, uint256 got) = _swapUpTo(key, zeroForOne, amountIn, limit);
        // The pool could not take all of it within the price limit: undo everything rather than
        // leave a thin pool's price at the edge of its liquidity with most of the deposit unused.
        if (mustFill && paid != amountIn) revert TooMuchForPool(paid, amountIn);
        (Currency cIn, Currency cOut) = zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        if (paid > 0) {
            if (cIn.isAddressZero()) {
                poolManager.settle{value: paid}();
            } else {
                poolManager.sync(cIn);
                IERC20(Currency.unwrap(cIn)).safeTransfer(address(poolManager), paid);
                poolManager.settle();
            }
        }
        if (got > 0) poolManager.take(cOut, address(this), got);
        return "";
    }

    /// @dev Swaps up to `amountIn`, never moving the price past `limit`. Returns what was paid and received.
    function _swapUpTo(PoolKey memory key, bool zeroForOne, uint256 amountIn, uint160 limit)
        private
        returns (uint256 paid, uint256 got)
    {
        (uint160 sqrtP,,,) = poolManager.getSlot0(key.toId());
        if (zeroForOne ? sqrtP <= limit : sqrtP >= limit) return (0, 0); // the price is at the limit already
        BalanceDelta delta = poolManager.swap(
            key,
            IPoolManager.SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: limit}),
            ""
        );
        paid = uint256(uint128(-(zeroForOne ? delta.amount0() : delta.amount1())));
        got = uint256(uint128(zeroForOne ? delta.amount1() : delta.amount0()));
    }
}
