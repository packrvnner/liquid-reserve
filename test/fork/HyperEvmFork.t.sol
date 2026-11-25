// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {LockedReserve} from "../../src/LockedReserve.sol";
import {StakeAndLock} from "../../src/hyperevm/StakeAndLock.sol";
import {YieldUnstakeBridge} from "../../src/hyperevm/YieldUnstakeBridge.sol";
import {ERC4626RateProvider} from "../../src/adapters/ERC4626RateProvider.sol";
import {IRateProvider} from "../../src/interfaces/IRateProvider.sol";
import {ISkntq} from "../../src/interfaces/ISkntq.sol";
import {IL1GatewayRouter} from "../../src/interfaces/IArbitrumGateway.sol";

/// @notice The staked-KNTQ side of the reserve against real HyperEVM state:
/// Kinetiq's sKNTQ vault and the canonical Elysium bridge.
///
///   HYPEREVM_FORK=true forge test --match-path "test/fork/HyperEvmFork.t.sol" -vv
contract HyperEvmForkTest is Test {
    ISkntq constant SKNTQ = ISkntq(0x696238e0Ca31c94e24ca4CBe7921754E172E4d0F);
    IERC20 constant KNTQ = IERC20(0x000000000000780555bD0BCA3791f89f9542c2d6);
    IL1GatewayRouter constant L1_ROUTER = IL1GatewayRouter(0x5D24f760DD7664b4214bDD4B04a3f62B9edd68c0);
    address constant L1_ERC20_GATEWAY = 0xd97B30dE0bA0C2eAeE942afce77530e06c5F122c; // also holds bridged KNTQ

    YieldUnstakeBridge yieldBridge;
    LockedReserve reserve;
    StakeAndLock stakeAndLock;
    address elysiumYieldRouter = makeAddr("Elysium YieldRouter");

    function setUp() public {
        if (!vm.envOr("HYPEREVM_FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork("hyperevm");
        yieldBridge = new YieldUnstakeBridge(SKNTQ, L1_ROUTER, address(this), 300_000, 0.5 gwei);
        ERC4626RateProvider rate = new ERC4626RateProvider(IERC4626(address(SKNTQ)));
        reserve = new LockedReserve(
            [address(SKNTQ), address(0), address(0)],
            [IRateProvider(address(rate)), IRateProvider(address(0)), IRateProvider(address(0))],
            address(yieldBridge)
        );
        stakeAndLock = new StakeAndLock(IERC4626(address(SKNTQ)), reserve);
        yieldBridge.setL2Recipient(elysiumYieldRouter);
    }

    function test_HyperEvm_StakeLockHarvestUnstakeBridge() public {
        // 1. KNTQ arrives from Elysium (the bridge gateway releases it), gets staked and locked.
        vm.prank(L1_ERC20_GATEWAY);
        KNTQ.transfer(address(stakeAndLock), 10_000e18);
        uint256 shares = stakeAndLock.stake();
        uint256 principal = reserve.principal(address(SKNTQ));
        console2.log("sKNTQ locked:", shares / 1e18);
        console2.log("principal (KNTQ):", principal / 1e18);
        assertApproxEqRel(principal, 10_000e18, 0.0001e18);

        // 2. Kinetiq rewards raise the sKNTQ rate (simulated: KNTQ added to the vault).
        uint256 rateBefore = SKNTQ.convertToAssets(1e18);
        vm.prank(L1_ERC20_GATEWAY);
        KNTQ.transfer(address(SKNTQ), 500_000e18);
        uint256 rateAfter = SKNTQ.convertToAssets(1e18);
        console2.log("sKNTQ rate before / after (1e15):", rateBefore / 1e15, rateAfter / 1e15);
        assertGt(rateAfter, rateBefore, "vault rate rises with rewards");

        // 3. Harvest only the yield; principal stays locked.
        vm.warp(block.timestamp + 90 days);
        uint256 yieldShares = reserve.harvest(address(SKNTQ));
        console2.log("yield harvested (sKNTQ, 1e15):", yieldShares / 1e15);
        assertGt(yieldShares, 0);
        assertEq(reserve.principal(address(SKNTQ)), principal);
        assertGe(reserve.valueOf(address(SKNTQ)), principal);

        // 4. Unstake the yield (7-day withdrawal), then bridge the KNTQ to Elysium.
        (uint256 id, uint256 assets) = yieldBridge.requestUnstake();
        console2.log("unstake request id:", id, "KNTQ (1e15):", assets / 1e15);
        vm.expectRevert();
        yieldBridge.confirm(id);
        vm.warp(block.timestamp + 7 days + 1);
        yieldBridge.confirm(id);
        assertEq(KNTQ.balanceOf(address(yieldBridge)), assets);

        uint256 escrowBefore = KNTQ.balanceOf(L1_ERC20_GATEWAY);
        vm.deal(address(this), 1 ether);
        uint256 bridged = yieldBridge.bridge{value: 0.02 ether}(300_000, 0.5 gwei, 0.01 ether);
        assertEq(KNTQ.balanceOf(L1_ERC20_GATEWAY) - escrowBefore, bridged, "escrowed by the real bridge");
        assertEq(KNTQ.balanceOf(address(yieldBridge)), 0);
        console2.log("bridged to Elysium YieldRouter (KNTQ, 1e15):", bridged / 1e15);
    }
}
