// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {WETH} from "solmate/src/tokens/WETH.sol";
import {ERC4626Mock} from "@openzeppelin/contracts/mocks/token/ERC4626Mock.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {UniswapV4Swapper} from "../../src/adapters/UniswapV4Swapper.sol";
import {V4TwapOracle} from "../../src/adapters/V4TwapOracle.sol";
import {TwapRateProvider} from "../../src/adapters/TwapRateProvider.sol";

/// @notice Adapters against a real Uniswap v4 PoolManager deployed locally,
/// with an ERC20/ERC20 pool and a native-HYPE/ERC20 pool, both at price 1.
contract V4AdaptersTest is Deployers {
    WETH internal whype;
    UniswapV4Swapper internal swapper;
    V4TwapOracle internal oracle;

    PoolKey internal keyAB; // currency0 / currency1
    PoolId internal idAB;
    PoolKey internal keyNA; // native HYPE / currency0
    PoolId internal idNA;

    address internal t0;
    address internal t1;
    address internal keeper = makeAddr("keeper");
    address internal user = makeAddr("user");

    IPoolManager.ModifyLiquidityParams internal deep =
        IPoolManager.ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 1e24, salt: 0});

    function setUp() public {
        vm.warp(1_800_000_000);
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        t0 = Currency.unwrap(currency0);
        t1 = Currency.unwrap(currency1);

        (keyAB, idAB) = initPool(currency0, currency1, IHooks(address(0)), 3000, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(keyAB, deep, ZERO_BYTES);

        vm.deal(address(this), 1e27);
        (keyNA, idNA) = initPool(CurrencyLibrary.ADDRESS_ZERO, currency0, IHooks(address(0)), 3000, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity{value: 5e23}(keyNA, deep, ZERO_BYTES);

        whype = new WETH();
        swapper = new UniswapV4Swapper(address(this), manager, address(whype));
        oracle = new V4TwapOracle(address(this), manager, address(whype), 30 minutes, 60, 1 hours, 10);
        oracle.setKeeper(keeper, true);

        MockERC20(t0).mint(user, 1e24);
        MockERC20(t1).mint(user, 1e24);
        vm.deal(user, 1e24);
        vm.prank(user);
        whype.deposit{value: 1e23}();
    }

    // ---------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------

    function _v4(PoolKey memory key, bool zeroForOne) internal pure returns (UniswapV4Swapper.Hop memory h) {
        h.kind = UniswapV4Swapper.HopKind.V4_SWAP;
        h.key = key;
        h.zeroForOne = zeroForOne;
    }

    function _route1(address tin, address tout, UniswapV4Swapper.Hop memory a) internal {
        UniswapV4Swapper.Hop[] memory hops = new UniswapV4Swapper.Hop[](1);
        hops[0] = a;
        swapper.setRoute(tin, tout, hops);
    }

    function _route2(address tin, address tout, UniswapV4Swapper.Hop memory a, UniswapV4Swapper.Hop memory b)
        internal
    {
        UniswapV4Swapper.Hop[] memory hops = new UniswapV4Swapper.Hop[](2);
        hops[0] = a;
        hops[1] = b;
        swapper.setRoute(tin, tout, hops);
    }

    function _swapAs(address who, address tin, address tout, uint256 amount, uint256 minOut)
        internal
        returns (uint256 out)
    {
        vm.startPrank(who);
        MockERC20(tin).approve(address(swapper), amount);
        out = swapper.swap(tin, tout, amount, minOut, who);
        vm.stopPrank();
    }

    function _ids(PoolId a) internal pure returns (PoolId[] memory ids) {
        ids = new PoolId[](1);
        ids[0] = a;
    }

    function _ids(PoolId a, PoolId b) internal pure returns (PoolId[] memory ids) {
        ids = new PoolId[](2);
        ids[0] = a;
        ids[1] = b;
    }

    function _fees(uint24 a) internal pure returns (uint24[] memory f) {
        f = new uint24[](1);
        f[0] = a;
    }

    function _fees(uint24 a, uint24 b) internal pure returns (uint24[] memory f) {
        f = new uint24[](2);
        f[0] = a;
        f[1] = b;
    }

    /// Pokes the given feeds as the keeper every minute for `minutes_` minutes.
    function _pokeFor(PoolId[] memory ids, uint256 minutes_) internal {
        for (uint256 i; i < minutes_; ++i) {
            vm.warp(block.timestamp + 60);
            vm.prank(keeper);
            oracle.poke(ids);
        }
    }

    function _assertSwapperEmpty() internal view {
        assertEq(MockERC20(t0).balanceOf(address(swapper)), 0);
        assertEq(MockERC20(t1).balanceOf(address(swapper)), 0);
        assertEq(whype.balanceOf(address(swapper)), 0);
        assertEq(address(swapper).balance, 0);
    }

    // ---------------------------------------------------------------------
    // Swapper
    // ---------------------------------------------------------------------

    function test_Swapper_SingleHop() public {
        _route1(t0, t1, _v4(keyAB, true));
        uint256 out = _swapAs(user, t0, t1, 1e18, 0);
        // 0.3% fee, negligible price impact in a deep pool
        assertApproxEqRel(out, 0.997e18, 0.0005e18);
        _assertSwapperEmpty();
    }

    function test_Swapper_NativePool_WhypeIn() public {
        _route1(address(whype), t0, _v4(keyNA, true)); // native is currency0
        uint256 out = _swapAs(user, address(whype), t0, 1e18, 0);
        assertApproxEqRel(out, 0.997e18, 0.0005e18);
        _assertSwapperEmpty();
    }

    function test_Swapper_NativePool_WhypeOut() public {
        _route1(t0, address(whype), _v4(keyNA, false));
        uint256 before = whype.balanceOf(user);
        uint256 out = _swapAs(user, t0, address(whype), 1e18, 0);
        assertEq(whype.balanceOf(user) - before, out, "paid out as WHYPE, not native");
        assertApproxEqRel(out, 0.997e18, 0.0005e18);
        _assertSwapperEmpty();
    }

    function test_Swapper_MultiHop() public {
        // currency1 -> currency0 -> native HYPE (delivered as WHYPE)
        _route2(t1, address(whype), _v4(keyAB, false), _v4(keyNA, false));
        uint256 out = _swapAs(user, t1, address(whype), 1e18, 0);
        assertApproxEqRel(out, 0.994e18, 0.001e18); // two 0.3% fees
        _assertSwapperEmpty();
    }

    function test_Swapper_VaultDepositHop() public {
        ERC4626Mock vault = new ERC4626Mock(t1);
        UniswapV4Swapper.Hop memory dep;
        dep.kind = UniswapV4Swapper.HopKind.VAULT_DEPOSIT;
        dep.vault = address(vault);
        _route2(t0, address(vault), _v4(keyAB, true), dep);

        uint256 shares = _swapAs(user, t0, address(vault), 1e18, 0);
        assertEq(vault.balanceOf(user), shares);
        assertApproxEqRel(vault.convertToAssets(shares), 0.997e18, 0.0005e18);
        _assertSwapperEmpty();
    }

    function test_RevertWhen_MinOutNotMet() public {
        _route1(t0, t1, _v4(keyAB, true));
        vm.startPrank(user);
        MockERC20(t0).approve(address(swapper), 1e18);
        vm.expectPartialRevert(UniswapV4Swapper.InsufficientOutput.selector);
        swapper.swap(t0, t1, 1e18, 0.999e18, user);
        vm.stopPrank();
    }

    function test_RevertWhen_NoRoute() public {
        vm.startPrank(user);
        MockERC20(t0).approve(address(swapper), 1e18);
        vm.expectRevert(abi.encodeWithSelector(UniswapV4Swapper.NoRoute.selector, t0, t1));
        swapper.swap(t0, t1, 1e18, 0, user);
        vm.stopPrank();
    }

    function test_RevertWhen_RouteDoesNotConnect() public {
        UniswapV4Swapper.Hop[] memory hops = new UniswapV4Swapper.Hop[](1);
        hops[0] = _v4(keyAB, false); // pays currency1, but route starts at currency0
        vm.expectRevert(abi.encodeWithSelector(UniswapV4Swapper.BadRoute.selector, 0));
        swapper.setRoute(t0, t1, hops);

        hops[0] = _v4(keyAB, true); // ends at currency1, but route says WHYPE
        vm.expectRevert(abi.encodeWithSelector(UniswapV4Swapper.BadRoute.selector, 1));
        swapper.setRoute(t0, address(whype), hops);
    }

    function test_RevertWhen_NonOwnerSetsRoute() public {
        UniswapV4Swapper.Hop[] memory hops = new UniswapV4Swapper.Hop[](1);
        hops[0] = _v4(keyAB, true);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        swapper.setRoute(t0, t1, hops);
    }

    function test_RevertWhen_PoolTooThin() public {
        (PoolKey memory thin,) = initPool(currency0, currency1, IHooks(address(0)), 500, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            thin, IPoolManager.ModifyLiquidityParams({tickLower: -10, tickUpper: 10, liquidityDelta: 1e18, salt: 0}), ""
        );
        _route1(t0, t1, _v4(thin, true));
        vm.startPrank(user);
        MockERC20(t0).approve(address(swapper), 1e21);
        vm.expectPartialRevert(UniswapV4Swapper.PartialFill.selector);
        swapper.swap(t0, t1, 1e21, 0, user);
        vm.stopPrank();
    }

    function test_RevertWhen_CallbackNotFromPoolManager() public {
        vm.expectRevert(UniswapV4Swapper.NotPoolManager.selector);
        swapper.unlockCallback(abi.encode(bytes32(0), uint256(1)));
    }

    function test_RevertWhen_RandomNativeTransfer() public {
        vm.prank(user);
        (bool ok,) = address(swapper).call{value: 1 ether}("");
        assertFalse(ok);
    }

    // ---------------------------------------------------------------------
    // Oracle
    // ---------------------------------------------------------------------

    function test_Oracle_QuoteAtTickMath() public view {
        assertEq(oracle.quoteAtTick(0, 1e18, true), 1e18);
        assertApproxEqRel(oracle.quoteAtTick(6931, 1e18, true), 2e18, 0.0001e18); // 1.0001^6931 ≈ 2
        assertApproxEqRel(oracle.quoteAtTick(6931, 1e18, false), 0.5e18, 0.0001e18);
        assertApproxEqRel(oracle.quoteAtTick(-6931, 1e18, true), 0.5e18, 0.0001e18);
    }

    function test_Oracle_FlatPriceQuote() public {
        oracle.addFeed(keyAB);
        oracle.setRoute(t0, t1, _ids(idAB), _fees(0));
        _pokeFor(_ids(idAB), 31);
        assertEq(oracle.quote(t0, t1, 1e18), 1e18);
    }

    function test_Oracle_MultiHopThroughNativePool() public {
        oracle.addFeed(keyAB);
        oracle.addFeed(keyNA);
        oracle.setRoute(t1, address(whype), _ids(idAB, idNA), _fees(0, 0));
        _pokeFor(_ids(idAB, idNA), 31);
        assertEq(oracle.quote(t1, address(whype), 1e18), 1e18);
    }

    function test_Oracle_QuoteSubtractsHopFees() public {
        oracle.addFeed(keyAB);
        oracle.addFeed(keyNA);
        oracle.setRoute(t1, address(whype), _ids(idAB, idNA), _fees(3000, 20_000));
        _pokeFor(_ids(idAB, idNA), 31);
        // 1e18 * 0.997 * 0.98
        assertEq(oracle.quote(t1, address(whype), 1e18), 0.97706e18);
    }

    function test_Oracle_RevertWhen_HopFeeTooHigh() public {
        oracle.addFeed(keyAB);
        vm.expectRevert(abi.encodeWithSelector(V4TwapOracle.BadRoute.selector, 0));
        oracle.setRoute(t0, t1, _ids(idAB), _fees(100_001));
    }

    function test_Oracle_RevertWhen_InsufficientHistory() public {
        oracle.addFeed(keyAB);
        oracle.setRoute(t0, t1, _ids(idAB), _fees(0));
        _pokeFor(_ids(idAB), 10);
        vm.expectRevert(abi.encodeWithSelector(V4TwapOracle.InsufficientHistory.selector, idAB));
        oracle.quote(t0, t1, 1e18);
    }

    function test_Oracle_RevertWhen_Stale_ButFeedQuoteStillWorks() public {
        oracle.addFeed(keyAB);
        oracle.setRoute(t0, t1, _ids(idAB), _fees(0));
        _pokeFor(_ids(idAB), 31);
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(abi.encodeWithSelector(V4TwapOracle.StalePrice.selector, idAB));
        oracle.quote(t0, t1, 1e18);
        assertEq(oracle.quoteFeed(idAB, 1e18, true), 1e18, "rate providers keep last price");
    }

    function test_Oracle_OnlyKeepersPokeFreshFeeds_AnyonePokesStale() public {
        oracle.addFeed(keyAB);
        vm.warp(block.timestamp + 60);
        vm.prank(user);
        vm.expectRevert(V4TwapOracle.NotKeeper.selector);
        oracle.poke(_ids(idAB));

        vm.warp(block.timestamp + 1 hours);
        vm.prank(user);
        oracle.poke(_ids(idAB)); // stale: anyone may poke
    }

    /// A price moved, poked and moved back in the same block has zero weight.
    function test_Oracle_SameBlockManipulationHasNoEffect() public {
        oracle.addFeed(keyAB);
        oracle.setRoute(t0, t1, _ids(idAB), _fees(0));
        _pokeFor(_ids(idAB), 31);
        vm.warp(block.timestamp + 30);
        uint256 before = oracle.quote(t0, t1, 1e18);

        // Push the price far up, poke, and push it back, all at one timestamp.
        swap(keyAB, false, -int256(2e23), ZERO_BYTES);
        vm.prank(keeper);
        oracle.poke(_ids(idAB));
        swap(keyAB, true, -int256(2e23), ZERO_BYTES);

        assertEq(oracle.quote(t0, t1, 1e18), before);
    }

    function test_Oracle_RecordedTickMovesAtMostMaxPerSecond() public {
        oracle.addFeed(keyAB);
        swap(keyAB, false, -int256(2e23), ZERO_BYTES); // big real move
        vm.warp(block.timestamp + 10);
        vm.prank(keeper);
        oracle.poke(_ids(idAB));
        (,,, int24 lastTick,,,) = oracle.feeds(idAB);
        assertEq(lastTick, 100, "10 ticks/s * 10 s");
    }

    function test_Oracle_TracksARealMoveOverTheWindow() public {
        oracle.addFeed(keyAB);
        oracle.setRoute(t0, t1, _ids(idAB), _fees(0));
        _pokeFor(_ids(idAB), 31);
        swap(keyAB, false, -int256(1e22), ZERO_BYTES); // price of currency0 rises and stays
        _pokeFor(_ids(idAB), 60);
        (uint160 sqrtP,,,) = _slot0(idAB);
        uint256 spotQuote = (uint256(sqrtP) * sqrtP >> 96) * 1e18 >> 96;
        assertApproxEqRel(oracle.quote(t0, t1, 1e18), spotQuote, 0.0002e18);
    }

    function test_Oracle_RevertWhen_FeedAddedTwiceOrRouteBroken() public {
        oracle.addFeed(keyAB);
        vm.expectRevert(abi.encodeWithSelector(V4TwapOracle.FeedExists.selector, idAB));
        oracle.addFeed(keyAB);
        vm.expectRevert(abi.encodeWithSelector(V4TwapOracle.BadRoute.selector, 1));
        oracle.setRoute(t0, address(whype), _ids(idAB), _fees(0));
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        oracle.addFeed(keyNA);
    }

    function test_RateProvider_ReadsFixedFeed() public {
        oracle.addFeed(keyAB);
        _pokeFor(_ids(idAB), 31);
        TwapRateProvider rp = new TwapRateProvider(oracle, idAB, true);
        assertEq(rp.getRate(), 1e18);
    }

    function _slot0(PoolId id) internal view returns (uint160, int24, uint24, uint24) {
        return StateLibraryView.getSlot0(manager, id);
    }
}

import {StateLibrary as StateLibraryView} from "v4-core/src/libraries/StateLibrary.sol";
