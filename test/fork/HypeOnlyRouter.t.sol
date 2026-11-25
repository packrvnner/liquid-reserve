// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {InflowAllocator} from "../../src/InflowAllocator.sol";
import {SwapConfig} from "../../src/SwapConfig.sol";
import {LockedReserve} from "../../src/LockedReserve.sol";
import {V4TwapOracle} from "../../src/adapters/V4TwapOracle.sol";
import {HypeOnlyRouter} from "../../src/adapters/HypeOnlyRouter.sol";
import {ISwapper} from "../../src/interfaces/ISwapper.sol";
import {IPriceOracle} from "../../src/interfaces/IPriceOracle.sol";

interface IWrappedHype {
    function deposit() external payable;
}

/// @notice The HYPE-only router against the LIVE reserve on a copy of Elysium mainnet: the real allocator,
/// SwapConfig, oracle, swapper and locked reserve. Only the two SwapConfig settings change, as the timelock.
///
///   ELYSIUM_FORK=true forge test --match-contract HypeOnlyRouterFork -vv
contract HypeOnlyRouterForkTest is Test {
    address constant TIMELOCK = 0xa9e0FEAf8032c669803F68af7e93370D86e03c7F;
    address constant BOT = 0x0461663d46DA68264966a0670335E3ecf0b96F3C; // the oracle's price reader
    address constant WHYPE = 0xbA876237B0F021A6c6D852d6c26E107997cC5E81;
    address constant USDC = 0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65;
    address constant KNTQ = 0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0;
    address constant KHYPE = 0x248888D396A546A69A188f3Deb476964e581E9d0;
    address constant POOL_MANAGER = 0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1;
    InflowAllocator constant ALLOCATOR = InflowAllocator(0xB7c3865FfF8e88276a1D57D31869A2b0a839356f);
    SwapConfig constant CONFIG = SwapConfig(0xe885e7D7Fda7e481Fe7466C4adB93b0C3045FF87);
    V4TwapOracle constant ORACLE = V4TwapOracle(0x51670e163023CC3fa63d857A655A430321Fc1f56);
    address constant SWAPPER = 0xC728E5B5eF36dbbEE5920c8956EB1c145B8badE4;
    LockedReserve constant RESERVE = LockedReserve(0xeAd849357Ba8Dbc5A6F205AA0036Bd3d677b0D61);
    address constant BRIDGE_OUT = 0x0423ba7C14b3B0c986b1B6858598439A251Cc7d4; // where bought KNTQ waits for the bridge
    address constant LIQUID_WAIT = 0x358B0d6eA642689C1C0f5424d36adB8B09DBcecB; // where the 20% USDC share waits
    /// The timelock made these two changes for real, to the live HYPE-only router, in Elysium block 10,457,235
    /// (2026-11-25 01:22 UTC). It was one of four steps taken that day, in blocks 10,457,168 to 10,457,277; this
    /// is the block before the first of them.
    uint256 constant BEFORE_THE_REAL_STEPS = 10_457_167;

    HypeOnlyRouter router;
    PoolId[] feeds;
    address stranger = makeAddr("stranger");

    struct Snap {
        uint256 khypeLocked;
        uint256 principal;
        uint256 kntqAtBridge;
        uint256 usdcParked;
    }

    function setUp() public {
        if (!vm.envOr("ELYSIUM_FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork("elysium");
        router = new HypeOnlyRouter(IPriceOracle(address(ORACLE)), ISwapper(SWAPPER), CONFIG, RESERVE, KHYPE, KNTQ);
        (PoolId[] memory p1,) = ORACLE.getRoute(KNTQ, KHYPE); // HYPE/KNTQ, kHYPE/WHYPE
        (PoolId[] memory p2,) = ORACLE.getRoute(WHYPE, USDC); // HYPE/USDC
        feeds.push(p1[0]);
        feeds.push(p1[1]);
        feeds.push(p2[0]);
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

    function _repoint() internal {
        vm.startPrank(TIMELOCK);
        CONFIG.setOracle(IPriceOracle(address(router)));
        CONFIG.setSwapper(ISwapper(address(router)));
        vm.stopPrank();
    }

    function _snap() internal view returns (Snap memory s) {
        s = Snap(IERC20(KHYPE).balanceOf(address(RESERVE)), RESERVE.principal(KHYPE), IERC20(KNTQ).balanceOf(BRIDGE_OUT), IERC20(USDC).balanceOf(LIQUID_WAIT));
    }

    function _whypeTo(address to, uint256 amount) internal {
        vm.deal(address(this), amount);
        IWrappedHype(WHYPE).deposit{value: amount}();
        IERC20(WHYPE).transfer(to, amount);
    }

    /// kHYPE, KNTQ and USDC for the tests are bought with HYPE through the reserve's real swapper.
    function _buy(address token, uint256 hype, address to) internal returns (uint256 got) {
        _whypeTo(address(this), hype);
        IERC20(WHYPE).approve(SWAPPER, hype);
        got = ISwapper(SWAPPER).swap(WHYPE, token, hype, 0, to);
    }

    function _nothingLeftInRouter() internal view {
        assertEq(IERC20(WHYPE).balanceOf(address(router)), 0, "router holds WHYPE");
        assertEq(IERC20(KHYPE).balanceOf(address(router)), 0, "router holds kHYPE");
        assertEq(IERC20(USDC).balanceOf(address(router)), 0, "router holds USDC");
        assertEq(IERC20(KNTQ).balanceOf(address(router)), 0, "router holds KNTQ");
    }

    // ---------------------------------------------------------------------

    /// "Today" is from before the real change: this test alone runs on the chain as it stood just before it.
    function test_Today_FortyPercentBecomesKntq() public {
        vm.createSelectFork("elysium", BEFORE_THE_REAL_STEPS);
        _warm(5);
        _whypeTo(address(ALLOCATOR), 0.2 ether);
        Snap memory a = _snap();
        ALLOCATOR.allocate(WHYPE);
        Snap memory b = _snap();
        assertGt(b.kntqAtBridge, a.kntqAtBridge, "today the allocator buys KNTQ");
        assertGt(b.khypeLocked, a.khypeLocked);
        assertGt(b.usdcParked, a.usdcParked);
    }

    function test_OnlyTheTimelockCanRepoint() public {
        vm.prank(stranger);
        vm.expectRevert();
        CONFIG.setSwapper(ISwapper(address(router)));
        vm.prank(BOT);
        vm.expectRevert();
        CONFIG.setOracle(IPriceOracle(address(router)));
    }

    function test_Repointed_HypeFees_EightyPercentLockedAsKhype_NoKntq() public {
        // what one leg of 0.08 HYPE buys today, for comparison
        uint256 oneLeg = ORACLE.quote(WHYPE, KHYPE, 0.08 ether);
        _repoint();
        _whypeTo(address(ALLOCATOR), 0.2 ether);
        Snap memory a = _snap();
        uint256[3] memory delivered = ALLOCATOR.allocate(WHYPE);
        Snap memory b = _snap();

        assertEq(b.kntqAtBridge, a.kntqAtBridge, "no KNTQ is bought any more");
        assertEq(delivered[1], 0, "the allocator's KNTQ leg reports nothing delivered");
        uint256 locked = b.khypeLocked - a.khypeLocked;
        // two legs of 0.08 HYPE each now end as kHYPE: within 1% of twice the oracle's price for one
        assertApproxEqRel(locked, 2 * oneLeg, 0.01e18, "80% of the fee is locked as kHYPE");
        assertGt(b.principal, a.principal, "and counted as principal, so it can never leave");
        assertGt(b.usdcParked, a.usdcParked, "the 20% share is still set aside as USDC");
        assertEq(IERC20(WHYPE).balanceOf(address(ALLOCATOR)), 0);
        _nothingLeftInRouter();
        console2.log("0.2 HYPE of fees -> kHYPE locked (wei):", locked);
        console2.log("                 -> USDC set aside:", b.usdcParked - a.usdcParked);
    }

    function test_Repointed_UsdcFees() public {
        _buy(USDC, 0.2 ether, address(ALLOCATOR));
        uint256 usdcIn = IERC20(USDC).balanceOf(address(ALLOCATOR));
        uint256 expectKhype = ORACLE.quote(USDC, KHYPE, usdcIn * 8000 / 10_000);
        _repoint();
        Snap memory a = _snap();
        ALLOCATOR.allocate(USDC);
        Snap memory b = _snap();
        assertEq(b.kntqAtBridge, a.kntqAtBridge, "no KNTQ");
        assertApproxEqRel(b.khypeLocked - a.khypeLocked, expectKhype, 0.01e18, "80% of USDC fees locked as kHYPE");
        assertEq(b.usdcParked - a.usdcParked, usdcIn - usdcIn * 4000 / 10_000 - usdcIn * 4000 / 10_000, "20% passes on as it is");
        _nothingLeftInRouter();
    }

    function test_Repointed_KhypeFees_AreLockedWithoutASwap() public {
        _buy(KHYPE, 0.2 ether, address(ALLOCATOR));
        uint256 khypeIn = IERC20(KHYPE).balanceOf(address(ALLOCATOR));
        _repoint();
        Snap memory a = _snap();
        ALLOCATOR.allocate(KHYPE);
        Snap memory b = _snap();
        assertEq(b.kntqAtBridge, a.kntqAtBridge, "no KNTQ");
        assertEq(b.khypeLocked - a.khypeLocked, khypeIn * 4000 / 10_000 * 2, "exactly 80% of kHYPE fees, untouched");
        assertGt(b.usdcParked, a.usdcParked);
        _nothingLeftInRouter();
    }

    /// The one thing the router cannot reach: the allocator hands the KNTQ part of a KNTQ fee straight to the bridge.
    function test_Repointed_KntqFees_StillSendTheirFortyPercentToTheBridge() public {
        _buy(KNTQ, 0.2 ether, address(ALLOCATOR));
        uint256 kntqIn = IERC20(KNTQ).balanceOf(address(ALLOCATOR));
        _repoint();
        Snap memory a = _snap();
        ALLOCATOR.allocate(KNTQ);
        Snap memory b = _snap();
        assertEq(b.kntqAtBridge - a.kntqAtBridge, kntqIn * 4000 / 10_000, "40% of a KNTQ fee is still KNTQ");
        assertGt(b.khypeLocked, a.khypeLocked);
        assertGt(b.usdcParked, a.usdcParked);
        _nothingLeftInRouter();
    }

    function test_Repointed_ThePriceLimitStillHolds() public {
        _repoint();
        _whypeTo(address(ALLOCATOR), 0.2 ether);
        // the average price now says kHYPE is 5% cheaper than the pool will give
        uint256 fair = ORACLE.quote(WHYPE, KHYPE, 0.08 ether);
        vm.mockCall(address(ORACLE), abi.encodeCall(IPriceOracle.quote, (WHYPE, KHYPE, 0.08 ether)), abi.encode(fair * 105 / 100));
        vm.expectRevert();
        ALLOCATOR.allocate(WHYPE);
        vm.clearMockedCalls();
        ALLOCATOR.allocate(WHYPE); // at the real price it goes through
    }

    function test_Repointed_StalePricesStopEverything() public {
        _repoint();
        _whypeTo(address(ALLOCATOR), 0.2 ether);
        vm.warp(block.timestamp + 2 hours); // nobody read prices for two hours
        vm.expectRevert();
        ALLOCATOR.allocate(WHYPE);
    }

    function test_Lock_AnyoneCanLockHypeAsKhype() public {
        _whypeTo(stranger, 0.1 ether);
        uint256 expected = ORACLE.quote(WHYPE, KHYPE, 0.1 ether);
        Snap memory a = _snap();
        vm.startPrank(stranger);
        IERC20(WHYPE).approve(address(router), 0.1 ether);
        uint256 locked = router.lock(WHYPE, 0.1 ether);
        vm.stopPrank();
        Snap memory b = _snap();
        assertEq(b.khypeLocked - a.khypeLocked, locked);
        assertApproxEqRel(locked, expected, 0.01e18);
        assertGt(b.principal, a.principal);
        assertEq(IERC20(KHYPE).balanceOf(stranger), 0, "the caller gets nothing back");
        _nothingLeftInRouter();
    }

    function test_Swap_PassesEverythingElseThrough() public {
        _whypeTo(stranger, 0.1 ether);
        uint256 quoted = router.quote(WHYPE, USDC, 0.1 ether);
        assertEq(quoted, ORACLE.quote(WHYPE, USDC, 0.1 ether), "same price as the real oracle");
        vm.startPrank(stranger);
        IERC20(WHYPE).approve(address(router), 0.1 ether);
        uint256 out = router.swap(WHYPE, USDC, 0.1 ether, quoted * 99 / 100, stranger);
        vm.stopPrank();
        assertEq(IERC20(USDC).balanceOf(stranger), out);
        assertGe(out, quoted * 99 / 100);
        _nothingLeftInRouter();
    }

    function test_Swap_RefusesACallerWhoWantsKntq() public {
        assertEq(router.quote(WHYPE, KNTQ, 1 ether), 1, "anything to KNTQ is quoted as 1");
        _whypeTo(stranger, 0.1 ether);
        vm.startPrank(stranger);
        IERC20(WHYPE).approve(address(router), 0.1 ether);
        vm.expectRevert(HypeOnlyRouter.NoKntq.selector);
        router.swap(WHYPE, KNTQ, 0.1 ether, 1, stranger);
        vm.stopPrank();
    }

    function test_TheTimelockCanPutItBack() public {
        _repoint();
        vm.startPrank(TIMELOCK);
        CONFIG.setOracle(IPriceOracle(address(ORACLE)));
        CONFIG.setSwapper(ISwapper(SWAPPER));
        vm.stopPrank();
        _whypeTo(address(ALLOCATOR), 0.2 ether);
        Snap memory a = _snap();
        ALLOCATOR.allocate(WHYPE);
        assertGt(_snap().kntqAtBridge, a.kntqAtBridge, "KNTQ is bought again");
    }
}
