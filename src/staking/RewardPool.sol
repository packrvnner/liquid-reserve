// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title RewardPool
/// @notice Deposit one token, earn another. Used for the boost paid in $liquid to people who stake with Liquid
/// Reserve: they deposit their staking token (liquidHYPE, liquidKNTQ, a vault's shares) here, earn $liquid for
/// as long as it stays, and can take it out again at any time.
///
/// Rewards are paid pro-rata to what is deposited and streamed over 7-day periods. Why streamed and queued:
/// - Streaming means depositing just before rewards arrive and leaving right after earns almost nothing.
/// - New rewards wait in a queue until the current period ends, so nobody can stretch or reset a running
///   period by sending dust.
/// - Rewards that would stream while nothing is deposited go back to the queue instead of being stuck.
/// @dev No owner; nothing here can be changed. Anyone can add rewards. Deposits and rewards are tracked
/// separately and balanceOf(this) is never used for accounting, so the two tokens may even be the same one.
/// The logic is LiquidReserveStaking's, with the deposited token and the reward token made separate.
contract RewardPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant DURATION = 7 days;
    uint256 private constant ONE = 1e18;

    /// @notice The token people deposit.
    IERC20 public immutable stakeToken;
    /// @notice The token they earn.
    IERC20 public immutable rewardToken;

    uint256 public totalStaked;
    mapping(address account => uint256) public balanceOf;

    /// @notice Rewards received but not yet streaming.
    uint256 public queuedRewards;
    uint256 public rewardRate;
    uint256 public periodFinish;
    uint256 public lastUpdate;
    uint256 public rewardPerTokenStored;
    mapping(address account => uint256) public userRewardPerTokenPaid;
    mapping(address account => uint256) public rewards;

    event Staked(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event RewardPaid(address indexed account, uint256 amount);
    event RewardQueued(address indexed from, uint256 amount);
    event PeriodStarted(uint256 rewardRate, uint256 periodFinish);

    error ZeroAddress();
    error ZeroAmount();
    error InsufficientStake();

    constructor(IERC20 stakeToken_, IERC20 rewardToken_) {
        if (address(stakeToken_) == address(0) || address(rewardToken_) == address(0)) revert ZeroAddress();
        stakeToken = stakeToken_;
        rewardToken = rewardToken_;
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerToken() public view returns (uint256) {
        if (totalStaked == 0) return rewardPerTokenStored;
        return rewardPerTokenStored + (lastTimeRewardApplicable() - lastUpdate) * rewardRate * ONE / totalStaked;
    }

    function earned(address account) public view returns (uint256) {
        return balanceOf[account] * (rewardPerToken() - userRewardPerTokenPaid[account]) / ONE + rewards[account];
    }

    // ---------------------------------------------------------------------
    // Actions
    // ---------------------------------------------------------------------

    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _update(msg.sender);
        uint256 before = stakeToken.balanceOf(address(this));
        stakeToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = stakeToken.balanceOf(address(this)) - before;
        balanceOf[msg.sender] += received;
        totalStaked += received;
        _maybeStartPeriod();
        emit Staked(msg.sender, received);
    }

    function withdraw(uint256 amount) public nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (amount > balanceOf[msg.sender]) revert InsufficientStake();
        _update(msg.sender);
        balanceOf[msg.sender] -= amount;
        totalStaked -= amount;
        _maybeStartPeriod();
        stakeToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function claim() public nonReentrant returns (uint256 reward) {
        _update(msg.sender);
        _maybeStartPeriod();
        reward = rewards[msg.sender];
        if (reward > 0) {
            rewards[msg.sender] = 0;
            rewardToken.safeTransfer(msg.sender, reward);
            emit RewardPaid(msg.sender, reward);
        }
    }

    function exit() external {
        uint256 bal = balanceOf[msg.sender];
        if (bal > 0) withdraw(bal);
        claim();
    }

    /// @notice Adds rewards. They start streaming when the current period ends (or now, if none is running).
    function notifyRewardAmount(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _update(address(0));
        uint256 before = rewardToken.balanceOf(address(this));
        rewardToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = rewardToken.balanceOf(address(this)) - before;
        queuedRewards += received;
        emit RewardQueued(msg.sender, received);
        _maybeStartPeriod();
    }

    /// @notice Starts the next period if the current one ended and rewards are queued.
    function poke() external nonReentrant {
        _update(address(0));
        _maybeStartPeriod();
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _update(address account) private {
        uint256 applicable = lastTimeRewardApplicable();
        if (totalStaked == 0) {
            // Nobody earned what streamed since the last update: put it back in the queue.
            if (applicable > lastUpdate) queuedRewards += (applicable - lastUpdate) * rewardRate;
        } else {
            rewardPerTokenStored = rewardPerToken();
        }
        lastUpdate = applicable;
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
    }

    function _maybeStartPeriod() private {
        if (block.timestamp < periodFinish || queuedRewards < DURATION) return;
        uint256 rate = queuedRewards / DURATION;
        queuedRewards -= rate * DURATION; // remainder (< DURATION wei) stays queued
        rewardRate = rate;
        lastUpdate = block.timestamp;
        periodFinish = block.timestamp + DURATION;
        emit PeriodStarted(rate, periodFinish);
    }
}
