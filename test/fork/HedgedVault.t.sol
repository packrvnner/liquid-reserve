// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {LiquidityMath} from "../../src/vaults/LiquidityMath.sol";
import {HedgedVault} from "../../src/hedged/HedgedVault.sol";
import {HedgedLens} from "../../src/hedged/HedgedLens.sol";
import "../../src/hedged/HedgedTypes.sol";
import {CoreSim, CorePrecompile, CoreWriterMock, CoreDepositWalletMock} from "../hedged/CoreSim.sol";

/// @notice Trades in the pool for everyone else: moves the price, makes volume.
contract Whale {
    IV3Pool internal immutable pool;
    IERC20 internal immutable t0;
    IERC20 internal immutable t1;

    constructor(IV3Pool pool_) {
        pool = pool_;
        t0 = IERC20(pool_.token0());
        t1 = IERC20(pool_.token1());
    }

    function moveTo(uint160 sqrtPriceX96) external {
        (uint160 p,,,,,,) = pool.slot0();
        if (sqrtPriceX96 == p) return;
        pool.swap(address(this), sqrtPriceX96 < p, type(int256).max / 4, sqrtPriceX96, "");
    }

    function uniswapV3SwapCallback(int256 d0, int256 d1, bytes calldata) external {
        require(msg.sender == address(pool));
        if (d0 > 0) t0.transfer(msg.sender, uint256(d0));
        if (d1 > 0) t1.transfer(msg.sender, uint256(d1));
    }
}

/// @notice The hedged vault against the real Project X HYPE/USDC pool on a fork of HyperEVM, with
/// `CoreSim` standing in for HyperCore (a fork has no HyperCore behind it).
///
///   HYPEREVM_FORK=true forge test --match-path "test/fork/HedgedVault.t.sol" -vv
contract HedgedVaultForkTest is Test {
    /// @dev Project X HYPE/USDC 0.30% unless HEDGED_POOL names another (the 0.05% pool is
    /// 0x6c9A33E3b592C0d65B3Ba59355d5Be0d38259285). The range is 1,800 ticks either side in both.
    IV3Pool POOL = IV3Pool(0x422e586C906eb241f784B4F5a633c2C7e59A2F54);
    IERC20 constant USDC = IERC20(0xb88339CB7199b77E23DB6E890353E22632Ba630f);
    IERC20 constant WHYPE = IERC20(0x5555555555555555555555555555555555555555);
    address constant CORE_WRITER = 0x3333333333333333333333333333333333333333;
    uint32 constant PERP = 159;
    uint8 constant SZ_DECIMALS = 2;

    CoreSim sim;
    HedgedVault vault;
    HedgedLens lens;
    Whale whale;
    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");
    address feeRecipient = makeAddr("fee recipient");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        if (!vm.envOr("HYPEREVM_FORK", false)) {
            vm.skip(true);
            return;
        }
        uint256 at = vm.envOr("HYPEREVM_BLOCK", uint256(0));
        if (at == 0) vm.createSelectFork("hyperevm");
        else vm.createSelectFork("hyperevm", at);

        POOL = IV3Pool(vm.envOr("HEDGED_POOL", address(POOL)));
        sim = new CoreSim(USDC, PERP, SZ_DECIMALS, poolRaw());
        CoreDepositWalletMock wallet = new CoreDepositWalletMock(sim, USDC);
        vm.etch(CORE_WRITER, address(new CoreWriterMock(sim)).code);
        bytes memory pre = address(new CorePrecompile(sim)).code;
        uint160[5] memory at_ = [uint160(0x0800), 0x0801, 0x0806, 0x0807, 0x080F];
        for (uint256 i; i < at_.length; i++) {
            vm.etch(address(at_[i]), pre);
        }
        sim.wire(CORE_WRITER, address(wallet));
        deal(address(USDC), address(sim), 50_000_000e6); // so the exchange can pay out a short's gains

        vault = new HedgedVault(
            HedgedVault.Params({
                pool: address(POOL),
                coreDeposit: address(wallet),
                feeRecipient: feeRecipient,
                owner: owner,
                keeper: keeper,
                perp: PERP,
                szDecimals: SZ_DECIMALS,
                width: 1_800 / POOL.tickSpacing(),
                depositCap: 0
            })
        );
        lens = new HedgedLens();
        whale = new Whale(POOL);
        deal(address(USDC), address(whale), 200_000_000e6);
        deal(address(WHYPE), address(whale), 5_000_000e18);
        for (uint256 i; i < 2; i++) {
            address who = i == 0 ? alice : bob;
            deal(address(USDC), who, 1_000_000e6);
            vm.prank(who);
            USDC.approve(address(vault), type(uint256).max);
        }
    }

    // ------------------------------------------------------------------ helpers

    function poolRaw() internal view returns (uint256) {
        (uint160 p,,,,,,) = POOL.slot0();
        return LiquidityMath.quote0In1(10 ** (18 - SZ_DECIMALS), p);
    }

    /// @dev The block ends: HyperCore carries out what was sent.
    function nextBlock() internal {
        sim.step();
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 1);
    }

    function blocks(uint256 n) internal {
        for (uint256 i; i < n; i++) {
            nextBlock();
        }
    }

    /// @dev What the bot does: `tend` every few blocks until there is nothing left to do.
    function settle() internal {
        uint256 quiet;
        for (uint256 i; i < 40 && quiet < 2; i++) {
            blocks(6);
            try vault.tend() {
                quiet = 0;
            } catch {
                quiet++;
            }
        }
        blocks(6);
    }

    /// @dev Someone trades the pool to this price, 3% at a time: one swap across a larger move would
    /// need more gas than a HyperEVM transaction may use.
    function moveTo(uint160 target) internal {
        for (uint256 i; i < 60; i++) {
            (uint160 p,,,,,,) = POOL.slot0();
            if (p == target) return;
            uint160 next = uint160(uint256(p) * (target > p ? 1_015 : 985) / 1_000);
            whale.moveTo((target > p ? next >= target : next <= target) ? target : next);
        }
    }

    /// @dev Moves the pool price by `bps` (negative is down) and lets the oracle follow.
    function movePrice(int256 bps) internal {
        (uint160 p,,,,,,) = POOL.slot0();
        uint256 factor = Math.sqrt(uint256(int256(10_000) + bps) * 1e32); // sqrt(1 + bps) in 1e18
        moveTo(uint160(uint256(p) * factor / 1e18));
        sim.setPx(poolRaw());
    }

    /// @dev An arbitrageur takes the pool back to the oracle price.
    function arb() internal {
        moveTo(uint160(Math.sqrt(Math.mulDiv(sim.px(), 1 << 192, 10 ** (18 - SZ_DECIMALS)))));
    }

    function short() internal view returns (uint256) {
        (, int256 szi,) = sim.accounts(address(vault));
        return szi < 0 ? uint256(-szi) : 0;
    }

    /// @dev After the bot has gone quiet, the short is within its band of the target (or the
    /// difference is under the smallest order HyperCore takes).
    function assertHedged() internal view {
        State memory s = lens.state(address(vault));
        uint256 sh = short();
        uint256 diff = sh > s.targetSz ? sh - s.targetSz : s.targetSz - sh;
        (, uint16 band,,,,,) = vault.settings();
        uint256 positionValue = s.positionUsdc + s.positionAsset * s.oraclePx / 1e16;
        assertLe(diff * s.oraclePx, positionValue * band / 10_000 + 11e6 + s.oraclePx, "short within its band of the target");
    }

    function deposit(address who, uint256 amount) internal returns (uint256 shares) {
        vm.prank(who);
        shares = vault.deposit(amount, 0, who);
    }

    /// @dev The keeper puts idle money to work, stating the tick it sees.
    function deployIdle() internal {
        (, int24 tick,,,,,) = POOL.slot0();
        vm.prank(keeper);
        vault.deploy(tick, 0);
    }

    function depositAndDeploy(address who, uint256 amount) internal returns (uint256 shares) {
        shares = deposit(who, amount);
        deployIdle();
        settle();
    }

    function logState(string memory label) internal view {
        State memory s = lens.state(address(vault));
        console2.log(label);
        console2.log("   value / supply (USDC, shares):", s.totalValue, s.totalSupply);
        console2.log("   position HYPE (1e15) / USDC:", s.positionAsset / 1e15, s.positionUsdc);
        console2.log("   idle HYPE (1e15) / USDC:", s.idleAsset / 1e15, s.idleUsdc);
        console2.log("   perp value / margin bps:", uint256(s.perpValue > 0 ? s.perpValue : int256(0)), s.marginBpsNow);
        console2.log("   short / target (0.01 HYPE):", short(), s.targetSz);
    }

    // ------------------------------------------------------------------ the basics

    function test_FirstDeposit_GoesToWork_AndIsHedged() public {
        uint256 shares = deposit(alice, 10_000e6);
        uint256 entryBps = uint256(POOL.fee()) / 200 + 5; // 0.20% in a 0.30% pool, 0.07% in a 0.05% pool
        assertEq(shares, 10_000e6 - 10_000e6 * entryBps / 10_000 - 1_000, "shares = deposit less the allowance and the dead shares");
        assertEq(vault.totalValue(), 10_000e6, "idle USDC counts at face value");

        deployIdle();
        assertEq(short(), 0, "the order has not landed inside the block that sent it");
        logState("after deploy, same block");
        assertApproxEqRel(vault.totalValue(), 10_000e6, 0.005e18, "value is whole while the money is on its way");

        settle();
        logState("after the order landed");
        State memory s = lens.state(address(vault));
        assertHedged();
        assertGt(s.targetSz, 0);
        assertApproxEqAbs(s.marginBpsNow, 4_000, 250, "margin near 40% of the short");
        assertApproxEqRel(s.totalValue, 10_000e6, 0.005e18, "costs of going to work are under half a percent");
        assertApproxEqRel(s.idleUsdc, s.totalValue * 2 / 100, 0.1e18, "the buffer is about 2%");
    }

    function test_Value_DoesNotFollowThePrice() public {
        depositAndDeploy(alice, 100_000e6);
        uint256 before = vault.totalValue();
        State memory s0 = lens.state(address(vault));
        uint256 hype = s0.positionAsset;

        // HYPE up 10% in ten steps, the bot tending between them
        for (uint256 i; i < 10; i++) {
            movePrice(96);
            settle();
        }
        uint256 up = vault.totalValue();
        logState("after +10%");
        console2.log("value before / after +10%:", before, up);
        // unhedged, the HYPE half alone would have made the vault gain about 4%
        assertApproxEqRel(up, before, 0.012e18, "up 10%: value within 1.2%");
        assertGt(hype, lens.state(address(vault)).positionAsset, "the position holds less HYPE after a rise");

        for (uint256 i; i < 20; i++) {
            movePrice(-96);
            settle();
        }
        uint256 down = vault.totalValue();
        logState("after -10% from the start");
        console2.log("value after the fall:", down);
        assertApproxEqRel(down, before, 0.025e18, "round trip up and down 10%: value within 2.5%");
        assertHedged();
    }

    function test_SecondDeposit_IsFair() public {
        uint256 a = depositAndDeploy(alice, 50_000e6);
        uint256 valueBefore = vault.totalValue();
        uint256 perShareBefore = valueBefore * 1e18 / vault.totalSupply();
        uint256 b = deposit(bob, 50_000e6);
        uint256 perShareAfter = vault.totalValue() * 1e18 / vault.totalSupply();
        assertGe(perShareAfter, perShareBefore, "a deposit never lowers the value of a share");
        assertApproxEqRel(perShareAfter, perShareBefore, 0.0011e18, "and raises it by the allowance at most");
        // Bob paid the vault's value per share, plus the allowance
        assertApproxEqRel(b * perShareBefore / 1e18, 50_000e6 * (10_000 - uint256(POOL.fee()) / 200 - 5) / 10_000, 0.0001e18);
        assertGt(a, 0);
    }

    function test_Withdraw_SmallIsPaidAtOnce() public {
        uint256 shares = depositAndDeploy(alice, 100_000e6);
        uint256 value = vault.totalValue();
        uint256 balBefore = USDC.balanceOf(alice);
        vm.prank(alice);
        (uint256 paid, uint256 asset, uint256 owed) = vault.withdraw(shares / 20, 0, alice);
        assertEq(owed, 0, "5% fits in the buffer");
        assertEq(asset, 0);
        assertEq(USDC.balanceOf(alice) - balBefore, paid);
        // a twentieth of the value, less the pool fee on the HYPE sold and the allowance
        assertApproxEqRel(paid, value / 20, 0.005e18, "paid within half a percent of the slice's value");
        settle();
        assertHedged();
    }

    function test_Withdraw_LargeIsOwed_ThenClaimed() public {
        depositAndDeploy(alice, 50_000e6);
        uint256 bobShares = depositAndDeploy(bob, 50_000e6);
        uint256 value = vault.totalValue();
        uint256 supply = vault.totalSupply();

        vm.prank(bob);
        (uint256 paid, uint256 asset, uint256 owed) = vault.withdraw(bobShares, 0, bob);
        assertEq(asset, 0);
        assertGt(owed, 0, "half the vault does not fit in the buffer");
        assertEq(vault.owed(bob), owed);
        uint256 slice = value * bobShares / supply;
        assertApproxEqRel(paid + owed, slice, 0.005e18, "paid plus owed is the slice, within half a percent");
        // what is owed is a debt: the value left belongs to those who stayed
        assertApproxEqRel(vault.totalValue(), value - slice, 0.005e18);

        settle(); // the short shrinks, the USDC comes back from HyperCore
        uint256 before = USDC.balanceOf(bob);
        vault.claim(bob);
        assertEq(USDC.balanceOf(bob) - before, owed, "claimed in full");
        assertEq(vault.owed(bob), 0);
        assertApproxEqRel(vault.totalValue(), value - slice, 0.006e18, "nothing was taken from those who stayed");
        assertHedged();
        assertApproxEqAbs(lens.state(address(vault)).marginBpsNow, 4_000, 1_600, "margin back between its lines");
    }

    /// @dev The one depositor takes half out, twice. Each time everything owed arrives and is claimed to
    /// the last unit: HyperCore's one-time dollar and the float it comes out of are the vault's affair,
    /// not a part of what someone who leaves is owed. (Found in the pilot page's rehearsal: the dollar
    /// had been taken from the second transfer home, and what stayed owed was too small to be fetched.)
    function test_SoleDepositor_IsPaidToTheLastUnit() public {
        uint256 shares = depositAndDeploy(alice, 2_000e6);
        for (uint256 round; round < 2; round++) {
            shares = vault.balanceOf(alice);
            vm.prank(alice);
            (,, uint256 owed) = vault.withdraw(shares / 2, 0, alice);
            assertGt(owed, 0, "part of it is on HyperCore");
            for (uint256 i; i < 4 && vault.owed(alice) > 0; i++) {
                settle();
                try vault.claim(alice) {} catch {}
            }
            assertEq(vault.owed(alice), 0, "paid to the last unit");
            assertEq(vault.owedTotal(), 0);
        }
        assertEq(sim.transfersRejected(), 0);
        assertHedged();
    }

    function test_EveryoneLeaves() public {
        uint256 a = depositAndDeploy(alice, 30_000e6);
        uint256 b = depositAndDeploy(bob, 70_000e6);
        movePrice(300);
        settle();
        vm.prank(alice);
        (uint256 pa,, uint256 oa) = vault.withdraw(a, 0, alice);
        vm.prank(bob);
        (uint256 pb,, uint256 ob) = vault.withdraw(b, 0, bob);
        settle();
        if (oa > 0) vault.claim(alice);
        if (ob > 0) vault.claim(bob);
        assertEq(vault.owed(alice) + vault.owed(bob), 0, "everything owed has been paid");
        console2.log("alice got / bob got:", pa + oa, pb + ob);
        assertApproxEqRel(pa + oa, 30_000e6, 0.02e18);
        assertApproxEqRel(pb + ob, 70_000e6, 0.02e18);
        assertApproxEqRel((pa + oa) * 7, (pb + ob) * 3, 0.01e18, "in proportion to what they put in");
        assertLe(short(), 1, "no short is left behind");
    }

    // ------------------------------------------------------------------ guards

    function test_Deposit_RefusedWhenPoolAndOracleDisagree() public {
        depositAndDeploy(alice, 20_000e6);
        (uint160 p,,,,,,) = POOL.slot0();
        moveTo(uint160(uint256(p) * 1012 / 1000)); // pool up about 2.4%, the oracle stays
        vm.prank(bob);
        vm.expectPartialRevert(PriceOutOfLine.selector);
        vault.deposit(10_000e6, 0, bob);
        (, int24 tickNow,,,,,) = POOL.slot0();
        vm.expectPartialRevert(PriceOutOfLine.selector);
        vm.prank(keeper);
        vault.deploy(tickNow, 0);
        // leaving stays possible
        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        (uint256 paid,, uint256 owed) = vault.withdraw(shares / 2, 0, alice);
        assertGt(paid + owed, 9_000e6);
    }

    function test_PushingThePool_DoesNotMakeTheVaultTrade() public {
        depositAndDeploy(alice, 50_000e6);
        uint256 filled = sim.ordersFilled();
        (uint160 p,,,,,,) = POOL.slot0();
        moveTo(uint160(uint256(p) * 1004 / 1000)); // pool up 0.8%, inside the allowed gap; the oracle stays
        blocks(6);
        vm.expectRevert(NothingToDo.selector);
        vault.tend();
        assertEq(sim.ordersFilled(), filled, "the target is read at the oracle price");
    }

    function test_OnlyKeeperMovesTheRange_OwnerWithinBounds() public {
        depositAndDeploy(alice, 20_000e6);
        (, int24 tick,,,,,) = POOL.slot0();
        vm.expectRevert(NotKeeper.selector);
        vault.rebalance(tick, 100);
        vm.expectRevert(NotKeeper.selector);
        vault.deploy(tick, 100);
        vm.prank(keeper);
        vm.expectPartialRevert(PriceMoved.selector);
        vault.deploy(tick + 500, 100); // the pool is not where the keeper says it is
        vm.startPrank(owner);
        vm.expectRevert(BadParams.selector);
        vault.setSettings(50, 4_000, 30); // band under 1%
        vm.expectRevert(BadParams.selector);
        vault.setSettings(500, 2_000, 30); // margin under 30%
        vault.setSettings(300, 5_000, 20);
        vm.stopPrank();
        (, uint16 band, uint16 margin, int24 width,,,) = vault.settings();
        assertEq(band, 300);
        assertEq(margin, 5_000);
        assertEq(width, 20);
        vm.prank(alice);
        vm.expectRevert();
        vault.setDepositsPaused(true);
    }

    function test_DepositCap_And_Pause() public {
        vm.prank(owner);
        vault.setDepositCap(15_000e6);
        deposit(alice, 10_000e6);
        vm.prank(bob);
        vm.expectPartialRevert(CapExceeded.selector);
        vault.deposit(6_000e6, 0, bob);
        vm.prank(owner);
        vault.setDepositsPaused(true);
        vm.prank(bob);
        vm.expectRevert(DepositsArePaused.selector);
        vault.deposit(1_000e6, 0, bob);
    }

    // ------------------------------------------------------------------ margin

    function test_Margin_ToppedUp_WhenThePriceRises() public {
        depositAndDeploy(alice, 100_000e6);
        uint256 before = vault.totalValue();
        // a rise with nobody tending: the margin thins out under its lower line
        movePrice(1_400);
        blocks(6);
        State memory s = lens.state(address(vault));
        console2.log("margin after +14% untended (bps):", s.marginBpsNow);
        assertLt(s.marginBpsNow, 2_500);
        uint256 perpBefore = uint256(s.perpValue);
        vault.tend(); // anyone
        nextBlock();
        s = lens.state(address(vault));
        assertGt(uint256(s.perpValue), perpBefore + 5_000e6, "USDC was sent to the margin");
        assertEq(s.idleAsset > 0, true, "the HYPE that came out with it waits in the vault, unswapped");
        settle();
        s = lens.state(address(vault));
        logState("after tending");
        assertGe(s.marginBpsNow, 2_500, "back above the lower line");
        assertHedged();
        // A 14% move with nobody tending costs about 2.3%: the short had the size for the old price all
        // the way up. That is the loss on swings, which the hedge does not remove, at its plainest.
        assertApproxEqRel(s.totalValue, before, 0.03e18);
        assertEq(sim.liquidations(), 0);
        // the keeper puts the idle HYPE back to work
        deployIdle();
        settle();
        assertLt(lens.state(address(vault)).idleAsset * lens.state(address(vault)).oraclePx / 1e16, 300e6, "little HYPE left idle");
        assertHedged();
    }

    function test_Margin_GivenBack_WhenThePriceFalls() public {
        depositAndDeploy(alice, 100_000e6);
        uint256 before = vault.totalValue();
        for (uint256 i; i < 4; i++) {
            movePrice(-400);
            settle();
        }
        State memory s = lens.state(address(vault));
        logState("after -15%");
        assertLe(s.marginBpsNow, 6_500 + 50, "not above the upper line");
        assertApproxEqRel(s.totalValue, before, 0.03e18, "a fall of 15%: value within 3%");
        // the USDC that came back can go to work again
        deployIdle();
        settle();
        assertHedged();
    }

    function test_Emergency_ShortIsCut_WhenNoTopUpIsPossible() public {
        depositAndDeploy(alice, 100_000e6);
        // The oracle jumps 30% and the pool does not follow: the vault may not swap, and its margin is nearly gone.
        sim.setPx(sim.px() * 130 / 100);
        blocks(6);
        State memory s = lens.state(address(vault));
        console2.log("margin after the jump (bps):", s.marginBpsNow);
        assertLt(s.marginBpsNow, 1_200);
        assertFalse(s.priceInLine);
        vault.tend();
        blocks(6);
        s = lens.state(address(vault));
        logState("after the emergency tend");
        assertGe(s.marginBpsNow, 2_000, "the margin carries the short again");
        assertEq(sim.liquidations(), 0);
    }

    function test_Liquidation_IsSurvived() public {
        depositAndDeploy(alice, 100_000e6);
        uint256 before = vault.totalValue();
        // a jump nobody could tend through
        sim.setPx(sim.px() * 145 / 100);
        assertTrue(sim.liquidateIfDue(address(vault)), "the exchange closes the short");
        assertEq(short(), 0);
        // the pool catches up with the oracle; the keeper moves the range; tending rebuilds margin and short
        (uint160 p,,,,,,) = POOL.slot0();
        moveTo(uint160(uint256(p) * Math.sqrt(145e34) / 1e18));
        sim.setPx(poolRaw());
        (, int24 tick,,,,,) = POOL.slot0();
        vm.prank(keeper);
        vault.rebalance(tick, 0);
        settle();
        State memory s = lens.state(address(vault));
        logState("after a liquidation, rebuilt");
        assertHedged();
        assertLt(s.totalValue, before, "the loss is real");
        assertGt(s.totalValue, before * 60 / 100, "and bounded by what the margin held and the rise gave");
    }

    // ------------------------------------------------------------------ HyperCore does not answer

    function test_RejectedOrders_AreSentAgain() public {
        deposit(alice, 50_000e6);
        sim.setRejectOrders(true);
        deployIdle();
        blocks(6);
        assertEq(short(), 0, "nothing filled");
        assertGt(sim.ordersRejected(), 0);
        assertApproxEqRel(vault.totalValue(), 50_000e6, 0.005e18, "value does not assume the order filled");
        sim.setRejectOrders(false);
        settle();
        assertHedged();
    }

    function test_PartialFills_Converge() public {
        deposit(alice, 50_000e6);
        sim.setFillBps(4_000);
        deployIdle();
        settle();
        assertHedged();
    }

    function test_RejectedTransfers_OwedStaysOwed() public {
        uint256 shares = depositAndDeploy(alice, 50_000e6);
        sim.setRejectTransfers(true);
        vm.prank(alice);
        (uint256 paid,, uint256 owed) = vault.withdraw(shares * 9 / 10, 0, alice);
        assertGt(owed, 0);
        blocks(12);
        try vault.tend() {} catch {}
        blocks(12);
        assertEq(vault.owed(alice), owed, "still owed: nothing arrived");
        assertGt(sim.transfersRejected(), 0);
        sim.setRejectTransfers(false);
        for (uint256 i; i < 4 && vault.owed(alice) > 0; i++) {
            settle();
            try vault.claim(alice) {} catch {}
        }
        assertEq(vault.owed(alice), 0, "paid once HyperCore answers");
        assertGt(paid + owed, 44_000e6);
    }

    // ------------------------------------------------------------------ range, fees, wind-down

    function test_Rebalance_RecentresAndHedges() public {
        depositAndDeploy(alice, 100_000e6);
        uint256 before = vault.totalValue();
        State memory s = lens.state(address(vault));
        int24 lower = s.lower;
        // out of the range upwards, in steps the bot tends through
        for (uint256 i; i < 6; i++) {
            movePrice(400);
            settle();
        }
        s = lens.state(address(vault));
        assertGe(s.poolTick, s.upper, "the price has left the range");
        assertEq(s.positionAsset, 0, "the position is all USDC now");
        assertHedged(); // only idle HYPE is left to hedge
        vm.warp(block.timestamp + 1 hours);
        vm.prank(keeper);
        vault.rebalance(s.poolTick, 0);
        settle();
        s = lens.state(address(vault));
        logState("after the rebalance");
        assertGt(s.lower, lower, "the range moved up");
        assertTrue(s.poolTick >= s.lower && s.poolTick < s.upper);
        assertHedged();
        assertApproxEqRel(s.totalValue, before, 0.03e18, "a rise of 26%: value within 3%");
    }

    function test_Fees_AreCollected_AndShared() public {
        depositAndDeploy(alice, 500_000e6);
        uint256 before = vault.totalValue();
        // volume: the price goes up and down inside the range
        for (uint256 i; i < 6; i++) {
            movePrice(i % 2 == 0 ? int256(150) : int256(-148));
        }
        sim.setPx(poolRaw());
        vault.harvest();
        (uint256 f0, uint256 f1) = vault.totalFees();
        assertTrue(f0 > 0 && f1 > 0, "fees in both tokens");
        assertEq(WHYPE.balanceOf(feeRecipient), f0 * 2_000 / 10_000, "20% of the HYPE fees");
        assertEq(USDC.balanceOf(feeRecipient), f1 * 2_000 / 10_000, "20% of the USDC fees");
        console2.log("fees collected (HYPE 1e15, USDC):", f0 / 1e15, f1);
        console2.log("value before / after:", before, vault.totalValue());
    }

    function test_WindDown_BringsEverythingHome() public {
        uint256 a = depositAndDeploy(alice, 40_000e6);
        uint256 b = depositAndDeploy(bob, 60_000e6);
        uint256 before = vault.totalValue();
        vm.prank(owner);
        vault.windDown();
        vm.prank(alice);
        vm.expectRevert(Closing.selector);
        vault.deposit(1_000e6, 0, alice);
        vault.tend(); // anyone: the position comes out
        assertEq(lens.state(address(vault)).positionAsset + lens.state(address(vault)).positionUsdc, 0, "the position is out");
        (, int24 tick,,,,,) = POOL.slot0();
        vm.prank(keeper);
        vault.rebalance(tick, 0); // the keeper sells the HYPE
        settle();
        State memory s = lens.state(address(vault));
        logState("after the wind-down");
        assertLe(short(), 1, "the short is closed");
        assertLt(s.idleAsset, 1e15, "the HYPE is sold");
        assertApproxEqRel(s.idleUsdc, before, 0.01e18, "everything is USDC in the vault");
        vm.prank(alice);
        (uint256 pa,, uint256 oa) = vault.withdraw(a, 0, alice);
        vm.prank(bob);
        (uint256 pb,, uint256 ob) = vault.withdraw(b, 0, bob);
        assertEq(oa + ob, 0, "paid in full at once");
        assertApproxEqRel(pa + pb, before, 0.012e18);
    }

    function test_WindDown_WithoutTheKeeper_EveryoneStillGetsOut() public {
        uint256 a = depositAndDeploy(alice, 40_000e6);
        uint256 b = depositAndDeploy(bob, 60_000e6);
        uint256 before = vault.totalValue();
        vm.prank(owner);
        vault.windDown();
        settle(); // anyone tends: the position is out, its HYPE waits in the vault, still covered by the short
        assertGt(lens.state(address(vault)).idleAsset, 0);
        assertHedged();
        vm.prank(alice);
        (uint256 pa,, uint256 oa) = vault.withdraw(a, 0, alice); // sells her slice of the HYPE herself
        vm.prank(bob);
        (uint256 pb,, uint256 ob) = vault.withdraw(b, 0, bob);
        for (uint256 i; i < 4 && vault.owed(alice) + vault.owed(bob) > 0; i++) {
            settle();
            if (vault.owed(alice) > 0) try vault.claim(alice) {} catch {}
            if (vault.owed(bob) > 0) try vault.claim(bob) {} catch {}
        }
        assertEq(vault.owed(alice) + vault.owed(bob), 0);
        assertApproxEqRel(pa + oa + pb + ob, before, 0.012e18);
        assertLe(short(), 1);
    }

    function test_OutOfRange_DepositsWaitForTheKeeper() public {
        depositAndDeploy(alice, 50_000e6);
        for (uint256 i; i < 6; i++) {
            movePrice(400);
            settle();
        }
        deposit(bob, 20_000e6); // deposits are still taken, at the vault's value
        (, int24 tick,,,,,) = POOL.slot0();
        vm.prank(keeper);
        vm.expectRevert(OutOfRange.selector);
        vault.deploy(tick, 0);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(keeper);
        vault.rebalance(tick, 0); // the new range takes the idle money too
        settle();
        assertLt(lens.state(address(vault)).idleUsdc, vault.totalValue() * 3 / 100);
        assertHedged();
    }

    // ------------------------------------------------------------------ nobody gains at the others' cost

    function test_PushedPool_DepositGainsNothing() public {
        depositAndDeploy(alice, 100_000e6);
        uint256 aliceShares = vault.balanceOf(alice);
        uint256 perShare = vault.totalValue() * 1e18 / vault.totalSupply();
        // an attacker pushes the pool as far as the vault still accepts, buys in, lets the pool fall back, leaves
        sim.setPx(poolRaw());
        (uint160 p,,,,,,) = POOL.slot0();
        moveTo(uint160(uint256(p) * 10_045 / 10_000)); // +0.9%
        uint256 b = deposit(bob, 100_000e6);
        moveTo(p);
        vm.prank(bob);
        (uint256 paid,, uint256 owed) = vault.withdraw(b, 0, bob);
        console2.log("attacker put in 100000000000, took out:", paid + owed);
        assertLt(paid + owed, 100_000e6, "the attacker leaves with less than they brought");
        settle();
        uint256 after_ = vault.totalValue() * 1e18 / vault.totalSupply();
        assertGe(after_ * 10_000, perShare * 9_995, "those who stayed lost nothing to it");
        assertEq(vault.balanceOf(alice), aliceShares);
    }

    function test_InAndOut_DoesNotDrainTheOthers() public {
        depositAndDeploy(alice, 100_000e6);
        arb();
        uint256 perShare = vault.totalValue() * 1e18 / vault.totalSupply();
        for (uint256 i; i < 5; i++) {
            uint256 b = deposit(bob, 50_000e6);
            deployIdle();
            arb(); // the vault's own purchase pushed the pool; someone takes it back to the market price
            settle();
            vm.prank(bob);
            vault.withdraw(b, 0, bob);
            arb();
            settle();
            if (vault.owed(bob) > 0) vault.claim(bob);
        }
        uint256 after_ = vault.totalValue() * 1e18 / vault.totalSupply();
        console2.log("value per share before / after five round trips by someone else:", perShare, after_);
        assertGe(after_, perShare, "round trips by someone else cost those who stay nothing: the allowances cover them");
    }

    function test_Donation_DoesNotStealAFirstDeposit() public {
        deposit(bob, 2_000); // the smallest possible first deposit: almost all of it becomes dead shares
        vm.prank(bob);
        USDC.transfer(address(vault), 50_000e6); // a gift that inflates the share price
        uint256 a = deposit(alice, 50_000e6);
        vm.prank(alice);
        (uint256 paid,, uint256 owed) = vault.withdraw(a, 0, alice);
        assertGt(paid + owed, 49_800e6, "the next depositor gets their money's worth");
    }

    function test_Claim_OnlyWhatIsOwed() public {
        depositAndDeploy(alice, 20_000e6);
        vm.expectRevert(NothingOwed.selector);
        vault.claim(alice);
        vm.expectRevert(NothingOwed.selector);
        vault.claim(bob);
    }

    /// @dev The owner's wallet refuses HyperEVM transactions above 2,000,000 gas, and a fast block
    /// holds 3,000,000. Every call has to fit.
    function test_Gas_EveryCallFits() public {
        uint256 g = gasleft();
        deposit(alice, 100_000e6);
        uint256 used = g - gasleft();
        console2.log("deposit:", used);
        assertLt(used, 1_900_000);

        g = gasleft();
        deployIdle();
        used = g - gasleft();
        console2.log("deploy:", used);
        assertLt(used, 1_900_000);
        settle();

        movePrice(1_400);
        blocks(6);
        g = gasleft();
        vault.tend();
        used = g - gasleft();
        console2.log("tend (top-up and order):", used);
        assertLt(used, 1_900_000);
        settle();

        g = gasleft();
        vault.harvest();
        used = g - gasleft();
        console2.log("harvest:", used);
        assertLt(used, 1_900_000);

        (, int24 tick,,,,,) = POOL.slot0();
        vm.warp(block.timestamp + 1 hours);
        vm.prank(keeper);
        g = gasleft();
        vault.rebalance(tick, 0);
        used = g - gasleft();
        console2.log("rebalance:", used);
        assertLt(used, 1_900_000);
        settle();

        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        g = gasleft();
        vault.withdraw(shares / 2, 0, alice);
        used = g - gasleft();
        console2.log("withdraw (half the vault):", used);
        assertLt(used, 1_900_000);
        settle();

        g = gasleft();
        vault.claim(alice);
        used = g - gasleft();
        console2.log("claim:", used);
        assertLt(used, 1_900_000);
    }

    // ------------------------------------------------------------------ the two promises about the short

    /// @dev Whatever happens, in any order: the account is never long, and no sale is ever sent that
    /// would take the short beyond the HYPE the vault holds. (Between a withdrawal and the landing of
    /// its buy order the short is larger than what is held: that cannot be avoided, only kept brief.)
    /// forge-config: default.fuzz.runs = 24
    function testFuzz_NeverLong_NeverSellsBeyondHoldings(uint256 seed) public {
        deposit(alice, 80_000e6);
        deployIdle();
        bytes32 orderSent = keccak256("OrderSent(bool,uint256,uint256,bool,int256,uint256)");
        vm.recordLogs();
        for (uint256 i; i < 12; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 pick = seed % 6;
            if (pick == 0) {
                movePrice(int256((seed >> 8) % 500) - 250);
            } else if (pick == 1) {
                try vault.tend() {} catch {}
            } else if (pick == 2) {
                (, int24 t,,,,,) = POOL.slot0();
                vm.prank(keeper);
                try vault.deploy(t, 0) {} catch {}
            } else if (pick == 3) {
                deposit(bob, 1_000e6 + (seed >> 16) % 20_000e6);
            } else if (pick == 4) {
                uint256 sh = vault.balanceOf(alice) * ((seed >> 24) % 30) / 100;
                if (sh > 0) {
                    vm.prank(alice);
                    vault.withdraw(sh, 0, alice);
                }
            } else {
                sim.setFillBps(2_000 + (seed >> 32) % 8_001);
            }
            blocks(1 + (seed >> 40) % 7);
            (, int256 szi,) = sim.accounts(address(vault));
            assertLe(szi, 0, "never long");
            Vm.Log[] memory logs = vm.getRecordedLogs();
            for (uint256 j; j < logs.length; j++) {
                if (logs[j].topics[0] != orderSent) continue;
                (bool isBuy, uint256 sz,, bool reduceOnly, int256 was, uint256 target) =
                    abi.decode(logs[j].data, (bool, uint256, uint256, bool, int256, uint256));
                assertEq(isBuy, reduceOnly, "every buy is reduce-only, no sale is");
                if (!isBuy) assertEq(uint256(-was) + sz, target, "a sale goes up to the target and no further");
            }
        }
        sim.setFillBps(10_000);
        settle();
        assertHedged();
        assertEq(sim.liquidations(), 0);
    }
}
