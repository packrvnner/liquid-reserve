// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {UniswapV4Swapper, IWHYPE} from "../../src/adapters/UniswapV4Swapper.sol";
import {V4TwapOracle} from "../../src/adapters/V4TwapOracle.sol";
import {TwapRateProvider} from "../../src/adapters/TwapRateProvider.sol";
import {SwapConfig} from "../../src/SwapConfig.sol";
import {ISwapper} from "../../src/interfaces/ISwapper.sol";
import {IPriceOracle} from "../../src/interfaces/IPriceOracle.sol";
import {IRateProvider} from "../../src/interfaces/IRateProvider.sol";
import {LiquidReserveStaking} from "../../src/LiquidReserveStaking.sol";
import {CreatorPayout} from "../../src/CreatorPayout.sol";
import {InflowAllocator} from "../../src/InflowAllocator.sol";
import {YieldRouter} from "../../src/YieldRouter.sol";
import {LockedReserve} from "../../src/LockedReserve.sol";
import {FeeSplitter} from "../../src/FeeSplitter.sol";
import {BridgeOut} from "../../src/bridge/BridgeOut.sol";
import {IL2GatewayRouter} from "../../src/interfaces/IArbitrumGateway.sol";
import {LiquidityVault} from "../../src/vaults/LiquidityVault.sol";
import {VaultLauncher} from "../../src/vaults/VaultLauncher.sol";
import {VaultZap, IZapVault} from "../../src/vaults/VaultZap.sol";

/// @dev Stand-in for Arbitrum's ArbSys precompile (0x64), which Foundry's EVM
/// doesn't have. The real gateway calls sendTxToL1 to queue the withdrawal.
contract MockArbSys {
    uint256 public calls;

    fallback(bytes calldata) external payable returns (bytes memory) {
        ++calls;
        return abi.encode(uint256(calls));
    }
}

interface IAscendLaunchpad {
    function currentFee(PoolId id) external view returns (uint24);
}

/// @notice Runs the adapters and the whole Liquid Reserve system against real
/// Elysium mainnet state (read-only fork).
///
///   ELYSIUM_FORK=true forge test --match-path "test/fork/*" -vv
///
/// An existing Ascend coin paired with KNTQ stands in for LR, so swaps go
/// through Ascend's real hook.
contract ElysiumForkTest is Test {
    using StateLibrary for IPoolManager;

    IPoolManager constant PM = IPoolManager(0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1);
    address constant WHYPE = 0xbA876237B0F021A6c6D852d6c26E107997cC5E81;
    address constant USDC = 0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65;
    address constant KNTQ = 0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0;
    address constant KHYPE = 0x248888D396A546A69A188f3Deb476964e581E9d0;
    address constant ASCEND = 0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC;
    address constant KHYPE_HOOK = 0x8129bab872318a64B0e6212C6C491feED06C3de3;
    address constant COIN = 0x75E2fF9730AC84eb995D7733971821E9125c7f38; // Ascend coin, KNTQ pair
    address constant ASCEND_BURN_SINK = 0x9F0b0e3B362937b07Cd1E869b50687961e0c7741;
    address constant L2_GATEWAY_ROUTER = 0x61EbbC3A29f1970aF2Ce862bA9c5364832E14d17;
    address constant KNTQ_ON_HYPEREVM = 0x000000000000780555bD0BCA3791f89f9542c2d6;

    PoolKey kntqHype; // native HYPE / KNTQ, 0.3%, no hook
    PoolKey usdcHype; // native HYPE / USDC, 0.3%, no hook
    PoolKey khypeWhype; // kHYPE / WHYPE, dynamic fee, hook
    PoolKey coinKntq; // Ascend coin / KNTQ, Ascend hook

    UniswapV4Swapper swapper;
    V4TwapOracle oracle;
    uint24 ascendFee;
    uint24 khypeFee;

    function setUp() public {
        if (!vm.envOr("ELYSIUM_FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork("elysium");

        kntqHype = PoolKey(Currency.wrap(address(0)), Currency.wrap(KNTQ), 3000, 60, IHooks(address(0)));
        usdcHype = PoolKey(Currency.wrap(address(0)), Currency.wrap(USDC), 3000, 60, IHooks(address(0)));
        khypeWhype = PoolKey(Currency.wrap(KHYPE), Currency.wrap(WHYPE), 0x800000, 1, IHooks(KHYPE_HOOK));
        coinKntq = PoolKey(Currency.wrap(COIN), Currency.wrap(KNTQ), 0x800000, 200, IHooks(ASCEND));

        swapper = new UniswapV4Swapper(address(this), PM, WHYPE);
        oracle = new V4TwapOracle(address(this), PM, WHYPE, 30 minutes, 60, 1 hours, 10);
        oracle.setKeeper(address(this), true);

        ascendFee = IAscendLaunchpad(ASCEND).currentFee(coinKntq.toId());
        (,,, khypeFee) = PM.getSlot0(khypeWhype.toId());
        console2.log("Ascend coin fee (pips):", ascendFee);
        console2.log("kHYPE pool lp fee (pips):", khypeFee);
    }

    // ---------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------

    struct H {
        PoolKey key;
        bool zeroForOne;
        uint24 fee;
    }

    /// Sets the same route on the swapper and the oracle.
    function _route(address tin, address tout, H[] memory hs) internal {
        UniswapV4Swapper.Hop[] memory hops = new UniswapV4Swapper.Hop[](hs.length);
        PoolId[] memory ids = new PoolId[](hs.length);
        uint24[] memory fees = new uint24[](hs.length);
        for (uint256 i; i < hs.length; ++i) {
            hops[i].kind = UniswapV4Swapper.HopKind.V4_SWAP;
            hops[i].key = hs[i].key;
            hops[i].zeroForOne = hs[i].zeroForOne;
            ids[i] = hs[i].key.toId();
            fees[i] = hs[i].fee;
            (,, uint32 lastTime,,,,) = oracle.feeds(ids[i]);
            if (lastTime == 0) oracle.addFeed(hs[i].key);
        }
        swapper.setRoute(tin, tout, hops);
        oracle.setRoute(tin, tout, ids, fees);
    }

    function _h(PoolKey memory k, bool z, uint24 f) internal pure returns (H memory) {
        return H(k, z, f);
    }

    function _r1(H memory a) internal pure returns (H[] memory r) {
        r = new H[](1);
        r[0] = a;
    }

    function _r2(H memory a, H memory b) internal pure returns (H[] memory r) {
        r = new H[](2);
        r[0] = a;
        r[1] = b;
    }

    function _r3(H memory a, H memory b, H memory c) internal pure returns (H[] memory r) {
        r = new H[](3);
        r[0] = a;
        r[1] = b;
        r[2] = c;
    }

    function _allFeeds() internal view returns (PoolId[] memory ids) {
        ids = new PoolId[](4);
        ids[0] = kntqHype.toId();
        ids[1] = usdcHype.toId();
        ids[2] = khypeWhype.toId();
        ids[3] = coinKntq.toId();
    }

    function _warmOracle() internal {
        PoolId[] memory ids = _allFeeds();
        for (uint256 i; i < 31; ++i) {
            vm.warp(block.timestamp + 60);
            oracle.poke(ids);
        }
    }

    function _keeperPause() internal {
        vm.warp(block.timestamp + 600);
        oracle.poke(_allFeeds());
    }

    function _swap(address tin, address tout, uint256 amount) internal returns (uint256 out) {
        IERC20(tin).approve(address(swapper), amount);
        out = swapper.swap(tin, tout, amount, 0, address(this));
    }

    function _wrap(uint256 amount) internal {
        vm.deal(address(this), amount);
        IWHYPE(WHYPE).deposit{value: amount}();
    }

    function _setAllRoutes() internal {
        // KNTQ <-> HYPE, HYPE <-> USDC, HYPE <-> kHYPE, KNTQ <-> coin (Ascend)
        _route(KNTQ, WHYPE, _r1(_h(kntqHype, false, 3000)));
        _route(WHYPE, USDC, _r1(_h(usdcHype, true, 3000)));
        _route(USDC, WHYPE, _r1(_h(usdcHype, false, 3000)));
        _route(WHYPE, KHYPE, _r1(_h(khypeWhype, false, khypeFee)));
        _route(KNTQ, COIN, _r1(_h(coinKntq, false, ascendFee)));
        _route(COIN, KNTQ, _r1(_h(coinKntq, true, ascendFee)));
        _route(KNTQ, USDC, _r2(_h(kntqHype, false, 3000), _h(usdcHype, true, 3000)));
        _route(KNTQ, KHYPE, _r2(_h(kntqHype, false, 3000), _h(khypeWhype, false, khypeFee)));
        _route(COIN, WHYPE, _r2(_h(coinKntq, true, ascendFee), _h(kntqHype, false, 3000)));
        _route(COIN, USDC, _r3(_h(coinKntq, true, ascendFee), _h(kntqHype, false, 3000), _h(usdcHype, true, 3000)));
        _route(COIN, KHYPE, _r3(_h(coinKntq, true, ascendFee), _h(kntqHype, false, 3000), _h(khypeWhype, false, khypeFee)));
    }

    // ---------------------------------------------------------------------
    // Adapters on real pools
    // ---------------------------------------------------------------------

    function test_Fork_PoolKeysMatchOnChainPools() public view {
        assertEq(PoolId.unwrap(kntqHype.toId()), 0xf9b8a9101438145d62c9f03156b203c6c573931167e2d36f9061a32575706c8a);
        assertEq(PoolId.unwrap(usdcHype.toId()), 0xb3032695ffb0a66e6342876dd2386835471466cb2bb70f341947d98a69e265cc);
        assertEq(PoolId.unwrap(khypeWhype.toId()), 0x890fc38d3b7ce4482eaab02250be48f596aec0b60c10f29fa2d1ccf356c3740c);
        assertEq(PoolId.unwrap(coinKntq.toId()), 0xb037fd6a45b19349809c1af2f869c2b302e9b4ce63e28d05f5887b85194a9cda);
    }

    /// Every route's real swap output is within 1% of the oracle's fee-adjusted quote.
    /// Each route is tried from the same starting point: the pools as the oracle read them. Several routes share
    /// a pool, and the quotes are taken before any swap, so without this a later route would also be charged with
    /// the price moves of the swaps before it (on 2026-11-25 that alone put KNTQ -> USDC 1.4% under its quote).
    function test_Fork_SwapsMatchOracleQuotes() public {
        _setAllRoutes();
        _warmOracle();
        deal(KNTQ, address(this), 20_000e18);
        _wrap(100e18);

        address[2][6] memory pairs = [
            [KNTQ, WHYPE], [WHYPE, USDC], [WHYPE, KHYPE], [KNTQ, COIN], [KNTQ, USDC], [KNTQ, KHYPE]
        ];
        // The stand-in coin's pool is thin (~11% impact for 1,000 KNTQ), so its route uses 20 KNTQ.
        uint256[6] memory amounts = [uint256(1_000e18), 5e18, 5e18, 20e18, 1_000e18, 1_000e18];
        for (uint256 i; i < pairs.length; ++i) {
            uint256 start = vm.snapshotState();
            uint256 expected = oracle.quote(pairs[i][0], pairs[i][1], amounts[i]);
            uint256 out = _swap(pairs[i][0], pairs[i][1], amounts[i]);
            console2.log("route", i, "out / expected (bps):", out * 10_000 / expected);
            assertApproxEqRel(out, expected, 0.01e18);
            // The swapper never keeps anything.
            assertEq(IERC20(KNTQ).balanceOf(address(swapper)), 0);
            assertEq(IERC20(WHYPE).balanceOf(address(swapper)), 0);
            assertEq(address(swapper).balance, 0);
            vm.revertToState(start);
        }
    }

    /// Ascend's hook accepts direct PoolManager swaps in both directions.
    function test_Fork_AscendCoinRoundTrip() public {
        _setAllRoutes();
        deal(KNTQ, address(this), 1_000e18);
        uint256 coins = _swap(KNTQ, COIN, 1_000e18);
        assertGt(coins, 0);
        uint256 back = _swap(COIN, KNTQ, coins);
        console2.log("KNTQ back from 1000 after round trip:", back / 1e18);
        // Two Ascend fees plus price impact.
        assertGt(back, 1_000e18 * (1e6 - 2 * uint256(ascendFee)) / 1e6 * 99 / 100);
    }

    function test_Fork_KhypeRateFromTwap() public {
        _setAllRoutes();
        _warmOracle();
        TwapRateProvider rp = new TwapRateProvider(oracle, khypeWhype.toId(), true);
        uint256 rate = rp.getRate();
        console2.log("kHYPE rate (HYPE per kHYPE, 1e18):", rate);
        assertGt(rate, 1e18); // kHYPE has accrued staking yield
        assertLt(rate, 1.2e18);
    }

    // ---------------------------------------------------------------------
    // Whole system on real Elysium state
    // ---------------------------------------------------------------------

    // The system under test lives in storage to keep the test function small.
    address creator;
    LiquidReserveStaking staking;
    CreatorPayout payout;
    BridgeOut bridgeOut;
    InflowAllocator allocator;
    YieldRouter router;
    LockedReserve reserve;
    FeeSplitter feeRouter;

    function _deployOnFork() internal {
        creator = makeAddr("creator");
        SwapConfig cfg = new SwapConfig(address(this), ISwapper(address(swapper)), IPriceOracle(address(oracle)), 100);
        staking = new LiquidReserveStaking(IERC20(COIN));
        payout = new CreatorPayout(cfg, creator, USDC, WHYPE, KNTQ, COIN);
        bridgeOut = new BridgeOut(
            IL2GatewayRouter(L2_GATEWAY_ROUTER), IERC20(KNTQ), KNTQ_ON_HYPEREVM, makeAddr("StakeAndLock on HyperEVM"), 100e18
        );
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 3);
        allocator = new InflowAllocator(
            cfg, LockedReserve(predicted), [KHYPE, KNTQ, COIN], [predicted, address(bridgeOut), predicted]
        );
        router = new YieldRouter(
            cfg, address(this), address(payout), address(allocator), staking, COIN, KNTQ, WHYPE, ASCEND_BURN_SINK
        );
        TwapRateProvider khypeRate = new TwapRateProvider(oracle, khypeWhype.toId(), true);
        reserve = new LockedReserve(
            [KHYPE, COIN, address(0)],
            [IRateProvider(address(khypeRate)), IRateProvider(address(0)), IRateProvider(address(0))],
            address(router)
        );
        assertEq(address(reserve), predicted);
        feeRouter = new FeeSplitter(address(payout), 2_000, address(allocator));
    }

    function test_Fork_FullFlywheel() public {
        _setAllRoutes();
        _warmOracle();
        _deployOnFork();

        // 1. Ascend creator fees arrive in KNTQ. The stand-in coin's pool is thin,
        //    so the whole batch would exceed the 1% slippage limit: the keeper
        //    processes it in pieces.
        deal(KNTQ, address(feeRouter), 1_000e18);
        feeRouter.distribute(KNTQ);
        vm.expectPartialRevert(bytes4(keccak256("InsufficientOutput(uint256,uint256)")));
        allocator.allocate(KNTQ);
        //    Like a real keeper, it spaces the pieces 10 minutes apart and pokes
        //    the oracle, so our own LR buying never runs >1% ahead of the average.
        while (IERC20(KNTQ).balanceOf(address(allocator)) > 0) {
            allocator.allocatePartial(KNTQ, 50e18);
            _keeperPause();
        }
        while (IERC20(KNTQ).balanceOf(address(payout)) > 0) {
            payout.payoutPartial(KNTQ, 50e18);
            _keeperPause();
        }

        console2.log("reserve kHYPE principal (HYPE):", reserve.principal(KHYPE) / 1e15, "e-3");
        console2.log("KNTQ waiting to bridge to HyperEVM:", IERC20(KNTQ).balanceOf(address(bridgeOut)) / 1e18);
        console2.log("reserve LR(coin) principal:", reserve.principal(COIN) / 1e18);
        console2.log("creator USDC:", IERC20(USDC).balanceOf(creator) / 1e6);
        assertGt(reserve.principal(KHYPE), 0);
        assertGt(reserve.principal(COIN), 0);
        assertEq(IERC20(KNTQ).balanceOf(address(bridgeOut)), 320e18, "40% of 800 KNTQ, to be staked on HyperEVM");
        assertGt(IERC20(USDC).balanceOf(creator), 0);
        assertGt(IERC20(WHYPE).balanceOf(creator), 0);
        assertEq(IERC20(KNTQ).balanceOf(creator), 40e18, "20% of 200 KNTQ");
        assertGt(IERC20(COIN).balanceOf(creator), 0);

        // 2. The KNTQ share leaves for HyperEVM through the canonical bridge.
        vm.etch(address(100), address(new MockArbSys()).code);
        uint256 supplyBefore = IERC20(KNTQ).totalSupply();
        bridgeOut.bridge();
        assertEq(IERC20(KNTQ).balanceOf(address(bridgeOut)), 0);
        assertEq(supplyBefore - IERC20(KNTQ).totalSupply(), 320e18, "burned on Elysium, released on HyperEVM");

        // 3. Yield: LR rewards land in the reserve; harvest and run the waterfall.
        deal(COIN, address(this), 100_000e18);
        IERC20(COIN).transfer(address(reserve), 100_000e18);
        assertEq(reserve.harvest(COIN), 100_000e18);
        router.route(COIN);
        payout.payout(COIN);
        allocator.allocate(COIN);

        assertEq(IERC20(COIN).balanceOf(address(router)), 0);
        assertGt(IERC20(COIN).balanceOf(ASCEND_BURN_SINK), 0, "LR burned in Ascend's BurnSink");
        assertGt(IERC20(KNTQ).balanceOf(router.BURN_ADDRESS()), 0, "KNTQ burned");
        assertGt(IERC20(WHYPE).balanceOf(router.BURN_ADDRESS()), 0, "HYPE burned");
        assertGt(IERC20(COIN).balanceOf(address(staking)), 0, "stakers funded");
        for (uint256 i; i < reserve.assetCount(); ++i) {
            address a = reserve.assetAt(i);
            assertGe(reserve.valueOf(a), reserve.principal(a));
        }
    }

    // ---------------------------------------------------------------------
    // Auto-compounding vault on a real Elysium pool
    // ---------------------------------------------------------------------

    function test_Fork_VaultOnRealHypeUsdcPool() public {
        _setAllRoutes(); // only so this test can trade through the pool; the vault needs none of it
        address feeRouterAddr = makeAddr("FeeRouter");
        address keeperAddr = makeAddr("keeper");
        LiquidityVault v = new LiquidityVault(
            LiquidityVault.Params({
                key: usdcHype,
                poolManager: PM,
                feeRecipient: feeRouterAddr,
                whype: WHYPE,
                owner: address(this),
                keeper: keeperAddr,
                name: "Liquid Reserve Vault HYPE-USDC",
                symbol: "lrvHYPE-USDC",
                mainWidth: 30,
                altWidth: 30,
                depositCap: 25_000e6
            })
        );
        assertEq(address(v.token0()), WHYPE);
        assertEq(address(v.token1()), USDC);

        // First deposit, in native HYPE: 10 HYPE + 700 USDC. No oracle, no bot.
        deal(USDC, address(this), 10_000e6);
        IERC20(USDC).approve(address(v), type(uint256).max);
        v.deposit{value: 10e18}(1, 0, 700e6, address(this));
        uint256 shares = v.balanceOf(address(this));
        (uint256 p0, uint256 p1) = v.positionAmounts();
        console2.log("vault shares:", shares, "position HYPE / USDC (1e15, 1e3):");
        console2.log(p0 / 1e15, p1 / 1e3);
        console2.log("vault value (USDC, 1e6):", v.totalValue());

        _carolJoins(v);

        // Traders swap through the pool both ways: fees accrue.
        for (uint256 i; i < 10; ++i) {
            _wrap(2e18);
            _swap(WHYPE, USDC, 2e18);
            _swap(USDC, WHYPE, IERC20(USDC).balanceOf(address(this)) - 9_300e6);
        }
        (uint256 f0, uint256 f1) = v.pendingFees();
        assertGt(f0 + f1, 0, "fees waiting");

        vm.prank(makeAddr("anyone")); // anyone can harvest, at any time
        v.harvest();
        uint256 perfUsdc = IERC20(USDC).balanceOf(feeRouterAddr);
        uint256 perfHype = IERC20(WHYPE).balanceOf(feeRouterAddr);
        console2.log("performance fee HYPE (1e12) / USDC (1e0):", perfHype / 1e12, perfUsdc);
        assertGt(perfUsdc + perfHype, 0, "20% of real pool fees to the fee recipient");

        // The keeper re-centers the ranges at the price it sees.
        (, int24 tick) = v.price();
        vm.prank(keeperAddr);
        v.rebalance(tick, 10);

        uint256 hypeBefore = address(this).balance;
        (uint256 out0, uint256 out1) = v.withdraw(shares, 0, 0, address(this), true);
        console2.log("withdrew HYPE (1e15) / USDC (1e3):", out0 / 1e15, out1 / 1e3);
        assertEq(address(this).balance - hypeBefore, out0, "paid in native HYPE");
        assertGt(out1, 0);
        assertEq(v.balanceOf(address(this)), 0);
    }

    /// A second depositor joins in the vault's ratio; the spare HYPE comes straight back.
    function _carolJoins(LiquidityVault v) internal {
        address carol = makeAddr("carol");
        vm.deal(carol, 20e18);
        deal(USDC, carol, 5_000e6);
        (uint256 s, uint256 n0, uint256 n1) = v.previewDeposit(5e18, type(uint128).max);
        vm.startPrank(carol);
        IERC20(USDC).approve(address(v), type(uint256).max);
        (uint256 used0, uint256 used1) = v.deposit{value: 8e18}(s, 0, n1 + n1 / 200, carol);
        vm.stopPrank();
        assertApproxEqRel(used0, n0, 0.001e18);
        assertEq(carol.balance, 20e18 - used0, "unused HYPE refunded as native HYPE");
        console2.log("carol paid HYPE (1e15) / USDC (1e3):", used0 / 1e15, used1 / 1e3);
    }

    /// The one-transaction launch, exactly as it will be sent on mainnet.
    function test_Fork_LauncherOnRealPools() public {
        address owner_ = 0x822aA88543b9da39c4c3D856857379E17526C1E8;
        VaultLauncher l = new VaultLauncher(
            VaultLauncher.Config({
                poolManager: PM,
                whype: WHYPE,
                usdc: USDC,
                kntq: KNTQ,
                owner: owner_,
                keeper: owner_,
                poolFee: 3000,
                tickSpacing: 60,
                mainWidth: 30,
                altWidth: 30,
                capUsdc: 25_000e6,
                capKntq: 90_000e18
            })
        );
        LiquidityVault a = l.hypeUsdc();
        LiquidityVault b = l.hypeKntq();
        assertEq(a.owner(), owner_);
        assertEq(b.keeper(), owner_);
        assertEq(address(b.token1()), KNTQ);

        // Both accept a first deposit straight away.
        deal(USDC, address(this), 1_000e6);
        deal(KNTQ, address(this), 1_000e18);
        IERC20(USDC).approve(address(a), type(uint256).max);
        IERC20(KNTQ).approve(address(b), type(uint256).max);
        a.deposit{value: 5e18}(1, 0, 200e6, address(this));
        b.deposit{value: 5e18}(1, 0, 500e18, address(this));
        assertGt(a.totalValue(), 0);
        assertGt(b.totalValue(), 0);
        console2.log("HYPE-USDC value (USDC 1e6):", a.totalValue());
        console2.log("HYPE-KNTQ value (KNTQ 1e18):", b.totalValue() / 1e18);
    }

    /// One-token deposits into the vaults that are live on mainnet, through the zap.
    function test_Fork_ZapIntoLiveVaults() public {
        LiquidityVault usdcVault = LiquidityVault(payable(0xdaaac4cc69E28CD1a4A1A8F97db464375E52E298));
        if (address(usdcVault).code.length == 0) return; // fork is older than the launch
        VaultZap zap = new VaultZap(PM);
        address dana = makeAddr("dana");
        vm.deal(dana, 10e18);
        deal(USDC, dana, 500e6);
        vm.startPrank(dana);
        IERC20(USDC).approve(address(zap), type(uint256).max);

        _zapHypeIntoKntqVault(zap, dana);

        // USDC only, then HYPE only, into HYPE-USDC.
        uint256 usdcBefore = IERC20(USDC).balanceOf(dana);
        (uint256 s2,, uint256 q1) = zap.zapIn(IZapVault(address(usdcVault)), false, 20e6, 0, dana);
        console2.log("HYPE-USDC: shares, USDC back:", s2, q1);
        assertGt(s2, 0);
        assertEq(usdcBefore - IERC20(USDC).balanceOf(dana), 20e6 - q1);
        (uint256 s3,,) = zap.zapIn{value: 0.2e18}(IZapVault(address(usdcVault)), true, 0.2e18, 0, dana);
        assertGt(s3, 0);

        // The shares are real: they can be withdrawn.
        (uint256 o0, uint256 o1) = usdcVault.withdraw(s2 + s3, 0, 0, dana, true);
        vm.stopPrank();
        console2.log("withdrew from HYPE-USDC: HYPE (1e12), USDC:", o0 / 1e12, o1);
        assertGt(o0 + o1, 0);
        assertEq(address(zap).balance, 0);
        assertEq(IERC20(USDC).balanceOf(address(zap)) + IERC20(KNTQ).balanceOf(address(zap)), 0, "zap keeps nothing");
    }

    function _zapHypeIntoKntqVault(VaultZap zap, address who) internal {
        IZapVault kntqVault = IZapVault(0xE78475C23691e7Fa65131C176C0D3bD5a146aDCf);
        uint256 hypeBefore = who.balance;
        (uint256 s1, uint256 r0, uint256 r1) = zap.zapIn{value: 0.5e18}(kntqVault, true, 0.5e18, 0, who);
        console2.log("HYPE-KNTQ: shares, HYPE back (1e12), KNTQ back (1e12):", s1, r0 / 1e12, r1 / 1e12);
        assertGt(s1, 0);
        assertEq(hypeBefore - who.balance, 0.5e18 - r0);
        assertLt(r0, 0.05e18, "nearly all the HYPE went in");
    }

    receive() external payable {}
}
