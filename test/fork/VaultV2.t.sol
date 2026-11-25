// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {UniswapV4Swapper} from "../../src/adapters/UniswapV4Swapper.sol";
import {LiquidityVaultV2} from "../../src/vaults/LiquidityVaultV2.sol";
import {VaultZap, IZapVault} from "../../src/vaults/VaultZap.sol";

interface IWrapped3 {
    function deposit() external payable;
}

/// @notice The self-balancing vault (LiquidityVaultV2) on a copy of Elysium mainnet, on the real
/// HYPE-USDC pool, next to the other liquidity providers in it.
///
///   ELYSIUM_FORK=true forge test --match-contract VaultV2Fork -vv
contract VaultV2ForkTest is Test {
    using StateLibrary for IPoolManager;

    IPoolManager constant PM = IPoolManager(0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1);
    address constant WHYPE = 0xbA876237B0F021A6c6D852d6c26E107997cC5E81;
    address constant USDC = 0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65;
    address constant ZAP = 0x4161ec401b91653495CfE888714C51fE01988678;

    PoolKey key = PoolKey(Currency.wrap(address(0)), Currency.wrap(USDC), 3000, 60, IHooks(address(0)));
    LiquidityVaultV2 v;
    UniswapV4Swapper swapper;
    address keeper = makeAddr("keeper");
    address feeTo = makeAddr("fee recipient");

    function setUp() public {
        if (!vm.envOr("ELYSIUM_FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork("elysium");
        v = _vault(key);
        swapper = new UniswapV4Swapper(address(this), PM, WHYPE);
        UniswapV4Swapper.Hop[] memory hop = new UniswapV4Swapper.Hop[](1);
        hop[0] = UniswapV4Swapper.Hop(UniswapV4Swapper.HopKind.V4_SWAP, key, true, address(0));
        swapper.setRoute(WHYPE, USDC, hop);
        hop[0].zeroForOne = false;
        swapper.setRoute(USDC, WHYPE, hop);
        vm.deal(address(this), 1_000 ether);
    }

    receive() external payable {}

    function _vault(PoolKey memory k) internal returns (LiquidityVaultV2) {
        return new LiquidityVaultV2(
            LiquidityVaultV2.Params({
                key: k,
                poolManager: PM,
                feeRecipient: feeTo,
                whype: WHYPE,
                owner: address(this),
                keeper: keeper,
                name: "Liquid Reserve Vault HYPE-USDC v2",
                symbol: "lrvHYPE-USDC-2",
                mainWidth: 30,
                altWidth: 30,
                depositCap: 0
            })
        );
    }

    function _inMain(LiquidityVaultV2 x) internal view returns (bool) {
        (, int24 tick) = x.price();
        (int24 lo, int24 hi, uint128 l) = x.main();
        return l > 0 && tick >= lo && tick < hi;
    }

    /// Share of the vault's value sitting in its main range.
    function _mainShare(LiquidityVaultV2 x) internal view returns (uint256 bps) {
        (uint160 p, int24 tick) = x.price();
        (int24 lo, int24 hi, uint128 l) = x.main();
        if (l == 0 || tick < lo || tick >= hi) return 0;
        (uint256 t0, uint256 t1) = x.balances();
        uint256 total = t1 + _q(t0, p);
        (uint256 m0, uint256 m1) = _amounts(p, lo, hi, l);
        return (m1 + _q(m0, p)) * 10_000 / total;
    }

    function _q(uint256 a0, uint160 p) internal pure returns (uint256) {
        return a0 * (uint256(p) * uint256(p) >> 96) >> 96;
    }

    function _amounts(uint160 p, int24 lo, int24 hi, uint128 l) internal pure returns (uint256 a0, uint256 a1) {
        uint256 sa = uint256(_sqrt(lo));
        uint256 sb = uint256(_sqrt(hi));
        uint256 s = uint256(p);
        a0 = uint256(l) * (sb - s) / sb * (1 << 96) / s;
        a1 = uint256(l) * (s - sa) >> 96;
    }

    function _sqrt(int24 t) internal pure returns (uint160) {
        return TickMath.getSqrtPriceAtTick(t);
    }

    function test_V2_OneTokenFirstDepositBalancesItself() public {
        // exactly what went wrong with the first HYPE-USDC vault: a first deposit of HYPE only
        (uint256 used0, uint256 used1) = v.deposit{value: 0.1 ether}(1, 0.1 ether, 0, address(this));
        (uint256 t0, uint256 t1) = v.balances();
        console2.log("deposited HYPE (1e-4):", used0 / 1e14, "USDC:", used1);
        console2.log("vault now HYPE (1e-4):", t0 / 1e14, "USDC (1e-2):", t1 / 1e4);
        console2.log("share of the value in the main range (bps):", _mainShare(v));
        assertGt(t1, 0, "it swapped part of the HYPE into USDC by itself");
        assertTrue(_inMain(v), "the main range holds liquidity at the price");
        assertGt(_mainShare(v), 9_000, "nearly everything earns");
    }

    function test_V2_KeeperRebalanceAfterPriceRunSwapsAndRecentres() public {
        v.deposit{value: 0.1 ether}(1, 0.1 ether, 0, address(this));
        // the price runs: a large sale of HYPE pushes it out of the vault's main range
        IWrapped3(WHYPE).deposit{value: 600 ether}();
        IERC20(WHYPE).approve(address(swapper), type(uint256).max);
        uint256 sold;
        while (_inMain(v) && sold < 600 ether) {
            swapper.swap(WHYPE, USDC, 1 ether, 0, address(this));
            sold += 1 ether;
        }
        console2.log("HYPE sold to push the price out of range:", sold / 1e18);
        assertGt(PM.getLiquidity(v.poolId()), 0, "other liquidity still at the new price");
        assertFalse(_inMain(v), "out of range");
        (uint256 o0, uint256 o1) = v.balances();
        console2.log("after the run, HYPE (1e-4):", o0 / 1e14, "USDC (1e-2):", o1 / 1e4);

        (, int24 tick) = v.price();
        vm.warp(block.timestamp + 16 minutes);
        vm.prank(keeper);
        v.rebalance(tick, 20);
        console2.log("after the keeper's rebalance, main share (bps):", _mainShare(v));
        assertTrue(_inMain(v), "back in range");
        assertGt(_mainShare(v), 9_000, "and it swapped so nearly everything earns again");
        (, int24 tickNow) = v.price();
        assertLe(tick - tickNow < 0 ? tickNow - tick : tick - tickNow, 100, "its own swap moved the price at most 1%");
    }

    function test_V2_SwapIsCappedAtOnePercent() public {
        // far more HYPE than the pool can absorb within 1%: the rest goes to the alt range
        (, int24 before) = v.price();
        v.deposit{value: 300 ether}(1, 300 ether, 0, address(this));
        (, int24 afterTick) = v.price();
        int24 moved = before > afterTick ? before - afterTick : afterTick - before;
        console2.log("price moved by the vault's own swap (ticks):", uint256(uint24(moved)));
        assertLe(moved, 100, "never more than about 1%");
        (,, uint128 altL) = v.alt();
        assertGt(altL, 0, "the part it could not swap waits in the alt range");
    }

    function test_V2_OnlyKeeperAndOnlyAtTheStatedPrice() public {
        v.deposit{value: 0.1 ether}(1, 0.1 ether, 0, address(this));
        (, int24 tick) = v.price();
        vm.warp(block.timestamp + 16 minutes);
        vm.expectRevert(bytes4(keccak256("NotKeeper()")));
        v.rebalance(tick, 20);
        vm.prank(keeper);
        vm.expectRevert();
        v.rebalance(tick + 500, 20); // the price is not where the keeper said
    }

    function test_V2_NoOtherLiquidityNoSwap() public {
        // a fresh HYPE / USDC pool nobody else is in: nothing to trade with, so it does not swap
        PoolKey memory fresh = PoolKey(Currency.wrap(address(0)), Currency.wrap(USDC), 4321, 13, IHooks(address(0)));
        (uint160 p,) = v.price();
        PM.initialize(fresh, p);
        LiquidityVaultV2 lonely = _vault(fresh);
        (, int24 before) = lonely.price();
        lonely.deposit{value: 0.1 ether}(1, 0.1 ether, 0, address(this));
        (, int24 afterTick) = lonely.price();
        (uint256 t0, uint256 t1) = lonely.balances();
        assertEq(afterTick, before, "price untouched");
        assertEq(t1, 0, "no swap");
        assertGt(t0, 0);
    }

    function test_V2_ZapAndWithdraw() public {
        v.deposit{value: 0.1 ether}(1, 0.1 ether, 0, address(this));
        address carol = makeAddr("carol");
        vm.deal(carol, 1 ether);
        vm.prank(carol);
        (uint256 shares,,) = VaultZap(payable(ZAP)).zapIn{value: 0.2 ether}(IZapVault(address(v)), true, 0.2 ether, 1, carol);
        assertGt(shares, 0, "the existing zap works with the new vault");
        uint256 hypeBefore = carol.balance;
        vm.prank(carol);
        (uint256 out0, uint256 out1) = v.withdraw(shares, 0, 0, carol, true);
        assertGt(out0, 0);
        assertGt(out1, 0);
        assertEq(carol.balance - hypeBefore, out0, "paid in plain HYPE");
    }
}

