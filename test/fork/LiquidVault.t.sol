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
import {UniswapV4Swapper} from "../../src/adapters/UniswapV4Swapper.sol";
import {LiquidityVault} from "../../src/vaults/LiquidityVault.sol";
import {LiquidVaultLaunch} from "../../src/launch/LiquidVaultLaunch.sol";

interface IWrappedHype2 {
    function deposit() external payable;
}

/// @notice The HYPE / $liquid vault on a copy of Elysium mainnet, with the real coin.
///
///   ELYSIUM_FORK=true forge test --match-contract LiquidVaultFork -vv
contract LiquidVaultForkTest is Test {
    using StateLibrary for IPoolManager;

    IPoolManager constant PM = IPoolManager(0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1);
    address constant WHYPE = 0xbA876237B0F021A6c6D852d6c26E107997cC5E81;
    address constant LIQUID = 0x247c91C14b5Aa1cF57f02d638B0287F5cd69E9f6;
    bytes32 constant ASCEND_POOL = 0xe522ea941342149346fa6641ad358ac49d8bf10abec2bba9106ac6bcc42b210c;
    address constant FEE_INBOX = 0x2AfD3850794b84205667CE2826b09FA5bf1c3a5c;
    address constant OWNER = 0x822aA88543b9da39c4c3D856857379E17526C1E8;
    address constant BOT = 0x0461663d46DA68264966a0670335E3ecf0b96F3C;

    LiquidVaultLaunch launch;
    LiquidityVault v;
    UniswapV4Swapper swapper;

    function setUp() public {
        if (!vm.envOr("ELYSIUM_FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork("elysium");
        // The vault is live on mainnet since 2026-11-16: the tests run against that deployment.
        launch = LiquidVaultLaunch(0xDe414f53f762cDAc89276dBD1151f810DA9C79C2);
        v = launch.vault();
        // the owner's real $liquid, moved to this test contract
        vm.prank(OWNER);
        IERC20(LIQUID).transfer(address(this), 6_000_000e18);

        swapper = new UniswapV4Swapper(address(this), PM, WHYPE);
        PoolKey memory key = PoolKey(Currency.wrap(address(0)), Currency.wrap(LIQUID), 20_000, 200, IHooks(address(0)));
        UniswapV4Swapper.Hop[] memory hop = new UniswapV4Swapper.Hop[](1);
        hop[0] = UniswapV4Swapper.Hop(UniswapV4Swapper.HopKind.V4_SWAP, key, true, address(0));
        swapper.setRoute(WHYPE, LIQUID, hop);
        hop[0].zeroForOne = false;
        swapper.setRoute(LIQUID, WHYPE, hop);
    }

    receive() external payable {}

    /// $liquid per HYPE, 1e18-scaled, from a sqrtPriceX96 where HYPE is currency0.
    function _liquidPerHype(uint160 sqrtP) internal pure returns (uint256) {
        return (uint256(sqrtP) * 1e9 >> 96) ** 2;
    }

    function test_LiquidVault_LaunchedAtAscendsPrice() public view {
        (uint160 ascend,,,) = PM.getSlot0(PoolId.wrap(ASCEND_POOL));
        (uint160 mine,,, uint24 lpFee) = PM.getSlot0(launch.poolId());
        // Ascend quotes HYPE per $liquid; the vault's pool quotes $liquid per HYPE.
        uint256 ascendLiquidPerHype = 1e36 / ((uint256(ascend) * 1e9 >> 96) ** 2);
        console2.log("Ascend pool, $liquid per HYPE:", ascendLiquidPerHype / 1e18);
        console2.log("vault pool,  $liquid per HYPE:", _liquidPerHype(mine) / 1e18);
        assertApproxEqRel(_liquidPerHype(launch.startSqrtPriceX96()), _liquidPerHype(mine), 0.5e18, "opened near today's price");
        assertApproxEqRel(_liquidPerHype(mine), ascendLiquidPerHype, 0.1e18, "within the two pools' fee band of Ascend's price");
        assertTrue(launch.createdPool());
        assertEq(lpFee, 20_000, "2% fee");
        assertEq(address(v.token0()), WHYPE);
        assertEq(address(v.token1()), LIQUID);
        assertEq(v.owner(), OWNER);
        assertEq(v.keeper(), BOT);
        assertEq(v.feeRecipient(), FEE_INBOX);
        assertGt(v.depositCap(), 0);
    }

    function test_LiquidVault_DepositTradeCompoundWithdraw() public {
        (uint160 p,) = v.price();
        uint256 liq = 4_000_000e18;
        uint256 hype = liq * 1e18 / _liquidPerHype(p); // the same value of HYPE
        console2.log("first deposit: HYPE (1e-4):", hype / 1e14, "and $liquid:", liq / 1e18);
        vm.deal(address(this), 5 ether);
        IERC20(LIQUID).approve(address(v), type(uint256).max);
        v.deposit{value: hype}(1, 0, liq, address(this));
        uint256 shares = v.balanceOf(address(this));
        (uint256 a0, uint256 a1) = v.positionAmounts();
        console2.log("in the pool: HYPE (1e-4):", a0 / 1e14, "$liquid:", a1 / 1e18);
        assertGt(shares, 0);
        assertGt(a0, 0);
        assertGt(a1, 0);

        // traders use the vault's pool both ways: 2% fees accrue
        for (uint256 i; i < 6; ++i) {
            IWrappedHype2(WHYPE).deposit{value: 0.004 ether}();
            IERC20(WHYPE).approve(address(swapper), 0.004 ether);
            uint256 got = swapper.swap(WHYPE, LIQUID, 0.004 ether, 0, address(this));
            IERC20(LIQUID).approve(address(swapper), got);
            swapper.swap(LIQUID, WHYPE, got, 0, address(this));
        }
        (uint256 f0, uint256 f1) = v.pendingFees();
        console2.log("fees waiting: HYPE (1e-6):", f0 / 1e12, "$liquid:", f1 / 1e18);
        assertGt(f0 + f1, 0, "fees waiting");

        uint256 inboxHype = IERC20(WHYPE).balanceOf(FEE_INBOX);
        uint256 inboxLiquid = IERC20(LIQUID).balanceOf(FEE_INBOX);
        vm.prank(makeAddr("anyone"));
        v.harvest();
        console2.log("protocol's 20%: HYPE (1e-6):", (IERC20(WHYPE).balanceOf(FEE_INBOX) - inboxHype) / 1e12);
        console2.log("protocol's 20%: $liquid:", (IERC20(LIQUID).balanceOf(FEE_INBOX) - inboxLiquid) / 1e18);
        assertGt(
            (IERC20(WHYPE).balanceOf(FEE_INBOX) - inboxHype) + (IERC20(LIQUID).balanceOf(FEE_INBOX) - inboxLiquid), 0
        );

        // the bot can re-centre the range; the depositor can always leave
        (, int24 tick) = v.price();
        vm.warp(block.timestamp + 16 minutes);
        vm.prank(BOT);
        v.rebalance(tick, 10);
        uint256 hypeBefore = address(this).balance;
        uint256 liquidBefore = IERC20(LIQUID).balanceOf(address(this));
        (uint256 out0, uint256 out1) = v.withdraw(shares, 0, 0, address(this), true);
        console2.log("withdrew: HYPE (1e-4):", out0 / 1e14, "$liquid:", out1 / 1e18);
        assertEq(address(this).balance - hypeBefore, out0, "paid in plain HYPE");
        assertEq(IERC20(LIQUID).balanceOf(address(this)) - liquidBefore, out1);
        assertEq(v.balanceOf(address(this)), 0);
    }

    function test_LiquidVault_CapHolds() public {
        (uint160 p,) = v.price();
        vm.prank(OWNER);
        v.setDepositCap(1_000_000e18);
        uint256 liq = 2_000_000e18;
        vm.deal(address(this), 5 ether);
        IERC20(LIQUID).approve(address(v), type(uint256).max);
        vm.expectPartialRevert(LiquidityVault.CapExceeded.selector);
        v.deposit{value: liq * 1e18 / _liquidPerHype(p)}(1, 0, liq, address(this));
    }
}
