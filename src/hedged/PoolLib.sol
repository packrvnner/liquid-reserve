// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {LiquidityMath} from "../vaults/LiquidityMath.sol";
import "./HedgedTypes.sol";

/// @title PoolLib
/// @notice The pool side of the hedged vault: one range in a Uniswap-v3-style pool. Deployed on its
/// own and called by the vault with delegatecall, so everything here runs as the vault.
library PoolLib {
    using SafeERC20 for IERC20;

    /// @dev The vault's own swaps may move the pool price by at most this many ticks (about 1%).
    int24 internal constant MAX_SWAP_IMPACT_TICKS = 100;
    /// @dev The pool price must be within this share of the oracle price for anything that prices or swaps.
    uint256 internal constant PRICE_GAP_BPS = 100;
    /// @dev A surplus smaller than this share of what is being placed is left alone.
    uint256 internal constant MIN_SWAP_BPS = 50;

    // ------------------------------------------------------------------ prices

    function price(Vault storage v) public view returns (uint160 sqrtPriceX96, int24 tick) {
        (sqrtPriceX96, tick,,,,,) = IV3Pool(v.c.pool).slot0();
    }

    /// @notice The pool price as a HyperCore raw price (see CoreLib).
    function poolRawPx(Vault storage v) public view returns (uint256) {
        (uint160 p,) = price(v);
        return LiquidityMath.quote0In1(10 ** (18 - v.c.szDecimals), p);
    }

    /// @notice The sqrt price the pool would have at a HyperCore raw price.
    function sqrtPriceAt(Vault storage v, uint256 rawPx) public view returns (uint160) {
        return uint160(Math.sqrt(FullMath.mulDiv(rawPx, 1 << 192, 10 ** (18 - v.c.szDecimals))));
    }

    function inLine(Vault storage v, uint256 oracleRaw) public view returns (bool) {
        uint256 poolRaw = poolRawPx(v);
        uint256 gap = poolRaw > oracleRaw ? poolRaw - oracleRaw : oracleRaw - poolRaw;
        return gap * 10_000 <= oracleRaw * PRICE_GAP_BPS;
    }

    function requireInLine(Vault storage v, uint256 oracleRaw) external view {
        if (!inLine(v, oracleRaw)) revert PriceOutOfLine(poolRawPx(v), oracleRaw);
    }

    // ------------------------------------------------------------------ the position

    /// @notice What the position holds at sqrt price `p`.
    function amountsAt(Vault storage v, uint160 p) public view returns (uint256 amount0, uint256 amount1) {
        if (v.liquidity == 0) return (0, 0);
        return LiquidityMath.amountsForLiquidity(
            p, TickMath.getSqrtPriceAtTick(v.lower), TickMath.getSqrtPriceAtTick(v.upper), v.liquidity
        );
    }

    /// @notice Share of a position's value that is token0 right now, in 1e18. For the open range,
    /// or for the range that would be opened at this price when none is open.
    function assetShare(Vault storage v) external view returns (uint256) {
        (uint160 p, int24 tick) = price(v);
        (int24 lo, int24 hi) = _range(v, tick);
        (uint256 w0, uint256 u1) = _unitValues(p, lo, hi);
        return w0 + u1 == 0 ? 0 : w0 * 1e18 / (w0 + u1);
    }

    /// @notice Takes `num / den` of the position out of the pool. Call `FlowLib.collectFees` first.
    function remove(Vault storage v, uint256 num, uint256 den) external returns (uint256 amount0, uint256 amount1) {
        uint128 liq = uint128(uint256(v.liquidity) * num / den);
        if (liq == 0) return (0, 0);
        IV3Pool pool = IV3Pool(v.c.pool);
        (amount0, amount1) = pool.burn(v.lower, v.upper, liq);
        pool.collect(address(this), v.lower, v.upper, uint128(amount0), uint128(amount1));
        v.liquidity -= liq;
        emit IHedgedVaultEvents.Removed(liq, amount0, amount1);
    }

    /// @notice Sells exactly `amountIn` of one token for the other in the vault's own pool, as far
    /// as the price limit allows.
    function swap(Vault storage v, bool zeroForOne, uint256 amountIn) public returns (uint256 spent, uint256 got) {
        if (amountIn == 0) return (0, 0);
        (, int24 tick) = price(v);
        int24 limitTick = zeroForOne ? tick - MAX_SWAP_IMPACT_TICKS : tick + MAX_SWAP_IMPACT_TICKS;
        (int256 d0, int256 d1) = IV3Pool(v.c.pool).swap(
            address(this), zeroForOne, int256(amountIn), TickMath.getSqrtPriceAtTick(limitTick), ""
        );
        (spent, got) = zeroForOne ? (uint256(d0), uint256(-d1)) : (uint256(d1), uint256(-d0));
        emit IHedgedVaultEvents.Swapped(zeroForOne, d0, d1);
    }

    /// @notice Puts all idle token0 and up to `usdcBudget` of token1 into the range, after swapping
    /// the surplus side so both fit. Opens a fresh range around the price when none is open. A second
    /// pass places most of what the first one's own price impact left over.
    function fill(Vault storage v, uint256 usdcBudget) external returns (uint128 added) {
        (, int24 tick) = price(v);
        if (v.liquidity == 0) {
            (v.lower, v.upper) = _range(v, tick);
        } else if (tick < v.lower || tick >= v.upper) {
            revert OutOfRange();
        }
        uint128 more;
        (usdcBudget, added) = _pass(v, usdcBudget, true);
        if (added > 0) (, more) = _pass(v, usdcBudget, false);
        added += more;
        emit IHedgedVaultEvents.Filled(tick, v.lower, v.upper, added);
    }

    /// @dev One pass: swaps the surplus side, then adds what fits. With `always` false it does
    /// nothing unless there is a surplus worth swapping.
    function _pass(Vault storage v, uint256 b1, bool always) private returns (uint256 left1, uint128 liq) {
        (uint160 p,) = price(v);
        uint256 b0 = IERC20(v.c.asset).balanceOf(address(this));
        (bool zeroForOne, uint256 amountIn) = _surplus(v, p, b0, b1);
        if (amountIn > 0 && IV3Pool(v.c.pool).liquidity() > 0) {
            (uint256 spent, uint256 got) = swap(v, zeroForOne, amountIn);
            b1 = zeroForOne ? b1 + got : b1 - spent;
            b0 = IERC20(v.c.asset).balanceOf(address(this));
            (p,) = price(v);
        } else if (!always) {
            return (b1, 0);
        }
        // 1 wei is kept back per token so that rounding up in the pool never asks for more than there is
        liq = LiquidityMath.liquidityForAmounts(
            p,
            TickMath.getSqrtPriceAtTick(v.lower),
            TickMath.getSqrtPriceAtTick(v.upper),
            b0 > 0 ? b0 - 1 : 0,
            b1 > 0 ? b1 - 1 : 0
        );
        if (liq == 0) return (b1, 0);
        (, uint256 used1) = IV3Pool(v.c.pool).mint(address(this), v.lower, v.upper, liq, "");
        v.liquidity += liq;
        return (b1 - used1, liq);
    }

    // ------------------------------------------------------------------ internals

    /// @dev The open range, or the one to open around `tick` when none is open.
    function _range(Vault storage v, int24 tick) private view returns (int24 lo, int24 hi) {
        if (v.liquidity != 0) return (v.lower, v.upper);
        int24 spacing = v.c.tickSpacing;
        int24 center = tick / spacing * spacing;
        if (tick < 0 && tick % spacing != 0) center -= spacing;
        lo = center - v.width * spacing;
        hi = center + v.width * spacing;
        int24 minTick = TickMath.minUsableTick(spacing);
        int24 maxTick = TickMath.maxUsableTick(spacing);
        if (lo < minTick) lo = minTick;
        if (hi > maxTick) hi = maxTick;
    }

    /// @dev What one unit of liquidity in [lo, hi] holds at price p, both sides in token1.
    function _unitValues(uint160 p, int24 lo, int24 hi) private pure returns (uint256 w0, uint256 u1) {
        uint256 u0;
        (u0, u1) =
            LiquidityMath.amountsForLiquidity(p, TickMath.getSqrtPriceAtTick(lo), TickMath.getSqrtPriceAtTick(hi), 1e18);
        w0 = LiquidityMath.quote0In1(u0, p);
    }

    /// @dev Which token is in surplus for the range at this price, and how much of it to sell so that
    /// both sides match after the pool fee. Zero when the surplus is too small to bother.
    function _surplus(Vault storage v, uint160 p, uint256 b0, uint256 b1)
        private
        view
        returns (bool zeroForOne, uint256 amountIn)
    {
        (uint256 w0, uint256 u1) = _unitValues(p, v.lower, v.upper);
        uint256 v0 = LiquidityMath.quote0In1(b0, p);
        if (v0 + b1 == 0) return (false, 0);
        uint256 keep = 1e6 - v.c.poolFee;
        // Sell value d of token0 so that (v0 - d) : (b1 + d after the fee) = w0 : u1, or the mirror image.
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
        if (d * 10_000 < (v0 + b1) * MIN_SWAP_BPS) return (zeroForOne, 0);
        amountIn = zeroForOne ? FullMath.mulDiv(d, b0, v0) : d;
    }
}
