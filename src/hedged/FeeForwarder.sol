// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IL1GatewayRouter} from "../interfaces/IArbitrumGateway.sol";

/// @title FeeForwarder
/// @notice HyperEVM. The hedged vault's fee recipient. Whatever arrives here can go to one place
/// only: the vault fee splitter on Elysium, through the canonical bridge (about a minute). There the
/// same splitter as for every other vault pays 20% to the creator and 80% to the reserve.
/// @dev No owner; recipient and gas floors are fixed forever. `forward` is permissionless. The gas
/// floors stop a caller from making the bridge ticket fail on purpose; a ticket that still fails to
/// run by itself (an Elysium gas spike) can be redeemed by anyone on Elysium for 7 days.
contract FeeForwarder is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IL1GatewayRouter public immutable gatewayRouter;
    /// @notice The vault fee splitter on Elysium.
    address public immutable l2Recipient;
    uint256 public immutable minGas;
    uint256 public immutable minGasPrice;

    event Forwarded(address indexed token, uint256 amount);

    error ZeroAddress();
    error NothingToForward();
    error GasTooLow();

    constructor(IL1GatewayRouter gatewayRouter_, address l2Recipient_, uint256 minGas_, uint256 minGasPrice_) {
        if (address(gatewayRouter_) == address(0) || l2Recipient_ == address(0)) revert ZeroAddress();
        gatewayRouter = gatewayRouter_;
        l2Recipient = l2Recipient_;
        minGas = minGas_;
        minGasPrice = minGasPrice_;
    }

    /// @notice Bridges everything this contract holds of `token` to the splitter on Elysium. The
    /// caller pays the bridge fee in msg.value; what is not used is refunded to the caller on Elysium.
    function forward(address token, uint256 maxGas, uint256 gasPriceBid, uint256 maxSubmissionCost)
        external
        payable
        nonReentrant
        returns (uint256 amount)
    {
        if (maxGas < minGas || gasPriceBid < minGasPrice) revert GasTooLow();
        amount = IERC20(token).balanceOf(address(this));
        if (amount == 0) revert NothingToForward();
        IERC20(token).forceApprove(gatewayRouter.getGateway(token), amount);
        gatewayRouter.outboundTransferCustomRefund{value: msg.value}(
            token, msg.sender, l2Recipient, amount, maxGas, gasPriceBid, abi.encode(maxSubmissionCost, bytes(""))
        );
        emit Forwarded(token, amount);
    }
}
