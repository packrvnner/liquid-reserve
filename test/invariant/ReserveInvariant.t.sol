// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockRateToken} from "../mocks/MockRateToken.sol";
import {LockedReserve} from "../../src/LockedReserve.sol";
import {IRateProvider} from "../../src/interfaces/IRateProvider.sol";

/// @notice Random sequences of deposits, donations, rate growth, time jumps,
/// harvests and sweeps against the reserve.
contract ReserveHandler is Test {
    LockedReserve public immutable reserve;
    address public immutable router;
    address[3] public assets;

    mapping(address asset => uint256) public ghostPrincipal; // sum of recorded deposits
    mapping(address asset => uint256) public ghostSharesIn; // deposited + donated

    constructor(LockedReserve reserve_, address router_, address[3] memory assets_) {
        reserve = reserve_;
        router = router_;
        assets = assets_;
    }

    function deposit(uint256 idx, uint256 amount) external {
        address asset = assets[idx % 3];
        amount = bound(amount, 1, 1e27);
        MockERC20(asset).mint(address(this), amount);
        MockERC20(asset).approve(address(reserve), amount);
        ghostPrincipal[asset] += reserve.deposit(asset, amount);
        ghostSharesIn[asset] += amount;
    }

    function donate(uint256 idx, uint256 amount) external {
        address asset = assets[idx % 3];
        amount = bound(amount, 1, 1e24);
        MockERC20(asset).mint(address(reserve), amount);
        ghostSharesIn[asset] += amount;
    }

    function growRate(uint256 idx, uint256 bps) external {
        MockRateToken t = MockRateToken(assets[idx % 2]); // kHYPE or sKNTQ
        bps = bound(bps, 0, 500);
        t.setRate(t.rate() * (10_000 + bps) / 10_000);
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 30 days));
    }

    function harvest(uint256 idx) external {
        reserve.harvest(assets[idx % 3]);
    }

    function harvestAll() external {
        reserve.harvestAll();
    }
}

contract ReserveInvariantTest is Test {
    LockedReserve internal reserve;
    ReserveHandler internal handler;
    address internal router = makeAddr("yieldRouter");
    address[3] internal assets;

    function setUp() public {
        MockRateToken khype = new MockRateToken("kHYPE", "kHYPE");
        MockRateToken skntq = new MockRateToken("sKNTQ", "sKNTQ");
        MockERC20 lr = new MockERC20("LR", "LR", 18);
        assets = [address(khype), address(skntq), address(lr)];
        reserve = new LockedReserve(
            assets, [IRateProvider(address(khype)), IRateProvider(address(skntq)), IRateProvider(address(0))], router
        );
        handler = new ReserveHandler(reserve, router, assets);
        targetContract(address(handler));
    }

    /// Principal only changes through deposits, by exactly what they recorded.
    function invariant_PrincipalOnlyFromDeposits() public view {
        for (uint256 i; i < 3; ++i) {
            assertEq(reserve.principal(assets[i]), handler.ghostPrincipal(assets[i]));
        }
    }

    /// Holdings always cover principal.
    function invariant_ValueCoversPrincipal() public view {
        for (uint256 i; i < 3; ++i) {
            assertGe(reserve.valueOf(assets[i]), reserve.principal(assets[i]));
        }
    }

    /// Nothing leaves the reserve except to the yield router.
    function invariant_OnlyOutflowIsYieldRouter() public view {
        for (uint256 i; i < 3; ++i) {
            uint256 held = MockERC20(assets[i]).balanceOf(address(reserve));
            uint256 sent = MockERC20(assets[i]).balanceOf(router);
            assertEq(held + sent, handler.ghostSharesIn(assets[i]));
        }
    }
}
