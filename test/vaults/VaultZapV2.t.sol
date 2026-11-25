// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {WETH} from "solmate/src/tokens/WETH.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {LiquidityVaultV2} from "../../src/vaults/LiquidityVaultV2.sol";
import {VaultZap, IZapVault} from "../../src/vaults/VaultZap.sol";
import {VaultZapV2, IZapVaultV2} from "../../src/vaults/VaultZapV2.sol";

/// @notice The second zap, on three vaults: `alone` is the only liquidity in its pool (the
/// case the first zap gets wrong), `shared` sits in a pool with deep liquidity from others,
/// and `hype` is a native-HYPE pool. Prices start at 1, so amounts are also values.
contract VaultZapV2Test is Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    WETH internal whype;
    LiquidityVaultV2 internal alone;
    LiquidityVaultV2 internal shared;
    LiquidityVaultV2 internal hype;
    VaultZapV2 internal zap;
    VaultZap internal old;
    PoolKey internal keyAlone;
    PoolKey internal keyDeep;
    PoolKey internal keyNA;
    address internal t0;
    address internal t1;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    uint256 internal constant DUST = 10;

    function setUp() public {
        vm.warp(1_800_000_000);
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        t0 = Currency.unwrap(currency0);
        t1 = Currency.unwrap(currency1);
        IPoolManager.ModifyLiquidityParams memory deep =
            IPoolManager.ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 1e24, salt: 0});
        (keyDeep,) = initPool(currency0, currency1, IHooks(address(0)), 3000, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(keyDeep, deep, ZERO_BYTES);
        vm.deal(address(this), 1e27);
        (keyNA,) = initPool(CurrencyLibrary.ADDRESS_ZERO, currency0, IHooks(address(0)), 3000, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity{value: 5e23}(keyNA, deep, ZERO_BYTES);
        // the same pair once more, in a pool of its own where the vault will be the only liquidity
        keyAlone = PoolKey(currency0, currency1, 3000, 30, IHooks(address(0)));
        manager.initialize(keyAlone, SQRT_PRICE_1_1);

        whype = new WETH();
        alone = _vault(keyAlone, 60); // 60 spacings of 30 ticks: about 18% either side, like the live wANTx-USDC vault
        shared = _vault(keyDeep, 10);
        hype = _vault(keyNA, 10);
        zap = new VaultZapV2(manager);
        old = new VaultZap(manager);
        address[2] memory users = [alice, bob];
        for (uint256 i; i < 2; ++i) {
            MockERC20(t0).mint(users[i], 1e24);
            MockERC20(t1).mint(users[i], 1e24);
            vm.deal(users[i], 1e24);
            vm.startPrank(users[i]);
            for (uint256 k; k < 5; ++k) {
                address spender = [address(alone), address(shared), address(hype), address(zap), address(old)][k];
                MockERC20(t0).approve(spender, type(uint256).max);
                MockERC20(t1).approve(spender, type(uint256).max);
            }
            vm.stopPrank();
        }
    }

    function _vault(PoolKey memory key, int24 width) internal returns (LiquidityVaultV2) {
        return new LiquidityVaultV2(
            LiquidityVaultV2.Params({
                key: key,
                poolManager: manager,
                feeRecipient: makeAddr("fees"),
                whype: address(whype),
                owner: address(this),
                keeper: address(this),
                name: "Liquid Reserve Vault",
                symbol: "lrvTEST",
                mainWidth: width,
                altWidth: width,
                depositCap: 0
            })
        );
    }

    function _z(LiquidityVaultV2 v) internal pure returns (IZapVaultV2) {
        return IZapVaultV2(address(v));
    }

    function _value(LiquidityVaultV2 v, address who) internal view returns (uint256) {
        return v.totalValue() * v.balanceOf(who) / v.totalSupply();
    }

    /// Liquidity behind each share. A deposit must never lower it.
    function _liquidityPerShare(LiquidityVaultV2 v) internal view returns (uint256) {
        (,, uint128 m) = v.main();
        (,, uint128 a) = v.alt();
        return (uint256(m) + a) * 1e18 / v.totalSupply();
    }

    function _tick(PoolKey memory key) internal view returns (int24 tick) {
        (, tick,,) = manager.getSlot0(key.toId());
    }

    function _assertEmpty() internal view {
        assertEq(MockERC20(t0).balanceOf(address(zap)), 0, "zap keeps no token0");
        assertEq(MockERC20(t1).balanceOf(address(zap)), 0, "zap keeps no token1");
        assertEq(address(zap).balance, 0, "zap keeps no HYPE");
        assertEq(alone.balanceOf(address(zap)) + shared.balanceOf(address(zap)) + hype.balanceOf(address(zap)), 0, "zap keeps no shares");
    }

    // ------------------------------------------------- a vault that is alone in its pool

    function test_Alone_EmptyVaultTakesTheOneTokenAsItIs() public {
        int24 tick = _tick(keyAlone);
        vm.prank(bob);
        (uint256 shares, uint256 r0, uint256 r1) = zap.zapIn(_z(alone), true, 10e18, 0, bob);
        assertGt(shares, 0);
        (uint256 total0, uint256 total1) = alone.balances();
        assertApproxEqAbs(total0, 10e18, DUST, "all of it is in the vault");
        assertEq(total1, 0, "nothing was swapped: there was nobody to swap with");
        assertEq(_tick(keyAlone), tick, "the pool price was not touched");
        assertEq(r0 + r1, 0);
        _assertEmpty();
    }

    function test_Alone_PayingTheTokenTheVaultHasNoneOf() public {
        vm.prank(alice);
        alone.deposit(1, 100e18, 0, alice); // the vault holds token0 only
        uint256 perShare = _liquidityPerShare(alone);

        // The first zap cannot do this: it swaps all of it against the vault itself and has nothing left to deposit.
        vm.prank(bob);
        vm.expectPartialRevert(VaultZap.Slippage.selector);
        old.zapIn(IZapVault(address(alone)), false, 5e18, 0, bob);

        uint256 before1 = MockERC20(t1).balanceOf(bob);
        vm.prank(bob);
        (uint256 shares, uint256 r0, uint256 r1) = zap.zapIn(_z(alone), false, 5e18, 0, bob);
        assertGt(shares, 0);
        assertEq(alone.balanceOf(bob), shares);
        assertEq(before1 - MockERC20(t1).balanceOf(bob), 5e18 - r1, "paid in token1 only");
        assertApproxEqRel(_value(alone, bob) + r0 + r1, 5e18, 0.02e18, "got about what was paid for");
        assertLt(r0 + r1, 0.05e18, "under 1% came back as change");
        assertGe(_liquidityPerShare(alone) + DUST, perShare, "existing holder not diluted");
        _assertEmpty();
    }

    function test_Alone_PayingTheTokenTheVaultHolds() public {
        vm.prank(alice);
        alone.deposit(1, 100e18, 0, alice); // token0 only
        int24 tick = _tick(keyAlone);
        vm.prank(bob);
        (uint256 shares, uint256 r0, uint256 r1) = zap.zapIn(_z(alone), true, 10e18, 0, bob);
        assertApproxEqRel(shares, alone.balanceOf(alice) / 10, 0.005e18, "a tenth of what the first depositor has");
        assertEq(_tick(keyAlone), tick, "no swap, so the price did not move");
        assertLt(r0, 0.02e18, "nearly all of it went in");
        assertEq(r1, 0);
        _assertEmpty();
    }

    function test_Alone_BalancedVaultSendsAlmostNothingBack() public {
        vm.prank(alice);
        alone.deposit(1, 100e18, 100e18, alice);
        uint256 perShare = _liquidityPerShare(alone);

        // what the first zap does with the same deposit
        uint256 snap = vm.snapshotState();
        vm.prank(bob);
        (, uint256 o0, uint256 o1) = old.zapIn(IZapVault(address(alone)), true, 10e18, 0, bob);
        vm.revertToState(snap);

        vm.prank(bob);
        (uint256 shares, uint256 r0, uint256 r1) = zap.zapIn(_z(alone), true, 10e18, 0, bob);
        assertGt(shares, 0);
        assertLt(r0 + r1, 0.05e18, "under 0.5% came back as change");
        assertGt(o0 + o1, (r0 + r1) * 5, "the first zap sent back over five times as much");
        assertApproxEqRel(_value(alone, bob) + r0 + r1, 10e18, 0.01e18, "got about what was paid for");
        assertGe(_liquidityPerShare(alone) + DUST, perShare, "existing holder not diluted");
        _assertEmpty();
    }

    function test_Alone_TooMuchForThePoolReverts() public {
        vm.prank(alice);
        alone.deposit(1, 100e18, 100e18, alice);
        int24 tick = _tick(keyAlone);
        vm.prank(bob);
        vm.expectPartialRevert(VaultZapV2.TooMuchForPool.selector);
        zap.zapIn(_z(alone), true, 120e18, 0, bob); // would need to buy about half the vault's token1
        assertEq(_tick(keyAlone), tick, "nothing changed");
    }

    /// Whatever the amount and the token: a zap either reverts or leaves the price within the limit, and keeps nothing.
    function testFuzz_Alone_PriceMoveIsCapped(uint256 amount, bool token0In, uint256 lean) public {
        amount = bound(amount, 1e15, 300e18);
        lean = bound(lean, 0, 100e18); // how much token1 the first depositor brings beside 100 token0
        vm.prank(alice);
        alone.deposit(1, 100e18, lean, alice);
        int24 tick = _tick(keyAlone);
        vm.prank(bob);
        try zap.zapIn(_z(alone), token0In, amount, 0, bob) returns (uint256 shares, uint256, uint256) {
            assertGt(shares, 0);
            int24 moved = _tick(keyAlone) - tick;
            assertLe(moved < 0 ? -moved : moved, zap.MAX_IMPACT_TICKS() + 1, "price moved more than the limit");
        } catch (bytes memory err) {
            bytes4 sel = bytes4(err);
            assertTrue(sel == VaultZapV2.TooMuchForPool.selector || sel == VaultZapV2.Slippage.selector, "unexpected revert");
            assertEq(_tick(keyAlone), tick);
        }
        _assertEmpty();
    }

    // ------------------------------------------------- a vault among other liquidity

    function test_Shared_DoesAsWellAsTheFirstZap() public {
        vm.prank(alice);
        shared.deposit(1, 100e18, 100e18, alice);
        uint256 perShare = _liquidityPerShare(shared);

        uint256 snap = vm.snapshotState();
        vm.prank(bob);
        (uint256 oldShares,,) = old.zapIn(IZapVault(address(shared)), true, 10e18, 0, bob);
        vm.revertToState(snap);

        vm.prank(bob);
        (uint256 shares, uint256 r0, uint256 r1) = zap.zapIn(_z(shared), true, 10e18, 0, bob);
        assertGe(shares, oldShares * 995 / 1000, "at least as many shares as the first zap gives, within rounding");
        assertApproxEqRel(_value(shared, bob) + r0 + r1, 10e18, 0.005e18, "got about what was paid for");
        assertLt(r0 + r1, 0.1e18, "almost all of it went in");
        assertGe(_liquidityPerShare(shared) + DUST, perShare, "existing holder not diluted");
        _assertEmpty();
    }

    function test_Shared_TheOtherToken() public {
        vm.prank(alice);
        shared.deposit(1, 100e18, 100e18, alice);
        vm.prank(bob);
        (uint256 shares, uint256 r0, uint256 r1) = zap.zapIn(_z(shared), false, 10e18, 0, bob);
        assertGt(shares, 0);
        assertApproxEqRel(_value(shared, bob) + r0 + r1, 10e18, 0.005e18);
        _assertEmpty();
    }

    function test_Shared_EmptyVaultGetsBothTokens() public {
        vm.prank(bob);
        (uint256 shares,,) = zap.zapIn(_z(shared), true, 10e18, 0, bob);
        assertGt(shares, 0);
        (,, uint128 mainLiquidity) = shared.main();
        assertGt(mainLiquidity, 0, "main range has liquidity");
        // the vault sets its own mix when it opens its first range (it swaps a little itself), so not exactly half
        (uint256 total0, uint256 total1) = shared.balances();
        assertGt(total0, 4e18, "a good part in token0");
        assertGt(total1, 4e18, "a good part in token1");
        _assertEmpty();
    }

    function test_RevertWhen_FewerSharesThanMinimum() public {
        vm.prank(alice);
        shared.deposit(1, 100e18, 100e18, alice);
        vm.prank(bob);
        vm.expectPartialRevert(VaultZapV2.Slippage.selector);
        zap.zapIn(_z(shared), true, 10e18, 11e18, bob);
    }

    function test_RevertWhen_PoolWasPushedBeforeTheZap() public {
        vm.prank(alice);
        shared.deposit(1, 100e18, 100e18, alice);
        uint256 snap = vm.snapshotState();
        vm.prank(bob);
        (uint256 expected,,) = zap.zapIn(_z(shared), true, 10e18, 0, bob);
        vm.revertToState(snap);
        swap(keyDeep, true, -int256(50_000e18), ZERO_BYTES); // someone pushes the price 10% first
        vm.prank(bob);
        vm.expectPartialRevert(VaultZapV2.Slippage.selector);
        zap.zapIn(_z(shared), true, 10e18, expected * 99 / 100, bob);
    }

    function test_RevertWhen_BadInputs() public {
        vm.startPrank(bob);
        vm.expectRevert(VaultZapV2.ZeroAmount.selector);
        zap.zapIn(_z(shared), true, 0, 0, bob);
        vm.expectRevert(VaultZapV2.ZeroAddress.selector);
        zap.zapIn(_z(shared), true, 1e18, 0, address(0));
        vm.expectRevert(VaultZapV2.WrongValue.selector);
        zap.zapIn{value: 1e18}(_z(shared), true, 1e18, 0, bob); // HYPE sent to a token pool
        vm.expectRevert(VaultZapV2.WrongValue.selector);
        zap.zapIn{value: 2e18}(_z(hype), true, 1e18, 0, bob); // value does not match
        vm.stopPrank();
    }

    function test_OnlyPoolManagerCanCallBack() public {
        vm.expectRevert(VaultZapV2.NotPoolManager.selector);
        zap.unlockCallback("");
    }

    // ------------------------------------------------- native HYPE vault

    function test_ZapNativeHype() public {
        vm.prank(alice);
        hype.deposit{value: 100e18}(1, 0, 100e18, alice);
        uint256 hypeBefore = bob.balance;
        uint256 tokBefore = MockERC20(t0).balanceOf(bob);
        vm.prank(bob);
        (uint256 shares, uint256 r0, uint256 r1) = zap.zapIn{value: 10e18}(_z(hype), true, 10e18, 0, bob);
        assertGt(shares, 0);
        assertEq(hypeBefore - bob.balance, 10e18 - r0, "paid in HYPE, change came back as HYPE");
        assertEq(MockERC20(t0).balanceOf(bob) - tokBefore, r1, "token change came back");
        assertApproxEqRel(_value(hype, bob) + r0 + r1, 10e18, 0.005e18);
        _assertEmpty();
    }

    function test_ZapTokenIntoHypeVault() public {
        vm.prank(alice);
        hype.deposit{value: 100e18}(1, 0, 100e18, alice);
        uint256 hypeBefore = bob.balance;
        vm.prank(bob);
        (uint256 shares, uint256 r0, uint256 r1) = zap.zapIn(_z(hype), false, 10e18, 0, bob);
        assertGt(shares, 0);
        assertEq(bob.balance - hypeBefore, r0, "HYPE change arrives as native HYPE");
        assertApproxEqRel(_value(hype, bob) + r0 + r1, 10e18, 0.005e18);
        _assertEmpty();
    }
}
