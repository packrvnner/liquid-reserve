// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {FeeInbox} from "../../src/FeeInbox.sol";
import {InflowAllocator} from "../../src/InflowAllocator.sol";
import {SwapConfig} from "../../src/SwapConfig.sol";
import {LockedReserve} from "../../src/LockedReserve.sol";
import {DropFeeder} from "../../src/DropFeeder.sol";
import {V4TwapOracle} from "../../src/adapters/V4TwapOracle.sol";
import {UniswapV4Swapper} from "../../src/adapters/UniswapV4Swapper.sol";
import {HypeOnlyRouter} from "../../src/adapters/HypeOnlyRouter.sol";
import {ISwapper} from "../../src/interfaces/ISwapper.sol";
import {IPriceOracle} from "../../src/interfaces/IPriceOracle.sol";

interface IWrappedHype2 {
    function deposit() external payable;
}

/// @notice The drop feeder against the LIVE reserve on a copy of Elysium mainnet: the real oracle, swapper,
/// SwapConfig, locked reserve, the contract where the 20% USDC share waits, Ascend's $liquid pool and burn address.
/// The timelock's part (routes for USDC to $liquid, and pointing the waiting contract at the feeder) is done as
/// the timelock.
///
///   ELYSIUM_FORK=true forge test --match-contract DropFeederFork -vv
contract DropFeederForkTest is Test {
    address constant TIMELOCK = 0xa9e0FEAf8032c669803F68af7e93370D86e03c7F;
    address constant BOT = 0x0461663d46DA68264966a0670335E3ecf0b96F3C; // the oracle's price reader, and the drop
    address constant WHYPE = 0xbA876237B0F021A6c6D852d6c26E107997cC5E81;
    address constant USDC = 0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65;
    address constant KNTQ = 0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0;
    address constant KHYPE = 0x248888D396A546A69A188f3Deb476964e581E9d0;
    address constant LIQUID = 0x247c91C14b5Aa1cF57f02d638B0287F5cd69E9f6;
    address constant BURN_SINK = 0x9F0b0e3B362937b07Cd1E869b50687961e0c7741;
    address constant POOL_MANAGER = 0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1;
    address constant ASCEND_HOOK = 0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC;
    InflowAllocator constant ALLOCATOR = InflowAllocator(0xB7c3865FfF8e88276a1D57D31869A2b0a839356f);
    SwapConfig constant CONFIG = SwapConfig(0xe885e7D7Fda7e481Fe7466C4adB93b0C3045FF87);
    V4TwapOracle constant ORACLE = V4TwapOracle(0x51670e163023CC3fa63d857A655A430321Fc1f56);
    UniswapV4Swapper constant SWAPPER = UniswapV4Swapper(payable(0xC728E5B5eF36dbbEE5920c8956EB1c145B8badE4));
    LockedReserve constant RESERVE = LockedReserve(0xeAd849357Ba8Dbc5A6F205AA0036Bd3d677b0D61);
    FeeInbox constant LIQUID_WAIT = FeeInbox(0x358B0d6eA642689C1C0f5424d36adB8B09DBcecB); // where the 20% USDC share waits
    /// The timelock's part was carried out for real on 2026-11-25, in Elysium blocks 10,457,168 to 10,457,277
    /// (01:21 to 01:22 UTC); the waiting contract was pointed at the live feeder in the last of them, and that
    /// can be done only once. So this rehearsal runs on the chain as it stood one block before the first.
    uint256 constant BEFORE_THE_REAL_STEPS = 10_457_167;

    DropFeeder feeder;
    PoolId[] feeds;
    PoolId ascendId;
    PoolId hypeUsdcId;
    address stranger = makeAddr("stranger");

    function setUp() public {
        if (!vm.envOr("ELYSIUM_FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork("elysium", BEFORE_THE_REAL_STEPS);
        feeder = new DropFeeder(
            TIMELOCK, IERC20(USDC), IERC20(LIQUID), IERC20(KHYPE), BURN_SINK, RESERVE, IPriceOracle(address(ORACLE)), ISwapper(address(SWAPPER)), CONFIG, BOT
        );

        (PoolId[] memory p1,) = ORACLE.getRoute(KNTQ, KHYPE); // HYPE/KNTQ, kHYPE/WHYPE
        (PoolId[] memory p2,) = ORACLE.getRoute(WHYPE, USDC); // HYPE/USDC
        hypeUsdcId = p2[0];
        PoolKey memory ascend = PoolKey(Currency.wrap(LIQUID), Currency.wrap(WHYPE), 0x800000, 200, IHooks(ASCEND_HOOK));
        PoolKey memory hypeUsdc = PoolKey(Currency.wrap(address(0)), Currency.wrap(USDC), 3000, 60, IHooks(address(0)));
        ascendId = ascend.toId();

        // ---- the timelock's part
        vm.startPrank(TIMELOCK);
        (,, uint32 lastTime,,,,) = ORACLE.feeds(ascendId);
        if (lastTime == 0) ORACLE.addFeed(ascend); // comes with the $liquid route's own timelock step
        PoolId[] memory path = new PoolId[](2);
        path[0] = hypeUsdcId;
        path[1] = ascendId;
        uint24[] memory fees = new uint24[](2);
        fees[0] = 3000;
        fees[1] = 20000; // Ascend's hook takes 2%
        ORACLE.setRoute(USDC, LIQUID, path, fees);
        UniswapV4Swapper.Hop[] memory hops = new UniswapV4Swapper.Hop[](2);
        hops[0] = UniswapV4Swapper.Hop(UniswapV4Swapper.HopKind.V4_SWAP, hypeUsdc, false, address(0)); // USDC in, HYPE out
        hops[1] = UniswapV4Swapper.Hop(UniswapV4Swapper.HopKind.V4_SWAP, ascend, false, address(0)); // HYPE in, $liquid out
        SWAPPER.setRoute(USDC, LIQUID, hops);
        LIQUID_WAIT.setTarget(address(feeder));
        vm.stopPrank();

        feeds.push(p1[0]);
        feeds.push(p1[1]);
        feeds.push(hypeUsdcId);
        feeds.push(ascendId);
        _warm(5);
    }

    /// The bot's rhythm: one price reading every 10 minutes, until the 30-minute average is fresh.
    function _warm(uint256 rounds) internal {
        for (uint256 i; i < rounds; ++i) {
            vm.warp(block.timestamp + 600);
            vm.prank(BOT);
            ORACLE.poke(feeds);
        }
    }

    function _whype(uint256 amount) internal {
        vm.deal(address(this), amount);
        IWrappedHype2(WHYPE).deposit{value: amount}();
    }

    /// More of the USDC share arrives at the waiting contract (bought with HYPE through the real swapper).
    function _usdcShare(uint256 hype) internal {
        _whype(hype);
        IERC20(WHYPE).approve(address(SWAPPER), hype);
        SWAPPER.swap(WHYPE, USDC, hype, 0, address(LIQUID_WAIT));
    }

    function _forward() internal returns (uint256 usdcAtFeeder) {
        LIQUID_WAIT.forward(USDC);
        return IERC20(USDC).balanceOf(address(feeder));
    }

    /// Puts `amount` of $liquid in a wallet, taken from the pool manager's holdings (test only).
    function _giveLiquid(address to, uint256 amount) internal {
        vm.prank(POOL_MANAGER);
        IERC20(LIQUID).transfer(to, amount);
    }

    function _nothingLeft() internal view {
        assertEq(IERC20(KHYPE).balanceOf(address(feeder)), 0, "feeder holds kHYPE");
        assertEq(IERC20(LIQUID).balanceOf(address(feeder)), 0, "feeder holds $liquid");
        assertEq(IERC20(WHYPE).balanceOf(address(feeder)), 0, "feeder holds WHYPE");
    }

    // ---------------------------------------------------------------------

    function test_TheWaitingShareCanOnlyGoToTheFeeder() public {
        assertEq(LIQUID_WAIT.target(), address(feeder));
        vm.prank(TIMELOCK);
        vm.expectRevert(FeeInbox.TargetAlreadySet.selector);
        LIQUID_WAIT.setTarget(stranger);
    }

    function test_Feed_HalfLockedAsKhype_HalfToTheDrop() public {
        uint256 usdcIn = _forward(); // what really waits today
        assertGt(usdcIn, 0);
        uint256 half = usdcIn * 5000 / 10_000;
        uint256 expectKhype = ORACLE.quote(USDC, KHYPE, usdcIn - half);
        uint256 expectLiquid = ORACLE.quote(USDC, LIQUID, half);
        uint256 khype0 = IERC20(KHYPE).balanceOf(address(RESERVE));
        uint256 principal0 = RESERVE.principal(KHYPE);
        uint256 drop0 = IERC20(LIQUID).balanceOf(BOT);

        vm.prank(stranger); // anyone may call it
        (uint256 toReserve, uint256 toDrop, uint256 toBurn) = feeder.feed(type(uint256).max);

        assertEq(IERC20(KHYPE).balanceOf(address(RESERVE)) - khype0, toReserve);
        assertApproxEqRel(toReserve, expectKhype, 0.01e18, "half buys kHYPE at the average price");
        assertGt(RESERVE.principal(KHYPE), principal0, "locked as principal");
        assertEq(IERC20(LIQUID).balanceOf(BOT) - drop0, toDrop);
        assertApproxEqRel(toDrop, expectLiquid, 0.01e18, "half buys $liquid at the average price");
        assertEq(toBurn, 0, "nothing burns while the drop has room");
        assertEq(IERC20(USDC).balanceOf(address(feeder)), 0);
        assertEq(feeder.usdcUsed(), usdcIn);
        assertEq(feeder.khypeLocked(), toReserve);
        assertEq(feeder.sentToDrop(), toDrop);
        assertEq(feeder.burned(), 0);
        _nothingLeft();
        console2.log("USDC used:", usdcIn);
        console2.log("kHYPE locked (wei):", toReserve);
        console2.log("$liquid to the drop (whole tokens):", toDrop / 1e18);
        console2.log("drop is full at (whole tokens):", feeder.cap() / 1e18);
    }

    function test_Cap_IsFivePercentOfWhatIsNotBurned() public {
        assertEq(feeder.cap(), (IERC20(LIQUID).totalSupply() - IERC20(LIQUID).balanceOf(BURN_SINK)) * 500 / 10_000);
        assertEq(feeder.cap(), 50_000_000e18, "50 million today: nothing has been burned yet");
        _giveLiquid(BURN_SINK, 100_000_000e18);
        assertEq(feeder.cap(), 45_000_000e18, "burning shrinks the line");
    }

    function test_AtTheLine_WhatFitsGoesIn_TheRestBurns_ThenEverythingBurns() public {
        _forward();
        uint256 half = IERC20(USDC).balanceOf(address(feeder)) * 5000 / 10_000;
        uint256 willBuy = ORACLE.quote(USDC, LIQUID, half);
        // the drop is 1/3 of this purchase short of full
        _giveLiquid(BOT, feeder.cap() - IERC20(LIQUID).balanceOf(BOT) - willBuy / 3);
        uint256 space = feeder.room();
        assertApproxEqAbs(space, willBuy / 3, 1);

        uint256 drop0 = IERC20(LIQUID).balanceOf(BOT);
        (, uint256 toDrop, uint256 toBurn) = feeder.feed(type(uint256).max);
        assertEq(toDrop, space, "exactly what fits");
        assertGt(toBurn, toDrop, "the rest burns");
        assertEq(IERC20(LIQUID).balanceOf(BOT) - drop0, toDrop);
        assertEq(IERC20(LIQUID).balanceOf(BURN_SINK), toBurn);
        assertEq(feeder.burned(), toBurn);
        assertEq(feeder.room(), 0, "full");
        assertGe(feeder.held(), feeder.cap(), "at or above the line, which the burn itself just lowered");

        // the next purchase burns whole
        _usdcShare(0.05 ether);
        _forward();
        _warm(1);
        uint256 dropBefore = IERC20(LIQUID).balanceOf(BOT);
        (uint256 toReserve2, uint256 toDrop2, uint256 toBurn2) = feeder.feed(type(uint256).max);
        assertGt(toReserve2, 0, "the reserve's half is still locked");
        assertEq(toDrop2, 0);
        assertGt(toBurn2, 0);
        assertEq(IERC20(LIQUID).balanceOf(BOT), dropBefore, "the drop itself is never touched");
        assertEq(feeder.burned(), toBurn + toBurn2);
        _nothingLeft();
    }

    /// The drop is a wallet, so it can be emptied by whoever holds its key. What it was sent still counts.
    function test_AnEmptiedDropDoesNotGetASecondFilling() public {
        _forward();
        feeder.feed(type(uint256).max);
        uint256 sent = feeder.sentToDrop();
        vm.startPrank(BOT);
        IERC20(LIQUID).transfer(stranger, IERC20(LIQUID).balanceOf(BOT)); // the wallet is emptied
        vm.stopPrank();
        assertEq(IERC20(LIQUID).balanceOf(BOT), 0);
        assertEq(feeder.held(), sent, "it still counts as holding what it was sent");
        assertEq(feeder.room(), feeder.cap() - sent, "so the most it can ever be sent is one line's worth");
    }

    function test_Feed_InPieces() public {
        _usdcShare(0.2 ether);
        uint256 usdcIn = _forward();
        feeder.feed(1_000_000); // one dollar
        assertEq(IERC20(USDC).balanceOf(address(feeder)), usdcIn - 1_000_000, "the rest waits");
        assertEq(feeder.usdcUsed(), 1_000_000);
        feeder.feed(type(uint256).max);
        assertEq(IERC20(USDC).balanceOf(address(feeder)), 0);
        _nothingLeft();
    }

    function test_Feed_ThePriceLimitHolds() public {
        uint256 usdcIn = _forward();
        uint256 half = usdcIn * 5000 / 10_000;
        uint256 fair = ORACLE.quote(USDC, LIQUID, half);
        // the average says $liquid is 5% cheaper than the pool will give
        vm.mockCall(address(ORACLE), abi.encodeCall(IPriceOracle.quote, (USDC, LIQUID, half)), abi.encode(fair * 105 / 100));
        vm.expectRevert();
        feeder.feed(type(uint256).max);
        vm.clearMockedCalls();
        feeder.feed(type(uint256).max);
    }

    function test_Feed_StalePricesStopIt() public {
        _forward();
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert();
        feeder.feed(type(uint256).max);
    }

    function test_Feed_NothingWaiting() public {
        vm.expectRevert(DropFeeder.NothingToFeed.selector);
        feeder.feed(type(uint256).max);
    }

    function test_OnlyTheTimelockCanChangeTheDropOrNameASuccessor() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        feeder.setDrop(stranger);
        vm.prank(BOT);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, BOT));
        feeder.setSuccessor(stranger);

        address newDrop = makeAddr("new drop wallet");
        vm.prank(TIMELOCK);
        feeder.setDrop(newDrop);
        _forward();
        (, uint256 toDrop,) = feeder.feed(type(uint256).max);
        assertEq(IERC20(LIQUID).balanceOf(newDrop), toDrop, "the new wallet receives");
    }

    function test_Successor_TakesTheUsdcInstead() public {
        address next = makeAddr("successor");
        vm.prank(TIMELOCK);
        feeder.setSuccessor(next);
        uint256 usdcIn = _forward();
        uint256 khype0 = IERC20(KHYPE).balanceOf(address(RESERVE));
        (uint256 a, uint256 b, uint256 c) = feeder.feed(type(uint256).max);
        assertEq(a + b + c, 0);
        assertEq(IERC20(USDC).balanceOf(next), usdcIn, "all of it passes on");
        assertEq(IERC20(KHYPE).balanceOf(address(RESERVE)), khype0, "nothing is bought here any more");
        assertEq(feeder.usdcUsed(), 0);
    }

    /// The whole of flywheel v2 on one fee: the HYPE-only router plus the feeder.
    function test_WithTheRouter_AFeeEndsNinetyPercentStakedHype_TenPercentLiquid() public {
        HypeOnlyRouter router = new HypeOnlyRouter(IPriceOracle(address(ORACLE)), ISwapper(address(SWAPPER)), CONFIG, RESERVE, KHYPE, KNTQ);
        vm.startPrank(TIMELOCK);
        CONFIG.setOracle(IPriceOracle(address(router)));
        CONFIG.setSwapper(ISwapper(address(router)));
        vm.stopPrank();
        // clear what waits today, so only this fee is measured
        _forward();
        feeder.feed(type(uint256).max);

        uint256 fee = 0.3 ether;
        uint256 khypePerHype = ORACLE.quote(WHYPE, KHYPE, 1 ether);
        uint256 liquidFor10 = ORACLE.quote(USDC, LIQUID, ORACLE.quote(WHYPE, USDC, fee / 10));
        uint256 khype0 = IERC20(KHYPE).balanceOf(address(RESERVE));
        uint256 drop0 = IERC20(LIQUID).balanceOf(BOT);
        uint256 kntq0 = IERC20(KNTQ).balanceOf(0x0423ba7C14b3B0c986b1B6858598439A251Cc7d4);

        _whype(fee);
        IERC20(WHYPE).transfer(address(ALLOCATOR), fee);
        ALLOCATOR.allocate(WHYPE);
        _forward();
        feeder.feed(type(uint256).max);

        uint256 lockedInHype = (IERC20(KHYPE).balanceOf(address(RESERVE)) - khype0) * 1 ether / khypePerHype;
        assertApproxEqRel(lockedInHype, fee * 9 / 10, 0.012e18, "90% of the fee is locked as staked HYPE");
        assertApproxEqRel(IERC20(LIQUID).balanceOf(BOT) - drop0, liquidFor10, 0.015e18, "10% of the fee reaches the drop as $liquid");
        assertEq(IERC20(KNTQ).balanceOf(0x0423ba7C14b3B0c986b1B6858598439A251Cc7d4), kntq0, "no KNTQ");
        _nothingLeft();
        console2.log("of a 0.3 HYPE fee, locked as staked HYPE (in HYPE, wei):", lockedInHype);
        console2.log("$liquid to the drop (whole tokens):", (IERC20(LIQUID).balanceOf(BOT) - drop0) / 1e18);
    }
}
