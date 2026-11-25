// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {LiquidityVault} from "../../src/vaults/LiquidityVault.sol";
import {LiquidVaultLaunch2} from "../../src/launch/LiquidVaultLaunch2.sol";

/// @notice The 0.5% HYPE / $liquid vault on a copy of Elysium mainnet, with the real coin and
/// the trading apps' real router.
///
///   ELYSIUM_FORK=true forge test --match-contract LiquidVault2Fork -vv
contract LiquidVault2ForkTest is Test {
    using StateLibrary for IPoolManager;

    IPoolManager constant PM = IPoolManager(0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1);
    address constant WHYPE = 0xbA876237B0F021A6c6D852d6c26E107997cC5E81;
    address constant LIQUID = 0x247c91C14b5Aa1cF57f02d638B0287F5cd69E9f6;
    bytes32 constant ASCEND_POOL = 0xe522ea941342149346fa6641ad358ac49d8bf10abec2bba9106ac6bcc42b210c;
    address constant FEE_INBOX = 0x2AfD3850794b84205667CE2826b09FA5bf1c3a5c;
    address constant OWNER = 0x822aA88543b9da39c4c3D856857379E17526C1E8;
    address constant BOT = 0x0461663d46DA68264966a0670335E3ecf0b96F3C;
    /// The router the busiest trading app on Elysium sends its buys through, and Uniswap's router it uses.
    address constant APP_ROUTER = 0xCCf663EFbe8a58E60A4855F0B44d5a48D1ed29af;
    address constant UNIVERSAL_ROUTER = 0x1B341FDD55d56F8E08409A2C25DDFad93Eb03C1a;
    /// The real 0.5% pool was created in Elysium block 6,931,278 (2026-11-16 02:04 UTC) and holds the live vault's
    /// liquidity since. The two tests that need the pool not to exist yet (the launch at Ascend's price, and
    /// lining up an empty pool again) run on the chain as it stood one block earlier.
    uint256 constant BEFORE_THE_REAL_POOL = 6_931_277;

    LiquidVaultLaunch2 launch;
    LiquidityVault v;

    function setUp() public {
        if (!vm.envOr("ELYSIUM_FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork("elysium");
        _launch();
    }

    /// The same launch again, on the chain as it stood just before the real pool was created.
    function _launchBeforeTheRealPool() internal {
        vm.createSelectFork("elysium", BEFORE_THE_REAL_POOL);
        _launch();
    }

    function _launch() internal {
        launch = new LiquidVaultLaunch2(
            LiquidVaultLaunch2.Config(
                PM, WHYPE, LIQUID, ASCEND_POOL, 5_000, 100, 60, FEE_INBOX, OWNER, BOT, 300_000_000e18,
                "Liquid Reserve Vault HYPE-liquid 0.5%", "lrvHYPE-LIQUID-05"
            )
        );
        v = launch.vault();
        vm.prank(OWNER);
        IERC20(LIQUID).transfer(address(this), 6_000_000e18);
        IERC20(LIQUID).approve(address(v), type(uint256).max);
        vm.deal(address(this), 10 ether);
    }

    receive() external payable {}

    function _liquidPerHype(uint160 sqrtP) internal pure returns (uint256) {
        return (uint256(sqrtP) * 1e9 >> 96) ** 2;
    }

    function _firstDeposit(uint256 liq) internal {
        (uint160 p,) = v.price();
        v.deposit{value: liq * 1e18 / _liquidPerHype(p)}(1, 0, liq, address(this));
    }

    function test_Vault2_LaunchedAtAscendsPrice() public {
        _launchBeforeTheRealPool();
        (uint160 ascend,,,) = PM.getSlot0(PoolId.wrap(ASCEND_POOL));
        (uint160 mine,,, uint24 lpFee) = PM.getSlot0(launch.poolId());
        assertApproxEqRel(_liquidPerHype(mine), 1e36 / ((uint256(ascend) * 1e9 >> 96) ** 2), 0.001e18);
        assertTrue(launch.createdPool());
        assertEq(lpFee, 5_000, "0.5% fee");
        assertEq(launch.tickSpacing(), 100);
        assertEq(address(v.token1()), LIQUID);
        assertEq(v.owner(), OWNER);
        assertEq(v.keeper(), BOT);
        assertEq(v.feeRecipient(), FEE_INBOX);
    }

    /// The point of this vault: a buy sent through the trading apps' own router, with the pool
    /// settings that router is always given (0.5% fee, spacing 100, no hook), is filled from it.
    function test_Vault2_AppRouterBuysThroughIt() public {
        _firstDeposit(4_000_000e18);
        address buyer = makeAddr("app user");
        vm.deal(buyer, 1 ether);
        uint256 pay = 0.01 ether;
        bool ok;
        // same layout as that router's real trades: (universal router, pool manager, token, amount, amount, recipient, deadline, fee, spacing, hooks)
        uint256[2][4] memory tries = [[uint256(0), 0], [uint256(0), 1], [uint256(1), 0], [uint256(1), 1]];
        for (uint256 i; i < tries.length && !ok; ++i) {
            vm.prank(buyer);
            (ok,) = APP_ROUTER.call{value: pay}(
                abi.encodeWithSelector(
                    bytes4(0xc1120e3d), UNIVERSAL_ROUTER, address(PM), LIQUID, tries[i][0], tries[i][1], buyer,
                    block.timestamp + 600, uint24(5_000), int24(100), address(0)
                )
            );
        }
        uint256 got = IERC20(LIQUID).balanceOf(buyer);
        console2.log("app router call went through:", ok);
        console2.log("$liquid the app user received for 0.01 HYPE:", got / 1e18);
        assertTrue(ok, "the apps' router must accept a $liquid buy through this pool");
        assertGt(got, 150_000e18, "filled from the vault's pool at about the market price");
    }

    function test_Vault2_DepositCompoundWithdraw() public {
        _firstDeposit(4_000_000e18);
        uint256 shares = v.balanceOf(address(this));
        assertGt(shares, 0);
        vm.prank(makeAddr("anyone"));
        v.harvest();
        (uint256 out0, uint256 out1) = v.withdraw(shares, 0, 0, address(this), true);
        assertGt(out0, 0);
        assertGt(out1, 3_990_000e18);
    }

    /// An empty pool whose price went stale can be lined up with Ascend's again, by anyone, for free.
    function test_Vault2_EmptyPoolCanBeRealigned() public {
        _launchBeforeTheRealPool();
        bytes32 slot = keccak256(abi.encode(PoolId.unwrap(launch.poolId()), uint256(6)));
        uint256 packed = uint256(vm.load(address(PM), slot));
        uint256 stale = (packed & type(uint160).max) * 105 / 100; // price about 10% off
        vm.store(address(PM), slot, bytes32((packed >> 160 << 160) | stale));
        (uint160 ascend,,,) = PM.getSlot0(PoolId.wrap(ASCEND_POOL));
        uint256 market = 1e36 / ((uint256(ascend) * 1e9 >> 96) ** 2);
        uint256 pmHype = address(PM).balance;
        uint256 pmLiquid = IERC20(LIQUID).balanceOf(address(PM));
        vm.prank(makeAddr("anyone"));
        launch.realign();
        (uint160 back,,,) = PM.getSlot0(launch.poolId());
        assertApproxEqRel(_liquidPerHype(back), market, 0.001e18, "back at Ascend's price");
        assertEq(address(PM).balance, pmHype, "no HYPE moved");
        assertEq(IERC20(LIQUID).balanceOf(address(PM)), pmLiquid, "no $liquid moved");

        _firstDeposit(1_000_000e18);
        vm.expectRevert(LiquidVaultLaunch2.PoolHasLiquidity.selector);
        launch.realign();
        vm.expectRevert(LiquidVaultLaunch2.NotPoolManager.selector);
        launch.unlockCallback("");
    }
}

/// @notice Against the LIVE 0.5% vault (opened by the owner on 2026-11-16): what a buyer actually
/// receives through the trading apps' router, for each pool setting.
///
///   ELYSIUM_FORK=true forge test --match-contract LiquidVault2Live -vv
contract LiquidVault2LiveTest is Test {
    address constant PM = 0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1;
    address constant LIQUID = 0x247c91C14b5Aa1cF57f02d638B0287F5cd69E9f6;
    address constant APP_ROUTER = 0xCCf663EFbe8a58E60A4855F0B44d5a48D1ed29af;
    address constant UNIVERSAL_ROUTER = 0x1B341FDD55d56F8E08409A2C25DDFad93Eb03C1a;
    LiquidVaultLaunch2 constant LIVE = LiquidVaultLaunch2(0xE699e8bea731851CdC7c012611512022B2313012);

    function setUp() public {
        if (!vm.envOr("ELYSIUM_FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork("elysium");
    }

    function _call(address buyer, uint256 x, uint256 y, uint24 fee, int24 spacing, uint256 pay) internal returns (bool ok) {
        bytes memory data = abi.encodeWithSelector(
            bytes4(0xc1120e3d), UNIVERSAL_ROUTER, PM, LIQUID, x, y, buyer, block.timestamp + 600, fee, spacing, address(0)
        );
        vm.prank(buyer);
        (ok,) = APP_ROUTER.call{value: pay}(data);
    }

    function _buy(uint24 fee, int24 spacing, uint256 pay) internal returns (bool ok, uint256 got) {
        address buyer = makeAddr(string(abi.encodePacked("buyer", vm.toString(fee), vm.toString(pay))));
        vm.deal(buyer, 1 ether);
        for (uint256 i; i < 4 && got == 0; ++i) {
            ok = _call(buyer, i / 2, i % 2, fee, spacing, pay);
            got = IERC20(LIQUID).balanceOf(buyer);
        }
    }

    function test_Live_AppBuys() public {
        assertEq(address(LIVE.vault()), 0x9BDCa4A12cdbc1D74B01F1b870d12166C8A0c9e2);
        (bool ok5, uint256 got5) = _buy(5_000, 100, 0.01 ether);
        (bool ok2, uint256 got2) = _buy(20_000, 200, 0.01 ether);
        (bool okBig, uint256 gotBig) = _buy(5_000, 100, 0.05 ether);
        console2.log("0.01 HYPE, 0.5% pool settings: call ok", ok5, "| $liquid received:", got5 / 1e18);
        console2.log("0.01 HYPE, 2% pool settings:   call ok", ok2, "| $liquid received:", got2 / 1e18);
        console2.log("0.05 HYPE, 0.5% pool settings: call ok", okBig, "| $liquid received:", gotBig / 1e18);
        assertGt(got5, 0, "a small app buy is filled from the 0.5% vault's pool");
    }
}
