// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SwapConfig} from "../SwapConfig.sol";

/// @title GuardedSwap
/// @notice Swap helper shared by the routing contracts. Every swap gets a minimum
/// output from the oracle price minus the configured slippage, and the output
/// actually received by the recipient is measured and checked, so a faulty or
/// malicious swap adapter can't underpay.
abstract contract GuardedSwap {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;

    SwapConfig public immutable swapConfig;

    error ZeroAddress();
    error QuoteZero(address tokenIn, address tokenOut, uint256 amountIn);
    error InsufficientOutput(uint256 received, uint256 minOut);

    constructor(SwapConfig swapConfig_) {
        if (address(swapConfig_) == address(0)) revert ZeroAddress();
        swapConfig = swapConfig_;
    }

    /// @dev Converts `amountIn` of `tokenIn` into `tokenOut` and delivers it to
    /// `recipient`. If the tokens are the same, it just transfers.
    /// @return amountOut amount of `tokenOut` the recipient actually received
    function _swapTo(address tokenIn, address tokenOut, uint256 amountIn, address recipient)
        internal
        returns (uint256 amountOut)
    {
        if (amountIn == 0) return 0;
        if (tokenIn == tokenOut) {
            if (recipient != address(this)) IERC20(tokenIn).safeTransfer(recipient, amountIn);
            return amountIn;
        }

        uint256 expected = swapConfig.oracle().quote(tokenIn, tokenOut, amountIn);
        if (expected == 0) revert QuoteZero(tokenIn, tokenOut, amountIn);
        uint256 minOut = expected * (BPS - swapConfig.maxSlippageBps()) / BPS;

        address swapper = address(swapConfig.swapper());
        uint256 before = IERC20(tokenOut).balanceOf(recipient);
        IERC20(tokenIn).forceApprove(swapper, amountIn);
        // The adapter's return value is ignored on purpose: the amount the recipient
        // actually received is measured below.
        // forge-lint: disable-next-line(unused-return)
        swapConfig.swapper().swap(tokenIn, tokenOut, amountIn, minOut, recipient);
        IERC20(tokenIn).forceApprove(swapper, 0);

        amountOut = IERC20(tokenOut).balanceOf(recipient) - before;
        if (amountOut < minOut) revert InsufficientOutput(amountOut, minOut);
    }
}
