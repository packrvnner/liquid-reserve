// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Fixture} from "./Fixture.sol";
import {FeeSplitter} from "../src/FeeSplitter.sol";
import {InflowAllocator} from "../src/InflowAllocator.sol";
import {YieldRouter} from "../src/YieldRouter.sol";
import {CreatorPayout} from "../src/CreatorPayout.sol";
import {SwapConfig} from "../src/SwapConfig.sol";
import {GuardedSwap} from "../src/base/GuardedSwap.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract FeeSplitterTest is Fixture {
    function test_DistributeSplits20To80() public {
        kntq.mint(address(feeRouter), 1_000e18);
        (uint256 toA, uint256 toB) = feeRouter.distribute(address(kntq));
        assertEq(toA, 200e18);
        assertEq(toB, 800e18);
        assertEq(kntq.balanceOf(address(creatorPayout)), 200e18);
        assertEq(kntq.balanceOf(address(allocator)), 800e18);
    }

    function testFuzz_DistributeConserves(uint256 amount) public {
        amount = bound(amount, 1, 1e36);
        kntq.mint(address(feeRouter), amount);
        feeRouter.distribute(address(kntq));
        assertEq(kntq.balanceOf(address(creatorPayout)) + kntq.balanceOf(address(allocator)), amount);
        assertEq(kntq.balanceOf(address(feeRouter)), 0);
    }

    function test_RevertWhen_NothingToDistribute() public {
        vm.expectRevert(FeeSplitter.NothingToDistribute.selector);
        feeRouter.distribute(address(kntq));
    }

    function test_RevertWhen_BadConstructorArgs() public {
        vm.expectRevert(FeeSplitter.InvalidBps.selector);
        new FeeSplitter(address(1), 10_000, address(2));
        vm.expectRevert(FeeSplitter.ZeroAddress.selector);
        new FeeSplitter(address(0), 2_000, address(2));
    }
}

contract InflowAllocatorTest is Fixture {
    function setUp() public override {
        super.setUp();
        oracle.setPrice(address(kntq), 0.4e18);
        oracle.setPrice(address(skntq), 0.4e18);
        oracle.setPrice(address(khype), 40e18);
        oracle.setPrice(address(lr), 0.001e18);
    }

    function test_AllocateSplits40_40_20() public {
        kntq.mint(address(allocator), 1_000e18); // $400 of KNTQ

        uint256[3] memory dep = allocator.allocate(address(kntq));

        assertEq(dep[0], 4e18, "kHYPE: $160 / $40");
        assertEq(dep[1], 400e18, "sKNTQ: 400 KNTQ at 1:1");
        assertEq(dep[2], 80_000e18, "LR: $80 / $0.001");
        assertEq(reserve.principal(address(khype)), 4e18);
        assertEq(reserve.principal(address(skntq)), 400e18);
        assertEq(reserve.principal(address(lr)), 80_000e18);
        assertEq(kntq.balanceOf(address(allocator)), 0);
    }

    function test_AllocateReserveAssetSkipsSwap() public {
        lr.mint(address(allocator), 100_000e18); // $100 of LR
        uint256[3] memory dep = allocator.allocate(address(lr));
        assertEq(dep[2], 20_000e18, "20% LR deposited as is");
        assertEq(dep[0], 1e18, "kHYPE: $40 / $40");
        assertEq(dep[1], 100e18, "sKNTQ: $40 / $0.40");
    }

    function test_RevertWhen_SwapperExceedsSlippage() public {
        swapper.setHaircutBps(200); // 2% worse than oracle, limit is 1%
        kntq.mint(address(allocator), 1_000e18);
        vm.expectRevert("MockSwapper: slippage");
        allocator.allocate(address(kntq));
    }

    function test_RevertWhen_SwapperUnderpaysSilently() public {
        swapper.setHaircutBps(200);
        swapper.setIgnoreMinOut(true); // adapter lies about the output
        kntq.mint(address(allocator), 1_000e18);
        vm.expectPartialRevert(GuardedSwap.InsufficientOutput.selector);
        allocator.allocate(address(kntq));
    }

    function test_RevertWhen_NoOraclePrice() public {
        MockERC20 junk = new MockERC20("Junk", "JUNK", 18);
        junk.mint(address(allocator), 1e18);
        vm.expectPartialRevert(GuardedSwap.QuoteZero.selector);
        allocator.allocate(address(junk));
    }

    function test_AllocatePartialLeavesTheRest() public {
        kntq.mint(address(allocator), 1_000e18);
        uint256[3] memory dep = allocator.allocatePartial(address(kntq), 250e18);
        assertEq(dep[1], 100e18, "40% of the 250 processed");
        assertEq(kntq.balanceOf(address(allocator)), 750e18, "rest waits for the next call");
    }

    function test_RevertWhen_NothingToAllocate() public {
        vm.expectRevert(InflowAllocator.NothingToAllocate.selector);
        allocator.allocate(address(kntq));
    }
}

contract YieldRouterTest is Fixture {
    address internal vault = makeAddr("lrVault");
    address internal bonus = makeAddr("lpBonus");

    function test_RouteWaterfall_BeforeVaultExists() public {
        kntq.mint(address(yieldRouter), 1_000e18);

        yieldRouter.route(address(kntq));

        assertEq(kntq.balanceOf(address(creatorPayout)), 200e18, "20% creator");
        assertEq(lr.balanceOf(LR_BURN_SINK), 200e18, "20% LR burned");
        assertEq(kntq.balanceOf(DEAD), 100e18, "10% KNTQ burned");
        assertEq(whype.balanceOf(DEAD), 100e18, "10% HYPE burned");
        assertEq(lr.balanceOf(address(staking)), 100e18, "10% to stakers");
        assertEq(kntq.balanceOf(address(allocator)), 300e18, "20% compound + 10% liquidity");
        assertEq(kntq.balanceOf(address(yieldRouter)), 0);
    }

    function test_RouteWaterfall_WithVault() public {
        vm.prank(timelock);
        yieldRouter.setLiquidityDestinations(vault, bonus);
        kntq.mint(address(yieldRouter), 1_000e18);

        yieldRouter.route(address(kntq));

        assertEq(lr.balanceOf(bonus), 20e18, "2% LP bonus in LR");
        assertEq(kntq.balanceOf(vault), 80e18, "8% to LR vault");
        assertEq(kntq.balanceOf(address(allocator)), 200e18, "20% compound");
    }

    function test_RoutePartialKeepsProportions() public {
        kntq.mint(address(yieldRouter), 1_000e18);
        yieldRouter.routePartial(address(kntq), 100e18);
        assertEq(kntq.balanceOf(address(creatorPayout)), 20e18);
        assertEq(lr.balanceOf(LR_BURN_SINK), 20e18);
        assertEq(kntq.balanceOf(address(yieldRouter)), 900e18);
    }

    function test_RevertWhen_NonOwnerSetsLiquidityDestinations() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        yieldRouter.setLiquidityDestinations(vault, bonus);
    }

    function testFuzz_RouteConserves(uint256 amount) public {
        amount = bound(amount, 1, 1e30);
        kntq.mint(address(yieldRouter), amount);
        yieldRouter.route(address(kntq));

        uint256 out = kntq.balanceOf(address(creatorPayout)) + lr.balanceOf(LR_BURN_SINK) + kntq.balanceOf(DEAD)
            + whype.balanceOf(DEAD) + lr.balanceOf(address(staking)) + kntq.balanceOf(address(allocator));
        assertEq(out, amount, "every unit accounted for at 1:1 prices");
    }
}

contract CreatorPayoutTest is Fixture {
    address internal newWallet = makeAddr("newWallet");

    function test_PayoutSplits50_20_20_10() public {
        oracle.setPrice(address(kntq), 0.4e18);
        oracle.setPrice(address(whype), 40e18);
        oracle.setPrice(address(lr), 0.001e18);
        kntq.mint(address(creatorPayout), 1_000e18); // $400

        creatorPayout.payout(address(kntq));

        assertEq(usdc.balanceOf(creator), 200e6, "50% as USDC");
        assertEq(whype.balanceOf(creator), 2e18, "20% as HYPE: $80 / $40");
        assertEq(kntq.balanceOf(creator), 200e18, "20% as KNTQ");
        assertEq(lr.balanceOf(creator), 40_000e18, "10% as LR: $40 / $0.001");
    }

    function test_PayoutPartial() public {
        kntq.mint(address(creatorPayout), 1_000e18);
        creatorPayout.payoutPartial(address(kntq), 100e18);
        assertEq(usdc.balanceOf(creator), 50e6);
        assertEq(kntq.balanceOf(address(creatorPayout)), 900e18);
    }

    function test_TwoStepPayoutAddressChange() public {
        vm.prank(creator);
        creatorPayout.proposePayoutAddress(newWallet);
        assertEq(creatorPayout.payoutAddress(), creator, "not changed until accepted");

        vm.prank(newWallet);
        creatorPayout.acceptPayoutAddress();
        assertEq(creatorPayout.payoutAddress(), newWallet);

        kntq.mint(address(creatorPayout), 100e18);
        creatorPayout.payout(address(kntq));
        assertGt(usdc.balanceOf(newWallet), 0);
        assertEq(usdc.balanceOf(creator), 0);
    }

    function test_RevertWhen_OthersProposePayoutAddress() public {
        vm.expectRevert(CreatorPayout.NotPayoutAddress.selector);
        creatorPayout.proposePayoutAddress(address(this));
        vm.prank(timelock);
        vm.expectRevert(CreatorPayout.NotPayoutAddress.selector);
        creatorPayout.proposePayoutAddress(timelock);
    }

    function test_RevertWhen_WrongAddressAccepts() public {
        vm.prank(creator);
        creatorPayout.proposePayoutAddress(newWallet);
        vm.expectRevert(CreatorPayout.NotPendingPayoutAddress.selector);
        creatorPayout.acceptPayoutAddress();
    }

    function test_CancelProposal() public {
        vm.prank(creator);
        creatorPayout.proposePayoutAddress(newWallet);
        vm.prank(creator);
        creatorPayout.proposePayoutAddress(address(0));
        vm.prank(newWallet);
        vm.expectRevert(CreatorPayout.NotPendingPayoutAddress.selector);
        creatorPayout.acceptPayoutAddress();
    }
}

contract SwapConfigTest is Fixture {
    function test_RevertWhen_SlippageAboveCap() public {
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(SwapConfig.SlippageTooHigh.selector, uint16(301)));
        cfg.setMaxSlippageBps(301);
    }

    function test_RevertWhen_NonOwnerSetsSwapper() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        cfg.setSwapper(swapper);
    }
}
