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
import {LiquidityVaultV3} from "../../src/vaults/LiquidityVaultV3.sol";
import {LiquidityVaultV2} from "../../src/vaults/LiquidityVaultV2.sol";
import {VaultZap, IZapVault} from "../../src/vaults/VaultZap.sol";
import {UniswapV4Swapper} from "../../src/adapters/UniswapV4Swapper.sol";
import {FeeSplitter} from "../../src/FeeSplitter.sol";

interface IWrapped4 {
    function deposit() external payable;
}

/// @notice The $liquid vaults that swap in Ascend's pool (LiquidityVaultV3) and the self-balancing
/// HYPE-KNTQ vault (LiquidityVaultV2), on a copy of Elysium mainnet with the real pools.
///
///   ELYSIUM_FORK=true forge test --match-contract VaultV3Fork -vv
contract VaultV3ForkTest is Test {
    using StateLibrary for IPoolManager;

    IPoolManager constant PM = IPoolManager(0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1);
    address constant WHYPE = 0xbA876237B0F021A6c6D852d6c26E107997cC5E81;
    address constant LIQUID = 0x247c91C14b5Aa1cF57f02d638B0287F5cd69E9f6;
    address constant KNTQ = 0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0;
    address constant LAUNCHPAD = 0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC;
    address constant OWNER = 0x822aA88543b9da39c4c3D856857379E17526C1E8;
    address constant ZAP = 0x4161ec401b91653495CfE888714C51fE01988678;

    PoolKey ascend = PoolKey(Currency.wrap(LIQUID), Currency.wrap(WHYPE), 0x800000, 200, IHooks(LAUNCHPAD));
    address keeper = makeAddr("keeper");
    address feeTo = makeAddr("fee recipient");

    function setUp() public {
        if (!vm.envOr("ELYSIUM_FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork("elysium");
        vm.deal(address(this), 100 ether);
        deal(LIQUID, address(this), 8_000_000e18);
    }

    receive() external payable {}

    function _liquidVault(uint24 fee, int24 spacing, int24 width) internal returns (LiquidityVaultV3) {
        return new LiquidityVaultV3(
            LiquidityVaultV3.Params({
                key: PoolKey(Currency.wrap(address(0)), Currency.wrap(LIQUID), fee, spacing, IHooks(address(0))),
                poolManager: PM,
                feeRecipient: feeTo,
                whype: WHYPE,
                owner: OWNER,
                keeper: keeper,
                name: "Liquid Reserve Vault HYPE-liquid v3",
                symbol: "lrvHYPE-LIQUID-3",
                mainWidth: width,
                altWidth: width,
                depositCap: 0,
                swapKey: ascend,
                swapFee: 20_000
            })
        );
    }

    function test_V3_HypeOnlyFirstDepositSwapsInAscendsPool() public {
        LiquidityVaultV3 v = _liquidVault(20_000, 200, 30);
        (, int24 ascendBefore,,) = PM.getSlot0(PoolId.wrap(0xe522ea941342149346fa6641ad358ac49d8bf10abec2bba9106ac6bcc42b210c));
        (, int24 ownBefore) = v.price();
        v.deposit{value: 0.1 ether}(1, 0.1 ether, 0, address(this));
        (uint256 t0, uint256 t1) = v.balances();
        (, int24 ownAfter) = v.price();
        (, int24 ascendAfter,,) = PM.getSlot0(PoolId.wrap(0xe522ea941342149346fa6641ad358ac49d8bf10abec2bba9106ac6bcc42b210c));
        console2.log("vault now HYPE (1e-4):", t0 / 1e14, "$liquid:", t1 / 1e18);
        console2.log("Ascend tick moved by:", uint256(int256(ascendAfter > ascendBefore ? ascendAfter - ascendBefore : ascendBefore - ascendAfter)));
        assertGt(t1, 500_000e18, "bought about half its value in $liquid, in Ascend's pool");
        assertEq(ownAfter, ownBefore, "its own pool's price untouched");
        (int24 lo, int24 hi, uint128 l) = v.main();
        assertTrue(l > 0 && ownAfter >= lo && ownAfter < hi, "main range funded at the price");
        (,, uint128 altL) = v.alt();
        console2.log("main liquidity / alt liquidity:", l, altL);
    }

    function test_V3_LiquidOnlyFirstDepositSwapsTheOtherWay() public {
        LiquidityVaultV3 v = _liquidVault(5_000, 100, 60);
        IERC20(LIQUID).approve(address(v), type(uint256).max);
        v.deposit(1, 0, 4_000_000e18, address(this));
        (uint256 t0, uint256 t1) = v.balances();
        console2.log("vault now HYPE (1e-4):", t0 / 1e14, "$liquid:", t1 / 1e18);
        assertGt(t0, 0.05 ether, "sold about half its $liquid for HYPE");
        (int24 lo, int24 hi, uint128 l) = v.main();
        (, int24 tick) = v.price();
        assertTrue(l > 0 && tick >= lo && tick < hi);
    }

    function test_V3_KeeperRebalanceSwapsASurplus() public {
        LiquidityVaultV3 v = _liquidVault(20_000, 200, 30);
        v.deposit{value: 0.1 ether}(1, 0.1 ether, 0, address(this));
        // someone sends the vault a pile of $liquid: now it is mostly one token
        IERC20(LIQUID).transfer(address(v), 3_000_000e18);
        (uint256 b0, uint256 b1) = v.balances();
        console2.log("before: HYPE (1e-4):", b0 / 1e14, "$liquid:", b1 / 1e18);
        (, int24 tick) = v.price();
        vm.warp(block.timestamp + 16 minutes);
        vm.prank(keeper);
        v.rebalance(tick, 20);
        (uint256 a0, uint256 a1) = v.balances();
        console2.log("after:  HYPE (1e-4):", a0 / 1e14, "$liquid:", a1 / 1e18);
        assertGt(a0, b0 * 13 / 10, "it sold surplus $liquid for HYPE in Ascend's pool");
        (,, uint128 altL) = v.alt();
        (,, uint128 mainL) = v.main();
        assertGt(mainL, altL, "most of it is in the main range");
    }

    function test_V3_RefusesASwapPoolWithOtherTokens() public {
        vm.expectRevert(bytes4(keccak256("BadParams()")));
        new LiquidityVaultV3(
            LiquidityVaultV3.Params({
                key: PoolKey(Currency.wrap(address(0)), Currency.wrap(LIQUID), 20_000, 200, IHooks(address(0))),
                poolManager: PM,
                feeRecipient: feeTo,
                whype: WHYPE,
                owner: OWNER,
                keeper: keeper,
                name: "x",
                symbol: "x",
                mainWidth: 30,
                altWidth: 30,
                depositCap: 0,
                swapKey: PoolKey(Currency.wrap(address(0)), Currency.wrap(KNTQ), 3000, 60, IHooks(address(0))),
                swapFee: 3000
            })
        );
    }

    function test_V3_ZapAndWithdraw() public {
        LiquidityVaultV3 v = _liquidVault(5_000, 100, 60);
        v.deposit{value: 0.1 ether}(1, 0.1 ether, 0, address(this));
        uint256 shares = v.balanceOf(address(this));
        (uint256 o0, uint256 o1) = v.withdraw(shares, 0, 0, address(this), true);
        assertGt(o0, 0);
        assertGt(o1, 0);
    }

    function test_V2_KntqOneTokenFirstDepositBalancesItself() public {
        LiquidityVaultV2 v = new LiquidityVaultV2(
            LiquidityVaultV2.Params({
                key: PoolKey(Currency.wrap(address(0)), Currency.wrap(KNTQ), 3000, 60, IHooks(address(0))),
                poolManager: PM,
                feeRecipient: feeTo,
                whype: WHYPE,
                owner: OWNER,
                keeper: keeper,
                name: "Liquid Reserve Vault HYPE-KNTQ v2",
                symbol: "lrvHYPE-KNTQ-2",
                mainWidth: 30,
                altWidth: 30,
                depositCap: 0
            })
        );
        v.deposit{value: 0.1 ether}(1, 0.1 ether, 0, address(this));
        (uint256 t0, uint256 t1) = v.balances();
        (int24 lo, int24 hi, uint128 l) = v.main();
        (, int24 tick) = v.price();
        console2.log("HYPE-KNTQ v2 now HYPE (1e-4):", t0 / 1e14, "KNTQ (1e-2):", t1 / 1e16);
        assertGt(t1, 5e18, "bought KNTQ with about half");
        assertTrue(l > 0 && tick >= lo && tick < hi, "earning at the price");
        // and the existing zap works with it
        address carol = makeAddr("carol");
        vm.deal(carol, 1 ether);
        vm.prank(carol);
        (uint256 shares,,) = VaultZap(payable(ZAP)).zapIn{value: 0.2 ether}(IZapVault(address(v)), true, 0.2 ether, 1, carol);
        assertGt(shares, 0);
    }

    /// The vaults' fee cut goes to VaultFeeSplit: 20% to the creator wallet, 80% to the vault fee inbox.
    function test_V3_FeeCutSplitsTwentyPercentToTheCreator() public {
        address creator = 0x9324605c9C707b2F805CCF2AC099fCA5d561DC37;
        address inbox = 0x2AfD3850794b84205667CE2826b09FA5bf1c3a5c;
        FeeSplitter split = new FeeSplitter(creator, 2000, inbox);
        PoolKey memory own = PoolKey(Currency.wrap(address(0)), Currency.wrap(LIQUID), 20_000, 200, IHooks(address(0)));
        LiquidityVaultV3 v = new LiquidityVaultV3(
            LiquidityVaultV3.Params({
                key: own,
                poolManager: PM,
                feeRecipient: address(split),
                whype: WHYPE,
                owner: OWNER,
                keeper: keeper,
                name: "x",
                symbol: "x",
                mainWidth: 30,
                altWidth: 30,
                depositCap: 0,
                swapKey: ascend,
                swapFee: 20_000
            })
        );
        v.deposit{value: 0.1 ether}(1, 0.1 ether, 0, address(this));

        _tradeBothWays(own);

        v.harvest();
        uint256 w = IERC20(WHYPE).balanceOf(address(split));
        uint256 l = IERC20(LIQUID).balanceOf(address(split));
        console2.log("fee cut at the splitter, WHYPE (1e-8):", w / 1e10, "$liquid:", l / 1e18);
        assertGt(w, 0, "fee cut in HYPE reached the splitter");
        assertGt(l, 0, "fee cut in $liquid reached the splitter");

        _checkSplit(split, WHYPE, w);
        _checkSplit(split, LIQUID, l);
    }

    /// someone trades both ways in the vault's own pool, where it is the only liquidity
    function _tradeBothWays(PoolKey memory own) internal {
        UniswapV4Swapper sw = new UniswapV4Swapper(address(this), PM, WHYPE);
        UniswapV4Swapper.Hop[] memory hop = new UniswapV4Swapper.Hop[](1);
        hop[0] = UniswapV4Swapper.Hop(UniswapV4Swapper.HopKind.V4_SWAP, own, true, address(0));
        sw.setRoute(WHYPE, LIQUID, hop);
        hop[0] = UniswapV4Swapper.Hop(UniswapV4Swapper.HopKind.V4_SWAP, own, false, address(0));
        sw.setRoute(LIQUID, WHYPE, hop);
        IWrapped4(WHYPE).deposit{value: 1 ether}();
        IERC20(WHYPE).approve(address(sw), type(uint256).max);
        IERC20(LIQUID).approve(address(sw), type(uint256).max);
        uint256 got = sw.swap(WHYPE, LIQUID, 0.01 ether, 0, address(this));
        sw.swap(LIQUID, WHYPE, got, 0, address(this));
    }

    function _checkSplit(FeeSplitter split, address token, uint256 amount) internal {
        address creator = split.recipientA();
        address inbox = split.recipientB();
        uint256 c0 = IERC20(token).balanceOf(creator);
        uint256 i0 = IERC20(token).balanceOf(inbox);
        split.distribute(token);
        assertEq(IERC20(token).balanceOf(creator) - c0, amount * 2000 / 10_000, "20% to the creator");
        assertEq(IERC20(token).balanceOf(inbox) - i0, amount - amount * 2000 / 10_000, "80% to the fee inbox");
    }
}
