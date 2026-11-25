// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

/// @notice Kinetiq's staked KNTQ on HyperEVM: an ERC-4626 vault over KNTQ whose
/// `redeem` opens a withdrawal request that pays out after `withdrawalDelay`
/// (7 days). Behavior verified on a HyperEVM fork (2026-11-13).
interface ISkntq is IERC4626 {
    function withdrawalDelay() external view returns (uint256);
    function nextWithdrawalRequestId(address owner) external view returns (uint256);
    function withdrawalRequest(address owner, uint256 id)
        external
        view
        returns (uint256 assets, uint256 shares, uint256 timestamp);
    function confirmWithdrawal(address owner, uint256 id) external returns (uint256 assets, uint256 shares);
}
