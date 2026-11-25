// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {LockedReserve} from "../../src/LockedReserve.sol";
import {FeeSplitter} from "../../src/FeeSplitter.sol";
import {ISkntq} from "../../src/interfaces/ISkntq.sol";
import {IL1GatewayRouter} from "../../src/interfaces/IArbitrumGateway.sol";
import {KntqVault} from "../../src/staking/KntqVault.sol";
import {SkntqLock, ILockedReserveDeposit} from "../../src/staking/KntqStakingVault.sol";
import {KntqStakeAgent, KntqAgentFactory, StakeSalt} from "../../src/staking/KntqStakeBridge.sol";

/// @notice The HyperEVM half of KNTQ staking against real HyperEVM state: Kinetiq's sKNTQ, the canonical
/// Elysium bridge, and the Locked Reserve that is live there.
///
///   HYPEREVM_FORK=true forge test --match-path "test/fork/KntqStakingFork.t.sol" -vv
contract KntqStakingForkTest is Test {
    ISkntq constant SKNTQ = ISkntq(0x696238e0Ca31c94e24ca4CBe7921754E172E4d0F);
    IERC20 constant KNTQ = IERC20(0x000000000000780555bD0BCA3791f89f9542c2d6);
    IL1GatewayRouter constant L1_ROUTER = IL1GatewayRouter(0x5D24f760DD7664b4214bDD4B04a3f62B9edd68c0);
    address constant L1_ERC20_GATEWAY = 0xd97B30dE0bA0C2eAeE942afce77530e06c5F122c; // also holds bridged KNTQ
    LockedReserve constant RESERVE = LockedReserve(0x394f6103B88D4DEB3A9686991C0dE24F968094A6); // live, holds sKNTQ
    address constant CREATOR = 0x9324605c9C707b2F805CCF2AC099fCA5d561DC37;
    address constant OWNER = 0x822aA88543b9da39c4c3D856857379E17526C1E8;

    KntqVault vault;
    SkntqLock lock;
    FeeSplitter splitter;
    KntqAgentFactory factory;
    address alice = makeAddr("alice");
    address box = makeAddr("a batch's box on Elysium");

    function setUp() public {
        if (!vm.envOr("HYPEREVM_FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork("hyperevm");
        lock = new SkntqLock(IERC20(address(SKNTQ)), ILockedReserveDeposit(address(RESERVE)));
        splitter = new FeeSplitter(CREATOR, 2000, address(lock));
        vault = new KntqVault(OWNER, IERC4626(address(SKNTQ)), address(splitter), 2_000_000e18);
        factory = new KntqAgentFactory(vault, L1_ROUTER, 300_000, 0.5 gwei);
        vm.deal(address(this), 10 ether);
    }

    function _kntqTo(address to, uint256 amount) internal {
        vm.prank(L1_ERC20_GATEWAY); // the bridge escrow releases KNTQ, as when a withdrawal from Elysium lands
        KNTQ.transfer(to, amount);
    }

    function test_Vault_StakeKntq_LeaveInSkntq() public {
        assertEq(address(vault.kntq()), address(KNTQ));
        uint256 rate = SKNTQ.convertToAssets(1e18);
        assertEq(vault.markRate(), rate);
        console2.log("sKNTQ rate (1e12):", rate / 1e12);
        _kntqTo(alice, 10_000e18);
        vm.startPrank(alice);
        KNTQ.approve(address(vault), 10_000e18);
        uint256 shares = vault.depositKntq(10_000e18, alice);
        vm.stopPrank();
        assertApproxEqRel(shares * rate / 1e18, 10_000e18, 0.0001e18, "liquidKNTQ worth the KNTQ put in");
        assertEq(SKNTQ.balanceOf(address(vault)), shares, "1 for 1 with sKNTQ at the start");
        assertApproxEqRel(vault.totalAssets() * vault.currentRate() / 1e18, 10_000e18, 0.0001e18);
        vm.prank(alice);
        uint256 out = vault.redeem(shares, alice, alice);
        assertApproxEqAbs(out, shares, 1_000);
        assertEq(SKNTQ.balanceOf(alice), out, "sKNTQ in hand, at once");
    }

    function test_DepositBatch_StakedAndSentHomeThroughTheRealBridge() public {
        KntqStakeAgent agent = KntqStakeAgent(factory.agentFor(StakeSalt.DEPOSIT, 0, box));
        _kntqTo(address(agent), 25_000e18); // the batch lands from Elysium before the agent exists
        assertEq(address(agent).code.length, 0);
        factory.open(StakeSalt.DEPOSIT, 0, box);
        address gateway = L1_ROUTER.getGateway(address(vault));
        assertEq(gateway, L1_ERC20_GATEWAY, "a new token goes through the standard gateway");
        (bool staked, uint256 sent) = agent.stake{value: 0.03 ether}(600_000, 0.5 gwei, 0.01 ether);
        assertTrue(staked);
        assertEq(vault.balanceOf(gateway), sent, "the liquidKNTQ is in the real bridge's escrow, on its way");
        assertEq(vault.balanceOf(address(agent)), 0);
        assertEq(KNTQ.balanceOf(address(agent)), 0);
        assertApproxEqRel(sent * SKNTQ.convertToAssets(1e18) / 1e18, 25_000e18, 0.0001e18);
        console2.log("liquidKNTQ sent home for 25,000 KNTQ (1e15):", sent / 1e15);
    }

    function test_DepositBatch_ComesHomeAsKntqWhenTheVaultIsShut() public {
        KntqStakeAgent agent = KntqStakeAgent(factory.open(StakeSalt.DEPOSIT, 3, box));
        _kntqTo(address(agent), 5_000e18);
        vm.prank(OWNER);
        vault.setDepositsPaused(true);
        uint256 escrow = KNTQ.balanceOf(L1_ERC20_GATEWAY);
        (bool staked, uint256 sent) = agent.stake{value: 0.02 ether}(300_000, 0.5 gwei, 0.01 ether);
        assertFalse(staked);
        assertEq(sent, 5_000e18);
        assertEq(KNTQ.balanceOf(L1_ERC20_GATEWAY) - escrow, 5_000e18, "the KNTQ itself went back into the bridge");
        assertEq(vault.totalSupply(), 0);
    }

    function test_ExitBatch_KinetiqsSevenDaysThenHome() public {
        _kntqTo(alice, 8_000e18);
        vm.startPrank(alice);
        KNTQ.approve(address(vault), 8_000e18);
        uint256 shares = vault.depositKntq(8_000e18, alice);
        // her liquidKNTQ arrives at the exit batch's agent (as it would from Elysium)
        KntqStakeAgent agent = KntqStakeAgent(factory.open(StakeSalt.EXIT, 0, box));
        vault.transfer(address(agent), shares);
        vm.stopPrank();

        (uint256 requestId, uint256 due) = agent.startExit();
        console2.log("withdrawal request id:", requestId, "KNTQ due (1e15):", due / 1e15);
        assertApproxEqRel(due, 8_000e18, 0.0001e18);
        (uint256 assets,,) = SKNTQ.withdrawalRequest(address(agent), requestId);
        assertEq(assets, due, "the request Kinetiq recorded is the one the agent reports");
        assertEq(vault.balanceOf(address(agent)), 0);
        assertEq(SKNTQ.balanceOf(address(agent)), 0);

        uint256[] memory ids = new uint256[](1);
        ids[0] = requestId;
        vm.expectRevert();
        agent.finishExit{value: 0.02 ether}(ids, 300_000, 0.5 gwei, 0.01 ether);
        vm.warp(block.timestamp + SKNTQ.withdrawalDelay() + 1);
        uint256 escrow = KNTQ.balanceOf(L1_ERC20_GATEWAY);
        uint256 home = agent.finishExit{value: 0.02 ether}(ids, 300_000, 0.5 gwei, 0.01 ether);
        assertEq(home, due);
        assertEq(KNTQ.balanceOf(L1_ERC20_GATEWAY) - escrow, due, "the KNTQ is in the real bridge, on its way home");
    }

    function test_Fee_TwentyPercentOfYield_CreatorAndTheLiveLockedReserve() public {
        _kntqTo(alice, 100_000e18);
        vm.startPrank(alice);
        KNTQ.approve(address(vault), 100_000e18);
        vault.depositKntq(100_000e18, alice);
        vm.stopPrank();
        assertEq(vault.pendingFees(), 0, "sKNTQ pays nothing today, so no fee");

        // Kinetiq pays stakers again (simulated: KNTQ added to sKNTQ), three months on
        uint256 r0 = SKNTQ.convertToAssets(1e18);
        vm.warp(block.timestamp + 90 days);
        _kntqTo(address(SKNTQ), SKNTQ.totalAssets() / 50); // +2%
        uint256 r1 = SKNTQ.convertToAssets(1e18);
        assertGt(r1, r0);
        uint256 yieldKntq = 100_000e18 * (r1 - r0) / r0;
        uint256 feeKntq = vault.pendingFees() * r1 / 1e18;
        assertApproxEqRel(feeKntq, yieldKntq * 2000 / 10_000, 0.001e18, "20% of the yield");
        console2.log("yield (KNTQ):", yieldKntq / 1e18, "fee (KNTQ):", feeKntq / 1e18);

        uint256 collected = vault.collectFees();
        splitter.distribute(address(SKNTQ));
        assertEq(SKNTQ.balanceOf(CREATOR), collected * 2000 / 10_000, "20% of the fee to the creator's wallet");
        uint256 toReserve = SKNTQ.balanceOf(address(lock));
        uint256 principal = RESERVE.principal(address(SKNTQ));
        uint256 held = SKNTQ.balanceOf(address(RESERVE));
        lock.lock();
        assertEq(SKNTQ.balanceOf(address(RESERVE)) - held, toReserve, "80% into the live Locked Reserve");
        assertGt(RESERVE.principal(address(SKNTQ)), principal, "counted as locked principal");
    }
}
