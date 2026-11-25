// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Swap adapter (e.g. a Uniswap router wrapper on Elysium).
/// Pulls `amountIn` of `tokenIn` from msg.sender and sends at least `minOut`
/// of `tokenOut` to `recipient`. May route multi-hop or "zap" into a staking token.
interface ISwapper {
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient)
        external
        returns (uint256 amountOut);
}
