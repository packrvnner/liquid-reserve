// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {UniswapV4Swapper} from "../../src/adapters/UniswapV4Swapper.sol";
import {V4TwapOracle} from "../../src/adapters/V4TwapOracle.sol";
import {FeeInbox} from "../../src/FeeInbox.sol";
import {FeeSplitter} from "../../src/FeeSplitter.sol";
import {InflowAllocator} from "../../src/InflowAllocator.sol";

interface ISeatFactory {
    struct LaunchParams {
        string name;
        string symbol;
        address quote;
        uint256 devBuyQuote;
        uint256 minDevOut;
        bytes32 salt;
        address creator;
        uint24 fee;
        uint24 builderFee;
    }

    struct SeatConfig {
        uint16 holderBpsQuote;
        uint16 holderBpsToken;
        uint16 buybackBps;
        bool burnBought;
        address devBuyTo;
        address[] payees;
        uint16[] bps;
    }

    function launchChecked(
        LaunchParams calldata p,
        SeatConfig calldata c,
        bytes32 seatSalt,
        address builder,
        address expectedRuleSet,
        int24 expectedStartTick
    ) external returns (address token, bytes32 poolId, address seat, address escrow);
}

interface IEscrowFactory {
    function ruleSet() external view returns (address);
}

interface ILaunchpad {
    function quoteConfig(address quote) external view returns (bool allowed, int24 startTick, uint128 maxClip);
    function currentFee(bytes32 poolId) external view returns (uint24);
    function accruedFees(bytes32 poolId) external view returns (uint256);
}

interface IEscrow {
    function settle() external;
    function claimable(address account) external view returns (uint256);
    function held() external view returns (uint256);
    function recipient() external view returns (address);
}

interface ISeat {
    function harvest() external;
    function claim(uint256 i, bool t) external returns (uint256);
    function claimable(uint256 i, bool t) external view returns (uint256);
    function slot(uint256 i) external view returns (address account, uint16 bps, address pending, uint40 lastSeen);
    function slotCount() external view returns (uint256);
    function sunset(uint256 i) external;
    function SUNSET_AFTER() external view returns (uint256);
    function pot(bool t) external view returns (uint256);
    function buybackPot(bool t) external view returns (uint256);
    function proposePayee(uint256 i, address next) external;
}

/// @notice Rehearsal: launch a stand-in for $liquid on Ascend (KNTQ pair, 2% fee, custom
/// mix 25% holders / 25% buyback-and-burn / 50% payee) with the LIVE vault fee inbox as
/// the payee, trade it, and follow the creator fees into the live reserve.
///
///   ELYSIUM_FORK=true forge test --match-contract AscendRehearsal -vv
contract AscendRehearsalTest is Test {
    IPoolManager constant PM = IPoolManager(0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1);
    ISeatFactory constant SEAT_FACTORY = ISeatFactory(0xBDB8d64452191041C4dAA3AD0f64bE4380FEA0b1);
    IEscrowFactory constant ESCROW_FACTORY = IEscrowFactory(0x63f6a8A8d0257c0363251a50cdE8A8b1046e4d19);
    address constant LAUNCHPAD = 0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC;
    address constant WHYPE = 0xbA876237B0F021A6c6D852d6c26E107997cC5E81;
    address constant KNTQ = 0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0;
    address constant KHYPE = 0x248888D396A546A69A188f3Deb476964e581E9d0;
    address constant USDC = 0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65;
    FeeInbox constant VAULT_INBOX = FeeInbox(0x2AfD3850794b84205667CE2826b09FA5bf1c3a5c);
    FeeSplitter constant SPLITTER = FeeSplitter(0x635321eE277e3aa3DDd62a2A63681dcB4fFC7E4e);
    InflowAllocator constant ALLOCATOR = InflowAllocator(0xB7c3865FfF8e88276a1D57D31869A2b0a839356f);
    V4TwapOracle constant ORACLE = V4TwapOracle(0x51670e163023CC3fa63d857A655A430321Fc1f56);
    address constant RESERVE = 0xeAd849357Ba8Dbc5A6F205AA0036Bd3d677b0D61;
    address constant BRIDGE_OUT = 0x0423ba7C14b3B0c986b1B6858598439A251Cc7d4;
    address constant CREATOR_WAIT = 0x0a3293Ee6D333A6Da9e0e09A9129b490193Bb1B4;
    address constant LIQUID_WAIT = 0x358B0d6eA642689C1C0f5424d36adB8B09DBcecB;
    address constant BOT = 0x0461663d46DA68264966a0670335E3ecf0b96F3C;

    address token;
    bytes32 poolId;
    ISeat seat;
    IEscrow escrow;
    UniswapV4Swapper swapper;
    address stranger = makeAddr("anyone at all");

    function setUp() public {
        if (!vm.envOr("ELYSIUM_FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork("elysium");

        (, int24 startTick,) = ILaunchpad(LAUNCHPAD).quoteConfig(KNTQ);
        address[] memory payees = new address[](1);
        payees[0] = address(VAULT_INBOX);
        uint16[] memory bps = new uint16[](1);
        bps[0] = 10_000; // the payees share what is left after holders and buyback: here all of the other 50%
        address seatAddr;
        address escrowAddr;
        (token, poolId, seatAddr, escrowAddr) = SEAT_FACTORY.launchChecked(
            ISeatFactory.LaunchParams("Liquid Reserve", "liquid", KNTQ, 0, 0, keccak256("rehearsal"), address(0), 20_000, 0),
            ISeatFactory.SeatConfig(2_500, 2_500, 2_500, true, address(0), payees, bps),
            keccak256("rehearsal seat"),
            address(0),
            ESCROW_FACTORY.ruleSet(),
            startTick
        );
        seat = ISeat(seatAddr);
        escrow = IEscrow(escrowAddr);

        // trade through the pool the way anyone can: straight through the pool manager
        swapper = new UniswapV4Swapper(address(this), PM, WHYPE);
        (address c0, address c1) = token < KNTQ ? (token, KNTQ) : (KNTQ, token);
        PoolKey memory key = PoolKey(Currency.wrap(c0), Currency.wrap(c1), 0x800000, 200, IHooks(LAUNCHPAD));
        UniswapV4Swapper.Hop[] memory hop = new UniswapV4Swapper.Hop[](1);
        hop[0] = UniswapV4Swapper.Hop(UniswapV4Swapper.HopKind.V4_SWAP, key, KNTQ == c0, address(0));
        swapper.setRoute(KNTQ, token, hop);
        hop[0].zeroForOne = token == c0;
        swapper.setRoute(token, KNTQ, hop);
    }

    function _trade(uint256 rounds, uint256 kntqEach) internal {
        deal(KNTQ, address(this), rounds * kntqEach);
        for (uint256 i; i < rounds; ++i) {
            IERC20(KNTQ).approve(address(swapper), kntqEach);
            uint256 got = swapper.swap(KNTQ, token, kntqEach, 0, address(this));
            IERC20(token).approve(address(swapper), got);
            swapper.swap(token, KNTQ, got, 0, address(this));
        }
    }

    function test_Rehearsal_LaunchTradeClaimIntoReserve() public {
        console2.log("coin:", token);
        console2.log("pool fee (pips):", ILaunchpad(LAUNCHPAD).currentFee(poolId));
        assertEq(escrow.recipient(), address(seat), "the escrow pays the seat");
        (address payee, uint16 share,,) = seat.slot(0);
        assertEq(payee, address(VAULT_INBOX), "the seat's payee is the fee contract");
        assertEq(share, 10_000);
        assertEq(seat.slotCount(), 1);

        // 1. trading: 10 buys of 400 KNTQ and 10 sells
        _trade(10, 400e18);
        console2.log("fees waiting in the launchpad (KNTQ 1e-3):", ILaunchpad(LAUNCHPAD).accruedFees(poolId) / 1e15);

        // 2. anyone settles the escrow and harvests the seat
        vm.startPrank(stranger);
        escrow.settle();
        console2.log("escrow: claimable by the seat (KNTQ 1e-3):", escrow.claimable(address(seat)) / 1e15);
        console2.log("escrow: held back until release (KNTQ 1e-3):", escrow.held() / 1e15);
        seat.harvest();
        vm.stopPrank();
        uint256 due = seat.claimable(0, false);
        console2.log("seat: payee can claim (KNTQ 1e-3):", due / 1e15);
        console2.log("seat: holders' pot (KNTQ 1e-3):", seat.pot(false) / 1e15);
        console2.log("seat: buyback pot (KNTQ 1e-3):", seat.buybackPot(false) / 1e15);
        assertGt(due, 0, "the payee has something to claim");

        // 3. can ANYONE trigger the payee's claim? (the fee contract cannot call anything itself)
        uint256 before = IERC20(KNTQ).balanceOf(address(VAULT_INBOX));
        vm.prank(stranger);
        (bool ok,) = address(seat).call(abi.encodeCall(ISeat.claim, (0, false)));
        uint256 got = IERC20(KNTQ).balanceOf(address(VAULT_INBOX)) - before;
        console2.log("claim sent by a stranger went through:", ok);
        console2.log("KNTQ that reached the fee contract (1e-3):", got / 1e15);
        assertTrue(ok && got == due, "a stranger's claim must pay the fee contract in full");
        assertEq(IERC20(KNTQ).balanceOf(stranger), 0, "nothing went to the caller");

        // 4. into the live reserve: prices warmed the way the bot does it, then forward, split, buy and lock
        bytes32[3] memory ids = [
            bytes32(0xb3032695ffb0a66e6342876dd2386835471466cb2bb70f341947d98a69e265cc),
            0xf9b8a9101438145d62c9f03156b203c6c573931167e2d36f9061a32575706c8a,
            0x890fc38d3b7ce4482eaab02250be48f596aec0b60c10f29fa2d1ccf356c3740c
        ];
        PoolId[] memory feeds = new PoolId[](3);
        for (uint256 i; i < 3; ++i) feeds[i] = PoolId.wrap(ids[i]);
        for (uint256 i; i < 4; ++i) {
            vm.warp(block.timestamp + 600);
            vm.prank(BOT);
            ORACLE.poke(feeds);
        }
        uint256 inInbox = IERC20(KNTQ).balanceOf(address(VAULT_INBOX));
        uint256[4] memory b0 = [
            IERC20(KHYPE).balanceOf(RESERVE),
            IERC20(KNTQ).balanceOf(BRIDGE_OUT),
            IERC20(USDC).balanceOf(LIQUID_WAIT),
            IERC20(KNTQ).balanceOf(CREATOR_WAIT)
        ];
        vm.startPrank(stranger);
        VAULT_INBOX.forward(KNTQ);
        SPLITTER.distribute(KNTQ);
        ALLOCATOR.allocate(KNTQ);
        vm.stopPrank();
        console2.log("KNTQ forwarded from the fee contract (1e-3):", inInbox / 1e15);
        console2.log("  creator's waiting contract +KNTQ (1e-3):", (IERC20(KNTQ).balanceOf(CREATOR_WAIT) - b0[3]) / 1e15);
        console2.log("  kHYPE locked in the reserve + (1e-6):", (IERC20(KHYPE).balanceOf(RESERVE) - b0[0]) / 1e12);
        console2.log("  KNTQ at the bridge + (1e-3):", (IERC20(KNTQ).balanceOf(BRIDGE_OUT) - b0[1]) / 1e15);
        console2.log("  USDC parked for the $liquid share + (1e-6):", IERC20(USDC).balanceOf(LIQUID_WAIT) - b0[2]);
        assertEq(IERC20(KNTQ).balanceOf(CREATOR_WAIT) - b0[3], inInbox / 5);
        assertGt(IERC20(KHYPE).balanceOf(RESERVE), b0[0]);
        assertEq(IERC20(KNTQ).balanceOf(BRIDGE_OUT) - b0[1], (inInbox - inInbox / 5) * 4 / 10);
        assertGt(IERC20(USDC).balanceOf(LIQUID_WAIT), b0[2]);
    }

    /// Can the fee contract lose its payee slot by being "idle"? It cannot call anything itself.
    function test_Rehearsal_PayeeSlotOverTime() public {
        uint256 sunsetAfter = seat.SUNSET_AFTER();
        console2.log("an idle payee can be removed after (days):", sunsetAfter / 1 days);
        (,,, uint40 seen0) = seat.slot(0);
        console2.log("slot last seen at launch:", seen0, "now:", block.timestamp);

        _trade(4, 400e18);
        vm.startPrank(stranger);
        escrow.settle();
        seat.harvest();
        vm.stopPrank();

        // (a) nobody ever claims: can a stranger remove the slot after the idle period?
        uint256 snap = vm.snapshotState();
        vm.warp(block.timestamp + sunsetAfter + 1 days);
        vm.prank(stranger);
        (bool removedIdle,) = address(seat).call(abi.encodeCall(ISeat.sunset, (0)));
        console2.log("(a) never claimed: slot removable after the idle period:", removedIdle);
        vm.revertToState(snap);

        // (b) a stranger (the bot) claims for it along the way: does that count as activity?
        vm.warp(block.timestamp + sunsetAfter / 2);
        vm.prank(stranger);
        seat.claim(0, false);
        (,,, uint40 seen1) = seat.slot(0);
        console2.log("(b) last seen moved forward by a stranger's claim:", seen1 > seen0);
        vm.warp(block.timestamp + sunsetAfter / 2 + 2 days);
        vm.prank(stranger);
        (bool removedActive,) = address(seat).call(abi.encodeCall(ISeat.sunset, (0)));
        console2.log("(b) claimed halfway: slot removable at the original deadline:", removedActive);

        // (c) the payee slot can only be handed on by the payee itself; a contract payee never can
        vm.prank(stranger);
        (bool moved,) = address(seat).call(abi.encodeCall(ISeat.proposePayee, (0, stranger)));
        assertFalse(moved, "a stranger cannot take over the payee slot");
    }
}

interface IWrappedHype {
    function deposit() external payable;
}

/// @notice The same rehearsal with $liquid paired with HYPE instead of KNTQ: the creator
/// fees then arrive as wrapped HYPE.
contract AscendRehearsalHypePairTest is Test {
    IPoolManager constant PM = IPoolManager(0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1);
    ISeatFactory constant SEAT_FACTORY = ISeatFactory(0xBDB8d64452191041C4dAA3AD0f64bE4380FEA0b1);
    IEscrowFactory constant ESCROW_FACTORY = IEscrowFactory(0x63f6a8A8d0257c0363251a50cdE8A8b1046e4d19);
    address constant LAUNCHPAD = 0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC;
    address constant WHYPE = 0xbA876237B0F021A6c6D852d6c26E107997cC5E81;
    address constant KNTQ = 0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0;
    address constant KHYPE = 0x248888D396A546A69A188f3Deb476964e581E9d0;
    address constant USDC = 0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65;
    FeeInbox constant VAULT_INBOX = FeeInbox(0x2AfD3850794b84205667CE2826b09FA5bf1c3a5c);
    FeeSplitter constant SPLITTER = FeeSplitter(0x635321eE277e3aa3DDd62a2A63681dcB4fFC7E4e);
    InflowAllocator constant ALLOCATOR = InflowAllocator(0xB7c3865FfF8e88276a1D57D31869A2b0a839356f);
    V4TwapOracle constant ORACLE = V4TwapOracle(0x51670e163023CC3fa63d857A655A430321Fc1f56);
    address constant RESERVE = 0xeAd849357Ba8Dbc5A6F205AA0036Bd3d677b0D61;
    address constant BRIDGE_OUT = 0x0423ba7C14b3B0c986b1B6858598439A251Cc7d4;
    address constant CREATOR_WAIT = 0x0a3293Ee6D333A6Da9e0e09A9129b490193Bb1B4;
    address constant LIQUID_WAIT = 0x358B0d6eA642689C1C0f5424d36adB8B09DBcecB;
    address constant BOT = 0x0461663d46DA68264966a0670335E3ecf0b96F3C;

    address token;
    bytes32 poolId;
    ISeat seat;
    IEscrow escrow;
    UniswapV4Swapper swapper;
    address stranger = makeAddr("anyone at all");

    function _launch() internal {
        (bool allowed, int24 startTick, uint128 maxClip) = ILaunchpad(LAUNCHPAD).quoteConfig(WHYPE);
        console2.log("HYPE pairs allowed:", allowed);
        console2.log("largest single trade at launch (HYPE 1e-3):", uint256(maxClip) / 1e15);
        address[] memory payees = new address[](1);
        payees[0] = address(VAULT_INBOX);
        uint16[] memory bps = new uint16[](1);
        bps[0] = 10_000;
        address seatAddr;
        address escrowAddr;
        (token, poolId, seatAddr, escrowAddr) = SEAT_FACTORY.launchChecked(
            ISeatFactory.LaunchParams("Liquid Reserve", "liquid", WHYPE, 0, 0, keccak256("rehearsal hype"), address(0), 20_000, 0),
            ISeatFactory.SeatConfig(2_500, 2_500, 2_500, true, address(0), payees, bps),
            keccak256("rehearsal seat hype"),
            address(0),
            ESCROW_FACTORY.ruleSet(),
            startTick
        );
        seat = ISeat(seatAddr);
        escrow = IEscrow(escrowAddr);

        swapper = new UniswapV4Swapper(address(this), PM, WHYPE);
        (address c0, address c1) = token < WHYPE ? (token, WHYPE) : (WHYPE, token);
        PoolKey memory key = PoolKey(Currency.wrap(c0), Currency.wrap(c1), 0x800000, 200, IHooks(LAUNCHPAD));
        UniswapV4Swapper.Hop[] memory hop = new UniswapV4Swapper.Hop[](1);
        hop[0] = UniswapV4Swapper.Hop(UniswapV4Swapper.HopKind.V4_SWAP, key, WHYPE == c0, address(0));
        swapper.setRoute(WHYPE, token, hop);
        hop[0].zeroForOne = token == c0;
        swapper.setRoute(token, WHYPE, hop);
    }

    /// 10 buys of 1 HYPE and 10 sells
    function _trade() internal {
        vm.deal(address(this), 10 ether);
        IWrappedHype(WHYPE).deposit{value: 10 ether}();
        for (uint256 i; i < 10; ++i) {
            IERC20(WHYPE).approve(address(swapper), 1 ether);
            uint256 got = swapper.swap(WHYPE, token, 1 ether, 0, address(this));
            IERC20(token).approve(address(swapper), got);
            swapper.swap(token, WHYPE, got, 0, address(this));
        }
        console2.log("fees waiting in the launchpad (HYPE 1e-6):", ILaunchpad(LAUNCHPAD).accruedFees(poolId) / 1e12);
    }

    /// The claim must arrive as wrapped HYPE: the fee contract cannot receive plain HYPE.
    function _claim() internal {
        vm.startPrank(stranger);
        escrow.settle();
        seat.harvest();
        vm.stopPrank();
        uint256 due = seat.claimable(0, false);
        console2.log("seat: recipient can claim (HYPE 1e-6):", due / 1e12);
        console2.log("escrow: held back until release (HYPE 1e-6):", escrow.held() / 1e12);
        assertGt(due, 0);
        uint256 before = IERC20(WHYPE).balanceOf(address(VAULT_INBOX));
        uint256 plainBefore = address(VAULT_INBOX).balance;
        vm.prank(stranger);
        (bool ok,) = address(seat).call(abi.encodeCall(ISeat.claim, (0, false)));
        uint256 got = IERC20(WHYPE).balanceOf(address(VAULT_INBOX)) - before;
        console2.log("claim sent by a stranger went through:", ok);
        console2.log("wrapped HYPE that reached the fee contract (1e-6):", got / 1e12);
        assertTrue(ok && got == due, "a stranger's claim must pay the fee contract in full, as wrapped HYPE");
        assertEq(address(VAULT_INBOX).balance, plainBefore, "no plain HYPE involved");
    }

    function _intoReserve() internal {
        bytes32[3] memory ids = [
            bytes32(0xb3032695ffb0a66e6342876dd2386835471466cb2bb70f341947d98a69e265cc),
            0xf9b8a9101438145d62c9f03156b203c6c573931167e2d36f9061a32575706c8a,
            0x890fc38d3b7ce4482eaab02250be48f596aec0b60c10f29fa2d1ccf356c3740c
        ];
        PoolId[] memory feeds = new PoolId[](3);
        for (uint256 i; i < 3; ++i) feeds[i] = PoolId.wrap(ids[i]);
        for (uint256 i; i < 4; ++i) {
            vm.warp(block.timestamp + 600);
            vm.prank(BOT);
            ORACLE.poke(feeds);
        }
        uint256 inInbox = IERC20(WHYPE).balanceOf(address(VAULT_INBOX));
        uint256[4] memory b0 = [
            IERC20(KHYPE).balanceOf(RESERVE),
            IERC20(KNTQ).balanceOf(BRIDGE_OUT),
            IERC20(USDC).balanceOf(LIQUID_WAIT),
            IERC20(WHYPE).balanceOf(CREATOR_WAIT)
        ];
        vm.startPrank(stranger);
        VAULT_INBOX.forward(WHYPE);
        SPLITTER.distribute(WHYPE);
        ALLOCATOR.allocate(WHYPE);
        vm.stopPrank();
        console2.log("wrapped HYPE forwarded from the fee contract (1e-6):", inInbox / 1e12);
        console2.log("  creator's waiting contract +HYPE (1e-6):", (IERC20(WHYPE).balanceOf(CREATOR_WAIT) - b0[3]) / 1e12);
        console2.log("  kHYPE locked in the reserve + (1e-6):", (IERC20(KHYPE).balanceOf(RESERVE) - b0[0]) / 1e12);
        console2.log("  KNTQ at the bridge + (1e-3):", (IERC20(KNTQ).balanceOf(BRIDGE_OUT) - b0[1]) / 1e15);
        console2.log("  USDC parked for the $liquid share + (1e-6):", IERC20(USDC).balanceOf(LIQUID_WAIT) - b0[2]);
        assertEq(IERC20(WHYPE).balanceOf(CREATOR_WAIT) - b0[3], inInbox / 5);
        assertGt(IERC20(KHYPE).balanceOf(RESERVE), b0[0]);
        assertGt(IERC20(KNTQ).balanceOf(BRIDGE_OUT), b0[1]);
        assertGt(IERC20(USDC).balanceOf(LIQUID_WAIT), b0[2]);
    }

    /// Since Elysium block 10,457,235 (2026-11-25 01:22 UTC) the reserve no longer buys KNTQ with HYPE fees, which
    /// the last step here still expects. That change was one of four owner steps in blocks 10,457,168 to
    /// 10,457,277, so this rehearsal runs on the chain as it stood one block before the first of them.
    uint256 constant BEFORE_THE_REAL_STEPS = 10_457_167;

    function test_Rehearsal_HypePair_LaunchTradeClaimIntoReserve() public {
        if (!vm.envOr("ELYSIUM_FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork("elysium", BEFORE_THE_REAL_STEPS);
        _launch();
        _trade();
        _claim();
        _intoReserve();
    }
}
