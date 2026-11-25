// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title LiquidReserveStaking (staked $liquid)
/// @notice Stake $liquid, earn $liquid. Rewards (the 10% holder share of reserve yield)
/// are paid pro-rata to stake and streamed over 7-day periods.
///
/// Why streamed and queued:
/// - Streaming means staking just before rewards arrive and leaving right after
///   earns almost nothing, so rewards go to people who actually hold.
/// - New rewards wait in a queue until the current period ends, so nobody can
///   stretch or reset an active period by sending dust.
/// - Rewards that would stream while nobody is staked go back to the queue
///   instead of being stuck.
/// @dev No owner. Anyone can add rewards. Staked $liquid and reward $liquid are tracked
/// separately; balanceOf(this) is never used for accounting.
contract LiquidReserveStaking is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant DURATION = 7 days;
    uint256 private constant ONE = 1e18;

    IERC20 public immutable liquidReserve;

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

    constructor(IERC20 liquidReserve_) {
        if (address(liquidReserve_) == address(0)) revert ZeroAddress();
        liquidReserve = liquidReserve_;
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
        uint256 before = liquidReserve.balanceOf(address(this));
        liquidReserve.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = liquidReserve.balanceOf(address(this)) - before;
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
        liquidReserve.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function claim() public nonReentrant returns (uint256 reward) {
        _update(msg.sender);
        _maybeStartPeriod();
        reward = rewards[msg.sender];
        if (reward > 0) {
            rewards[msg.sender] = 0;
            liquidReserve.safeTransfer(msg.sender, reward);
            emit RewardPaid(msg.sender, reward);
        }
    }

    function exit() external {
        uint256 bal = balanceOf[msg.sender];
        if (bal > 0) withdraw(bal);
        claim();
    }

    /// @notice Adds $liquid rewards. They start streaming when the current period ends
    /// (or now, if no period is active).
    function notifyRewardAmount(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _update(address(0));
        uint256 before = liquidReserve.balanceOf(address(this));
        liquidReserve.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = liquidReserve.balanceOf(address(this)) - before;
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
