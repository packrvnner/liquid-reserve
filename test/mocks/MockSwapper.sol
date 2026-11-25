// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapper} from "../../src/interfaces/ISwapper.sol";
import {MockOracle} from "./MockOracle.sol";
import {MockERC20} from "./MockERC20.sol";

/// @notice Swaps at the oracle price minus `haircutBps`. With `ignoreMinOut`
/// it behaves like a broken/malicious adapter that underpays silently.
contract MockSwapper is ISwapper {
    MockOracle public immutable oracle;
    uint256 public haircutBps;
    bool public ignoreMinOut;

    constructor(MockOracle oracle_) {
        oracle = oracle_;
    }

    function setHaircutBps(uint256 bps) external {
        haircutBps = bps;
    }

    function setIgnoreMinOut(bool v) external {
        ignoreMinOut = v;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient)
        external
        returns (uint256 amountOut)
    {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        amountOut = oracle.quote(tokenIn, tokenOut, amountIn) * (10_000 - haircutBps) / 10_000;
        if (!ignoreMinOut) require(amountOut >= minOut, "MockSwapper: slippage");
        MockERC20(tokenOut).mint(recipient, amountOut);
        if (ignoreMinOut) return minOut; // lies about the amount
    }
}
