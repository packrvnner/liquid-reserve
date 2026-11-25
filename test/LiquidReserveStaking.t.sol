// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {LiquidReserveStaking} from "../src/LiquidReserveStaking.sol";

contract LRStakingTest is Test {
    MockERC20 internal lr;
    LiquidReserveStaking internal staking;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal funder = makeAddr("funder");

    function setUp() public {
        lr = new MockERC20("Liquid Reserve", "LR", 18);
        staking = new LiquidReserveStaking(lr);
        address[3] memory users = [alice, bob, funder];
        for (uint256 i; i < users.length; ++i) {
            lr.mint(users[i], 1e30);
            vm.prank(users[i]);
            lr.approve(address(staking), type(uint256).max);
        }
    }

    function _stake(address who, uint256 amount) internal {
        vm.prank(who);
        staking.stake(amount);
    }

    function _fund(uint256 amount) internal {
        vm.prank(funder);
        staking.notifyRewardAmount(amount);
    }

    function _assertSolvent() internal view {
        uint256 streamingLeft = staking.periodFinish() > block.timestamp
            ? (staking.periodFinish() - block.timestamp) * staking.rewardRate()
            : 0;
        uint256 owed = staking.totalStaked() + staking.queuedRewards() + streamingLeft + staking.earned(alice)
            + staking.earned(bob);
        assertGe(lr.balanceOf(address(staking)), owed, "staking contract solvent");
    }

    function test_SingleStakerEarnsAllRewards() public {
        _stake(alice, 100e18);
        _fund(700e18);
        vm.warp(block.timestamp + 7 days);
        assertApproxEqAbs(staking.earned(alice), 700e18, 1e6);
        _assertSolvent();
    }

    function test_TwoStakersSplitProRata() public {
        _stake(alice, 100e18);
        _stake(bob, 300e18);
        _fund(700e18);
        vm.warp(block.timestamp + 7 days);
        assertApproxEqAbs(staking.earned(alice), 175e18, 1e6);
        assertApproxEqAbs(staking.earned(bob), 525e18, 1e6);
        _assertSolvent();
    }

    function test_NewRewardsWaitForCurrentPeriod() public {
        _stake(alice, 100e18);
        _fund(700e18);
        uint256 rate = staking.rewardRate();
        uint256 finish = staking.periodFinish();

        vm.warp(block.timestamp + 1 days);
        _fund(1_400e18); // arrives mid-period: queued, doesn't change the active stream
        assertEq(staking.rewardRate(), rate);
        assertEq(staking.periodFinish(), finish);
        assertApproxEqAbs(staking.queuedRewards(), 1_400e18, 1e6);

        vm.warp(finish);
        staking.poke();
        assertGt(staking.rewardRate(), rate, "second period streams the queued rewards");
        vm.warp(block.timestamp + 7 days);
        assertApproxEqAbs(staking.earned(alice), 2_100e18, 1e7);
        _assertSolvent();
    }

    function test_RewardsRequeuedWhenNobodyStakes() public {
        _fund(700e18);
        vm.warp(block.timestamp + 7 days);
        staking.poke(); // nothing was earned: rewards go back in the queue and restart
        assertApproxEqAbs(staking.queuedRewards() + staking.rewardRate() * 7 days, 700e18, 1e6);

        _stake(alice, 100e18);
        vm.warp(block.timestamp + 7 days);
        assertApproxEqAbs(staking.earned(alice), 700e18, 1e7);
        _assertSolvent();
    }

    function test_JustInTimeStakerEarnsLittle() public {
        _stake(alice, 100e18);
        _fund(700e18);
        vm.warp(block.timestamp + 7 days - 1 hours);
        _stake(bob, 100e18); // stakes in the last hour
        vm.warp(block.timestamp + 1 hours);
        // 700 * (1h / 168h) / 2 ≈ 2.08 LR
        assertLt(staking.earned(bob), 2.1e18);
        assertGt(staking.earned(alice), 697e18);
    }

    function test_ExitReturnsStakeAndRewards() public {
        _stake(alice, 100e18);
        _fund(700e18);
        vm.warp(block.timestamp + 7 days);
        uint256 before = lr.balanceOf(alice);
        vm.prank(alice);
        staking.exit();
        assertApproxEqAbs(lr.balanceOf(alice) - before, 800e18, 1e6);
        assertEq(staking.balanceOf(alice), 0);
        assertEq(staking.totalStaked(), 0);
    }

    function test_RevertWhen_WithdrawMoreThanStaked() public {
        _stake(alice, 100e18);
        vm.prank(alice);
        vm.expectRevert(LiquidReserveStaking.InsufficientStake.selector);
        staking.withdraw(101e18);
    }

    function testFuzz_StakersShareRewardsByStake(uint96 a, uint96 b, uint96 reward, uint32 elapsed) public {
        a = uint96(bound(a, 1e18, 1e27));
        b = uint96(bound(b, 1e18, 1e27));
        reward = uint96(bound(reward, 1e18, 1e27));
        elapsed = uint32(bound(elapsed, 1, 30 days));

        _stake(alice, a);
        _stake(bob, b);
        _fund(reward);
        vm.warp(block.timestamp + elapsed);

        uint256 ea = staking.earned(alice);
        uint256 eb = staking.earned(bob);
        assertLe(ea + eb, reward, "never pays more than funded");
        // alice's share of rewards matches her share of stake, up to rounding
        // (at most stake/1e18 wei per reward update, so < 1e10 wei here)
        assertApproxEqAbs(ea, (ea + eb) * uint256(a) / (uint256(a) + b), 1e10);
        _assertSolvent();
    }
}
