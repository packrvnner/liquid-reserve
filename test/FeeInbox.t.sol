// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {FeeInbox} from "../src/FeeInbox.sol";

contract FeeInboxTest is Test {
    FeeInbox internal inbox;
    MockERC20 internal kntq;
    address internal deployer = makeAddr("deployer");
    address internal feeRouter = makeAddr("feeRouter");

    function setUp() public {
        inbox = new FeeInbox(deployer);
        kntq = new MockERC20("Kinetiq", "KNTQ", 18);
    }

    function test_FeesWaitUntilTargetSetThenForward() public {
        kntq.mint(address(inbox), 100e18);
        vm.expectRevert(FeeInbox.TargetNotSet.selector);
        inbox.forward(address(kntq));

        vm.prank(deployer);
        inbox.setTarget(feeRouter);
        inbox.forward(address(kntq)); // anyone can forward
        assertEq(kntq.balanceOf(feeRouter), 100e18);
    }

    function test_TargetCanBeSetOnlyOnce() public {
        vm.prank(deployer);
        inbox.setTarget(feeRouter);
        vm.prank(deployer);
        vm.expectRevert(FeeInbox.TargetAlreadySet.selector);
        inbox.setTarget(address(this));
    }

    function test_RevertWhen_OthersSetTarget() public {
        vm.expectRevert(FeeInbox.NotSetter.selector);
        inbox.setTarget(address(this));
    }
}
