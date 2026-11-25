// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title FeeSplitter
/// @notice Immutable two-way splitter. Deployed as:
/// - the FeeRouter (Ascend creator payout recipient): 20% CreatorPayout, 80% InflowAllocator
/// - later, the vault fee router (20% performance fee): same 20/80 split
/// @dev Permissionless `distribute`. No owner; recipients and split are fixed forever.
contract FeeSplitter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;

    address public immutable recipientA;
    address public immutable recipientB;
    /// @notice Share sent to recipientA; recipientB gets the rest.
    uint16 public immutable bpsA;

    event Distributed(address indexed token, uint256 toA, uint256 toB);

    error ZeroAddress();
    error InvalidBps();
    error NothingToDistribute();

    constructor(address recipientA_, uint16 bpsA_, address recipientB_) {
        if (recipientA_ == address(0) || recipientB_ == address(0)) revert ZeroAddress();
        if (bpsA_ == 0 || bpsA_ >= BPS) revert InvalidBps();
        recipientA = recipientA_;
        recipientB = recipientB_;
        bpsA = bpsA_;
    }

    function distribute(address token) external nonReentrant returns (uint256 toA, uint256 toB) {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal == 0) revert NothingToDistribute();
        toA = bal * bpsA / BPS;
        toB = bal - toA;
        IERC20(token).safeTransfer(recipientA, toA);
        IERC20(token).safeTransfer(recipientB, toB);
        emit Distributed(token, toA, toB);
    }
}
