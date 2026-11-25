// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Fixture} from "./Fixture.sol";

/// @notice The whole Phase 1 path: Ascend creator fees -> FeeRouter -> creator
/// payout + reserve; a year of staking yield -> harvest -> waterfall -> burns,
/// stakers, compounding.
contract EndToEndTest is Fixture {
    address internal alice = makeAddr("alice");

    function setUp() public override {
        super.setUp();
        oracle.setPrice(address(kntq), 0.4e18);
        oracle.setPrice(address(skntq), 0.4e18);
        oracle.setPrice(address(whype), 40e18);
        oracle.setPrice(address(khype), 40e18);
        oracle.setPrice(address(lr), 0.001e18);
    }

    function test_FullFlow() public {
        // 1. Ascend pays 10,000 KNTQ ($4,000) of creator fees to the FeeRouter.
        kntq.mint(address(feeRouter), 10_000e18);
        feeRouter.distribute(address(kntq));
        creatorPayout.payout(address(kntq)); // 2,000 KNTQ = $800
        allocator.allocate(address(kntq)); //  8,000 KNTQ = $3,200

        assertEq(usdc.balanceOf(creator), 400e6, "creator: 50% of $800 as USDC");
        assertEq(whype.balanceOf(creator), 4e18, "creator: 20% of $800 as HYPE");
        assertEq(reserve.principal(address(khype)), 32e18, "reserve: $1,280 of kHYPE");
        assertEq(reserve.principal(address(skntq)), 3_200e18, "reserve: $1,280 of staked KNTQ");
        assertEq(reserve.principal(address(lr)), 640_000e18, "reserve: $640 of LR");

        // 2. A holder stakes LR.
        lr.mint(alice, 1_000e18);
        vm.startPrank(alice);
        lr.approve(address(staking), type(uint256).max);
        staking.stake(1_000e18);
        vm.stopPrank();

        // 3. A year passes: kHYPE earns 2.5%, staked KNTQ 5%.
        vm.warp(block.timestamp + 365 days);
        khype.setRate(1.025e18);
        oracle.setPrice(address(khype), 41e18);
        skntq.setRate(1.05e18);
        oracle.setPrice(address(skntq), 0.42e18);

        uint256 principalBefore = reserve.principal(address(khype));
        uint256[3] memory shares = reserve.harvestAll();
        assertApproxEqAbs(shares[0], uint256(0.8e18) * 1e18 / 1.025e18, 1, "kHYPE yield: 0.8 HYPE");
        assertApproxEqAbs(shares[1], uint256(160e18) * 1e18 / 1.05e18, 1, "sKNTQ yield: 160 KNTQ");
        assertEq(shares[2], 0, "no LR yield");

        // 4. Route the yield through the waterfall, then process its outputs.
        yieldRouter.route(address(khype));
        yieldRouter.route(address(skntq));
        creatorPayout.payout(address(khype));
        creatorPayout.payout(address(skntq));
        allocator.allocate(address(khype));
        allocator.allocate(address(skntq));

        // Burns happened.
        assertGt(lr.balanceOf(LR_BURN_SINK), 0, "LR burned");
        assertGt(kntq.balanceOf(DEAD), 0, "KNTQ burned");
        assertGt(whype.balanceOf(DEAD), 0, "HYPE burned");
        // 30% of yield compounded (20% + 10% liquidity share, no vault yet).
        assertGt(reserve.principal(address(khype)), principalBefore, "principal grew");
        // Principal is always covered.
        for (uint256 i; i < 3; ++i) {
            address a = reserve.assetAt(i);
            assertGe(reserve.valueOf(a), reserve.principal(a));
        }
        // Nothing left sitting in the routers.
        assertEq(khype.balanceOf(address(yieldRouter)), 0);
        assertEq(khype.balanceOf(address(allocator)), 0);
        assertEq(khype.balanceOf(address(creatorPayout)), 0);

        // 5. The staker earns the holder share over the next week.
        vm.warp(block.timestamp + 7 days);
        assertGt(staking.earned(alice), 0, "staker earned LR");
    }
}
