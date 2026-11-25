// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IL2GatewayRouter} from "../interfaces/IArbitrumGateway.sol";

/// @title BridgeOut
/// @notice Elysium -> HyperEVM. Holds the allocator's KNTQ bucket and sends it,
/// over the canonical bridge, to a fixed recipient on HyperEVM (StakeAndLock).
/// The withdrawal becomes claimable on HyperEVM after the rollup's challenge
/// period (~1 day); anyone can then execute it from the HyperEVM outbox.
/// @dev No owner. Everything is immutable. `minAmount` stops dust withdrawals,
/// each of which would need its own HyperEVM execution.
contract BridgeOut is ReentrancyGuard {
    IL2GatewayRouter public immutable gatewayRouter;
    IERC20 public immutable token; // Elysium token (e.g. bridged KNTQ)
    address public immutable l1Token; // its HyperEVM counterpart
    address public immutable l1Recipient; // fixed HyperEVM destination
    uint256 public immutable minAmount;

    event Bridged(uint256 amount, address indexed l1Recipient);

    error ZeroAddress();
    error BelowMinimum(uint256 amount, uint256 minAmount);

    constructor(IL2GatewayRouter gatewayRouter_, IERC20 token_, address l1Token_, address l1Recipient_, uint256 minAmount_) {
        if (
            address(gatewayRouter_) == address(0) || address(token_) == address(0) || l1Token_ == address(0)
                || l1Recipient_ == address(0)
        ) revert ZeroAddress();
        gatewayRouter = gatewayRouter_;
        token = token_;
        l1Token = l1Token_;
        l1Recipient = l1Recipient_;
        minAmount = minAmount_;
    }

    function bridge() external nonReentrant returns (uint256 amount) {
        amount = token.balanceOf(address(this));
        if (amount == 0 || amount < minAmount) revert BelowMinimum(amount, minAmount);
        gatewayRouter.outboundTransfer(l1Token, l1Recipient, amount, "");
        emit Bridged(amount, l1Recipient);
    }
}
