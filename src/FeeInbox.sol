// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title FeeInbox
/// @notice The address given to Ascend as $liquidreserve's creator-fee recipient.
///
/// Ascend fixes the recipient at launch, but most Liquid Reserve contracts need
/// $liquidreserve's address, which only exists after launch. So this inbox is deployed
/// first; fees collect here; after launch the deployer points it at the
/// FeeRouter exactly once. From then on it is fixed forever, and anyone can
/// forward its balance.
contract FeeInbox is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The only address that can set the target, and only once.
    address public immutable setter;
    address public target;

    event TargetSet(address indexed target);
    event Forwarded(address indexed token, uint256 amount);

    error ZeroAddress();
    error NotSetter();
    error TargetAlreadySet();
    error TargetNotSet();
    error NothingToForward();

    constructor(address setter_) {
        if (setter_ == address(0)) revert ZeroAddress();
        setter = setter_;
    }

    function setTarget(address target_) external {
        if (msg.sender != setter) revert NotSetter();
        if (target != address(0)) revert TargetAlreadySet();
        if (target_ == address(0)) revert ZeroAddress();
        target = target_;
        emit TargetSet(target_);
    }

    function forward(address token) external nonReentrant returns (uint256 amount) {
        address to = target;
        if (to == address(0)) revert TargetNotSet();
        amount = IERC20(token).balanceOf(address(this));
        if (amount == 0) revert NothingToForward();
        IERC20(token).safeTransfer(to, amount);
        emit Forwarded(token, amount);
    }
}
