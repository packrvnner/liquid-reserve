// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @notice Concentrated-liquidity conversions between token amounts and liquidity.
library LiquidityMath {
    uint256 internal constant Q96 = 1 << 96;

    function liquidityFor0(uint160 a, uint160 b, uint256 amount0) internal pure returns (uint128) {
        if (a > b) (a, b) = (b, a);
        uint256 intermediate = FullMath.mulDiv(a, b, Q96);
        return SafeCast.toUint128(FullMath.mulDiv(amount0, intermediate, b - a));
    }

    function liquidityFor1(uint160 a, uint160 b, uint256 amount1) internal pure returns (uint128) {
        if (a > b) (a, b) = (b, a);
        return SafeCast.toUint128(FullMath.mulDiv(amount1, Q96, b - a));
    }

    /// @notice Most liquidity that `amount0`/`amount1` can fund in range [a, b] at price p.
    function liquidityForAmounts(uint160 p, uint160 a, uint160 b, uint256 amount0, uint256 amount1)
        internal
        pure
        returns (uint128)
    {
        if (a > b) (a, b) = (b, a);
        if (p <= a) return liquidityFor0(a, b, amount0);
        if (p >= b) return liquidityFor1(a, b, amount1);
        uint128 l0 = liquidityFor0(p, b, amount0);
        uint128 l1 = liquidityFor1(a, p, amount1);
        return l0 < l1 ? l0 : l1;
    }

    /// @notice Token amounts held by `liquidity` in range [a, b] at price p (rounded down).
    function amountsForLiquidity(uint160 p, uint160 a, uint160 b, uint128 liquidity)
        internal
        pure
        returns (uint256 amount0, uint256 amount1)
    {
        if (a > b) (a, b) = (b, a);
        if (p <= a) {
            amount0 = SqrtPriceMath.getAmount0Delta(a, b, liquidity, false);
        } else if (p < b) {
            amount0 = SqrtPriceMath.getAmount0Delta(p, b, liquidity, false);
            amount1 = SqrtPriceMath.getAmount1Delta(a, p, liquidity, false);
        } else {
            amount1 = SqrtPriceMath.getAmount1Delta(a, b, liquidity, false);
        }
    }

    /// @notice Value of `amount0` in token1 at sqrt price `p` (Q64.96).
    function quote0In1(uint256 amount0, uint160 p) internal pure returns (uint256) {
        if (p <= type(uint128).max) return FullMath.mulDiv(amount0, uint256(p) * p, 1 << 192);
        return FullMath.mulDiv(amount0, FullMath.mulDiv(p, p, 1 << 64), 1 << 128);
    }
}
