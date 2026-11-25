// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ISkntq} from "../interfaces/ISkntq.sol";
import {IL1GatewayRouter} from "../interfaces/IArbitrumGateway.sol";
import {KntqVault} from "./KntqVault.sol";

// Staking KNTQ from Elysium, where sKNTQ does not exist.
//
// People on Elysium hand KNTQ to the queue (KntqStakeQueue.sol). It travels in batches over the canonical bridge,
// is staked on HyperEVM, and the liquidKNTQ comes back over the same bridge. Leaving runs the other way.
//
// No message is ever sent between the chains, only tokens. What makes that enough is that every batch has its own
// address on each side:
//
//   on HyperEVM, an "agent"  the batch's tokens are sent to it; it stakes (or unstakes) and sends the result home
//   on Elysium, a "box"      the result arrives in it; the queue empties it and shares it out among the batch
//
// Both addresses are worked out from the batch's number alone (CREATE2), so the queue knows the agent's address
// before the agent exists, and the agent's home address is part of what its own address is derived from. Whatever
// tokens sit at a batch's address belong to that batch. Nothing has to be reported, trusted or signed, and a token
// sent to one of these addresses by mistake simply becomes a gift to that batch.

/// @dev How the two sides derive a batch's addresses. Both must use exactly this.
library StakeSalt {
    uint8 internal constant DEPOSIT = 1;
    uint8 internal constant EXIT = 2;

    /// @dev Salt of a batch's box on Elysium (a clone made by the queue).
    function box(uint8 kind, uint256 id) internal pure returns (bytes32) {
        return keccak256(abi.encode(kind, id));
    }

    /// @dev Salt of a batch's agent on HyperEVM (a clone made by the factory). It contains the box's address, so
    /// an agent can only ever send home to the box it was derived from.
    function agent(uint8 kind, uint256 id, address l2Box) internal pure returns (bytes32) {
        return keccak256(abi.encode(kind, id, l2Box));
    }
}

/// @title KntqStakeAgent
/// @notice HyperEVM. One batch's address on HyperEVM (a minimal clone of this contract per batch).
///
///   a deposit batch  KNTQ arrives from Elysium; `stake` stakes it in the vault and bridges the liquidKNTQ to
///                    the batch's box. If the vault will not take it (cap reached, deposits paused), the KNTQ
///                    itself is bridged back instead, so a batch can never be left stranded here.
///   an exit batch    liquidKNTQ arrives from Elysium; `startExit` turns it into sKNTQ and opens Kinetiq's
///                    7-day withdrawal; `finishExit` collects the KNTQ after that and bridges it to the box.
///
/// @dev No owner. Every step is permissionless: whoever calls pays the bridge fee, and the tokens can only go
/// to this batch's own box. Gas floors stop a caller from making the bridge ticket fail on purpose; a ticket that
/// still fails to run by itself can be redeemed by anyone on Elysium for 7 days.
contract KntqStakeAgent is ReentrancyGuard {
    using SafeERC20 for IERC20;

    KntqVault public immutable vault; // liquidKNTQ
    ISkntq public immutable skntq;
    IERC20 public immutable kntq;
    IL1GatewayRouter public immutable router;
    address public immutable factory;
    uint256 public immutable minGas;
    uint256 public immutable minGasPrice;

    /// @notice What this batch is (StakeSalt.DEPOSIT or EXIT), its number, and its box on Elysium. Set once.
    uint8 public kind;
    uint256 public id;
    address public l2Box;

    event Staked(uint256 kntqIn, uint256 sharesHome);
    event Returned(uint256 kntqHome);
    event ExitStarted(uint256 indexed requestId, uint256 skntqOut, uint256 kntqDue);
    event ExitFinished(uint256 kntqHome);

    error NotFactory();
    error AlreadySet();
    error BadBatch();
    error WrongKind();
    error NothingHere();
    error GasTooLow();

    constructor(KntqVault vault_, IL1GatewayRouter router_, uint256 minGas_, uint256 minGasPrice_) {
        vault = vault_;
        skntq = ISkntq(vault_.asset());
        kntq = IERC20(ISkntq(vault_.asset()).asset());
        router = router_;
        factory = msg.sender;
        minGas = minGas_;
        minGasPrice = minGasPrice_;
    }

    function init(uint8 kind_, uint256 id_, address l2Box_) external {
        if (msg.sender != factory) revert NotFactory();
        if (kind != 0) revert AlreadySet();
        if ((kind_ != StakeSalt.DEPOSIT && kind_ != StakeSalt.EXIT) || l2Box_ == address(0)) revert BadBatch();
        kind = kind_;
        id = id_;
        l2Box = l2Box_;
    }

    /// @notice A deposit batch: stakes all KNTQ held here and bridges the liquidKNTQ to the batch's box. If the
    /// vault refuses the deposit, bridges the KNTQ back instead.
    /// @return staked true when liquidKNTQ went home, false when the KNTQ itself did
    function stake(uint256 maxGas, uint256 gasPriceBid, uint256 maxSubmissionCost)
        external
        payable
        nonReentrant
        returns (bool staked, uint256 sent)
    {
        if (kind != StakeSalt.DEPOSIT) revert WrongKind();
        uint256 amount = kntq.balanceOf(address(this));
        if (amount == 0) revert NothingHere();
        kntq.forceApprove(address(vault), amount);
        try vault.depositKntq(amount, address(this)) {
            staked = true;
            sent = IERC20(address(vault)).balanceOf(address(this));
            _home(IERC20(address(vault)), sent, maxGas, gasPriceBid, maxSubmissionCost);
            emit Staked(amount, sent);
        } catch {
            kntq.forceApprove(address(vault), 0);
            sent = amount;
            _home(kntq, amount, maxGas, gasPriceBid, maxSubmissionCost);
            emit Returned(amount);
        }
    }

    /// @notice An exit batch, first step: turns all liquidKNTQ held here into sKNTQ and opens Kinetiq's
    /// withdrawal for it. The KNTQ can be collected with `finishExit` once sKNTQ's delay (7 days) has passed.
    function startExit() external nonReentrant returns (uint256 requestId, uint256 kntqDue) {
        if (kind != StakeSalt.EXIT) revert WrongKind();
        uint256 shares = IERC20(address(vault)).balanceOf(address(this));
        if (shares > 0) vault.redeem(shares, address(this), address(this));
        uint256 staked = IERC20(address(skntq)).balanceOf(address(this));
        if (staked == 0) revert NothingHere();
        kntqDue = skntq.redeem(staked, address(this), address(this));
        requestId = skntq.nextWithdrawalRequestId(address(this)) - 1;
        emit ExitStarted(requestId, staked, kntqDue);
    }

    /// @notice An exit batch, second step: collects the given matured withdrawals and bridges all KNTQ held
    /// here to the batch's box. Reverts while a request has not matured.
    function finishExit(uint256[] calldata requestIds, uint256 maxGas, uint256 gasPriceBid, uint256 maxSubmissionCost)
        external
        payable
        nonReentrant
        returns (uint256 amount)
    {
        if (kind != StakeSalt.EXIT) revert WrongKind();
        for (uint256 i; i < requestIds.length; ++i) {
            skntq.confirmWithdrawal(address(this), requestIds[i]);
        }
        amount = kntq.balanceOf(address(this));
        if (amount == 0) revert NothingHere();
        _home(kntq, amount, maxGas, gasPriceBid, maxSubmissionCost);
        emit ExitFinished(amount);
    }

    /// @dev Bridges `amount` of `token` to this batch's box on Elysium. The caller pays the bridge fee in
    /// msg.value; what is not used is refunded to the caller on Elysium.
    function _home(IERC20 token, uint256 amount, uint256 maxGas, uint256 gasPriceBid, uint256 maxSubmissionCost) private {
        if (maxGas < minGas || gasPriceBid < minGasPrice) revert GasTooLow();
        token.forceApprove(router.getGateway(address(token)), amount);
        router.outboundTransferCustomRefund{value: msg.value}(
            address(token), msg.sender, l2Box, amount, maxGas, gasPriceBid, abi.encode(maxSubmissionCost, bytes(""))
        );
    }
}

/// @title KntqAgentFactory
/// @notice HyperEVM. Creates a batch's agent at the address the Elysium queue already sent its tokens to.
/// @dev No owner. Anyone may open any batch's agent; its address is fixed by (kind, id, box), so opening one
/// with made-up values only creates an agent nothing was ever sent to.
contract KntqAgentFactory {
    address public immutable agentImpl;

    event AgentOpened(uint8 indexed kind, uint256 indexed id, address l2Box, address agent);

    constructor(KntqVault vault, IL1GatewayRouter router, uint256 minGas, uint256 minGasPrice) {
        agentImpl = address(new KntqStakeAgent(vault, router, minGas, minGasPrice));
    }

    function agentFor(uint8 kind, uint256 id, address l2Box) public view returns (address) {
        return Clones.predictDeterministicAddress(agentImpl, StakeSalt.agent(kind, id, l2Box), address(this));
    }

    /// @notice Creates the agent if it does not exist yet. Returns its address either way.
    function open(uint8 kind, uint256 id, address l2Box) external returns (address agent) {
        agent = agentFor(kind, id, l2Box);
        if (agent.code.length == 0) {
            Clones.cloneDeterministic(agentImpl, StakeSalt.agent(kind, id, l2Box));
            KntqStakeAgent(agent).init(kind, id, l2Box);
            emit AgentOpened(kind, id, l2Box, agent);
        }
    }
}
