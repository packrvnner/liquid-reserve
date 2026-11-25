// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Exchange rate of a yield-bearing token to its underlying.
interface IRateProvider {
    /// @return rate underlying units per 1e18 units of the token (1e18 means 1:1)
    function getRate() external view returns (uint256 rate);
}
