// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {Fixture} from "./Fixture.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockL2GatewayRouter, MockL1GatewayRouter, MockSkntq} from "./mocks/MockBridge.sol";
import {LockedReserve} from "../src/LockedReserve.sol";
import {InflowAllocator} from "../src/InflowAllocator.sol";
import {BridgeOut} from "../src/bridge/BridgeOut.sol";
import {StakeAndLock} from "../src/hyperevm/StakeAndLock.sol";
import {YieldUnstakeBridge} from "../src/hyperevm/YieldUnstakeBridge.sol";
import {ERC4626RateProvider} from "../src/adapters/ERC4626RateProvider.sol";
import {IRateProvider} from "../src/interfaces/IRateProvider.sol";
import {IL2GatewayRouter, IL1GatewayRouter} from "../src/interfaces/IArbitrumGateway.sol";
import {ISkntq} from "../src/interfaces/ISkntq.sol";

/// Elysium side: reserve with fewer assets, allocator bucket that leaves the
/// reserve, and BridgeOut.
contract ElysiumSideTest is Fixture {
    address internal sink = makeAddr("BridgeOut");

    function test_ReserveWithTwoAssets() public {
        LockedReserve r = new LockedReserve(
            [address(khype), address(lr), address(0)],
            [IRateProvider(address(khype)), IRateProvider(address(0)), IRateProvider(address(0))],
            address(yieldRouter)
        );
        assertEq(r.assetCount(), 2);
        assertTrue(r.isReserveAsset(address(lr)));
        assertFalse(r.isReserveAsset(address(0)));
        vm.expectRevert(abi.encodeWithSelector(LockedReserve.NotReserveAsset.selector, address(0)));
        r.assetAt(2);
        uint256[3] memory shares = r.harvestAll();
        assertEq(shares[2], 0);
    }

    function test_RevertWhen_AssetListHasGapOrStrayProvider() public {
        vm.expectRevert(LockedReserve.BadAssetList.selector);
        new LockedReserve(
            [address(khype), address(0), address(lr)],
            [IRateProvider(address(0)), IRateProvider(address(0)), IRateProvider(address(0))],
            address(yieldRouter)
        );
        vm.expectRevert(LockedReserve.BadAssetList.selector);
        new LockedReserve(
            [address(khype), address(0), address(0)],
            [IRateProvider(address(0)), IRateProvider(address(khype)), IRateProvider(address(0))],
            address(yieldRouter)
        );
        vm.expectRevert(LockedReserve.ZeroAddress.selector);
        new LockedReserve(
            [address(0), address(0), address(0)],
            [IRateProvider(address(0)), IRateProvider(address(0)), IRateProvider(address(0))],
            address(yieldRouter)
        );
    }

    function test_AllocatorBucketCanLeaveTheReserve() public {
        InflowAllocator a = new InflowAllocator(
            cfg, reserve, [address(khype), address(kntq), address(lr)], [address(reserve), sink, address(reserve)]
        );
        kntq.mint(address(a), 1_000e18);
        uint256[3] memory out = a.allocate(address(kntq));
        assertEq(kntq.balanceOf(sink), 400e18, "40% KNTQ straight to BridgeOut");
        assertEq(out[1], 400e18);
        assertEq(reserve.principal(address(khype)), 400e18);
        assertEq(reserve.principal(address(lr)), 200e18);
    }

    function test_BridgeOutSendsToFixedHyperEvmRecipient() public {
        MockL2GatewayRouter router = new MockL2GatewayRouter();
        address l1Kntq = makeAddr("KNTQ on HyperEVM");
        address stakeAndLock = makeAddr("StakeAndLock");
        BridgeOut b = new BridgeOut(IL2GatewayRouter(address(router)), kntq, l1Kntq, stakeAndLock, 100e18);

        kntq.mint(address(b), 99e18);
        vm.expectRevert(abi.encodeWithSelector(BridgeOut.BelowMinimum.selector, 99e18, 100e18));
        b.bridge();

        kntq.mint(address(b), 1e18);
        b.bridge();
        assertEq(router.lastL1Token(), l1Kntq);
        assertEq(router.lastTo(), stakeAndLock);
        assertEq(router.lastAmount(), 100e18);
    }
}

/// HyperEVM side: StakeAndLock, the sKNTQ reserve, and YieldUnstakeBridge.
contract HyperEvmSideTest is Test {
    MockERC20 internal kntq;
    MockSkntq internal skntq;
    MockL1GatewayRouter internal l1Router;
    YieldUnstakeBridge internal yieldBridge;
    LockedReserve internal reserve;
    StakeAndLock internal stakeAndLock;
    address internal elysiumYieldRouter = makeAddr("Elysium YieldRouter");

    function setUp() public {
        kntq = new MockERC20("Kinetiq", "KNTQ", 18);
        skntq = new MockSkntq(kntq);
        l1Router = new MockL1GatewayRouter();
        yieldBridge = new YieldUnstakeBridge(
            ISkntq(address(skntq)), IL1GatewayRouter(address(l1Router)), address(this), 300_000, 0.5 gwei
        );
        ERC4626RateProvider rate = new ERC4626RateProvider(IERC4626(address(skntq)));
        reserve = new LockedReserve(
            [address(skntq), address(0), address(0)],
            [IRateProvider(address(rate)), IRateProvider(address(0)), IRateProvider(address(0))],
            address(yieldBridge)
        );
        stakeAndLock = new StakeAndLock(IERC4626(address(skntq)), reserve);
        vm.warp(1_800_000_000);
    }

    /// Simulates Kinetiq rewards: KNTQ added to the vault raises the sKNTQ rate.
    function _vaultEarns(uint256 amount) internal {
        kntq.mint(address(skntq), amount);
    }

    function test_StakeAndLock() public {
        kntq.mint(address(stakeAndLock), 1_000e18); // arrives from the bridge
        uint256 shares = stakeAndLock.stake();
        assertEq(shares, 1_000e18);
        assertEq(skntq.balanceOf(address(reserve)), 1_000e18);
        assertEq(reserve.principal(address(skntq)), 1_000e18, "principal in KNTQ");
    }

    function test_FullYieldPath() public {
        kntq.mint(address(stakeAndLock), 1_000e18);
        stakeAndLock.stake();
        yieldBridge.setL2Recipient(elysiumYieldRouter);

        // A year of rewards: the vault's rate rises 4%.
        vm.warp(block.timestamp + 365 days);
        _vaultEarns(40e18);
        uint256 shares = reserve.harvest(address(skntq));
        assertGt(shares, 0);
        assertEq(reserve.principal(address(skntq)), 1_000e18, "principal untouched");
        assertGe(reserve.valueOf(address(skntq)), 1_000e18);

        (uint256 id, uint256 assets) = yieldBridge.requestUnstake();
        assertEq(id, 1);
        assertApproxEqAbs(assets, 40e18, 1e6, "the yield, in KNTQ (rounding favors principal)");

        vm.expectRevert("not ready");
        yieldBridge.confirm(id);
        vm.warp(block.timestamp + 7 days);
        yieldBridge.confirm(id);
        assertApproxEqAbs(kntq.balanceOf(address(yieldBridge)), 40e18, 1e6);

        vm.deal(address(this), 1 ether);
        uint256 bridged = yieldBridge.bridge{value: 0.01 ether}(300_000, 0.5 gwei, 0.005 ether);
        assertApproxEqAbs(bridged, 40e18, 1e6);
        assertEq(l1Router.lastTo(), elysiumYieldRouter);
        assertEq(l1Router.lastRefundTo(), address(this));
        assertEq(l1Router.lastValue(), 0.01 ether);
        assertEq(kntq.balanceOf(address(l1Router.gateway())), bridged, "escrowed by the bridge");
        assertEq(kntq.balanceOf(address(yieldBridge)), 0);
    }

    function test_RecipientSetOnceBySetterOnly() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(YieldUnstakeBridge.NotSetter.selector);
        yieldBridge.setL2Recipient(elysiumYieldRouter);
        yieldBridge.setL2Recipient(elysiumYieldRouter);
        vm.expectRevert(YieldUnstakeBridge.AlreadySet.selector);
        yieldBridge.setL2Recipient(address(this));
    }

    function test_RevertWhen_BridgeBeforeRecipientOrWithLowGas() public {
        kntq.mint(address(yieldBridge), 10e18);
        vm.expectRevert(YieldUnstakeBridge.RecipientNotSet.selector);
        yieldBridge.bridge(300_000, 0.5 gwei, 0);

        yieldBridge.setL2Recipient(elysiumYieldRouter);
        vm.expectRevert(YieldUnstakeBridge.GasTooLow.selector);
        yieldBridge.bridge(100_000, 0.5 gwei, 0);
        vm.expectRevert(YieldUnstakeBridge.GasTooLow.selector);
        yieldBridge.bridge(300_000, 0.1 gwei, 0);
    }
}
