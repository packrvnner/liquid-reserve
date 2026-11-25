// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IRateProvider} from "../../src/interfaces/IRateProvider.sol";
import {FeeSplitter} from "../../src/FeeSplitter.sol";
import {HypeStakingVault} from "../../src/staking/HypeStakingVault.sol";

/// A rate the test can set, to play staking yield forward.
contract SettableRate is IRateProvider {
    uint256 public rate;
    bool public broken;

    constructor(uint256 r) {
        rate = r;
    }

    function set(uint256 r) external {
        rate = r;
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function getRate() external view returns (uint256) {
        require(!broken, "rate unavailable");
        return rate;
    }
}

/// The HYPE staking vault against the real kHYPE / WHYPE pool on a fork of Elysium:
///   ELYSIUM_FORK=true forge test --match-contract HypeStakingVaultFork -vv
contract HypeStakingVaultForkTest is Test {
    IPoolManager constant PM = IPoolManager(0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1);
    address constant WHYPE = 0xbA876237B0F021A6c6D852d6c26E107997cC5E81;
    address constant KHYPE = 0x248888D396A546A69A188f3Deb476964e581E9d0;
    address constant KHYPE_POOL_HOOK = 0x8129bab872318a64B0e6212C6C491feED06C3de3;
    address constant KHYPE_RATE = 0xcd08e24b11f4bD4e2F609964692A7E78BC09e708; // the reserve's own provider
    address constant FEE_SPLIT = 0xB92c756347de468d7086a97EF112801b3371a408; // 20% creator, 80% vault fee inbox
    address constant CREATOR = 0x9324605c9C707b2F805CCF2AC099fCA5d561DC37;
    address constant FEE_INBOX = 0x2AfD3850794b84205667CE2826b09FA5bf1c3a5c;
    address constant OWNER = 0x822aA88543b9da39c4c3D856857379E17526C1E8;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    SettableRate rate;
    HypeStakingVault vault; // fee measured from the settable rate, so yield can be played forward
    IERC20 khype = IERC20(KHYPE);

    function setUp() public {
        if (!vm.envOr("ELYSIUM_FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork("elysium");
        rate = new SettableRate(IRateProvider(KHYPE_RATE).getRate());
        vault = _deploy(rate, type(uint256).max);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
    }

    function _deploy(IRateProvider r, uint256 cap) internal returns (HypeStakingVault) {
        return new HypeStakingVault(
            HypeStakingVault.Params({
                name: "Liquid Reserve Staked HYPE",
                symbol: "lqHYPE",
                owner: OWNER,
                poolManager: PM,
                whype: WHYPE,
                khype: khype,
                pool: PoolKey(Currency.wrap(KHYPE), Currency.wrap(WHYPE), 0x800000, 1, IHooks(KHYPE_POOL_HOOK)),
                rateProvider: r,
                feeRecipient: FEE_SPLIT,
                depositCap: cap
            })
        );
    }

    function _khypeTo(address who, uint256 amount) internal {
        deal(KHYPE, who, amount);
        vm.prank(who);
        khype.approve(address(vault), type(uint256).max);
    }

    // ------------------------------------------------------------------ HYPE in, HYPE out

    function test_StakeHypeAndUnstakeToHype() public {
        uint256 r = rate.rate();
        vm.prank(alice);
        uint256 shares = vault.depositHype{value: 10 ether}(0, alice);
        uint256 held = vault.totalAssets();
        // 10 HYPE buys about 10 / rate kHYPE, less the pool's fee and price impact
        assertApproxEqRel(held * r / 1e18, 10 ether, 0.01e18, "about 10 HYPE worth of kHYPE");
        assertEq(khype.balanceOf(address(vault)), held, "all of it is depositors' kHYPE");
        assertEq(vault.balanceOf(alice), shares);
        assertEq(shares + vault.DEAD_SHARES(), vault.totalSupply());
        assertEq(address(vault).balance, 0, "no HYPE left in the vault");
        assertEq(IERC20(WHYPE).balanceOf(address(vault)), 0, "no WHYPE left in the vault");

        uint256 before = alice.balance;
        vm.prank(alice);
        uint256 out = vault.redeemToHype(shares, 0, alice);
        assertEq(alice.balance - before, out);
        assertGt(out, 9.9 ether, "a round trip costs well under 1%");
        console2.log("10 HYPE staked and unstaked straight away returns (wei)", out);
        assertEq(vault.balanceOf(alice), 0);
        assertEq(address(vault).balance, 0);
    }

    function test_SlippageLimitsAreEnforced() public {
        vm.prank(alice);
        vm.expectRevert();
        vault.depositHype{value: 1 ether}(type(uint256).max, alice);
        vm.prank(alice);
        uint256 shares = vault.depositHype{value: 1 ether}(0, alice);
        vm.prank(alice);
        vm.expectRevert();
        vault.redeemToHype(shares, 2 ether, alice);
    }

    // ------------------------------------------------------------------ plain ERC-4626 in kHYPE

    function test_Erc4626InKhype() public {
        _khypeTo(bob, 50 ether);
        vm.startPrank(bob);
        uint256 shares = vault.deposit(20 ether, bob);
        assertEq(vault.totalAssets(), 20 ether);
        assertEq(shares, 20 ether, "the depositor receives exactly the shares quoted");
        assertEq(vault.totalSupply(), 20 ether + vault.DEAD_SHARES(), "plus 1000 wei of shares locked at a dead address");
        assertApproxEqAbs(vault.convertToAssets(shares), 20 ether, 1_001, "the first depositor gives up 1000 wei to them");
        uint256 minted = vault.previewMint(5 ether);
        vault.mint(5 ether, bob);
        assertEq(khype.balanceOf(bob), 50 ether - 20 ether - minted);
        vault.withdraw(3 ether, bob, bob);
        uint256 back = vault.redeem(vault.balanceOf(bob), bob, bob);
        vm.stopPrank();
        assertGt(back, 0);
        assertApproxEqAbs(khype.balanceOf(bob), 50 ether, 2_000, "everything back but the locked dust");
        assertEq(vault.asset(), KHYPE);
        assertEq(vault.decimals(), 18);
    }

    // ------------------------------------------------------------------ the fee

    function test_FeeIsTwentyPercentOfTheYield_AndSplitsToCreatorAndReserve() public {
        _khypeTo(bob, 100 ether);
        vm.prank(bob);
        vault.deposit(100 ether, bob);
        uint256 r0 = rate.rate();
        uint256 worth0 = 100 ether * r0 / 1e18; // in HYPE

        // 90 days of staking: kHYPE gains 0.5% against HYPE
        vm.warp(block.timestamp + 90 days);
        uint256 r1 = r0 * 1005 / 1000;
        rate.set(r1);

        uint256 gainHype = 100 ether * (r1 - r0) / 1e18;
        uint256 expectedFee = (100 ether * (r1 - r0) / r1) * 2000 / 10_000; // in kHYPE
        assertApproxEqAbs(vault.pendingFees(), expectedFee, 10, "fee due: 20% of the gain, in kHYPE");
        assertApproxEqAbs(vault.totalAssets(), 100 ether - expectedFee, 10);
        // depositors keep 80% of the gain
        assertApproxEqRel(vault.totalHype(), worth0 + gainHype * 8 / 10, 1e12, "depositors keep 80% of the yield");

        uint256 c0 = khype.balanceOf(CREATOR);
        uint256 i0 = khype.balanceOf(FEE_INBOX);
        vm.prank(carol); // anyone
        uint256 sent = vault.collectFees();
        assertApproxEqAbs(sent, expectedFee, 10);
        assertEq(khype.balanceOf(FEE_SPLIT), sent, "the fee went to the fixed fee address");
        assertEq(vault.feesOwed(), 0);
        assertEq(vault.markRate(), r1, "the mark moved up");

        // the fee address is the creator-share splitter: a fifth to the creator's wallet, the rest to the reserve
        FeeSplitter(FEE_SPLIT).distribute(KHYPE);
        assertEq(khype.balanceOf(CREATOR) - c0, sent * 2000 / 10_000, "20% of the cut to the creator's wallet");
        assertEq(khype.balanceOf(FEE_INBOX) - i0, sent - sent * 2000 / 10_000, "80% of the cut to the reserve's fee inbox");

        // nothing more is due until the rate rises again
        assertEq(vault.collectFees(), 0);
        uint256 bobShares = vault.balanceOf(bob);
        vm.prank(bob);
        uint256 out = vault.redeem(bobShares, bob, bob);
        assertApproxEqAbs(out, 100 ether - sent, 2_000, "bob leaves with all the kHYPE but the fee");
    }

    function test_NoFeeBelowTheHighWaterMark() public {
        _khypeTo(bob, 10 ether);
        vm.prank(bob);
        vault.deposit(10 ether, bob);
        uint256 r0 = rate.rate();
        vm.warp(block.timestamp + 30 days);
        rate.set(r0 * 99 / 100); // kHYPE slips 1% against HYPE
        assertEq(vault.pendingFees(), 0);
        assertEq(vault.collectFees(), 0);
        assertEq(vault.markRate(), r0, "the mark stays where it was");
        vm.warp(block.timestamp + 30 days);
        rate.set(r0); // and recovers
        assertEq(vault.pendingFees(), 0, "recovering lost ground is not yield");
        rate.set(r0 * 1001 / 1000);
        assertGt(vault.pendingFees(), 0, "only the rise above the old mark is");
    }

    function test_TheRateCanOnlyCountSoFast() public {
        _khypeTo(bob, 100 ether);
        vm.prank(bob);
        vault.deposit(100 ether, bob);
        uint256 r0 = rate.rate();
        vm.warp(block.timestamp + 1 days);
        rate.set(r0 * 2); // a wildly wrong price
        uint256 ceiling = r0 + r0 * 500 / 10_000 / 365; // 5% a year, for one day
        assertApproxEqAbs(vault.currentRate(), ceiling, 1e6);
        uint256 maxFee = (100 ether * (ceiling - r0) / ceiling) * 2000 / 10_000;
        assertApproxEqAbs(vault.pendingFees(), maxFee, 1e6, "the fee on a false price is bounded");
        assertLt(vault.pendingFees(), 0.003 ether, "under 0.003% of deposits for a day of it");
    }

    /// The worst case the ceiling allows: the price feed reads far too high every single day for a year, and
    /// the fee is collected every day.
    function test_AYearOfFalsePricesCostsDepositorsUnderOnePercent() public {
        _khypeTo(bob, 100 ether);
        vm.prank(bob);
        vault.deposit(100 ether, bob);
        uint256 r0 = rate.rate();
        rate.set(r0 * 2);
        uint256 taken;
        for (uint256 d; d < 365; ++d) {
            vm.warp(block.timestamp + 1 days);
            taken += vault.collectFees();
        }
        assertLt(taken, 1 ether, "under 1% of deposits");
        assertGt(taken, 0.9 ether, "and the bound is tight: the test would notice a looser ceiling");
        assertLe(vault.markRate(), r0 * 1052 / 1000, "the mark rose 5% (compounded daily), no more");
        assertApproxEqAbs(vault.totalAssets(), 100 ether - taken, 10, "depositors still hold the rest");
        // and once the feed reads true again, nothing more is taken until real yield passes the mark
        rate.set(r0 * 103 / 100);
        vm.warp(block.timestamp + 30 days);
        assertEq(vault.collectFees(), 0, "no second fee on the same ground");
    }

    function test_ANewDepositorDoesNotPayForEarlierYield() public {
        _khypeTo(bob, 100 ether);
        _khypeTo(carol, 100 ether);
        vm.prank(bob);
        vault.deposit(100 ether, bob);
        vm.warp(block.timestamp + 90 days);
        rate.set(rate.rate() * 101 / 100); // +1% while only bob is in (within the 5%-a-year ceiling for 90 days)
        uint256 feeOnBob = vault.pendingFees();
        vm.prank(carol);
        uint256 carolShares = vault.deposit(100 ether, carol);
        assertEq(vault.feesOwed(), feeOnBob, "the fee on bob's yield was set aside before carol came in");
        assertApproxEqAbs(vault.convertToAssets(carolShares), 100 ether, 2, "carol holds what she put in");
        assertApproxEqAbs(vault.convertToAssets(vault.balanceOf(bob)), 100 ether - feeOnBob, 2_000, "bob paid the fee on his own yield");
    }

    // ------------------------------------------------------------------ safety

    function test_WithdrawingNeverNeedsThePriceOrThePool() public {
        _khypeTo(bob, 10 ether);
        vm.prank(bob);
        uint256 shares = vault.deposit(10 ether, bob);
        rate.setBroken(true);
        vm.prank(OWNER);
        vault.setDepositsPaused(true);
        // deposits stop
        _khypeTo(carol, 1 ether);
        vm.prank(carol);
        vm.expectRevert();
        vault.deposit(1 ether, carol);
        vm.prank(carol);
        vm.expectRevert();
        vault.depositHype{value: 1 ether}(0, carol);
        // withdrawals do not
        vm.prank(bob);
        uint256 out = vault.redeem(shares, bob, bob);
        assertApproxEqAbs(out, 10 ether, 2_000);
    }

    function test_DepositsNeedAWorkingRate() public {
        rate.setBroken(true);
        _khypeTo(bob, 1 ether);
        vm.prank(bob);
        vm.expectRevert(HypeStakingVault.RateUnavailable.selector);
        vault.deposit(1 ether, bob);
    }

    function test_OwnerCanOnlyPauseAndCapDeposits() public {
        vm.prank(alice);
        vm.expectRevert();
        vault.setDepositsPaused(true);
        vm.prank(alice);
        vm.expectRevert();
        vault.setDepositCap(1);

        vm.prank(OWNER);
        vault.setDepositCap(5 ether);
        assertEq(vault.maxDeposit(bob), 5 ether);
        _khypeTo(bob, 10 ether);
        vm.prank(bob);
        vm.expectRevert();
        vault.deposit(6 ether, bob);
        vm.prank(bob);
        vault.deposit(5 ether, bob);
        assertEq(vault.maxDeposit(bob), 0);
        vm.prank(alice);
        vm.expectRevert();
        vault.depositHype{value: 1 ether}(0, alice); // over the cap through the HYPE door too
        assertEq(vault.feeRecipient(), FEE_SPLIT);
        assertEq(vault.FEE_BPS(), 2000);
    }

    function test_ADonationCannotStealFromTheNextDepositor() public {
        _khypeTo(alice, 100 ether);
        _khypeTo(bob, 10 ether);
        vm.startPrank(alice);
        vault.deposit(2_000, alice); // the smallest first deposit that leaves her any shares
        khype.transfer(address(vault), 50 ether); // then a donation to push the share price up
        vm.stopPrank();
        vm.prank(bob);
        uint256 shares = vault.deposit(10 ether, bob);
        assertApproxEqRel(vault.convertToAssets(shares), 10 ether, 0.01e18, "bob still holds what he put in");
        uint256 aliceShares = vault.balanceOf(alice);
        vm.prank(alice);
        uint256 back = vault.redeem(aliceShares, alice, alice);
        assertLt(back, 50 ether * 70 / 100, "the donor lost a large part of the donation to the locked shares");
    }

    function test_OnlyThePoolManagerMayCallBack() public {
        vm.expectRevert(HypeStakingVault.NotPoolManager.selector);
        vault.unlockCallback(abi.encode(true, uint256(1)));
        vm.prank(address(PM));
        vm.expectRevert(HypeStakingVault.NotPoolManager.selector); // not during a swap of the vault's own
        vault.unlockCallback(abi.encode(true, uint256(1)));
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(vault).call{value: 1}("");
        assertFalse(ok, "the vault takes no stray HYPE");
    }

    // ------------------------------------------------------------------ as it will be launched

    function test_WithTheRealRateFeed() public {
        HypeStakingVault live = _deploy(IRateProvider(KHYPE_RATE), 5_000 ether);
        assertEq(live.markRate(), IRateProvider(KHYPE_RATE).getRate());
        assertGt(live.markRate(), 1e18, "kHYPE is worth more than 1 HYPE");
        assertEq(live.owner(), OWNER);
        vm.prank(alice);
        uint256 shares = live.depositHype{value: 5 ether}(0, alice);
        assertGt(shares, 4.7 ether);
        assertEq(live.pendingFees(), 0, "no yield yet, no fee");
        vm.prank(alice);
        uint256 out = live.redeemToHype(shares, 0, alice);
        assertGt(out, 4.95 ether);
    }
}
