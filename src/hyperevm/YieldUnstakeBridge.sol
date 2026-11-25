// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ISkntq} from "../interfaces/ISkntq.sol";
import {IL1GatewayRouter} from "../interfaces/IArbitrumGateway.sol";

/// @title YieldUnstakeBridge
/// @notice HyperEVM. The HyperEVM reserve's yield router. Receives sKNTQ yield,
/// unstakes it (7-day withdrawal), and bridges the KNTQ to the YieldRouter on
/// Elysium, where it runs through the normal waterfall.
///
///   harvest (reserve) -> requestUnstake -> 7 days -> confirm -> bridge (minutes)
///
/// @dev No owner. The Elysium recipient is set once by the deployer (the
/// YieldRouter is deployed after this contract), then fixed forever. All other
/// steps are permissionless. `bridge` enforces gas floors so a caller can't make
/// the bridge ticket fail on purpose; a ticket that still fails to auto-execute
/// (e.g. an Elysium gas spike) can be redeemed by anyone on Elysium for 7 days.
contract YieldUnstakeBridge is ReentrancyGuard {
    using SafeERC20 for IERC20;

    ISkntq public immutable vault; // sKNTQ
    IERC20 public immutable asset; // KNTQ
    IL1GatewayRouter public immutable gatewayRouter;
    address public immutable setter;
    uint256 public immutable minGas;
    uint256 public immutable minGasPrice;

    /// @notice Elysium YieldRouter. Set once.
    address public l2Recipient;

    event L2RecipientSet(address indexed l2Recipient);
    event UnstakeRequested(uint256 indexed requestId, uint256 shares, uint256 assets);
    event UnstakeConfirmed(uint256 indexed requestId, uint256 assets);
    event Bridged(uint256 amount, address indexed l2Recipient);

    error ZeroAddress();
    error NotSetter();
    error AlreadySet();
    error RecipientNotSet();
    error NothingToUnstake();
    error NothingToBridge();
    error GasTooLow();

    constructor(ISkntq vault_, IL1GatewayRouter gatewayRouter_, address setter_, uint256 minGas_, uint256 minGasPrice_) {
        if (address(vault_) == address(0) || address(gatewayRouter_) == address(0) || setter_ == address(0)) {
            revert ZeroAddress();
        }
        vault = vault_;
        asset = IERC20(vault_.asset());
        gatewayRouter = gatewayRouter_;
        setter = setter_;
        minGas = minGas_;
        minGasPrice = minGasPrice_;
    }

    function setL2Recipient(address l2Recipient_) external {
        if (msg.sender != setter) revert NotSetter();
        if (l2Recipient != address(0)) revert AlreadySet();
        if (l2Recipient_ == address(0)) revert ZeroAddress();
        l2Recipient = l2Recipient_;
        emit L2RecipientSet(l2Recipient_);
    }

    /// @notice Starts unstaking all sKNTQ held here.
    /// @return requestId the vault's withdrawal request id (confirm after 7 days)
    function requestUnstake() external nonReentrant returns (uint256 requestId, uint256 assets) {
        uint256 shares = IERC20(address(vault)).balanceOf(address(this));
        if (shares == 0) revert NothingToUnstake();
        assets = vault.redeem(shares, address(this), address(this));
        requestId = vault.nextWithdrawalRequestId(address(this)) - 1;
        emit UnstakeRequested(requestId, shares, assets);
    }

    /// @notice Collects a matured withdrawal request (KNTQ arrives here).
    function confirm(uint256 requestId) external nonReentrant returns (uint256 assets) {
        (assets,) = vault.confirmWithdrawal(address(this), requestId);
        emit UnstakeConfirmed(requestId, assets);
    }

    /// @notice Bridges all KNTQ held here to the Elysium YieldRouter. The caller
    /// pays the bridge fee in msg.value; unused fee is refunded to the caller on Elysium.
    function bridge(uint256 maxGas, uint256 gasPriceBid, uint256 maxSubmissionCost)
        external
        payable
        nonReentrant
        returns (uint256 amount)
    {
        address to = l2Recipient;
        if (to == address(0)) revert RecipientNotSet();
        if (maxGas < minGas || gasPriceBid < minGasPrice) revert GasTooLow();
        amount = asset.balanceOf(address(this));
        if (amount == 0) revert NothingToBridge();

        asset.forceApprove(gatewayRouter.getGateway(address(asset)), amount);
        gatewayRouter.outboundTransferCustomRefund{value: msg.value}(
            address(asset), msg.sender, to, amount, maxGas, gasPriceBid, abi.encode(maxSubmissionCost, bytes(""))
        );
        emit Bridged(amount, to);
    }
}
