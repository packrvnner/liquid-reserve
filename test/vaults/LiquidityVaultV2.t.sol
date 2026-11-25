// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {WETH} from "solmate/src/tokens/WETH.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {LiquidityVaultV2} from "../../src/vaults/LiquidityVaultV2.sol";
import {FeeInbox} from "../../src/FeeInbox.sol";

contract LiquidityVaultV2Test is Deployers {
    WETH internal whype;
    LiquidityVaultV2 internal vault;
    PoolKey internal keyAB;
    PoolKey internal keyNA;
    address internal t0;
    address internal t1;
    address internal feeRouter = makeAddr("feeRouter");
    address internal keeper = makeAddr("keeper");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal mallory = makeAddr("mallory");
    /// Share value is computed with rounded-down maths; allow a few wei of wobble.
    uint256 internal constant DUST = 10;

    function setUp() public {
        vm.warp(1_800_000_000);
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        t0 = Currency.unwrap(currency0);
        t1 = Currency.unwrap(currency1);
        IPoolManager.ModifyLiquidityParams memory deep =
            IPoolManager.ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 1e24, salt: 0});

        (keyAB,) = initPool(currency0, currency1, IHooks(address(0)), 3000, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(keyAB, deep, ZERO_BYTES);
        vm.deal(address(this), 1e27);
        (keyNA,) = initPool(CurrencyLibrary.ADDRESS_ZERO, currency0, IHooks(address(0)), 3000, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity{value: 5e23}(keyNA, deep, ZERO_BYTES);

        whype = new WETH();
        vault = _vault(keyAB);
        address[3] memory users = [alice, bob, mallory];
        for (uint256 i; i < 3; ++i) {
            MockERC20(t0).mint(users[i], 1e24);
            MockERC20(t1).mint(users[i], 1e24);
            vm.startPrank(users[i]);
            MockERC20(t0).approve(address(vault), type(uint256).max);
            MockERC20(t1).approve(address(vault), type(uint256).max);
            vm.stopPrank();
        }
    }

    // ------------------------------------------------------------- helpers

    function _vault(PoolKey memory key) internal returns (LiquidityVaultV2) {
        return new LiquidityVaultV2(
            LiquidityVaultV2.Params({
                key: key,
                poolManager: manager,
                feeRecipient: feeRouter,
                whype: address(whype),
                owner: address(this),
                keeper: keeper,
                name: "Liquid Reserve Vault",
                symbol: "lrvTEST",
                mainWidth: 10,
                altWidth: 10,
                depositCap: 0
            })
        );
    }

    /// Deposits the way the site does: ask for the shares the amounts can pay
    /// for, then allow 0.5% more than quoted.
    function _deposit(address who, uint256 a0, uint256 a1) internal returns (uint256 shares) {
        (uint256 s, uint256 n0, uint256 n1) = vault.previewDeposit(a0, a1);
        uint256 before = vault.balanceOf(who);
        bool empty = vault.totalSupply() <= vault.MINIMUM_SHARES();
        vm.prank(who);
        if (empty) vault.deposit(s, a0, a1, who);
        else vault.deposit(s, n0 + n0 / 200 + 1e6, n1 + n1 / 200 + 1e6, who);
        shares = vault.balanceOf(who) - before;
    }

    function _withdrawAll(address who) internal returns (uint256 out0, uint256 out1) {
        uint256 shares = vault.balanceOf(who);
        vm.prank(who);
        (out0, out1) = vault.withdraw(shares, 0, 0, who, false);
    }

    /// Trades back and forth so fees accrue but the price ends near where it started.
    function _churn(uint256 rounds, uint256 size) internal {
        for (uint256 i; i < rounds; ++i) {
            swap(keyAB, true, -int256(size), ZERO_BYTES);
            swap(keyAB, false, -int256(size), ZERO_BYTES);
        }
    }

    /// Value in token1 of `who`'s shares at the current pool price.
    function _shareValue(address who) internal view returns (uint256) {
        return vault.totalValue() * vault.balanceOf(who) / vault.totalSupply();
    }

    function _wallet(address who) internal view returns (uint256) {
        return MockERC20(t0).balanceOf(who) + MockERC20(t1).balanceOf(who);
    }

    // ------------------------------------------------------------- deposits

    function test_FirstDepositMintsSharesAndOpensRanges() public {
        uint256 shares = _deposit(alice, 100e18, 100e18);
        assertEq(shares, 200e18 - vault.MINIMUM_SHARES(), "value at price 1, less the locked minimum");
        assertEq(vault.balanceOf(vault.DEAD()), vault.MINIMUM_SHARES());

        (int24 lo, int24 hi, uint128 liq) = vault.main();
        (, int24 tick) = vault.price();
        assertTrue(lo <= tick && tick < hi, "main range straddles the price");
        assertGt(liq, 0);
        assertApproxEqRel(vault.totalValue(), 200e18, 0.0001e18);
        assertLt(MockERC20(t0).balanceOf(address(vault)) + MockERC20(t1).balanceOf(address(vault)), 1e15, "all deployed");
    }

    function test_FirstDepositCanBeOneSided() public {
        _deposit(alice, 100e18, 0);
        (,, uint128 altLiq) = vault.alt();
        assertGt(altLiq, 0, "leftover token sits in the alt range");
        // V2 swaps about half of a one-sided first deposit into the other token: that costs the pool fee on the swapped half.
        assertApproxEqRel(vault.totalValue(), 100e18, 0.005e18);
    }

    function test_LaterDepositsAreProportionalAndRefundTheRest() public {
        _deposit(alice, 100e18, 100e18);
        uint256 aliceBefore = _shareValue(alice);
        uint256 walletBefore = _wallet(bob);

        // Bob offers far more token1 than the ratio needs.
        uint256 shares = _deposit(bob, 50e18, 500e18);
        assertApproxEqRel(shares, 100e18, 0.0001e18, "half of alice's size");
        assertApproxEqRel(walletBefore - _wallet(bob), 100e18, 0.0001e18, "only what the ratio needs was taken");
        assertGe(_shareValue(alice), aliceBefore, "existing holder not diluted");
        assertApproxEqRel(_shareValue(bob), 100e18, 0.0001e18);
    }

    function test_RevertWhen_DepositNeedsMoreThanMaximums() public {
        _deposit(alice, 100e18, 100e18);
        (uint256 s,,) = vault.previewDeposit(10e18, 10e18);
        vm.prank(bob);
        vm.expectRevert(); // token transfer runs short, or Slippage
        vault.deposit(s, 10e18, 5e18, bob);
    }

    function test_DepositCollectsFeesForExistingHoldersFirst() public {
        _deposit(alice, 100e18, 100e18);
        _churn(20, 5_000e18);
        (uint256 f0, uint256 f1) = vault.pendingFees();
        assertGt(f0 + f1, 0, "fees are waiting");
        uint256 aliceBefore = _shareValue(alice) + (f0 + f1) * 8 / 10;

        _deposit(bob, 100e18, 100e18);
        assertGt(MockERC20(t0).balanceOf(feeRouter) + MockERC20(t1).balanceOf(feeRouter), 0, "performance fee paid");
        assertApproxEqRel(_shareValue(alice), aliceBefore, 0.0005e18, "alice keeps all fees earned before bob joined");
        (uint256 b0, uint256 b1) = _withdrawAll(bob);
        assertLe(b0 + b1, 200e18 + 1e15, "bob did not capture earlier fees");
    }

    // ------------------------------------------------------------- compounding

    function test_HarvestCompoundsAndPaysPerformanceFee() public {
        _deposit(alice, 100e18, 100e18);
        (,, uint128 liqBefore) = vault.main();
        _churn(20, 5_000e18);
        (uint256 f0, uint256 f1) = vault.pendingFees();

        vm.prank(bob); // anyone can harvest
        vault.harvest();

        assertEq(vault.totalFees0(), f0, "view matches what was collected");
        assertEq(vault.totalFees1(), f1);
        assertEq(MockERC20(t0).balanceOf(feeRouter), f0 * 2_000 / 10_000, "20% of fees");
        assertEq(MockERC20(t1).balanceOf(feeRouter), f1 * 2_000 / 10_000);
        (,, uint128 liqAfter) = vault.main();
        assertGt(liqAfter, liqBefore, "fees went back into the range");
        (uint256 p0, uint256 p1) = vault.pendingFees();
        assertEq(p0 + p1, 0);
        assertGt(vault.totalValue(), 200e18, "holders are ahead");
        assertEq(vault.lastHarvest(), block.timestamp);
    }

    function test_HarvestOnEmptyVaultDoesNothing() public {
        vault.harvest();
        assertEq(vault.totalValue(), 0);
    }

    // ------------------------------------------------------------- withdrawals

    function test_WithdrawIsProRata() public {
        _deposit(alice, 100e18, 100e18);
        _deposit(bob, 100e18, 100e18);
        (uint256 a0, uint256 a1) = _withdrawAll(alice);
        assertApproxEqRel(a0 + a1, 200e18, 0.0001e18);
        (uint256 b0, uint256 b1) = _withdrawAll(bob);
        assertApproxEqRel(b0 + b1, 200e18, 0.0001e18);
    }

    function test_WithdrawAlwaysWorks() public {
        _deposit(alice, 100e18, 100e18);
        swap(keyAB, true, -int256(60_000e18), ZERO_BYTES); // ~12% move: outside the main range
        vault.setDepositsPaused(true);
        (uint256 o0, uint256 o1) = _withdrawAll(alice);
        assertGt(o0 + o1, 0, "withdrawals work out of range and while deposits are paused");
    }

    function test_RevertWhen_WithdrawBelowMinimums() public {
        _deposit(alice, 100e18, 100e18);
        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert(LiquidityVaultV2.Slippage.selector);
        vault.withdraw(shares, 101e18, 0, alice, false);
    }

    function test_EmptiedVaultCanBeReseededAtAnyRatio() public {
        _deposit(alice, 100e18, 100e18);
        _withdrawAll(alice);
        assertEq(vault.totalSupply(), vault.MINIMUM_SHARES());
        swap(keyAB, true, -int256(20_000e18), ZERO_BYTES);
        uint256 shares = _deposit(bob, 10e18, 90e18);
        assertGt(shares, 0);
        (int24 lo, int24 hi,) = vault.main();
        (, int24 tick) = vault.price();
        assertTrue(lo <= tick && tick < hi, "ranges re-opened around the new price");
        (uint256 o0, uint256 o1) = _withdrawAll(bob);
        assertApproxEqRel(vault.totalValue() + o0 + o1, o0 + o1, 0.0001e18, "bob got everything back");
    }

    // ------------------------------------------------------------- no oracle needed

    function test_DepositWorksAtAnyPriceWithNoOracle() public {
        _deposit(alice, 100e18, 100e18);
        swap(keyAB, true, -int256(60_000e18), ZERO_BYTES); // price leaves the main range
        uint256 aliceBefore = _shareValue(alice);
        uint256 shares = _deposit(bob, 100e18, 100e18);
        assertGt(shares, 0, "deposits still work");
        assertGe(_shareValue(alice) + 1e6, aliceBefore, "and are still fair");
    }

    /// Push the price, deposit, push it back, withdraw: the attacker must not come out ahead
    /// and the existing holder must not lose.
    function test_PriceManipulationAroundDepositDoesNotPay() public {
        _deposit(alice, 100e18, 100e18);
        uint256 aliceBefore = _shareValue(alice);
        uint256 malloryBefore = _wallet(mallory);

        vm.startPrank(mallory);
        MockERC20(t0).approve(address(swapRouter), type(uint256).max);
        MockERC20(t1).approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();

        _swapAs(mallory, true, 40_000e18); // push the price down ~8%
        _deposit(mallory, 300e18, 300e18);
        _swapAs(mallory, false, 39_700e18); // push it back
        _withdrawAll(mallory);

        assertLt(_wallet(mallory), malloryBefore, "attacker paid swap fees and gained nothing");
        assertGe(_shareValue(alice) + 1e12, aliceBefore, "existing holder did not lose");
    }

    function _swapAs(address who, bool zeroForOne, uint256 amountIn) internal {
        if (amountIn == 0) return;
        vm.prank(who);
        swapRouter.swap(
            keyAB,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            _settings(),
            ZERO_BYTES
        );
    }

    function _settings() internal pure returns (PoolSwapTest.TestSettings memory) {
        return PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});
    }

    // ------------------------------------------------------------- rebalancing

    function test_RebalanceRecentersAndIsKeeperOnly() public {
        _deposit(alice, 100e18, 100e18);
        swap(keyAB, true, -int256(60_000e18), ZERO_BYTES); // ~12% move
        (, int24 tick) = vault.price();
        (int24 lo,,) = vault.main();
        assertLt(tick, lo, "out of range");

        vm.prank(alice);
        vm.expectRevert(LiquidityVaultV2.NotKeeper.selector);
        vault.rebalance(tick, 10);

        (uint256 f0, uint256 f1) = vault.pendingFees();
        (uint160 sqrtP,) = vault.price();
        uint256 valueBefore = vault.totalValue() + (f1 + FullMath.mulDiv(f0, uint256(sqrtP) * sqrtP, 1 << 192)) * 8 / 10;
        vm.prank(keeper);
        vault.rebalance(tick, 10);
        (int24 lo2, int24 hi2,) = vault.main();
        assertTrue(lo2 <= tick && tick < hi2, "re-centered on the new price");
        // V2 swaps the surplus when it moves the ranges: that costs the pool fee on the swapped part.
        assertApproxEqRel(vault.totalValue(), valueBefore, 0.005e18, "moving ranges costs at most the swap fee");
    }

    function test_RevertWhen_RebalanceAtUnexpectedPrice() public {
        _deposit(alice, 100e18, 100e18);
        (, int24 seen) = vault.price();
        swap(keyAB, true, -int256(20_000e18), ZERO_BYTES); // someone moves the price first
        vm.prank(keeper);
        vm.expectPartialRevert(LiquidityVaultV2.PriceMoved.selector);
        vault.rebalance(seen, 20);

        vm.prank(keeper);
        vm.expectRevert(LiquidityVaultV2.BadParams.selector);
        vault.rebalance(seen, 201); // drift allowance is capped
    }

    function test_RebalanceIsRateLimited() public {
        _deposit(alice, 100e18, 100e18);
        (, int24 tick) = vault.price();
        vm.startPrank(keeper);
        vault.rebalance(tick, 5);
        vm.expectPartialRevert(LiquidityVaultV2.TooSoon.selector);
        vault.rebalance(tick, 5);
        vm.warp(block.timestamp + 15 minutes);
        vault.rebalance(tick, 5);
        vm.stopPrank();
    }

    // ------------------------------------------------------------- guardrails

    function test_DepositCapAndPause() public {
        vault.setDepositCap(150e18);
        vm.prank(alice);
        vm.expectPartialRevert(LiquidityVaultV2.CapExceeded.selector);
        vault.deposit(1, 100e18, 100e18, alice);
        vault.setDepositCap(0);
        vault.setDepositsPaused(true);
        vm.prank(alice);
        vm.expectRevert(LiquidityVaultV2.DepositsArePaused.selector);
        vault.deposit(1, 1e18, 1e18, alice);
    }

    function test_OwnerParamsBoundedAndOwnerOnly() public {
        vm.expectRevert(LiquidityVaultV2.BadParams.selector);
        vault.setRanges(1, 10);
        vm.expectRevert(LiquidityVaultV2.ZeroAddress.selector);
        vault.setKeeper(address(0));
        vault.setKeeper(bob);
        assertEq(vault.keeper(), bob);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.setDepositsPaused(true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.setKeeper(alice);
    }

    function test_RevertWhen_HookedPool() public {
        PoolKey memory hooked = keyAB;
        hooked.hooks = IHooks(address(0xbeef));
        vm.expectRevert(LiquidityVaultV2.BadParams.selector);
        _vault(hooked);
    }

    function test_InflationAttackIsUneconomic() public {
        // Attacker makes a tiny first deposit, then donates to inflate the share price.
        _deposit(bob, 2_000, 2_000);
        vm.prank(bob);
        MockERC20(t1).transfer(address(vault), 10e18);
        vault.harvest();
        // Victim still gets a fair share.
        uint256 before = _wallet(alice);
        _deposit(alice, 10e18, 10e18);
        uint256 paid = before - _wallet(alice);
        (uint256 o0, uint256 o1) = _withdrawAll(alice);
        assertGt(o0 + o1, paid * 995 / 1000, "victim keeps >99.5% of what they paid in");
    }

    // ------------------------------------------------------------- native HYPE pool

    function test_NativePoolTakesAndReturnsNativeHype() public {
        LiquidityVaultV2 v = _vault(keyNA);
        assertEq(address(v.token0()), address(whype));
        assertTrue(v.nativePool());
        vm.deal(alice, 100e18);
        vm.deal(bob, 100e18);
        vm.prank(alice);
        MockERC20(t0).approve(address(v), type(uint256).max);
        vm.prank(bob);
        MockERC20(t0).approve(address(v), type(uint256).max);

        vm.prank(alice);
        v.deposit{value: 50e18}(1, 0, 50e18, alice);
        assertEq(alice.balance, 50e18);

        // Bob sends more HYPE than needed: the rest comes back as native HYPE.
        (uint256 s, uint256 n0, uint256 n1) = v.previewDeposit(10e18, 10e18);
        vm.prank(bob);
        (uint256 used0,) = v.deposit{value: 30e18}(s, 0, n1 + 1e15, bob);
        assertApproxEqRel(used0, n0, 0.0001e18);
        assertEq(bob.balance, 100e18 - used0, "unused HYPE refunded");

        uint256 shares = v.balanceOf(alice);
        vm.prank(alice);
        (uint256 o0, uint256 o1) = v.withdraw(shares, 0, 0, alice, true);
        assertEq(alice.balance, 50e18 + o0, "paid out as native HYPE");
        assertApproxEqRel(o0 + o1, 100e18, 0.0001e18);
        assertEq(address(v).balance, 0);
    }

    function test_RevertWhen_NativeSentToTokenPool() public {
        vm.deal(alice, 1e18);
        vm.prank(alice);
        vm.expectRevert(LiquidityVaultV2.UnexpectedNative.selector);
        vault.deposit{value: 1e18}(1, 0, 1e18, alice);
    }

    // ------------------------------------------------------------- launcher

    function testFuzz_DepositWithdrawRoundTrip(uint96 a0, uint96 a1) public {
        a0 = uint96(bound(a0, 1e15, 1e23));
        a1 = uint96(bound(a1, 1e15, 1e23));
        _deposit(bob, 10e18, 10e18); // existing holder
        uint256 bobBefore = _shareValue(bob);
        uint256 walletBefore = _wallet(alice);
        _deposit(alice, a0, a1);
        uint256 paid = walletBefore - _wallet(alice);
        assertGe(_shareValue(bob) + DUST, bobBefore, "a deposit never dilutes existing holders");
        (uint256 o0, uint256 o1) = _withdrawAll(alice);
        assertLe(o0 + o1, paid, "nobody withdraws more than they paid in");
        assertApproxEqRel(o0 + o1, paid, 0.0001e18, "and gets it back, minus rounding");
        assertGe(_shareValue(bob) + DUST, bobBefore, "other holders unaffected");
    }

    /// Same, after the price has moved and fees have built up.
    function testFuzz_FairAfterTradingAtAnyPrice(uint96 amount, uint96 push, bool down) public {
        amount = uint96(bound(amount, 1e15, 1e23));
        push = uint96(bound(push, 1e18, 80_000e18));
        _deposit(bob, 100e18, 100e18);
        _churn(3, 2_000e18);
        swap(keyAB, down, -int256(uint256(push)), ZERO_BYTES);
        vault.harvest();

        uint256 bobBefore = _shareValue(bob);
        uint256 walletBefore = _wallet(alice);
        (uint256 s, uint256 n0, uint256 n1) = vault.previewDeposit(amount, amount);
        vm.assume(s > 0);
        vm.prank(alice);
        vault.deposit(s, n0 + n0 / 200 + 1e6, n1 + n1 / 200 + 1e6, alice);
        assertGe(_shareValue(bob) + DUST, bobBefore, "a deposit never dilutes existing holders");
        _withdrawAll(alice);
        assertGe(_shareValue(bob) + DUST, bobBefore, "other holders unaffected");
        assertLe(_wallet(alice), walletBefore, "depositor cannot extract value");
    }
}
