// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Manipulation-resistant price source (e.g. a TWAP). Used only to set
/// a minimum output on swaps, so a sandwich attacker can't take more than the
/// configured slippage.
interface IPriceOracle {
    /// @return amountOut expected `tokenOut` for `amountIn` of `tokenIn`
    function quote(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256 amountOut);
}
