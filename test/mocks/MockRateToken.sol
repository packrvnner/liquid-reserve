// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MockERC20} from "./MockERC20.sol";
import {IRateProvider} from "../../src/interfaces/IRateProvider.sol";

/// @notice Yield-bearing token that is also its own rate provider (like kHYPE + its accountant).
contract MockRateToken is MockERC20, IRateProvider {
    uint256 public rate = 1e18;

    constructor(string memory name_, string memory symbol_) MockERC20(name_, symbol_, 18) {}

    function setRate(uint256 rate_) external {
        rate = rate_;
    }

    function getRate() external view returns (uint256) {
        return rate;
    }
}
