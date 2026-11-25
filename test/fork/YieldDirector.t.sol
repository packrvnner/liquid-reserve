// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {FeeInbox} from "../../src/FeeInbox.sol";
import {SwapConfig} from "../../src/SwapConfig.sol";
import {LockedReserve} from "../../src/LockedReserve.sol";
import {DropFeeder} from "../../src/DropFeeder.sol";
import {YieldDirector, IDropFeeder} from "../../src/YieldDirector.sol";
import {RewardPool} from "../../src/staking/RewardPool.sol";
import {V4TwapOracle} from "../../src/adapters/V4TwapOracle.sol";
import {UniswapV4Swapper} from "../../src/adapters/UniswapV4Swapper.sol";
import {ISwapper} from "../../src/interfaces/ISwapper.sol";
import {IPriceOracle} from "../../src/interfaces/IPriceOracle.sol";

interface IWrappedHype3 {
    function deposit() external payable;
}

/// @notice The yield director, the reward pools and the feeder's hand-over function against the LIVE reserve on
/// a copy of Elysium mainnet. The timelock's part (routes for kHYPE and USDC to $liquid, and pointing the two
/// waiting contracts) is done as the timelock.
///
///   ELYSIUM_FORK=true forge test --match-contract YieldDirectorFork -vv
contract YieldDirectorForkTest is Test {
    address constant TIMELOCK = 0xa9e0FEAf8032c669803F68af7e93370D86e03c7F;
    address constant OWNER = 0x822aA88543b9da39c4c3D856857379E17526C1E8; // the manager: the owner's wallet
    address constant BOT = 0x0461663d46DA68264966a0670335E3ecf0b96F3C; // the oracle's price reader, and the drop
    address constant WHYPE = 0xbA876237B0F021A6c6D852d6c26E107997cC5E81;
    address constant USDC = 0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65;
    address constant KNTQ = 0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0;
    address constant KHYPE = 0x248888D396A546A69A188f3Deb476964e581E9d0;
    address constant LIQUID = 0x247c91C14b5Aa1cF57f02d638B0287F5cd69E9f6;
    address constant LIQUID_HYPE = 0x5B550c1DAd656B688Da2422baBb11470f5f419B0; // the HYPE staking vault's token
    address constant LIQUID_KNTQ = 0xf15903dc81e8736Ee107a481b58C57db48482e09; // not on Elysium until the first batch crosses
    address constant BURN_SINK = 0x9F0b0e3B362937b07Cd1E869b50687961e0c7741;
    address constant POOL_MANAGER = 0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1;
    SwapConfig constant CONFIG = SwapConfig(0xe885e7D7Fda7e481Fe7466C4adB93b0C3045FF87);
    V4TwapOracle constant ORACLE = V4TwapOracle(0x51670e163023CC3fa63d857A655A430321Fc1f56);
    UniswapV4Swapper constant SWAPPER = UniswapV4Swapper(payable(0xC728E5B5eF36dbbEE5920c8956EB1c145B8badE4));
    LockedReserve constant RESERVE = LockedReserve(0xeAd849357Ba8Dbc5A6F205AA0036Bd3d677b0D61);
    FeeInbox constant LIQUID_WAIT = FeeInbox(0x358B0d6eA642689C1C0f5424d36adB8B09DBcecB);
    FeeInbox constant YIELD_REST = FeeInbox(0x14938d73fdCF459c07fB749dbA21DE76e4519938); // where 80% of the yield waits
    /// The timelock's part was carried out for real on 2026-11-25, in Elysium blocks 10,457,168 to 10,457,277
    /// (01:21 to 01:22 UTC); the yield's waiting contract was pointed at the live director in block 10,457,200,
    /// and that can be done only once. So this rehearsal runs on the chain as it stood one block before the first.
    uint256 constant BEFORE_THE_REAL_STEPS = 10_457_167;

    DropFeeder feeder;
    RewardPool hypePool;
    RewardPool kntqPool;
    YieldDirector director;
    PoolId[] feeds;
    address stranger = makeAddr("stranger");
    address staker = makeAddr("staker");

    function setUp() public {
        if (!vm.envOr("ELYSIUM_FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork("elysium", BEFORE_THE_REAL_STEPS);
        feeder = new DropFeeder(
            TIMELOCK, IERC20(USDC), IERC20(LIQUID), IERC20(KHYPE), BURN_SINK, RESERVE, IPriceOracle(address(ORACLE)), ISwapper(address(SWAPPER)), CONFIG, BOT
        );
        hypePool = new RewardPool(IERC20(LIQUID_HYPE), IERC20(LIQUID));
        kntqPool = new RewardPool(IERC20(LIQUID_KNTQ), IERC20(LIQUID));
        address[] memory pools = new address[](2);
        pools[0] = address(hypePool);
        pools[1] = address(kntqPool);
        director = new YieldDirector(
            TIMELOCK, OWNER, IERC20(KHYPE), IERC20(LIQUID), RESERVE, IDropFeeder(address(feeder)), IPriceOracle(address(ORACLE)), ISwapper(address(SWAPPER)), CONFIG, pools, _bps4(2500, 2500, 2500, 2500)
        );

        (PoolId[] memory p1,) = ORACLE.getRoute(KNTQ, KHYPE); // HYPE/KNTQ, kHYPE/WHYPE
        (PoolId[] memory p2,) = ORACLE.getRoute(WHYPE, USDC); // HYPE/USDC
        PoolKey memory ascend = PoolKey(Currency.wrap(LIQUID), Currency.wrap(WHYPE), 0x800000, 200, IHooks(0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC));
        PoolKey memory khypeWhype = PoolKey(Currency.wrap(KHYPE), Currency.wrap(WHYPE), 0x800000, 1, IHooks(0x8129bab872318a64B0e6212C6C491feED06C3de3));
        PoolId ascendId = ascend.toId();
        assertEq(PoolId.unwrap(khypeWhype.toId()), PoolId.unwrap(p1[1]), "the kHYPE pool key");

        // ---- the timelock's part
        vm.startPrank(TIMELOCK);
        (,, uint32 lastTime,,,,) = ORACLE.feeds(ascendId);
        if (lastTime == 0) ORACLE.addFeed(ascend);
        PoolId[] memory path = new PoolId[](2);
        path[0] = p1[1];
        path[1] = ascendId;
        uint24[] memory fees = new uint24[](2);
        fees[0] = 0;
        fees[1] = 20000; // Ascend's hook takes 2%
        ORACLE.setRoute(KHYPE, LIQUID, path, fees);
        UniswapV4Swapper.Hop[] memory hops = new UniswapV4Swapper.Hop[](2);
        hops[0] = UniswapV4Swapper.Hop(UniswapV4Swapper.HopKind.V4_SWAP, khypeWhype, true, address(0)); // kHYPE in, HYPE out
        hops[1] = UniswapV4Swapper.Hop(UniswapV4Swapper.HopKind.V4_SWAP, ascend, false, address(0)); // HYPE in, $liquid out
        SWAPPER.setRoute(KHYPE, LIQUID, hops);
        YIELD_REST.setTarget(address(director));
        vm.stopPrank();

        feeds.push(p1[0]);
        feeds.push(p1[1]);
        feeds.push(p2[0]);
        feeds.push(ascendId);
        _warm(5);
    }

    function _bps4(uint16 a, uint16 b, uint16 c, uint16 d) internal pure returns (uint16[] memory bps) {
        bps = new uint16[](4);
        bps[0] = a;
        bps[1] = b;
        bps[2] = c;
        bps[3] = d;
    }

    function _warm(uint256 rounds) internal {
        for (uint256 i; i < rounds; ++i) {
            vm.warp(block.timestamp + 600);
            vm.prank(BOT);
            ORACLE.poke(feeds);
        }
    }

    /// kHYPE bought with HYPE through the reserve's real swapper, sent to `to`.
    function _khypeTo(address to, uint256 hype) internal returns (uint256 got) {
        vm.deal(address(this), hype);
        IWrappedHype3(WHYPE).deposit{value: hype}();
        IERC20(WHYPE).approve(address(SWAPPER), hype);
        got = SWAPPER.swap(WHYPE, KHYPE, hype, 0, to);
    }

    /// Yield arrives where it waits, and is passed on to the director.
    function _yield(uint256 hype) internal returns (uint256 khypeIn) {
        _khypeTo(address(YIELD_REST), hype);
        YIELD_REST.forward(KHYPE);
        return IERC20(KHYPE).balanceOf(address(director));
    }

    function _nothingLeft() internal view {
        assertEq(IERC20(KHYPE).balanceOf(address(director)), 0, "director holds kHYPE");
        assertEq(IERC20(LIQUID).balanceOf(address(director)), 0, "director holds $liquid");
        assertEq(IERC20(WHYPE).balanceOf(address(director)), 0, "director holds WHYPE");
        assertEq(IERC20(LIQUID).balanceOf(address(feeder)), 0, "feeder holds $liquid");
    }

    // ---------------------------------------------------------------------

    function test_TheYieldCanOnlyGoToTheDirector() public {
        assertEq(YIELD_REST.target(), address(director));
        vm.prank(TIMELOCK);
        vm.expectRevert(FeeInbox.TargetAlreadySet.selector);
        YIELD_REST.setTarget(stranger);
    }

    function test_Distribute_FourEqualShares() public {
        uint256 khypeIn = _yield(0.2 ether);
        uint256 quarter = khypeIn * 2500 / 10_000;
        uint256 expectLiquid = ORACLE.quote(KHYPE, LIQUID, khypeIn - quarter);
        uint256 reserve0 = IERC20(KHYPE).balanceOf(address(RESERVE));
        uint256 principal0 = RESERVE.principal(KHYPE);
        uint256 drop0 = IERC20(LIQUID).balanceOf(BOT);

        vm.prank(stranger); // anyone may call it
        (uint256 toReserve, uint256 bought) = director.distribute(KHYPE, type(uint256).max);

        assertEq(toReserve, quarter, "a quarter is locked again, as it is");
        assertEq(IERC20(KHYPE).balanceOf(address(RESERVE)) - reserve0, quarter);
        assertGt(RESERVE.principal(KHYPE), principal0);
        assertApproxEqRel(bought, expectLiquid, 0.01e18, "the rest buys $liquid at the average price");
        uint256 third = bought * 2500 / 7500;
        assertEq(IERC20(LIQUID).balanceOf(BOT) - drop0, third, "a quarter of the yield reaches the drop");
        assertEq(feeder.sentToDrop(), third, "and the feeder counts it");
        assertEq(IERC20(LIQUID).balanceOf(address(hypePool)), third, "a quarter waits for HYPE stakers");
        assertEq(IERC20(LIQUID).balanceOf(address(kntqPool)), bought - 2 * third, "a quarter waits for KNTQ stakers");
        assertEq(hypePool.queuedRewards() + hypePool.rewardRate() * 7 days, third, "all of it is queued or streaming");
        _nothingLeft();
        console2.log("yield in (kHYPE wei):", khypeIn);
        console2.log("$liquid bought (whole tokens):", bought / 1e18);
    }

    function test_TheManagerSwitchesTheSharesAtOnce() public {
        uint256 khypeIn = _yield(0.1 ether);
        vm.prank(OWNER);
        director.setShares(_bps4(10_000, 0, 0, 0)); // everything compounds
        uint256 reserve0 = IERC20(KHYPE).balanceOf(address(RESERVE));
        (uint256 toReserve, uint256 bought) = director.distribute(KHYPE, type(uint256).max);
        assertEq(toReserve, khypeIn);
        assertEq(bought, 0, "nothing is swapped");
        assertEq(IERC20(KHYPE).balanceOf(address(RESERVE)) - reserve0, khypeIn);

        _yield(0.1 ether);
        _warm(1);
        vm.prank(OWNER);
        director.setShares(_bps4(0, 0, 10_000, 0)); // everything to the HYPE stakers' pool
        uint256 pool0 = IERC20(LIQUID).balanceOf(address(hypePool));
        uint256 drop0 = IERC20(LIQUID).balanceOf(BOT);
        (toReserve, bought) = director.distribute(KHYPE, type(uint256).max);
        assertEq(toReserve, 0);
        assertEq(IERC20(LIQUID).balanceOf(address(hypePool)) - pool0, bought);
        assertEq(IERC20(LIQUID).balanceOf(BOT), drop0);
        _nothingLeft();
    }

    function test_OnlyTheManagerSetsShares_AndTheyMustAddUp() public {
        vm.prank(stranger);
        vm.expectRevert(YieldDirector.NotManager.selector);
        director.setShares(_bps4(10_000, 0, 0, 0));
        vm.prank(TIMELOCK);
        vm.expectRevert(YieldDirector.NotManager.selector);
        director.setShares(_bps4(10_000, 0, 0, 0));
        vm.startPrank(OWNER);
        vm.expectRevert(YieldDirector.BadShares.selector);
        director.setShares(_bps4(5000, 2500, 2500, 100)); // adds up to more than 100%
        uint16[] memory three = new uint16[](3);
        three[0] = 10_000;
        vm.expectRevert(YieldDirector.BadShares.selector);
        director.setShares(three); // one number per destination
        vm.stopPrank();
    }

    function test_OnlyTheTimelockAddsADestination_AndItStartsAtZero() public {
        address lending = makeAddr("a future incentive contract");
        vm.prank(OWNER);
        vm.expectRevert(YieldDirector.NotTimelock.selector);
        director.addDestination(YieldDirector.Kind.SEND, lending);
        vm.startPrank(TIMELOCK);
        vm.expectRevert(YieldDirector.BadDestination.selector);
        director.addDestination(YieldDirector.Kind.COMPOUND, lending); // only pools and addresses can be added
        uint256 index = director.addDestination(YieldDirector.Kind.SEND, lending);
        vm.stopPrank();
        assertEq(index, 4);
        assertEq(director.destinations()[4].bps, 0, "a new destination gets nothing until the manager says so");

        uint16[] memory bps = new uint16[](5);
        bps[0] = 5000;
        bps[4] = 5000;
        vm.prank(OWNER);
        director.setShares(bps);
        _yield(0.1 ether);
        (, uint256 bought) = director.distribute(KHYPE, type(uint256).max);
        assertEq(IERC20(LIQUID).balanceOf(lending), bought, "half the yield reaches it as $liquid");
        _nothingLeft();
    }

    function test_AStakerDepositsLiquidHype_AndEarnsLiquidOverAWeek() public {
        // the staker stakes HYPE with Liquid Reserve (kHYPE into the liquidHYPE vault), then deposits the token
        uint256 khype = _khypeTo(staker, 0.05 ether);
        vm.startPrank(staker);
        IERC20(KHYPE).approve(LIQUID_HYPE, khype);
        uint256 shares = IERC4626(LIQUID_HYPE).deposit(khype, staker);
        IERC20(LIQUID_HYPE).approve(address(hypePool), shares);
        hypePool.stake(shares);
        vm.stopPrank();

        vm.prank(OWNER);
        director.setShares(_bps4(0, 0, 10_000, 0));
        _yield(0.1 ether);
        _warm(1);
        (, uint256 bought) = director.distribute(KHYPE, type(uint256).max);
        assertEq(hypePool.earned(staker), 0, "nothing at once: it streams");
        vm.warp(block.timestamp + 7 days);
        assertApproxEqAbs(hypePool.earned(staker), bought, 1e7, "the only depositor earns all of it over the week");

        vm.prank(staker);
        hypePool.exit();
        assertApproxEqAbs(IERC20(LIQUID).balanceOf(staker), bought, 1e7, "paid in $liquid");
        assertEq(IERC20(LIQUID_HYPE).balanceOf(staker), shares, "and the staking token comes back whole");
    }

    function test_WhenTheDropIsFull_ItsShareBurns() public {
        uint256 toFill = feeder.cap() - IERC20(LIQUID).balanceOf(BOT);
        vm.prank(POOL_MANAGER); // the drop's wallet is filled to the line (test only)
        IERC20(LIQUID).transfer(BOT, toFill);
        assertEq(feeder.room(), 0);
        vm.prank(OWNER);
        director.setShares(_bps4(0, 10_000, 0, 0));
        _yield(0.05 ether);
        uint256 drop0 = IERC20(LIQUID).balanceOf(BOT);
        (, uint256 bought) = director.distribute(KHYPE, type(uint256).max);
        assertEq(IERC20(LIQUID).balanceOf(BOT), drop0, "the drop takes no more");
        assertEq(IERC20(LIQUID).balanceOf(BURN_SINK), bought, "its share goes to the burn address");
        assertEq(feeder.burned(), bought, "and is counted");
        _nothingLeft();
    }

    function test_Feeder_AnyoneCanHandOverLiquid() public {
        vm.prank(POOL_MANAGER);
        IERC20(LIQUID).transfer(stranger, 1_000e18);
        uint256 drop0 = IERC20(LIQUID).balanceOf(BOT);
        vm.startPrank(stranger);
        IERC20(LIQUID).approve(address(feeder), 1_000e18);
        (uint256 toDrop, uint256 toBurn) = feeder.addLiquid(1_000e18);
        vm.expectRevert(DropFeeder.ZeroAmount.selector);
        feeder.addLiquid(0);
        vm.stopPrank();
        assertEq(toDrop, 1_000e18);
        assertEq(toBurn, 0);
        assertEq(IERC20(LIQUID).balanceOf(BOT) - drop0, 1_000e18);
        assertEq(IERC20(LIQUID).balanceOf(stranger), 0, "nothing comes back");
    }

    function test_ThePriceLimitHolds_AndStalePricesStopIt() public {
        uint256 khypeIn = _yield(0.1 ether);
        uint256 forLiquid = khypeIn - khypeIn * 2500 / 10_000;
        uint256 fair = ORACLE.quote(KHYPE, LIQUID, forLiquid);
        vm.mockCall(address(ORACLE), abi.encodeCall(IPriceOracle.quote, (KHYPE, LIQUID, forLiquid)), abi.encode(fair * 105 / 100));
        vm.expectRevert();
        director.distribute(KHYPE, type(uint256).max);
        vm.clearMockedCalls();
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert();
        director.distribute(KHYPE, type(uint256).max);
        _warm(5);
        director.distribute(KHYPE, type(uint256).max);
        _nothingLeft();
    }

    function test_InPieces_AndNothingToDistribute() public {
        uint256 khypeIn = _yield(0.2 ether);
        director.distribute(KHYPE, khypeIn / 4);
        assertEq(IERC20(KHYPE).balanceOf(address(director)), khypeIn - khypeIn / 4, "the rest waits");
        director.distribute(KHYPE, type(uint256).max);
        vm.expectRevert(YieldDirector.NothingToDistribute.selector);
        director.distribute(KHYPE, type(uint256).max);
    }

    function test_Successor_TakesTheYieldInstead_AndOnlyTheTimelockNamesIt() public {
        address next = makeAddr("successor");
        vm.prank(OWNER);
        vm.expectRevert(YieldDirector.NotTimelock.selector);
        director.setSuccessor(next);
        vm.prank(TIMELOCK);
        director.setSuccessor(next);
        uint256 khypeIn = _yield(0.1 ether);
        director.distribute(KHYPE, type(uint256).max);
        assertEq(IERC20(KHYPE).balanceOf(next), khypeIn);
    }

    function test_TheTimelockCanNameANewManager() public {
        vm.prank(OWNER);
        vm.expectRevert(YieldDirector.NotTimelock.selector);
        director.setManager(stranger);
        vm.prank(TIMELOCK);
        director.setManager(stranger);
        vm.prank(OWNER);
        vm.expectRevert(YieldDirector.NotManager.selector);
        director.setShares(_bps4(10_000, 0, 0, 0));
        vm.prank(stranger);
        director.setShares(_bps4(10_000, 0, 0, 0));
    }
}
