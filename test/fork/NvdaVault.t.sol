// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {UniswapV4Swapper} from "../../src/adapters/UniswapV4Swapper.sol";
import {LiquidityVaultV2} from "../../src/vaults/LiquidityVaultV2.sol";
import {EmptyPoolPrice} from "../../src/vaults/EmptyPoolPrice.sol";
import {FeeSplitter} from "../../src/FeeSplitter.sol";

interface INvdaL2Gateway {
    function finalizeInboundTransfer(address token, address from, address to, uint256 amount, bytes calldata data) external payable;
}

interface INvdaL2Router {
    function calculateL2TokenAddress(address l1Token) external view returns (address);
}

interface IBridgedToken {
    function l1Address() external view returns (address);
}

/// @notice The wNVDAx-USDC vault on a copy of Elysium mainnet. wNVDAx (Wrapped NVIDIA xStock) lives on HyperEVM
/// and is already on Elysium as the canonical bridge's token for it. It trades there in pools of other people; the
/// one against USDC runs through a hook, which the vault contract does not accept, so the vault gets a new
/// hookless 0.30% pool where it is the only liquidity to begin with, like the wANTx-USDC vault. Same contract
/// (LiquidityVaultV2), same live price helper (EmptyPoolPrice), same live fee splitter. The pool's first token is
/// wNVDAx here (the wANTx pool has USDC first), so the pool quotes USDC per wNVDAx and the vault counts its value,
/// its cap and its shares in USDC.
///
///   ELYSIUM_FORK=true forge test --match-contract NvdaVaultFork -vv
contract NvdaVaultForkTest is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    IPoolManager constant PM = IPoolManager(0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1);
    address constant WHYPE = 0xbA876237B0F021A6c6D852d6c26E107997cC5E81;
    address constant USDC = 0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65;
    address constant WNVDAX_L1 = 0xa8ddb5Cd96b5222AFe198316E9A57CAA642850D5; // on HyperEVM
    address constant WNVDAX = 0x11265018bF2d5a99fb71EFaE73aD670203C1dF44; // on Elysium, the bridge's token
    INvdaL2Router constant L2_ROUTER = INvdaL2Router(0x61EbbC3A29f1970aF2Ce862bA9c5364832E14d17);
    INvdaL2Gateway constant L2_GATEWAY = INvdaL2Gateway(0x5DC84e4Cb0F9082246E92a5585C5395592B1aF1f);
    address constant L1_GATEWAY_ALIAS = 0xEa8c30de0Ba0C2eAeE942afcE77530e06c5F233d;
    EmptyPoolPrice constant SETTER = EmptyPoolPrice(0x26D7857d548EBADE54212BB5482f5770ae9d2548); // live
    FeeSplitter constant FEE_SPLIT = FeeSplitter(0xB92c756347de468d7086a97EF112801b3371a408); // VaultFeeSplit, live
    address constant CREATOR = 0x9324605c9C707b2F805CCF2AC099fCA5d561DC37;
    address constant FEE_INBOX = 0x2AfD3850794b84205667CE2826b09FA5bf1c3a5c;
    address constant OWNER = 0x822aA88543b9da39c4c3D856857379E17526C1E8;
    address constant BOT = 0x0461663d46DA68264966a0670335E3ecf0b96F3C;
    // the wNVDAx/USDC pool other people already trade in: dynamic fee, spacing 50, behind a hook
    address constant OTHER_POOL_HOOK = 0xd4410c4cB192892320fA370367aF7A98510e3dE3;
    bytes32 constant OTHER_POOL_ID = 0x6547eea17cc285cac8310de7e87f41e0b172b8609c17e38fbfd81cd30c81f7bc;
    uint256 constant PRICE = 164; // dollars per wNVDAx, where the pool is opened
    uint256 constant CAP = 25_000e6; // USDC of value
    /// The real pool was opened in Elysium block 10,010,183 and the real vault deployed in block 10,010,212
    /// (both 2026-11-23 18:32 UTC). This rehearsal of the launch needs the pool not to exist yet, so it runs on
    /// the chain as it stood one block before the pool was opened.
    uint256 constant BEFORE_THE_REAL_POOL = 10_010_182;

    PoolKey key = PoolKey(Currency.wrap(WNVDAX), Currency.wrap(USDC), 3000, 60, IHooks(address(0)));
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
        // the token arrives over the bridge, as it does for anyone who brings it from HyperEVM
        _bridgeIn(alice, 100e18);
        _bridgeIn(bob, 100e18);
        _bridgeIn(trader, 1_000e18);
        deal(USDC, alice, 100_000e6);
        deal(USDC, bob, 100_000e6);
        deal(USDC, trader, 500_000e6);

        SETTER.set(key, _sqrtPriceFor(PRICE));
        v = new LiquidityVaultV2(
            LiquidityVaultV2.Params({
                key: key,
                poolManager: PM,
                feeRecipient: address(FEE_SPLIT),
                whype: WHYPE,
                owner: OWNER,
                keeper: BOT,
                name: "Liquid Reserve Vault wNVDAx-USDC v2",
                symbol: "lrvwNVDAx-USDC-2",
                mainWidth: 30,
                altWidth: 30,
                depositCap: CAP
            })
        );
        swapper = new UniswapV4Swapper(address(this), PM, WHYPE);
        UniswapV4Swapper.Hop[] memory hop = new UniswapV4Swapper.Hop[](1);
        hop[0] = UniswapV4Swapper.Hop(UniswapV4Swapper.HopKind.V4_SWAP, key, false, address(0));
        swapper.setRoute(USDC, WNVDAX, hop);
        hop[0].zeroForOne = true;
        swapper.setRoute(WNVDAX, USDC, hop);
        for (uint256 i; i < 3; ++i) {
            address who = [alice, bob, trader][i];
            vm.startPrank(who);
            IERC20(USDC).approve(address(v), type(uint256).max);
            IERC20(WNVDAX).approve(address(v), type(uint256).max);
            IERC20(USDC).approve(address(swapper), type(uint256).max);
            IERC20(WNVDAX).approve(address(swapper), type(uint256).max);
            vm.stopPrank();
        }
    }

    // ------------------------------------------------------------------ helpers

    /// What the bridge does on Elysium when wNVDAx arrives from HyperEVM.
    function _bridgeIn(address to, uint256 amount) internal {
        bytes memory tokenInfo = abi.encode(abi.encode("Wrapped NVIDIA xStock"), abi.encode("wNVDAx"), abi.encode(uint8(18)));
        vm.prank(L1_GATEWAY_ALIAS);
        L2_GATEWAY.finalizeInboundTransfer(WNVDAX_L1, address(this), to, amount, abi.encode(tokenInfo, bytes("")));
    }

    /// sqrtPriceX96 of the pool (USDC per wNVDAx, in raw units) for a wNVDAx worth `dollars`.
    function _sqrtPriceFor(uint256 dollars) internal pure returns (uint160) {
        // raw USDC per raw wNVDAx = dollars * 1e6 / 1e18
        return uint160(_sqrt((dollars << 192) / 1e12));
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

    /// Dollars per wNVDAx at the pool's price, with 4 decimals.
    function _dollars() internal view returns (uint256) {
        (uint160 p,) = v.price();
        uint256 ratioX96 = uint256(p) * uint256(p) >> 96; // raw USDC per raw wNVDAx, times 2^96
        return (ratioX96 * 1e16) >> 96;
    }

    function _firstDeposit() internal returns (uint256 shares) {
        vm.prank(alice);
        v.deposit(1, 10e18, 1_640e6, alice); // $1,640 of each side at $164
        shares = v.balanceOf(alice);
    }

    /// A buyer takes the price up to `limitTick` (more USDC per wNVDAx), buying whatever is on the way.
    /// The project's swapper refuses a swap it cannot fill completely, so this one talks to the pool itself.
    function _buyUpTo(int24 limitTick) internal {
        deal(USDC, address(this), 1_000_000e6);
        PM.unlock(abi.encode(limitTick));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(PM), "pool manager only");
        int24 limitTick = abi.decode(data, (int24));
        BalanceDelta d = PM.swap(
            key,
            IPoolManager.SwapParams({zeroForOne: false, amountSpecified: -int256(1_000_000e6), sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(limitTick)}),
            ""
        );
        if (d.amount1() < 0) {
            PM.sync(key.currency1);
            IERC20(USDC).transfer(address(PM), uint256(uint128(-d.amount1())));
            PM.settle();
        }
        if (d.amount0() > 0) PM.take(key.currency0, address(this), uint256(uint128(d.amount0())));
        return "";
    }

    function _trade(uint256 rounds, uint256 usdcEach) internal {
        vm.startPrank(trader);
        for (uint256 i; i < rounds; ++i) {
            uint256 got = swapper.swap(USDC, WNVDAX, usdcEach, 0, trader);
            swapper.swap(WNVDAX, USDC, got, 0, trader);
        }
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ the token and the pool

    function test_TheTokenIsTheBridgesTokenForWrappedNvidia() public view {
        assertEq(L2_ROUTER.calculateL2TokenAddress(WNVDAX_L1), WNVDAX, "the address the bridge's router gives for wNVDAx");
        assertEq(IBridgedToken(WNVDAX).l1Address(), WNVDAX_L1, "and it points back at the HyperEVM token");
        assertEq(IERC20Metadata(WNVDAX).name(), "Wrapped NVIDIA xStock");
        assertEq(IERC20Metadata(WNVDAX).symbol(), "wNVDAx");
        assertEq(IERC20Metadata(WNVDAX).decimals(), 18);
        assertEq(IERC20(WNVDAX).balanceOf(alice), 100e18);
        assertLt(uint160(WNVDAX), uint160(USDC), "wNVDAx is the pool's first token, USDC its second");
    }

    function test_VaultSettingsAsLaunched() public view {
        assertEq(v.feeRecipient(), address(FEE_SPLIT), "the fee goes to the live fee splitter");
        assertEq(FEE_SPLIT.recipientA(), CREATOR);
        assertEq(FEE_SPLIT.bpsA(), 2000);
        assertEq(FEE_SPLIT.recipientB(), FEE_INBOX);
        assertEq(v.owner(), OWNER);
        assertEq(v.keeper(), BOT);
        assertEq(address(v.token0()), WNVDAX);
        assertEq(address(v.token1()), USDC);
        assertFalse(v.nativePool());
        assertEq(v.decimals(), 6, "shares follow USDC");
        assertEq(v.depositCap(), CAP);
        assertEq(v.PERFORMANCE_FEE_BPS(), 2000);
        assertApproxEqRel(_dollars(), PRICE * 1e4, 0.001e18, "the pool opened at the price asked for");
    }

    function test_ItsPoolIsNewAndNotTheHookedOne() public {
        assertTrue(PoolId.unwrap(v.poolId()) != OTHER_POOL_ID, "a pool of its own");
        (uint160 theirs,,,) = PM.getSlot0(PoolId.wrap(OTHER_POOL_ID));
        assertGt(theirs, 0, "the other pool exists and is left alone");
        // the vault contract takes hookless pools only: it cannot be put on that pool
        PoolKey memory hooked = PoolKey(Currency.wrap(WNVDAX), Currency.wrap(USDC), 0x800000, 50, IHooks(OTHER_POOL_HOOK));
        assertEq(PoolId.unwrap(hooked.toId()), OTHER_POOL_ID, "that is the other pool's key");
        vm.expectRevert(LiquidityVaultV2.BadParams.selector);
        new LiquidityVaultV2(
            LiquidityVaultV2.Params({
                key: hooked,
                poolManager: PM,
                feeRecipient: address(FEE_SPLIT),
                whype: WHYPE,
                owner: OWNER,
                keeper: BOT,
                name: "x",
                symbol: "x",
                mainWidth: 30,
                altWidth: 30,
                depositCap: CAP
            })
        );
    }

    function test_PriceHelper_MovesOnlyAnEmptyPool() public {
        // empty: anyone can put it at another price, and nothing changes hands
        uint256 pm0 = IERC20(WNVDAX).balanceOf(address(PM));
        uint256 pm1 = IERC20(USDC).balanceOf(address(PM));
        vm.prank(bob);
        SETTER.set(key, _sqrtPriceFor(180));
        assertApproxEqRel(_dollars(), 180e4, 0.001e18);
        vm.prank(bob);
        SETTER.set(key, _sqrtPriceFor(150));
        assertApproxEqRel(_dollars(), 150e4, 0.001e18);
        assertEq(IERC20(WNVDAX).balanceOf(address(PM)), pm0, "no wNVDAx moved");
        assertEq(IERC20(USDC).balanceOf(address(PM)), pm1, "no USDC moved");
        assertEq(IERC20(USDC).balanceOf(address(SETTER)) + IERC20(WNVDAX).balanceOf(address(SETTER)), 0);
        SETTER.set(key, _sqrtPriceFor(PRICE));

        // with the vault's liquidity at the price it refuses
        _firstDeposit();
        uint256 before = _dollars();
        vm.expectRevert(EmptyPoolPrice.PoolHasLiquidity.selector);
        SETTER.set(key, _sqrtPriceFor(100));
        assertEq(_dollars(), before);
    }

    function test_PriceHelper_CannotJumpOverLiquidityBesideThePrice() public {
        _firstDeposit();
        // the price is pushed out past everything the vault holds: nothing is left at the price,
        // but the vault's ranges are still in the way back
        (, int24 hi,) = v.main();
        _buyUpTo(hi + 600);
        assertEq(PM.getLiquidity(v.poolId()), 0, "nothing at the price any more");
        uint256 before = _dollars();
        assertGt(before, PRICE * 1e4);
        vm.expectRevert(); // it would have to trade through the vault's ranges
        SETTER.set(key, _sqrtPriceFor(PRICE));
        assertEq(_dollars(), before);
    }

    // ------------------------------------------------------------------ deposits and withdrawals

    function test_FirstDeposit_BothTokens_OpensRanges() public {
        uint256 u0 = IERC20(USDC).balanceOf(alice);
        uint256 w0 = IERC20(WNVDAX).balanceOf(alice);
        uint256 shares = _firstDeposit();
        (uint256 t0, uint256 t1) = v.balances();
        (int24 lo, int24 hi, uint128 liq) = v.main();
        (, int24 tick) = v.price();
        console2.log("shares minted (1e3):", shares / 1e3);
        console2.log("vault holds wNVDAx (1e-3):", t0 / 1e15, "USDC (cents):", t1 / 1e4);
        assertEq(w0 - IERC20(WNVDAX).balanceOf(alice), 10e18, "took the wNVDAx");
        assertEq(u0 - IERC20(USDC).balanceOf(alice), 1_640e6, "took the USDC");
        assertApproxEqAbs(t0, 10e18, 1e7, "all of it is in the vault");
        assertApproxEqAbs(t1, 1_640e6, 10);
        assertTrue(liq > 0 && tick >= lo && tick < hi, "the main range earns at the price");
        // value in USDC: 1,640 held as USDC plus 10 wNVDAx worth 1,640 more
        assertApproxEqRel(v.totalValue(), 3_280e6, 0.002e18);
        assertApproxEqRel(shares, 3_280e6, 0.002e18);
        assertEq(v.balanceOf(v.DEAD()), 1_000, "1,000 shares (a tenth of a cent) locked for good");
    }

    function test_NoHypeCanBeSent() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(LiquidityVaultV2.UnexpectedNative.selector);
        v.deposit{value: 0.1 ether}(1, 10e18, 1_640e6, alice);
    }

    function test_SecondDepositor_ProRata_ThenBothWithdraw() public {
        uint256 aShares = _firstDeposit();
        (uint256 want, uint256 need0, uint256 need1) = v.previewDeposit(5e18, 820e6);
        vm.prank(bob);
        v.deposit(want, need0 + need0 / 200, need1 + need1 / 200, bob);
        assertApproxEqRel(v.balanceOf(bob), aShares / 2, 0.01e18, "half the money, half the shares");

        uint256 u = IERC20(USDC).balanceOf(bob);
        uint256 w = IERC20(WNVDAX).balanceOf(bob);
        vm.startPrank(bob);
        v.withdraw(v.balanceOf(bob), 0, 0, bob, false);
        vm.stopPrank();
        assertApproxEqRel(IERC20(WNVDAX).balanceOf(bob) - w, need0, 0.001e18, "bob's wNVDAx back");
        assertApproxEqRel(IERC20(USDC).balanceOf(bob) - u, need1, 0.001e18, "bob's USDC back");

        vm.startPrank(alice);
        (uint256 o0, uint256 o1) = v.withdraw(aShares, 0, 0, alice, true); // the "unwrap HYPE" flag means nothing here
        vm.stopPrank();
        assertApproxEqRel(o0, 10e18, 0.001e18);
        assertApproxEqRel(o1, 1_640e6, 0.001e18);
        assertEq(alice.balance, 0, "no HYPE involved");
    }

    function test_CapIsCountedInUsdc() public {
        _firstDeposit(); // worth $3,280
        vm.prank(OWNER);
        v.setDepositCap(4_000e6);
        (uint256 want, uint256 need0, uint256 need1) = v.previewDeposit(5e18, 820e6); // +$1,640 of value
        vm.prank(bob);
        vm.expectRevert();
        v.deposit(want, need0 + need0 / 200, need1 + need1 / 200, bob);
        (want, need0, need1) = v.previewDeposit(2e18, 328e6); // +$656
        vm.prank(bob);
        v.deposit(want, need0 + need0 / 200, need1 + need1 / 200, bob);
    }

    function test_TheStartingCapStopsTheDepositThatWouldPassIt() public {
        deal(USDC, alice, 100_000e6);
        vm.prank(alice);
        v.deposit(1, 70e18, 11_480e6, alice); // $22,960
        assertLt(v.totalValue(), CAP);
        (uint256 want, uint256 need0, uint256 need1) = v.previewDeposit(10e18, 1_640e6); // +$3,280 would make $26,240
        vm.prank(bob);
        vm.expectRevert();
        v.deposit(want, need0 + need0 / 200, need1 + need1 / 200, bob);
        // withdrawals are never stopped, cap or no cap
        vm.startPrank(alice);
        (uint256 o0, uint256 o1) = v.withdraw(v.balanceOf(alice), 0, 0, alice, false);
        vm.stopPrank();
        assertApproxEqRel(o0, 70e18, 0.001e18);
        assertApproxEqRel(o1, 11_480e6, 0.001e18);
    }

    // ------------------------------------------------------------------ fees

    function test_Fees_TwentyPercent_ToCreatorAndFeeInbox() public {
        _firstDeposit();
        _trade(10, 200e6); // $200 each way, ten times, at 0.3%
        (uint256 f0, uint256 f1) = v.pendingFees();
        console2.log("fees waiting, wNVDAx (1e-6):", f0 / 1e12, "USDC (cents):", f1 / 1e4);
        assertGt(f0, 0);
        assertGt(f1, 0);
        // $200 x 10 paid in USDC at 0.3% is $6; the vault is the only liquidity, so it earns all of it
        assertApproxEqRel(f1, 6e6, 0.01e18, "all of the pool's USDC fee");

        uint256 s0 = IERC20(WNVDAX).balanceOf(address(FEE_SPLIT));
        uint256 s1 = IERC20(USDC).balanceOf(address(FEE_SPLIT));
        uint256 value = v.totalValue();
        v.harvest(); // anyone
        uint256 cut0 = IERC20(WNVDAX).balanceOf(address(FEE_SPLIT)) - s0;
        uint256 cut1 = IERC20(USDC).balanceOf(address(FEE_SPLIT)) - s1;
        assertApproxEqAbs(cut0, f0 * 2000 / 10_000, 2, "20% of the wNVDAx fees to the splitter");
        assertApproxEqAbs(cut1, f1 * 2000 / 10_000, 2, "20% of the USDC fees to the splitter");
        assertGt(v.totalValue(), value, "the other 80% is compounded for depositors");

        // the splitter pays out per token, to fixed addresses, and anyone may trigger it
        uint256 c0 = IERC20(WNVDAX).balanceOf(CREATOR);
        uint256 c1 = IERC20(USDC).balanceOf(CREATOR);
        uint256 i0 = IERC20(WNVDAX).balanceOf(FEE_INBOX);
        uint256 i1 = IERC20(USDC).balanceOf(FEE_INBOX);
        uint256 all0 = IERC20(WNVDAX).balanceOf(address(FEE_SPLIT));
        uint256 all1 = IERC20(USDC).balanceOf(address(FEE_SPLIT));
        vm.startPrank(trader);
        FEE_SPLIT.distribute(WNVDAX);
        FEE_SPLIT.distribute(USDC);
        vm.stopPrank();
        assertEq(IERC20(WNVDAX).balanceOf(CREATOR) - c0, all0 * 2000 / 10_000, "20% of the cut to the creator wallet, in wNVDAx");
        assertEq(IERC20(USDC).balanceOf(CREATOR) - c1, all1 * 2000 / 10_000, "and in USDC");
        assertEq(IERC20(WNVDAX).balanceOf(FEE_INBOX) - i0, all0 - all0 * 2000 / 10_000, "80% to the fee inbox, for the reserve");
        assertEq(IERC20(USDC).balanceOf(FEE_INBOX) - i1, all1 - all1 * 2000 / 10_000);
        assertEq(IERC20(USDC).balanceOf(address(FEE_SPLIT)) + IERC20(WNVDAX).balanceOf(address(FEE_SPLIT)), 0);
    }

    // ------------------------------------------------------------------ the keeper

    function test_Rebalance_AloneInThePool_NoSwap_PriceUntouched() public {
        _firstDeposit();
        // buyers take the price up and out of the main range (30 spacings is about +20%), buying all its wNVDAx
        (, int24 hi0,) = v.main();
        _buyUpTo(hi0 + 120);
        int24 tick;
        (int24 lo, int24 hi3,) = v.main();
        (, tick) = v.price();
        assertTrue(tick < lo || tick >= hi3, "out of the main range");
        (uint256 h0, uint256 h1) = v.balances();
        console2.log("vault after the run, wNVDAx (1e-3):", h0 / 1e15, "USDC (cents):", h1 / 1e4);
        console2.log("price after the run (dollars x 1e4):", _dollars());
        assertLt(h0, 1e12, "its wNVDAx was all bought");

        vm.expectRevert(LiquidityVaultV2.NotKeeper.selector);
        v.rebalance(tick, 20);
        uint256 value = v.totalValue();
        vm.warp(block.timestamp + 16 minutes);
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
        console2.log("alice leaves with wNVDAx (1e-3):", o0 / 1e15, "USDC (cents):", o1 / 1e4);
        assertGt(o0 + o1, 0);
    }
}
