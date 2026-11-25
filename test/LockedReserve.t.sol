// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Fixture} from "./Fixture.sol";
import {LockedReserve} from "../src/LockedReserve.sol";
import {IRateProvider} from "../src/interfaces/IRateProvider.sol";

contract LockedReserveTest is Fixture {
    function test_DepositRecordsPrincipalInUnderlying() public {
        khype.setRate(1.1e18);
        uint256 underlying = _depositToReserve(address(khype), 100e18);
        assertEq(underlying, 110e18);
        assertEq(reserve.principal(address(khype)), 110e18);
        assertEq(khype.balanceOf(address(reserve)), 100e18);
    }

    function test_HarvestSendsOnlyYield() public {
        _depositToReserve(address(khype), 100e18);
        vm.warp(block.timestamp + 365 days);
        khype.setRate(1.05e18); // 5% in a year, under the 25% ceiling

        uint256 shares = reserve.harvest(address(khype));

        // 5 HYPE of yield at 1.05 HYPE per kHYPE
        assertApproxEqAbs(shares, uint256(5e18) * 1e18 / 1.05e18, 1);
        assertEq(khype.balanceOf(address(yieldRouter)), shares);
        assertEq(reserve.principal(address(khype)), 100e18, "principal unchanged");
        assertGe(reserve.valueOf(address(khype)), 100e18, "value still covers principal");
        assertEq(reserve.pendingYield(address(khype)), 0);
    }

    function test_HarvestNothingWithoutGrowth() public {
        _depositToReserve(address(khype), 100e18);
        vm.warp(block.timestamp + 30 days);
        assertEq(reserve.harvest(address(khype)), 0);
        assertEq(khype.balanceOf(address(yieldRouter)), 0);
    }

    function test_HarvestNothingAfterRateDrop() public {
        _depositToReserve(address(khype), 100e18);
        khype.setRate(0.9e18); // e.g. a slashing event
        assertEq(reserve.harvest(address(khype)), 0);
        assertEq(reserve.principal(address(khype)), 100e18);
    }

    function test_RateCeilingCapsSpike() public {
        _depositToReserve(address(khype), 100e18);
        vm.warp(block.timestamp + 1 days);
        khype.setRate(2e18); // faulty or compromised provider doubles the rate

        uint256 shares = reserve.harvest(address(khype));

        // At most 25%/yr for one day: 100 * 0.25 / 365 ≈ 0.0685 HYPE of "yield".
        assertGt(shares, 0);
        assertLt(shares, 0.0685e18);
        assertGt(khype.balanceOf(address(reserve)), 99.93e18, "principal protected");
    }

    function test_UnsolicitedLRCountsAsYield() public {
        _depositToReserve(address(lr), 1_000e18);
        lr.mint(address(reserve), 5e18); // e.g. holder rewards paid in LR
        assertEq(reserve.harvest(address(lr)), 5e18);
        assertEq(lr.balanceOf(address(yieldRouter)), 5e18);
        assertEq(lr.balanceOf(address(reserve)), 1_000e18);
    }

    function test_HarvestAll() public {
        _depositToReserve(address(khype), 100e18);
        _depositToReserve(address(skntq), 100e18);
        _depositToReserve(address(lr), 100e18);
        vm.warp(block.timestamp + 365 days);
        khype.setRate(1.02e18);
        skntq.setRate(1.10e18);
        lr.mint(address(reserve), 1e18);

        uint256[3] memory shares = reserve.harvestAll();

        assertGt(shares[0], 0);
        assertGt(shares[1], 0);
        assertEq(shares[2], 1e18);
    }

    function test_SweepSendsNonReserveTokensToRouter() public {
        kntq.mint(address(reserve), 7e18);
        assertEq(reserve.sweep(address(kntq)), 7e18);
        assertEq(kntq.balanceOf(address(yieldRouter)), 7e18);
    }

    function test_RevertWhen_SweepReserveAsset() public {
        _depositToReserve(address(khype), 100e18);
        vm.expectRevert(abi.encodeWithSelector(LockedReserve.IsReserveAsset.selector, address(khype)));
        reserve.sweep(address(khype));
    }

    function test_RevertWhen_DepositUnknownAsset() public {
        kntq.mint(address(this), 1e18);
        kntq.approve(address(reserve), 1e18);
        vm.expectRevert(abi.encodeWithSelector(LockedReserve.NotReserveAsset.selector, address(kntq)));
        reserve.deposit(address(kntq), 1e18);
    }

    function test_RevertWhen_DepositZero() public {
        vm.expectRevert(LockedReserve.ZeroAmount.selector);
        reserve.deposit(address(khype), 0);
    }

    function test_RevertWhen_RateProviderReturnsZero() public {
        khype.setRate(0);
        khype.mint(address(this), 1e18);
        khype.approve(address(reserve), 1e18);
        vm.expectRevert(abi.encodeWithSelector(LockedReserve.ZeroRate.selector, address(khype)));
        reserve.deposit(address(khype), 1e18);
    }

    function test_RevertWhen_ConstructedWithDuplicateAssets() public {
        vm.expectRevert(LockedReserve.DuplicateAsset.selector);
        new LockedReserve(
            [address(khype), address(khype), address(lr)],
            [IRateProvider(address(khype)), IRateProvider(address(khype)), IRateProvider(address(0))],
            address(yieldRouter)
        );
    }

    /// @notice There is no owner and no way to pull funds: common admin and
    /// withdraw selectors all fail.
    function test_HasNoAdminOrWithdrawFunctions() public {
        _depositToReserve(address(khype), 100e18);
        bytes[6] memory calls = [
            abi.encodeWithSignature("owner()"),
            abi.encodeWithSignature("transferOwnership(address)", address(this)),
            abi.encodeWithSignature("withdraw(address,uint256)", address(khype), 1),
            abi.encodeWithSignature("emergencyWithdraw(address)", address(khype)),
            abi.encodeWithSignature("upgradeToAndCall(address,bytes)", address(this), ""),
            abi.encodeWithSignature("rescueTokens(address,address,uint256)", address(khype), address(this), 1)
        ];
        for (uint256 i; i < calls.length; ++i) {
            (bool ok,) = address(reserve).call(calls[i]);
            assertFalse(ok);
        }
        assertEq(khype.balanceOf(address(reserve)), 100e18);
    }

    function testFuzz_HarvestNeverTouchesPrincipal(uint96 amount, uint16 growthBps, uint32 elapsed) public {
        amount = uint96(bound(amount, 1e6, type(uint96).max));
        growthBps = uint16(bound(growthBps, 0, 5_000));
        elapsed = uint32(bound(elapsed, 0, 3 * 365 days));

        uint256 underlying = _depositToReserve(address(khype), amount);
        vm.warp(block.timestamp + elapsed);
        khype.setRate(1e18 + uint256(growthBps) * 1e14);
        reserve.harvest(address(khype));

        assertEq(reserve.principal(address(khype)), underlying);
        assertGe(reserve.valueOf(address(khype)), reserve.principal(address(khype)));
    }
}
