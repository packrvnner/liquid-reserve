// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {LiquidityMath} from "../vaults/LiquidityMath.sol";
import {CoreLib} from "./CoreLib.sol";
import "./HedgedTypes.sol";

interface IHedgedVaultRead {
    function config() external view returns (Config memory);
    function position() external view returns (int24 lower, int24 upper, uint128 liquidity);
    function owedTotal() external view returns (uint256);
    function totalValue() external view returns (uint256);
    function totalSupply() external view returns (uint256);
}

/// @title HedgedLens
/// @notice HyperEVM. Reads everything about a hedged vault in one call, for the site and the bot. It
/// holds nothing and decides nothing, and can be replaced at any time; the vault does not know it.
contract HedgedLens {
    /// @dev Must match PoolLib.PRICE_GAP_BPS.
    uint256 internal constant PRICE_GAP_BPS = 100;

    function state(address vault) external view returns (State memory s) {
        IHedgedVaultRead v = IHedgedVaultRead(vault);
        Config memory c = v.config();
        uint128 liquidity;
        (s.lower, s.upper, liquidity) = v.position();
        (s.poolSqrtPriceX96, s.poolTick,,,,,) = IV3Pool(c.pool).slot0();
        s.oraclePx = CoreLib.oraclePx(c.perp);
        s.totalValue = v.totalValue();
        s.totalSupply = v.totalSupply();
        s.idleAsset = IERC20(c.asset).balanceOf(vault);
        s.idleUsdc = IERC20(c.usdc).balanceOf(vault);
        s.perpValue = CoreLib.accountValue(vault);
        s.spotUsdc = CoreLib.spotUsdc(vault);
        s.shortSz = CoreLib.positionSz(vault, c.perp);
        s.owedTotal = v.owedTotal();

        uint256 scale = 10 ** (18 - c.szDecimals);
        uint256 atOracle;
        if (liquidity > 0) {
            uint160 lo = TickMath.getSqrtPriceAtTick(s.lower);
            uint160 hi = TickMath.getSqrtPriceAtTick(s.upper);
            (s.positionAsset, s.positionUsdc) = LiquidityMath.amountsForLiquidity(s.poolSqrtPriceX96, lo, hi, liquidity);
            (atOracle,) = LiquidityMath.amountsForLiquidity(
                uint160(Math.sqrt(Math.mulDiv(s.oraclePx, 1 << 192, scale))), lo, hi, liquidity
            );
        }
        s.targetSz = (atOracle + s.idleAsset) * 10 ** c.szDecimals / 1e18;
        if (s.shortSz < 0 && s.perpValue > 0) {
            s.marginBpsNow = uint256(s.perpValue) * 10_000 / (uint256(-s.shortSz) * s.oraclePx);
        }
        uint256 poolRaw = LiquidityMath.quote0In1(scale, s.poolSqrtPriceX96);
        uint256 gap = poolRaw > s.oraclePx ? poolRaw - s.oraclePx : s.oraclePx - poolRaw;
        s.priceInLine = gap * 10_000 <= s.oraclePx * PRICE_GAP_BPS;
    }
}
