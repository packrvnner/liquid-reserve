// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {WETH} from "solmate/src/tokens/WETH.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {LiquidityVault} from "../../src/vaults/LiquidityVault.sol";
import {VaultZap, IZapVault} from "../../src/vaults/VaultZap.sol";

contract VaultZapTest is Deployers {
    WETH internal whype;
    LiquidityVault internal vault; // token/token pool
    LiquidityVault internal hypeVault; // native HYPE/token pool
    VaultZap internal zap;
    PoolKey internal keyAB;
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
        (keyAB,) = initPool(currency0, currency1, IHooks(address(0)), 3000, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(keyAB, deep, ZERO_BYTES);
        vm.deal(address(this), 1e27);
        (keyNA,) = initPool(CurrencyLibrary.ADDRESS_ZERO, currency0, IHooks(address(0)), 3000, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity{value: 5e23}(keyNA, deep, ZERO_BYTES);

        whype = new WETH();
        vault = _vault(keyAB);
        hypeVault = _vault(keyNA);
        zap = new VaultZap(manager);
        address[2] memory users = [alice, bob];
        for (uint256 i; i < 2; ++i) {
            MockERC20(t0).mint(users[i], 1e24);
            MockERC20(t1).mint(users[i], 1e24);
            vm.deal(users[i], 1e24);
            vm.startPrank(users[i]);
            for (uint256 k; k < 3; ++k) {
                address spender = [address(vault), address(hypeVault), address(zap)][k];
                MockERC20(t0).approve(spender, type(uint256).max);
                MockERC20(t1).approve(spender, type(uint256).max);
            }
            vm.stopPrank();
        }
    }

    function _vault(PoolKey memory key) internal returns (LiquidityVault) {
        return new LiquidityVault(
            LiquidityVault.Params({
                key: key,
                poolManager: manager,
                feeRecipient: makeAddr("fees"),
                whype: address(whype),
                owner: address(this),
                keeper: address(this),
                name: "Liquid Reserve Vault",
                symbol: "lrvTEST",
                mainWidth: 10,
                altWidth: 10,
                depositCap: 0
            })
        );
    }

    function _shareValue(LiquidityVault v, address who) internal view returns (uint256) {
        return v.totalValue() * v.balanceOf(who) / v.totalSupply();
    }

    /// Liquidity behind each share. A deposit must never lower it. (Value in one token is no
    /// good for this: the zap's own swap nudges the pool price, which moves that number.)
    function _liquidityPerShare(LiquidityVault v) internal view returns (uint256) {
        (,, uint128 m) = v.main();
        (,, uint128 a) = v.alt();
        return (uint256(m) + a) * 1e18 / v.totalSupply();
    }

    function _assertEmpty() internal view {
        assertEq(MockERC20(t0).balanceOf(address(zap)), 0, "zap keeps no token0");
        assertEq(MockERC20(t1).balanceOf(address(zap)), 0, "zap keeps no token1");
        assertEq(address(zap).balance, 0, "zap keeps no HYPE");
        assertEq(vault.balanceOf(address(zap)) + hypeVault.balanceOf(address(zap)), 0, "zap keeps no shares");
    }

    // ------------------------------------------------------------- token/token vault

    function test_ZapOneTokenIntoBalancedVault() public {
        vm.prank(alice);
        vault.deposit(1, 100e18, 100e18, alice);
        uint256 perShare = _liquidityPerShare(vault);

        uint256 t0Before = MockERC20(t0).balanceOf(bob);
        vm.prank(bob);
        (uint256 shares, uint256 r0, uint256 r1) = zap.zapIn(IZapVault(address(vault)), true, 10e18, 0, bob);

        assertEq(vault.balanceOf(bob), shares);
        assertEq(t0Before - MockERC20(t0).balanceOf(bob), 10e18 - r0, "paid in token0 only");
        // Bob put in 10 of value. He holds shares plus a little change, less the swap fee on about half.
        assertApproxEqRel(_shareValue(vault, bob) + r0 + r1, 10e18, 0.005e18, "got about what he paid for");
        assertLt(r0 + r1, 0.1e18, "almost all of it went in");
        assertGe(_liquidityPerShare(vault) + DUST, perShare, "existing holder not diluted");
        _assertEmpty();
    }

    function test_ZapTheOtherToken() public {
        vm.prank(alice);
        vault.deposit(1, 100e18, 100e18, alice);
        vm.prank(bob);
        (uint256 shares, uint256 r0, uint256 r1) = zap.zapIn(IZapVault(address(vault)), false, 10e18, 0, bob);
        assertGt(shares, 0);
        assertApproxEqRel(_shareValue(vault, bob) + r0 + r1, 10e18, 0.005e18);
        _assertEmpty();
    }

    function test_ZapIntoEmptyVaultOpensABalancedRange() public {
        vm.prank(bob);
        (uint256 shares,,) = zap.zapIn(IZapVault(address(vault)), true, 10e18, 0, bob);
        assertGt(shares, 0);
        (,, uint128 mainLiquidity) = vault.main();
        assertGt(mainLiquidity, 0, "main range has liquidity");
        (uint256 total0, uint256 total1) = vault.balances();
        assertApproxEqRel(total0, total1, 0.02e18, "about half and half");
        _assertEmpty();
    }

    function test_ZapIntoOneSidedVaultSwapsEverythingNeeded() public {
        vm.prank(alice);
        vault.deposit(1, 100e18, 0, alice); // vault holds token0 only
        vm.prank(bob);
        (uint256 shares, uint256 r0, uint256 r1) = zap.zapIn(IZapVault(address(vault)), false, 10e18, 0, bob); // pays in token1
        assertGt(shares, 0);
        assertApproxEqRel(_shareValue(vault, bob) + r0 + r1, 10e18, 0.01e18);
        _assertEmpty();
    }

    function test_RevertWhen_FewerSharesThanMinimum() public {
        vm.prank(alice);
        vault.deposit(1, 100e18, 100e18, alice);
        vm.prank(bob);
        vm.expectPartialRevert(VaultZap.Slippage.selector);
        zap.zapIn(IZapVault(address(vault)), true, 10e18, 11e18, bob);
    }

    function test_RevertWhen_PoolWasPushedBeforeTheZap() public {
        vm.prank(alice);
        vault.deposit(1, 100e18, 100e18, alice);
        // What Bob expects at the honest price...
        uint256 snap = vm.snapshotState();
        vm.prank(bob);
        (uint256 expected,,) = zap.zapIn(IZapVault(address(vault)), true, 10e18, 0, bob);
        vm.revertToState(snap);
        // ...then someone pushes the price 10% before his transaction lands.
        swap(keyAB, true, -int256(50_000e18), ZERO_BYTES);
        vm.prank(bob);
        vm.expectPartialRevert(VaultZap.Slippage.selector);
        zap.zapIn(IZapVault(address(vault)), true, 10e18, expected * 99 / 100, bob);
    }

    function test_RevertWhen_BadInputs() public {
        vm.startPrank(bob);
        vm.expectRevert(VaultZap.ZeroAmount.selector);
        zap.zapIn(IZapVault(address(vault)), true, 0, 0, bob);
        vm.expectRevert(VaultZap.ZeroAddress.selector);
        zap.zapIn(IZapVault(address(vault)), true, 1e18, 0, address(0));
        vm.expectRevert(VaultZap.WrongValue.selector);
        zap.zapIn{value: 1e18}(IZapVault(address(vault)), true, 1e18, 0, bob); // HYPE sent to a token pool
        vm.expectRevert(VaultZap.WrongValue.selector);
        zap.zapIn{value: 2e18}(IZapVault(address(hypeVault)), true, 1e18, 0, bob); // value does not match
        vm.stopPrank();
    }

    function test_OnlyPoolManagerCanCallBack() public {
        vm.expectRevert(VaultZap.NotPoolManager.selector);
        zap.unlockCallback("");
    }

    // ------------------------------------------------------------- native HYPE vault

    function test_ZapNativeHype() public {
        vm.prank(alice);
        hypeVault.deposit{value: 100e18}(1, 0, 100e18, alice);
        uint256 hypeBefore = bob.balance;
        uint256 tokBefore = MockERC20(t0).balanceOf(bob);
        vm.prank(bob);
        (uint256 shares, uint256 r0, uint256 r1) = zap.zapIn{value: 10e18}(IZapVault(address(hypeVault)), true, 10e18, 0, bob);
        assertGt(shares, 0);
        assertEq(hypeBefore - bob.balance, 10e18 - r0, "paid in HYPE, change came back as HYPE");
        assertEq(MockERC20(t0).balanceOf(bob) - tokBefore, r1, "token change came back");
        assertApproxEqRel(_shareValue(hypeVault, bob) + r0 + r1, 10e18, 0.005e18);
        _assertEmpty();
    }

    function test_ZapTokenIntoHypeVault() public {
        vm.prank(alice);
        hypeVault.deposit{value: 100e18}(1, 0, 100e18, alice);
        uint256 hypeBefore = bob.balance;
        vm.prank(bob);
        (uint256 shares, uint256 r0, uint256 r1) = zap.zapIn(IZapVault(address(hypeVault)), false, 10e18, 0, bob);
        assertGt(shares, 0);
        assertEq(bob.balance - hypeBefore, r0, "HYPE change came back as HYPE");
        assertApproxEqRel(_shareValue(hypeVault, bob) + r0 + r1, 10e18, 0.005e18);
        _assertEmpty();
    }

    // ------------------------------------------------------------- fuzz

    function testFuzz_ZapIsFairAndKeepsNothing(uint96 amount, bool token0In, uint96 push, bool down) public {
        amount = uint96(bound(amount, 1e15, 5_000e18));
        push = uint96(bound(push, 0, 30_000e18));
        vm.prank(alice);
        vault.deposit(1, 1_000e18, 1_000e18, alice);
        if (push > 1e18) swap(keyAB, down, -int256(uint256(push)), ZERO_BYTES); // the mix is no longer 50/50
        vault.harvest();
        uint256 perShare = _liquidityPerShare(vault);

        vm.prank(bob);
        (uint256 shares, uint256 r0, uint256 r1) = zap.zapIn(IZapVault(address(vault)), token0In, amount, 0, bob);
        assertGt(shares, 0);
        assertGe(_liquidityPerShare(vault) + DUST, perShare, "existing holders never diluted");
        assertLe(token0In ? r0 : r1, amount, "never refunds more than was paid");
        _assertEmpty();
    }
}
