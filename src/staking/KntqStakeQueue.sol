// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {StakeSalt} from "./KntqStakeBridge.sol";

/// @notice The parts of Elysium's token bridge router this file uses.
interface IL2Router {
    /// @dev Burns `amount` of the Elysium token from msg.sender (no approval needed) and releases it to `to`
    /// on HyperEVM once the withdrawal is confirmed (about a day).
    function outboundTransfer(address l1Token, address to, uint256 amount, bytes calldata data)
        external
        payable
        returns (bytes memory);

    /// @dev The Elysium address of a HyperEVM token bridged through the standard gateway.
    function calculateL2TokenAddress(address l1Token) external view returns (address);
}

/// @title StakeBox
/// @notice Elysium. One batch's address on Elysium (a minimal clone per batch). Whatever arrives here from
/// HyperEVM belongs to that batch; only the queue can take it out, and only to share it among the batch.
contract StakeBox {
    using SafeERC20 for IERC20;

    address public immutable queue;

    error NotQueue();

    constructor() {
        queue = msg.sender;
    }

    function sweep(IERC20 token) external returns (uint256 amount) {
        if (msg.sender != queue) revert NotQueue();
        amount = token.balanceOf(address(this));
        if (amount > 0) token.safeTransfer(msg.sender, amount);
    }
}

/// @title KntqStakeQueue
/// @notice Elysium. Stake KNTQ without leaving Elysium, and unstake back to KNTQ.
///
///   staking    `deposit` KNTQ. Deposits collect in a batch; `sendDeposits` sends the batch over the bridge to
///              its agent on HyperEVM (about a day), where it is staked and the liquidKNTQ is bridged back to
///              the batch's box (minutes). `claim` hands each depositor their share of it.
///   unstaking  `requestExit` with liquidKNTQ. Exits collect in a batch; `sendExits` sends it to its agent
///              (about a day), which opens Kinetiq's 7-day withdrawal and then bridges the KNTQ back. `claim`
///              hands each person their share of it.
///
/// See KntqStakeBridge.sol for why no message between the chains is needed.
///
/// - Until a batch is sent, anyone in it can take their tokens back out (`cancelDeposit`, `cancelExit`).
/// - A batch is shared out by what each account put in. Tokens can arrive in more than one piece; `claim` pays
///   whatever has arrived so far and can be called again.
/// - If the vault on HyperEVM will not take a deposit batch, the KNTQ comes back instead and is shared out the
///   same way.
/// - Sending, collecting and claiming are open to anyone (a claim always pays the account it is for), so a bot
///   can do all of it and people only ever make one transaction.
/// - The owner can pause new deposits and name a keeper, who may send a batch smaller than the minimum.
///   Nothing else: the owner cannot touch anyone's tokens, and exits and claims cannot be paused.
/// @dev Unaudited.
contract KntqStakeQueue is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Math for uint256;

    uint8 public constant DEPOSIT = StakeSalt.DEPOSIT;
    uint8 public constant EXIT = StakeSalt.EXIT;

    /// @notice KNTQ on Elysium, and its HyperEVM counterpart.
    IERC20 public immutable kntq;
    address public immutable kntqL1;
    /// @notice liquidKNTQ as bridged to Elysium (the token exists from the first batch's return on), and the
    /// vault on HyperEVM it is a share of.
    IERC20 public immutable share;
    address public immutable shareL1;
    IL2Router public immutable router;
    /// @notice HyperEVM: the factory that creates batch agents, and the contract they are clones of.
    address public immutable agentFactory;
    address public immutable agentImpl;
    /// @notice The contract batch boxes are clones of.
    address public immutable boxImpl;
    /// @notice Smallest batch anyone may send: KNTQ for deposits, liquidKNTQ for exits. Every batch needs
    /// several transactions on HyperEVM, so dust is not worth sending. The keeper and the owner may send less.
    uint256 public immutable minDeposits;
    uint256 public immutable minExits;

    address public keeper;
    bool public depositsPaused;

    struct Batch {
        uint256 total; // what the batch's members put in (KNTQ for deposits, liquidKNTQ for exits)
        uint64 sentAt; // 0 while the batch is still open
        uint256 received; // what has come back so far: liquidKNTQ for deposits, KNTQ for exits
        uint256 returned; // the same token that went out, if any came back unprocessed
    }

    mapping(uint8 kind => mapping(uint256 id => Batch)) private _batches;
    /// @notice The batch of each kind that is still open (collecting).
    mapping(uint8 kind => uint256) public openBatch;
    mapping(uint8 kind => mapping(uint256 id => mapping(address => uint256))) public amountOf;
    mapping(uint8 kind => mapping(uint256 id => mapping(address => uint256))) public claimedReceived;
    mapping(uint8 kind => mapping(uint256 id => mapping(address => uint256))) public claimedReturned;

    event Joined(uint8 indexed kind, uint256 indexed id, address indexed account, uint256 amount);
    event Cancelled(uint8 indexed kind, uint256 indexed id, address indexed account, uint256 amount);
    event Sent(uint8 indexed kind, uint256 indexed id, uint256 total, address agent, address box);
    event Collected(uint8 indexed kind, uint256 indexed id, uint256 received, uint256 returned);
    event Claimed(uint8 indexed kind, uint256 indexed id, address indexed account, uint256 received, uint256 returned);
    event KeeperSet(address keeper);
    event DepositsPausedSet(bool paused);

    error ZeroAddress();
    error ZeroAmount();
    error BadKind();
    error DepositsArePaused();
    error NothingToSend();
    error BelowMinimum(uint256 total, uint256 minimum);
    error NotSent();

    struct Params {
        address owner;
        IERC20 kntq;
        address kntqL1;
        address shareL1; // the KntqVault (liquidKNTQ) on HyperEVM
        IL2Router router;
        address agentFactory;
        address agentImpl;
        uint256 minDeposits;
        uint256 minExits;
    }

    constructor(Params memory p) Ownable(p.owner) {
        if (
            address(p.kntq) == address(0) || p.kntqL1 == address(0) || p.shareL1 == address(0)
                || address(p.router) == address(0) || p.agentFactory == address(0) || p.agentImpl == address(0)
        ) revert ZeroAddress();
        kntq = p.kntq;
        kntqL1 = p.kntqL1;
        shareL1 = p.shareL1;
        share = IERC20(p.router.calculateL2TokenAddress(p.shareL1));
        router = p.router;
        agentFactory = p.agentFactory;
        agentImpl = p.agentImpl;
        boxImpl = address(new StakeBox());
        minDeposits = p.minDeposits;
        minExits = p.minExits;
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function batch(uint8 kind, uint256 id) external view returns (Batch memory) {
        return _batches[kind][id];
    }

    /// @notice A batch's box on Elysium (it may not have been created yet; tokens can arrive before it is).
    function boxOf(uint8 kind, uint256 id) public view returns (address) {
        return Clones.predictDeterministicAddress(boxImpl, StakeSalt.box(kind, id), address(this));
    }

    /// @notice A batch's agent on HyperEVM.
    function agentOf(uint8 kind, uint256 id) public view returns (address) {
        return Clones.predictDeterministicAddress(agentImpl, StakeSalt.agent(kind, id, boxOf(kind, id)), agentFactory);
    }

    /// @notice What `claim` would pay `account` right now, counting what has reached the box but has not been
    /// collected yet. `received`: liquidKNTQ for a deposit batch, KNTQ for an exit batch. `returned`: the
    /// token that went out, if any came back.
    function claimable(uint8 kind, uint256 id, address account) external view returns (uint256 received, uint256 returned) {
        Batch memory b = _batches[kind][id];
        uint256 mine = amountOf[kind][id][account];
        if (b.sentAt == 0 || mine == 0) return (0, 0);
        address box = boxOf(kind, id);
        (IERC20 main, IERC20 back) = _tokens(kind);
        received = (b.received + _balance(main, box)).mulDiv(mine, b.total) - claimedReceived[kind][id][account];
        returned = (b.returned + _balance(back, box)).mulDiv(mine, b.total) - claimedReturned[kind][id][account];
    }

    // ---------------------------------------------------------------------
    // Staking: KNTQ in
    // ---------------------------------------------------------------------

    /// @notice Adds `amount` of the caller's KNTQ to the open deposit batch, in `receiver`'s name.
    function deposit(uint256 amount, address receiver) external nonReentrant returns (uint256 id) {
        if (depositsPaused) revert DepositsArePaused();
        id = _join(DEPOSIT, kntq, amount, receiver);
    }

    /// @notice Takes `amount` of the caller's KNTQ back out of the open deposit batch.
    function cancelDeposit(uint256 amount) external nonReentrant {
        _cancel(DEPOSIT, kntq, amount);
    }

    /// @notice Sends the open deposit batch over the bridge to be staked. The next deposit starts a new batch.
    function sendDeposits() external nonReentrant returns (uint256 id) {
        id = _send(DEPOSIT, kntqL1, minDeposits);
    }

    // ---------------------------------------------------------------------
    // Unstaking: liquidKNTQ in
    // ---------------------------------------------------------------------

    /// @notice Adds `shares` of the caller's liquidKNTQ to the open exit batch, in `receiver`'s name.
    function requestExit(uint256 shares, address receiver) external nonReentrant returns (uint256 id) {
        id = _join(EXIT, share, shares, receiver);
    }

    /// @notice Takes `shares` of the caller's liquidKNTQ back out of the open exit batch.
    function cancelExit(uint256 shares) external nonReentrant {
        _cancel(EXIT, share, shares);
    }

    /// @notice Sends the open exit batch over the bridge to be unstaked. The next request starts a new batch.
    function sendExits() external nonReentrant returns (uint256 id) {
        id = _send(EXIT, shareL1, minExits);
    }

    // ---------------------------------------------------------------------
    // What comes back
    // ---------------------------------------------------------------------

    /// @notice Moves whatever has arrived in a sent batch's box into the queue, to be claimed.
    function collect(uint8 kind, uint256 id) external nonReentrant returns (uint256 received, uint256 returned) {
        if (_batches[kind][id].sentAt == 0) revert NotSent();
        return _collect(kind, id);
    }

    /// @notice Pays `account` its share of what a batch has brought back so far. Anyone may call it; the tokens
    /// go to `account`. Call it again if more arrives later.
    function claim(uint8 kind, uint256 id, address account) external nonReentrant returns (uint256 received, uint256 returned) {
        Batch storage b = _batches[kind][id];
        if (b.sentAt == 0) revert NotSent();
        _collect(kind, id);
        uint256 mine = amountOf[kind][id][account];
        if (mine == 0) return (0, 0);
        (IERC20 main, IERC20 back) = _tokens(kind);
        received = b.received.mulDiv(mine, b.total) - claimedReceived[kind][id][account];
        returned = b.returned.mulDiv(mine, b.total) - claimedReturned[kind][id][account];
        if (received > 0) {
            claimedReceived[kind][id][account] += received;
            main.safeTransfer(account, received);
        }
        if (returned > 0) {
            claimedReturned[kind][id][account] += returned;
            back.safeTransfer(account, returned);
        }
        if (received > 0 || returned > 0) emit Claimed(kind, id, account, received, returned);
    }

    // ---------------------------------------------------------------------
    // Owner
    // ---------------------------------------------------------------------

    function setKeeper(address keeper_) external onlyOwner {
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    function setDepositsPaused(bool paused) external onlyOwner {
        depositsPaused = paused;
        emit DepositsPausedSet(paused);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    /// @dev What a batch of `kind` gets back (`main`) and what it sent out (`back`).
    function _tokens(uint8 kind) private view returns (IERC20 main, IERC20 back) {
        if (kind == DEPOSIT) return (share, kntq);
        if (kind == EXIT) return (kntq, share);
        revert BadKind();
    }

    /// @dev A token balance that reads as zero while the token contract does not exist yet (liquidKNTQ on
    /// Elysium is created by the bridge when the first batch comes back).
    function _balance(IERC20 token, address who) private view returns (uint256) {
        return address(token).code.length == 0 ? 0 : token.balanceOf(who);
    }

    function _join(uint8 kind, IERC20 token, uint256 amount, address receiver) private returns (uint256 id) {
        if (amount == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        id = openBatch[kind];
        token.safeTransferFrom(msg.sender, address(this), amount);
        amountOf[kind][id][receiver] += amount;
        _batches[kind][id].total += amount;
        emit Joined(kind, id, receiver, amount);
    }

    function _cancel(uint8 kind, IERC20 token, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        uint256 id = openBatch[kind];
        amountOf[kind][id][msg.sender] -= amount; // reverts if the caller has less in the open batch
        _batches[kind][id].total -= amount;
        token.safeTransfer(msg.sender, amount);
        emit Cancelled(kind, id, msg.sender, amount);
    }

    function _send(uint8 kind, address l1Token, uint256 minimum) private returns (uint256 id) {
        id = openBatch[kind];
        Batch storage b = _batches[kind][id];
        uint256 total = b.total;
        if (total == 0) revert NothingToSend();
        if (total < minimum && msg.sender != keeper && msg.sender != owner()) revert BelowMinimum(total, minimum);
        b.sentAt = uint64(block.timestamp);
        openBatch[kind] = id + 1;
        address agent = agentOf(kind, id);
        router.outboundTransfer(l1Token, agent, total, "");
        emit Sent(kind, id, total, agent, boxOf(kind, id));
    }

    function _collect(uint8 kind, uint256 id) private returns (uint256 received, uint256 returned) {
        (IERC20 main, IERC20 back) = _tokens(kind);
        address box = boxOf(kind, id);
        if (_balance(main, box) == 0 && _balance(back, box) == 0) return (0, 0);
        if (box.code.length == 0) Clones.cloneDeterministic(boxImpl, StakeSalt.box(kind, id));
        Batch storage b = _batches[kind][id];
        if (address(main).code.length != 0) received = StakeBox(box).sweep(main);
        if (address(back).code.length != 0) returned = StakeBox(box).sweep(back);
        b.received += received;
        b.returned += returned;
        emit Collected(kind, id, received, returned);
    }
}
