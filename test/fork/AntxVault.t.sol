// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {UniswapV4Swapper} from "../../src/adapters/UniswapV4Swapper.sol";
import {LiquidityVaultV2} from "../../src/vaults/LiquidityVaultV2.sol";
import {EmptyPoolPrice} from "../../src/vaults/EmptyPoolPrice.sol";
import {FeeSplitter} from "../../src/FeeSplitter.sol";

interface IL2Gateway {
    function finalizeInboundTransfer(address token, address from, address to, uint256 amount, bytes calldata data) external payable;
}

interface IL2Router {
    function calculateL2TokenAddress(address l1Token) external view returns (address);
}

/// @notice The wANTx-USDC vault on a copy of Elysium mainnet. wANTx (Wrapped Anthropic xStock) lives on HyperEVM;
/// on Elysium it is the token the canonical bridge makes for it, which did not exist yet when this was written.
/// The test brings it into being exactly as the bridge would (the Elysium gateway, called by the HyperEVM
/// gateway's alias), then runs the vault's whole life on a pool where the vault is the only liquidity:
/// LiquidityVaultV2, the same contract as the HYPE-USDC and HYPE-KNTQ vaults, for the first time on a pair
/// without HYPE.
///
///   ELYSIUM_FORK=true forge test --match-contract AntxVaultFork -vv
contract AntxVaultForkTest is Test {
    using StateLibrary for IPoolManager;

    IPoolManager constant PM = IPoolManager(0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1);
    address constant WHYPE = 0xbA876237B0F021A6c6D852d6c26E107997cC5E81;
    address constant USDC = 0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65;
    address constant WANTX_L1 = 0xabec6AeAb037b77c09a2a99264F9C81a35B02649; // on HyperEVM
    address constant WANTX = 0xd7d0288Cef796cCc5752B4352f80b74aD2929334; // on Elysium, made by the bridge
    IL2Router constant L2_ROUTER = IL2Router(0x61EbbC3A29f1970aF2Ce862bA9c5364832E14d17);
    IL2Gateway constant L2_GATEWAY = IL2Gateway(0x5DC84e4Cb0F9082246E92a5585C5395592B1aF1f);
    address constant L1_GATEWAY_ALIAS = 0xEa8c30de0Ba0C2eAeE942afcE77530e06c5F233d;
    FeeSplitter constant FEE_SPLIT = FeeSplitter(0xB92c756347de468d7086a97EF112801b3371a408); // VaultFeeSplit, live
    address constant CREATOR = 0x9324605c9C707b2F805CCF2AC099fCA5d561DC37;
    address constant FEE_INBOX = 0x2AfD3850794b84205667CE2826b09FA5bf1c3a5c;
    address constant OWNER = 0x822aA88543b9da39c4c3D856857379E17526C1E8;
    address constant BOT = 0x0461663d46DA68264966a0670335E3ecf0b96F3C;
    uint256 constant PRICE = 87; // dollars per wANTx, where the pool is opened
    /// The real pool was opened in Elysium block 9,037,700 (2026-11-21 04:36 UTC) and holds the live vault's
    /// liquidity since. This rehearsal needs the pool empty, so it runs on the chain as it stood one block earlier.
    uint256 constant BEFORE_THE_REAL_POOL = 9_037_699;

    PoolKey key = PoolKey(Currency.wrap(USDC), Currency.wrap(WANTX), 3000, 60, IHooks(address(0)));
    EmptyPoolPrice setter;
    LiquidityVaultV2 v;
    UniswapV4Swapper swapper;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address trader = makeAddr("trader");

    function setUp() public {
        if (!vm.envOr("ELYSIUM_FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork("elysium", BEFORE_THE_REAL_POOL);
        // the token arrives over the bridge (the first arrival creates it)
        _bridgeIn(alice, 100e18);
        _bridgeIn(bob, 100e18);
        _bridgeIn(trader, 1_000e18);
        deal(USDC, alice, 100_000e6);
        deal(USDC, bob, 100_000e6);
        deal(USDC, trader, 500_000e6);

        setter = new EmptyPoolPrice(PM);
        setter.set(key, _sqrtPriceFor(PRICE));
        v = new LiquidityVaultV2(
            LiquidityVaultV2.Params({
                key: key,
                poolManager: PM,
                feeRecipient: address(FEE_SPLIT),
                whype: WHYPE,
                owner: OWNER,
                keeper: BOT,
                name: "Liquid Reserve Vault wANTx-USDC v2",
                symbol: "lrvwANTx-USDC-2",
                mainWidth: 30,
                altWidth: 30,
                depositCap: 300e18
            })
        );
        swapper = new UniswapV4Swapper(address(this), PM, WHYPE);
        UniswapV4Swapper.Hop[] memory hop = new UniswapV4Swapper.Hop[](1);
        hop[0] = UniswapV4Swapper.Hop(UniswapV4Swapper.HopKind.V4_SWAP, key, true, address(0));
        swapper.setRoute(USDC, WANTX, hop);
        hop[0].zeroForOne = false;
        swapper.setRoute(WANTX, USDC, hop);
        for (uint256 i; i < 3; ++i) {
            address who = [alice, bob, trader][i];
            vm.startPrank(who);
            IERC20(USDC).approve(address(v), type(uint256).max);
            IERC20(WANTX).approve(address(v), type(uint256).max);
            IERC20(USDC).approve(address(swapper), type(uint256).max);
            IERC20(WANTX).approve(address(swapper), type(uint256).max);
            vm.stopPrank();
        }
    }

    // ------------------------------------------------------------------ helpers

    /// What the bridge does on Elysium when wANTx arrives from HyperEVM.
    function _bridgeIn(address to, uint256 amount) internal {
        bytes memory tokenInfo = abi.encode(abi.encode("Wrapped Anthropic xStock"), abi.encode("wANTx"), abi.encode(uint8(18)));
        vm.prank(L1_GATEWAY_ALIAS);
        L2_GATEWAY.finalizeInboundTransfer(WANTX_L1, address(this), to, amount, abi.encode(tokenInfo, bytes("")));
    }

    /// sqrtPriceX96 of the pool (wANTx per USDC, in raw units) for a wANTx worth `dollars`.
    function _sqrtPriceFor(uint256 dollars) internal pure returns (uint160) {
        // raw wANTx per raw USDC = 1e18 / (dollars * 1e6)
        return uint160(_sqrt((uint256(1e12) << 192) / dollars));
    }

    function _sqrt(uint256 x) internal pure returns (uint256 r) {
        if (x == 0) return 0;
        r = x;
        uint256 k = (x >> 1) + 1;
        while (k < r) {
            r = k;
            k = (x / k + k) >> 1;
        }
    }

    /// Dollars per wANTx at the pool's price, with 4 decimals.
    function _dollars() internal view returns (uint256) {
        (uint160 p,) = v.price();
        uint256 ratioX96 = uint256(p) * uint256(p) >> 96; // raw wANTx per raw USDC, times 2^96
        return (uint256(1e16) << 96) / ratioX96;
    }

    function _firstDeposit() internal returns (uint256 shares) {
        vm.prank(alice);
        v.deposit(1, 870e6, 10e18, alice); // $870 of each side at $87
        shares = v.balanceOf(alice);
    }

    /// A buyer takes the price down to `limitTick` (fewer wANTx per USDC), buying whatever is on the way.
    /// The project's swapper refuses a swap it cannot fill completely, so this one talks to the pool itself.
    function _buyDownTo(int24 limitTick) internal {
        deal(USDC, address(this), 1_000_000e6);
        PM.unlock(abi.encode(limitTick));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(PM), "pool manager only");
        int24 limitTick = abi.decode(data, (int24));
        BalanceDelta d = PM.swap(
            key,
            IPoolManager.SwapParams({zeroForOne: true, amountSpecified: -int256(1_000_000e6), sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(limitTick)}),
            ""
        );
        if (d.amount0() < 0) {
            PM.sync(key.currency0);
            IERC20(USDC).transfer(address(PM), uint256(uint128(-d.amount0())));
            PM.settle();
        }
        if (d.amount1() > 0) PM.take(key.currency1, address(this), uint256(uint128(d.amount1())));
        return "";
    }

    function _trade(uint256 rounds, uint256 usdcEach) internal {
        vm.startPrank(trader);
        for (uint256 i; i < rounds; ++i) {
            uint256 got = swapper.swap(USDC, WANTX, usdcEach, 0, trader);
            swapper.swap(WANTX, USDC, got, 0, trader);
        }
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ the token and the pool

    function test_TheTokenIsTheOneTheBridgeMakes() public view {
        assertEq(L2_ROUTER.calculateL2TokenAddress(WANTX_L1), WANTX, "the address the bridge's router gives for wANTx");
        assertEq(IERC20Metadata(WANTX).name(), "Wrapped Anthropic xStock");
        assertEq(IERC20Metadata(WANTX).symbol(), "wANTx");
        assertEq(IERC20Metadata(WANTX).decimals(), 18);
        assertEq(IERC20(WANTX).balanceOf(alice), 100e18);
        assertLt(uint160(USDC), uint160(WANTX), "USDC is the pool's first token, wANTx its second");
    }

    function test_VaultSettingsAsLaunched() public view {
        assertEq(v.feeRecipient(), address(FEE_SPLIT), "the fee goes to the live fee splitter");
        assertEq(FEE_SPLIT.recipientA(), CREATOR);
        assertEq(FEE_SPLIT.bpsA(), 2000);
        assertEq(FEE_SPLIT.recipientB(), FEE_INBOX);
        assertEq(v.owner(), OWNER);
        assertEq(v.keeper(), BOT);
        assertEq(address(v.token0()), USDC);
        assertEq(address(v.token1()), WANTX);
        assertFalse(v.nativePool());
        assertEq(v.decimals(), 18);
        assertEq(v.depositCap(), 300e18);
        assertEq(v.PERFORMANCE_FEE_BPS(), 2000);
        assertApproxEqRel(_dollars(), PRICE * 1e4, 0.001e18, "the pool opened at the price asked for");
    }

    function test_PriceHelper_MovesOnlyAnEmptyPool() public {
        // empty: anyone can put it at another price, and nothing changes hands
        uint256 pm0 = IERC20(USDC).balanceOf(address(PM));
        uint256 pm1 = IERC20(WANTX).balanceOf(address(PM));
        vm.prank(bob);
        setter.set(key, _sqrtPriceFor(95));
        assertApproxEqRel(_dollars(), 95e4, 0.001e18);
        vm.prank(bob);
        setter.set(key, _sqrtPriceFor(80));
        assertApproxEqRel(_dollars(), 80e4, 0.001e18);
        assertEq(IERC20(USDC).balanceOf(address(PM)), pm0, "no USDC moved");
        assertEq(IERC20(WANTX).balanceOf(address(PM)), pm1, "no wANTx moved");
        assertEq(IERC20(USDC).balanceOf(address(setter)) + IERC20(WANTX).balanceOf(address(setter)), 0);
        setter.set(key, _sqrtPriceFor(PRICE));

        // with the vault's liquidity at the price it refuses
        _firstDeposit();
        uint256 before = _dollars();
        vm.expectRevert(EmptyPoolPrice.PoolHasLiquidity.selector);
        setter.set(key, _sqrtPriceFor(50));
        assertEq(_dollars(), before);

        // a pool with a hook is refused, and only the pool manager may call back
        PoolKey memory hooked = PoolKey(Currency.wrap(USDC), Currency.wrap(WANTX), 3000, 60, IHooks(address(0xBEEF)));
        vm.expectRevert(EmptyPoolPrice.HookedPool.selector);
        setter.set(hooked, _sqrtPriceFor(PRICE));
        vm.expectRevert(EmptyPoolPrice.NotPoolManager.selector);
        setter.unlockCallback("");
    }

    function test_PriceHelper_CannotJumpOverLiquidityBesideThePrice() public {
        _firstDeposit();
        // the price is pushed out past everything the vault holds: nothing is left at the price,
        // but the vault's ranges are still in the way back
        (int24 lo,,) = v.main();
        _buyDownTo(lo - 600);
        assertEq(PM.getLiquidity(v.poolId()), 0, "nothing at the price any more");
        uint256 before = _dollars();
        assertGt(before, PRICE * 1e4);
        vm.expectRevert(); // it would have to trade through the vault's ranges
        setter.set(key, _sqrtPriceFor(PRICE));
        assertEq(_dollars(), before);
    }

    // ------------------------------------------------------------------ deposits and withdrawals

    function test_FirstDeposit_BothTokens_OpensRanges() public {
        uint256 u0 = IERC20(USDC).balanceOf(alice);
        uint256 w0 = IERC20(WANTX).balanceOf(alice);
        uint256 shares = _firstDeposit();
        (uint256 t0, uint256 t1) = v.balances();
        (int24 lo, int24 hi, uint128 liq) = v.main();
        (, int24 tick) = v.price();
        console2.log("shares minted (1e15):", shares / 1e15);
        console2.log("vault holds USDC (cents):", t0 / 1e4, "wANTx (1e-3):", t1 / 1e15);
        assertEq(u0 - IERC20(USDC).balanceOf(alice), 870e6, "took the USDC");
        assertEq(w0 - IERC20(WANTX).balanceOf(alice), 10e18, "took the wANTx");
        assertApproxEqAbs(t0, 870e6, 10, "all of it is in the vault");
        assertApproxEqAbs(t1, 10e18, 1e6);
        assertTrue(liq > 0 && tick >= lo && tick < hi, "the main range earns at the price");
        // value in wANTx: 10 held as wANTx plus 870 USDC worth 10 more
        assertApproxEqRel(v.totalValue(), 20e18, 0.002e18);
        assertApproxEqRel(shares, 20e18, 0.002e18);
        assertEq(v.balanceOf(v.DEAD()), 1_000, "1,000 shares locked for good");
    }

    function test_NoHypeCanBeSent() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(LiquidityVaultV2.UnexpectedNative.selector);
        v.deposit{value: 0.1 ether}(1, 870e6, 10e18, alice);
    }

    function test_SecondDepositor_ProRata_ThenBothWithdraw() public {
        uint256 aShares = _firstDeposit();
        (uint256 want, uint256 need0, uint256 need1) = v.previewDeposit(435e6, 5e18);
        vm.prank(bob);
        v.deposit(want, need0 + need0 / 200, need1 + need1 / 200, bob);
        assertApproxEqRel(v.balanceOf(bob), aShares / 2, 0.01e18, "half the money, half the shares");

        uint256 u = IERC20(USDC).balanceOf(bob);
        uint256 w = IERC20(WANTX).balanceOf(bob);
        vm.startPrank(bob);
        v.withdraw(v.balanceOf(bob), 0, 0, bob, false);
        vm.stopPrank();
        assertApproxEqRel(IERC20(USDC).balanceOf(bob) - u, need0, 0.001e18, "bob's USDC back");
        assertApproxEqRel(IERC20(WANTX).balanceOf(bob) - w, need1, 0.001e18, "bob's wANTx back");

        vm.startPrank(alice);
        (uint256 o0, uint256 o1) = v.withdraw(aShares, 0, 0, alice, true); // the "unwrap HYPE" flag means nothing here
        vm.stopPrank();
        assertApproxEqRel(o0, 870e6, 0.001e18);
        assertApproxEqRel(o1, 10e18, 0.001e18);
        assertEq(alice.balance, 0, "no HYPE involved");
    }

    function test_CapIsCountedInWantx() public {
        _firstDeposit(); // worth 20 wANTx
        vm.prank(OWNER);
        v.setDepositCap(25e18);
        (uint256 want, uint256 need0, uint256 need1) = v.previewDeposit(435e6, 5e18); // +10 wANTx of value
        vm.prank(bob);
        vm.expectRevert();
        v.deposit(want, need0 + need0 / 200, need1 + need1 / 200, bob);
        (want, need0, need1) = v.previewDeposit(174e6, 2e18); // +4
        vm.prank(bob);
        v.deposit(want, need0 + need0 / 200, need1 + need1 / 200, bob);
    }

    // ------------------------------------------------------------------ fees

    function test_Fees_TwentyPercent_ToCreatorAndFeeInbox() public {
        _firstDeposit();
        _trade(10, 200e6); // $2,000 each way, ten times, at 0.3%
        (uint256 f0, uint256 f1) = v.pendingFees();
        console2.log("fees waiting, USDC (cents):", f0 / 1e4, "wANTx (1e-6):", f1 / 1e12);
        assertGt(f0, 0);
        assertGt(f1, 0);
        // $2,000 x 10 in USDC at 0.3% is $60; the vault is the only liquidity, so it earns all of it
        assertApproxEqRel(f0, 6e6, 0.01e18, "all of the pool's USDC fee");

        uint256 s0 = IERC20(USDC).balanceOf(address(FEE_SPLIT));
        uint256 s1 = IERC20(WANTX).balanceOf(address(FEE_SPLIT));
        uint256 value = v.totalValue();
        v.harvest(); // anyone
        uint256 cut0 = IERC20(USDC).balanceOf(address(FEE_SPLIT)) - s0;
        uint256 cut1 = IERC20(WANTX).balanceOf(address(FEE_SPLIT)) - s1;
        assertApproxEqAbs(cut0, f0 * 2000 / 10_000, 2, "20% of the USDC fees to the splitter");
        assertApproxEqAbs(cut1, f1 * 2000 / 10_000, 2, "20% of the wANTx fees to the splitter");
        assertGt(v.totalValue(), value, "the other 80% is compounded for depositors");

        // the splitter pays out per token, to fixed addresses, and anyone may trigger it
        uint256 c0 = IERC20(USDC).balanceOf(CREATOR);
        uint256 c1 = IERC20(WANTX).balanceOf(CREATOR);
        uint256 i0 = IERC20(USDC).balanceOf(FEE_INBOX);
        uint256 i1 = IERC20(WANTX).balanceOf(FEE_INBOX);
        uint256 all0 = IERC20(USDC).balanceOf(address(FEE_SPLIT));
        uint256 all1 = IERC20(WANTX).balanceOf(address(FEE_SPLIT));
        vm.startPrank(trader);
        FEE_SPLIT.distribute(USDC);
        FEE_SPLIT.distribute(WANTX);
        vm.stopPrank();
        assertEq(IERC20(USDC).balanceOf(CREATOR) - c0, all0 * 2000 / 10_000, "20% of the cut to the creator wallet, in USDC");
        assertEq(IERC20(WANTX).balanceOf(CREATOR) - c1, all1 * 2000 / 10_000, "and in wANTx");
        assertEq(IERC20(USDC).balanceOf(FEE_INBOX) - i0, all0 - all0 * 2000 / 10_000, "80% to the fee inbox, for the reserve");
        assertEq(IERC20(WANTX).balanceOf(FEE_INBOX) - i1, all1 - all1 * 2000 / 10_000);
        assertEq(IERC20(USDC).balanceOf(address(FEE_SPLIT)) + IERC20(WANTX).balanceOf(address(FEE_SPLIT)), 0);
    }

    // ------------------------------------------------------------------ the keeper

    function test_Rebalance_AloneInThePool_NoSwap_PriceUntouched() public {
        _firstDeposit();
        // buyers take the price up and out of the main range (30 spacings is about +20%), buying all its wANTx
        (int24 lo0,,) = v.main();
        _buyDownTo(lo0 - 120);
        int24 tick;
        (int24 lo, int24 hi3,) = v.main();
        (, tick) = v.price();
        assertTrue(tick < lo || tick >= hi3, "out of the main range");
        (uint256 h0, uint256 h1) = v.balances();
        console2.log("vault after the run, USDC (cents):", h0 / 1e4, "wANTx (1e-3):", h1 / 1e15);
        console2.log("price after the run (dollars x 1e4):", _dollars());

        vm.expectRevert(LiquidityVaultV2.NotKeeper.selector);
        v.rebalance(tick, 20);
        uint256 value = v.totalValue();
        vm.warp(block.timestamp + 16 minutes);
        vm.recordLogs();
        vm.prank(BOT);
        v.rebalance(tick, 20);
        (, int24 after_) = v.price();
        assertEq(after_, tick, "the rebalance did not move the price");
        // it cost nothing: the value only rose, by the trading fees of the run that the rebalance collected
        assertGe(v.totalValue(), value, "and cost nothing");
        assertApproxEqRel(v.totalValue(), value, 0.003e18);
        (int24 mLo, int24 mHi, uint128 mL) = v.main();
        (,, uint128 aL) = v.alt();
        assertTrue(mLo <= tick && tick < mHi, "the new main range is around the price");
        assertTrue(mL > 0 || aL > 0, "the tokens are back in ranges");
        // leaving still works
        vm.startPrank(alice);
        (uint256 o0, uint256 o1) = v.withdraw(v.balanceOf(alice), 0, 0, alice, false);
        vm.stopPrank();
        console2.log("alice leaves with USDC (cents):", o0 / 1e4, "wANTx (1e-3):", o1 / 1e15);
        assertGt(o0 + o1, 0);
    }
}
