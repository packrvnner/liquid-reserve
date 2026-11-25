// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {FeeInbox} from "../../src/FeeInbox.sol";
import {InflowAllocator} from "../../src/InflowAllocator.sol";
import {V4TwapOracle} from "../../src/adapters/V4TwapOracle.sol";
import {LockedReserve} from "../../src/LockedReserve.sol";
import {ISkntq} from "../../src/interfaces/ISkntq.sol";
import {ReserveLaunchA, ReserveLaunchB, ReserveLaunchH1, ReserveLaunchH2} from "../../src/launch/ReserveLaunch.sol";
import {MockArbSys} from "./ElysiumFork.t.sol";

interface IWrapped {
    function deposit() external payable;
}

/// @notice The pre-launch reserve on a copy of Elysium mainnet, wired to the LIVE
/// vault fee inbox: fees -> 20% creator / 80% reserve -> kHYPE locked, KNTQ to
/// the bridge, USDC parked for the $liquid share.
///
///   ELYSIUM_FORK=true forge test --match-contract PreLaunchElysium -vv
contract PreLaunchElysiumTest is Test {
    address constant OWNER = 0x822aA88543b9da39c4c3D856857379E17526C1E8;
    address constant BOT = 0x0461663d46DA68264966a0670335E3ecf0b96F3C;
    FeeInbox constant VAULT_INBOX = FeeInbox(0x2AfD3850794b84205667CE2826b09FA5bf1c3a5c);
    address constant WHYPE = 0xbA876237B0F021A6c6D852d6c26E107997cC5E81;
    address constant USDC = 0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65;
    address constant KNTQ = 0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0;
    address constant KHYPE = 0x248888D396A546A69A188f3Deb476964e581E9d0;
    address stakeAndLock = makeAddr("HyperEVM StakeAndLock");
    /// The owner wallet connected the live vault fee inbox to the real reserve in Elysium block 6,865,652
    /// (2026-11-15 21:11 UTC). That can be done only once, so this rehearsal of it runs on the chain as it stood
    /// one block earlier.
    uint256 constant BEFORE_THE_REAL_STEP = 6_865_651;

    ReserveLaunchA a;
    ReserveLaunchB b;
    PoolId[] feeds;

    function setUp() public {
        if (!vm.envOr("ELYSIUM_FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork("elysium", BEFORE_THE_REAL_STEP);
        a = new ReserveLaunchA(OWNER, BOT, 48 hours, 100);
        b = new ReserveLaunchB(a, stakeAndLock, 25e18);
        (PoolId[] memory p1,) = a.oracle().getRoute(KNTQ, KHYPE); // KNTQ/HYPE, kHYPE/WHYPE
        (PoolId[] memory p2,) = a.oracle().getRoute(WHYPE, USDC); // HYPE/USDC
        feeds.push(p1[0]);
        feeds.push(p1[1]);
        feeds.push(p2[0]);
    }

    /// The bot's rhythm: one price reading every 10 minutes.
    function _warm(uint256 rounds) internal {
        V4TwapOracle o = a.oracle();
        for (uint256 i; i < rounds; ++i) {
            vm.warp(block.timestamp + 600);
            vm.prank(BOT);
            o.poke(feeds);
        }
    }

    function _fund(uint256 whype, uint256 usdc, uint256 kntq) internal {
        vm.deal(address(this), whype);
        IWrapped(WHYPE).deposit{value: whype}();
        IERC20(WHYPE).transfer(address(VAULT_INBOX), whype);
        deal(USDC, address(VAULT_INBOX), usdc);
        deal(KNTQ, address(VAULT_INBOX), kntq);
    }

    /// The one permanent step: the owner wallet points the live vault fee inbox at the splitter.
    function _connect() internal {
        address splitter = address(b.feeSplitter());
        vm.prank(OWNER);
        VAULT_INBOX.setTarget(splitter);
    }

    function _run(address token) internal {
        VAULT_INBOX.forward(token);
        b.feeSplitter().distribute(token);
        b.allocator().allocate(token);
    }

    function test_PreLaunch_Wiring() public view {
        assertEq(VAULT_INBOX.setter(), OWNER, "the owner wallet connects the live fee inbox");
        assertEq(VAULT_INBOX.target(), address(0), "not connected yet");
        assertEq(a.creatorWait().setter(), OWNER);
        assertEq(a.liquidWait().setter(), address(a.timelock()));
        assertEq(a.yieldWait().setter(), address(a.timelock()));
        assertEq(a.swapper().owner(), address(a), "frozen until the timelock accepts");
        assertEq(a.swapper().pendingOwner(), address(a.timelock()));
        assertEq(a.oracle().pendingOwner(), address(a.timelock()));
        assertEq(a.swapConfig().owner(), address(a.timelock()));
        assertTrue(a.oracle().isKeeper(BOT));
        assertTrue(a.oracle().isKeeper(OWNER));
        assertEq(a.timelock().getMinDelay(), 48 hours);
        assertTrue(a.timelock().hasRole(a.timelock().PROPOSER_ROLE(), OWNER));
        assertEq(b.reserve().yieldRouter(), address(a.yieldWait()));
        assertEq(b.bridgeOut().l1Recipient(), stakeAndLock);
        assertEq(b.feeSplitter().recipientA(), address(a.creatorWait()));
        assertEq(b.feeSplitter().recipientB(), address(b.allocator()));
    }

    function test_PreLaunch_FeesFlowIntoTheReserve() public {
        _connect();

        _fund(0.2 ether, 15e6, 100e18);
        uint256 w = IERC20(WHYPE).balanceOf(address(VAULT_INBOX));

        // Prices have no history yet: nothing can be swapped.
        VAULT_INBOX.forward(WHYPE);
        b.feeSplitter().distribute(WHYPE);
        InflowAllocator al = b.allocator();
        vm.expectRevert();
        al.allocate(WHYPE);

        _warm(4); // 40 minutes of readings
        al.allocate(WHYPE);
        _run(USDC);
        _run(KNTQ);

        // creator: 20% of each token, untouched
        assertEq(IERC20(WHYPE).balanceOf(address(a.creatorWait())), w / 5);
        assertEq(IERC20(USDC).balanceOf(address(a.creatorWait())), 3e6);
        assertEq(IERC20(KNTQ).balanceOf(address(a.creatorWait())), 20e18);

        // reserve: kHYPE locked, KNTQ at the bridge, USDC parked
        uint256 khype = IERC20(KHYPE).balanceOf(address(b.reserve()));
        uint256 kntq = IERC20(KNTQ).balanceOf(address(b.bridgeOut()));
        uint256 usdc = IERC20(USDC).balanceOf(address(a.liquidWait()));
        console2.log("kHYPE locked (1e-6):", khype / 1e12);
        console2.log("kHYPE principal in HYPE (1e-6):", b.reserve().principal(KHYPE) / 1e12);
        console2.log("KNTQ at the bridge (1e-3):", kntq / 1e15);
        console2.log("USDC parked for $liquid (1e-6):", usdc);
        assertGt(khype, 0);
        assertGt(b.reserve().principal(KHYPE), 0);
        assertGt(kntq, 32e18, "40% of 80 KNTQ directly, plus what WHYPE and USDC bought");
        assertGt(usdc, 2.4e6, "20% of 12 USDC directly, plus what WHYPE and KNTQ bought");
        for (uint256 i; i < 3; ++i) {
            address t = [WHYPE, USDC, KNTQ][i];
            assertEq(IERC20(t).balanceOf(address(b.allocator())), 0);
            assertEq(IERC20(t).balanceOf(address(b.feeSplitter())), 0);
        }

        // 40 / 40 / 20 by value: USDC parked is about half of each of the other two.
        uint256 kntqInUsdc = a.oracle().quote(KNTQ, USDC, kntq);
        uint256 khypeInUsdc = a.oracle().quote(KHYPE, USDC, khype);
        console2.log("value locked as kHYPE, USDC (1e-6):", khypeInUsdc);
        console2.log("value sent to KNTQ, USDC (1e-6):", kntqInUsdc);
        assertApproxEqRel(kntqInUsdc, usdc * 2, 0.05e18);
        assertApproxEqRel(khypeInUsdc, usdc * 2, 0.05e18);

        // The KNTQ share leaves through the canonical bridge.
        vm.etch(address(100), address(new MockArbSys()).code);
        uint256 supply = IERC20(KNTQ).totalSupply();
        assertEq(b.bridgeOut().bridge(), kntq);
        assertEq(supply - IERC20(KNTQ).totalSupply(), kntq, "burned on Elysium, released on HyperEVM");

        // The parked money cannot move until its target is set, and only the timelock can set it.
        FeeInbox lw = a.liquidWait();
        vm.expectRevert(FeeInbox.TargetNotSet.selector);
        lw.forward(USDC);
        vm.prank(OWNER);
        vm.expectRevert(FeeInbox.NotSetter.selector);
        lw.setTarget(OWNER);
    }

    function test_PreLaunch_LockedForGood_YieldWaits() public {
        _connect();
        _fund(0.2 ether, 0, 0);
        _warm(4);
        _run(WHYPE);
        LockedReserve r = b.reserve();
        uint256 principal = r.principal(KHYPE);
        uint256 locked = IERC20(KHYPE).balanceOf(address(r));

        // Nothing earned yet: nothing to take.
        assertEq(r.harvest(KHYPE), 0);
        assertEq(IERC20(KHYPE).balanceOf(address(r)), locked);

        // Extra kHYPE (stand-in for staking yield) can be harvested; the principal cannot.
        deal(KHYPE, address(this), 1e15);
        IERC20(KHYPE).transfer(address(r), 1e15);
        _warm(1);
        uint256 got = r.harvest(KHYPE);
        assertGt(got, 0);
        assertEq(IERC20(KHYPE).balanceOf(address(a.yieldWait())), got, "yield waits in its own contract");
        assertEq(r.principal(KHYPE), principal);
        assertGe(r.valueOf(KHYPE), principal);
    }

    function test_PreLaunch_PricesGoStale_NothingSwaps() public {
        _connect();
        _fund(0.2 ether, 0, 0);
        _warm(4);
        vm.warp(block.timestamp + 2 hours); // the bot stops
        VAULT_INBOX.forward(WHYPE);
        b.feeSplitter().distribute(WHYPE);
        InflowAllocator al = b.allocator();
        vm.expectRevert();
        al.allocate(WHYPE);
        // only the bot (or the owner wallet) may add readings while prices are fresh
        _warm(1);
        V4TwapOracle orc = a.oracle();
        vm.expectRevert();
        orc.poke(feeds);
    }

    function test_PreLaunch_TimelockTakesOverAndSetsTargets() public {
        TimelockController t = a.timelock();
        address sw = address(a.swapper());
        address orc = address(a.oracle());
        address lw = address(a.liquidWait());
        address buyer = makeAddr("liquid buyer");
        bytes memory accept = abi.encodeWithSignature("acceptOwnership()");
        bytes memory set = abi.encodeCall(FeeInbox.setTarget, (buyer));
        vm.startPrank(OWNER);
        t.schedule(sw, 0, accept, 0, 0, 48 hours);
        t.schedule(orc, 0, accept, 0, 0, 48 hours);
        t.schedule(lw, 0, set, 0, 0, 48 hours);
        vm.expectRevert();
        t.execute(sw, 0, accept, 0, 0); // not before the 48 hours are up
        vm.warp(block.timestamp + 48 hours);
        t.execute(sw, 0, accept, 0, 0);
        t.execute(orc, 0, accept, 0, 0);
        t.execute(lw, 0, set, 0, 0);
        vm.stopPrank();
        assertEq(a.swapper().owner(), address(t));
        assertEq(a.oracle().owner(), address(t));
        assertEq(a.liquidWait().target(), buyer);
    }
}

/// @notice The HyperEVM half on a copy of HyperEVM mainnet.
///
///   HYPEREVM_FORK=true forge test --match-contract PreLaunchHyperEvm -vv
contract PreLaunchHyperEvmTest is Test {
    ISkntq constant SKNTQ = ISkntq(0x696238e0Ca31c94e24ca4CBe7921754E172E4d0F);
    IERC20 constant KNTQ = IERC20(0x000000000000780555bD0BCA3791f89f9542c2d6);
    address constant L1_ERC20_GATEWAY = 0xd97B30dE0bA0C2eAeE942afce77530e06c5F122c;
    address yieldWait = makeAddr("Elysium yieldWait");

    ReserveLaunchH1 h1;
    ReserveLaunchH2 h2;

    function setUp() public {
        if (!vm.envOr("HYPEREVM_FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork("hyperevm");
        h1 = new ReserveLaunchH1(yieldWait);
        h2 = new ReserveLaunchH2(h1);
    }

    function test_PreLaunch_HyperEvm_StakeLockAndYield() public {
        assertEq(h1.yieldBridge().l2Recipient(), yieldWait);
        assertEq(h2.reserve().yieldRouter(), address(h1.yieldBridge()));

        // KNTQ arrives from Elysium, is staked as sKNTQ and locked.
        address sl = address(h2.stakeAndLock());
        vm.prank(L1_ERC20_GATEWAY);
        KNTQ.transfer(sl, 40e18);
        uint256 shares = h2.stakeAndLock().stake();
        assertGt(shares, 0);
        assertEq(IERC20(address(SKNTQ)).balanceOf(address(h2.reserve())), shares);
        uint256 principal = h2.reserve().principal(address(SKNTQ));
        assertApproxEqRel(principal, 40e18, 0.0001e18);

        // Rewards raise the sKNTQ rate; only that yield can leave, toward Elysium.
        vm.prank(L1_ERC20_GATEWAY);
        KNTQ.transfer(address(SKNTQ), 500_000e18);
        vm.warp(block.timestamp + 90 days);
        uint256 y = h2.reserve().harvest(address(SKNTQ));
        assertGt(y, 0);
        assertEq(h2.reserve().principal(address(SKNTQ)), principal);
        (uint256 id,) = h1.yieldBridge().requestUnstake();
        vm.warp(block.timestamp + 7 days + 1);
        uint256 assets = h1.yieldBridge().confirm(id);
        vm.deal(address(this), 1 ether);
        assertEq(h1.yieldBridge().bridge{value: 0.02 ether}(300_000, 0.5 gwei, 0.01 ether), assets);
    }
}
