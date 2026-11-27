// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {CoreLib} from "../../src/hedged/CoreLib.sol";
import {HedgeLib, Core} from "../../src/hedged/HedgeLib.sol";
import "../../src/hedged/HedgedTypes.sol";
import {CoreSim, CorePrecompile, CoreWriterMock, CoreDepositWalletMock} from "./CoreSim.sol";

/// @notice Records what is sent to CoreWriter, byte for byte.
contract RecordingWriter {
    bytes[] public sent;

    function sendRawAction(bytes calldata data) external {
        sent.push(data);
    }

    function count() external view returns (uint256) {
        return sent.length;
    }
}

/// @notice CoreLib's internal functions, callable.
contract CoreLibUser {
    function order(uint32 perp, uint8 szDecimals, bool isBuy, uint256 sz, uint256 limitRaw, bool reduceOnly)
        external
        returns (uint256)
    {
        return CoreLib.order(perp, szDecimals, isBuy, sz, limitRaw, reduceOnly);
    }

    function perpToSpot(uint256 usdc6) external {
        CoreLib.perpToSpot(usdc6);
    }

    function spotToEvm(uint256 usdc6) external {
        CoreLib.spotToEvm(usdc6);
    }

    function roundPx(uint256 raw, bool up) external pure returns (uint256) {
        return CoreLib.roundPx(raw, up);
    }

    function read(uint32 perp) external view returns (uint256 px, int256 szi, int256 value, uint256 spot) {
        return (
            CoreLib.oraclePx(perp),
            CoreLib.positionSz(address(this), perp),
            CoreLib.accountValue(address(this)),
            CoreLib.spotUsdc(address(this))
        );
    }
}

/// @notice A vault's storage with nothing in the pool: only idle token0 to hedge. Enough to drive
/// HedgeLib on its own.
contract HedgeHarness {
    Vault internal _v;

    constructor(address asset, address usdc, address coreDeposit) {
        _v.c.asset = asset;
        _v.c.usdc = usdc;
        _v.c.coreDeposit = coreDeposit;
        _v.c.perp = 159;
        _v.c.szDecimals = 2;
        _v.bandBps = 500;
        _v.marginBps = 4_000;
    }

    function fund(uint256 usdc) external {
        HedgeLib.fund(_v, usdc);
    }

    function hedge(bool force) external returns (bool) {
        return HedgeLib.hedge(_v, HedgeLib.read(_v), force);
    }

    function askBack(uint256 usdc) external returns (bool) {
        return HedgeLib.askBack(_v, HedgeLib.read(_v), usdc);
    }

    function targetSz() external view returns (uint256) {
        return HedgeLib.targetSz(_v, CoreLib.oraclePx(159));
    }

}

contract HedgeLibTest is Test {
    address constant CORE_WRITER = 0x3333333333333333333333333333333333333333;
    uint256 constant PX = 600_000; // $60.00 as a raw price

    MockERC20 usdc;
    MockERC20 hype;
    CoreSim sim;
    CoreDepositWalletMock wallet;
    HedgeHarness h;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        hype = new MockERC20("Wrapped HYPE", "WHYPE", 18);
        sim = new CoreSim(IERC20(address(usdc)), 159, 2, PX);
        wallet = new CoreDepositWalletMock(sim, IERC20(address(usdc)));
        bytes memory pre = address(new CorePrecompile(sim)).code;
        uint160[5] memory at = [uint160(0x0800), 0x0801, 0x0806, 0x0807, 0x080F];
        for (uint256 i; i < at.length; i++) {
            vm.etch(address(at[i]), pre);
        }
        vm.etch(CORE_WRITER, address(new CoreWriterMock(sim)).code);
        sim.wire(CORE_WRITER, address(wallet));
        usdc.mint(address(sim), 10_000_000e6);
        h = new HedgeHarness(address(hype), address(usdc), address(wallet));
        vm.roll(1_000);
    }

    function nextBlocks(uint256 n) internal {
        for (uint256 i; i < n; i++) {
            sim.step();
            vm.roll(block.number + 1);
        }
    }

    function short() internal view returns (uint256) {
        (, int256 szi,) = sim.accounts(address(h));
        return szi < 0 ? uint256(-szi) : 0;
    }

    /// @dev 100 HYPE idle, `margin` USDC on the perp side, and the short opened as far as that carries.
    function open(uint256 margin) internal {
        hype.mint(address(h), 100e18);
        usdc.mint(address(h), margin);
        h.fund(margin);
        h.hedge(true);
        nextBlocks(6);
    }

    // ------------------------------------------------------------------ CoreLib: bytes and units

    /// @dev The layouts are the ones real contracts send on HyperEVM (decoded from CoreWriter's
    /// RawAction events on 2026-11-26): a version byte, a three-byte action number, then the fields
    /// ABI-encoded; order prices and sizes are x 10^8, class transfers have 6 decimals, asset
    /// transfers 8.
    function test_Order_Bytes() public {
        RecordingWriter w = new RecordingWriter();
        vm.etch(CORE_WRITER, address(w).code);
        CoreLibUser u = new CoreLibUser();
        // sell 12.34 HYPE at no less than $61.948
        uint256 used = u.order(159, 2, false, 1_234, 619_480, false);
        assertEq(used, 619_480);
        assertEq(
            RecordingWriter(CORE_WRITER).sent(0),
            abi.encodePacked(
                hex"01000001", abi.encode(uint32(159), false, uint64(61.948e8), uint64(12.34e8), false, uint8(3), uint128(0))
            )
        );
        // buy back 0.5 HYPE at no more than $62.2586, which becomes $62.259: five significant figures, rounded up
        used = u.order(159, 2, true, 50, 622_586, true);
        assertEq(used, 622_590);
        assertEq(
            RecordingWriter(CORE_WRITER).sent(1),
            abi.encodePacked(
                hex"01000001", abi.encode(uint32(159), true, uint64(62.259e8), uint64(0.5e8), true, uint8(3), uint128(0))
            )
        );
    }

    function test_Transfer_Bytes() public {
        RecordingWriter w = new RecordingWriter();
        vm.etch(CORE_WRITER, address(w).code);
        CoreLibUser u = new CoreLibUser();
        u.perpToSpot(1_234_567_890); // 1,234.56789 USDC
        assertEq(RecordingWriter(CORE_WRITER).sent(0), abi.encodePacked(hex"01000007", abi.encode(uint64(1_234_567_890), false)));
        u.spotToEvm(1_234_567_890);
        assertEq(
            RecordingWriter(CORE_WRITER).sent(1),
            abi.encodePacked(
                hex"0100000d",
                abi.encode(
                    0x2000000000000000000000000000000000000000,
                    address(0),
                    type(uint32).max,
                    type(uint32).max,
                    uint64(0),
                    uint64(123_456_789_000)
                )
            )
        );
    }

    function test_RoundPx_FiveSignificantFigures() public {
        CoreLibUser u = new CoreLibUser();
        assertEq(u.roundPx(619_480, false), 619_480);
        assertEq(u.roundPx(619_487, false), 619_480);
        assertEq(u.roundPx(619_487, true), 619_490);
        assertEq(u.roundPx(99_999, true), 99_999);
        assertEq(u.roundPx(1_234_567, false), 1_234_500);
        assertEq(u.roundPx(1_234_567, true), 1_234_600);
        assertEq(u.roundPx(999_999, true), 1_000_000);
        assertEq(u.roundPx(0, true), 0);
    }

    function testFuzz_RoundPx(uint256 raw, bool up) public {
        raw = bound(raw, 1, 1e15);
        CoreLibUser u = new CoreLibUser();
        uint256 r = u.roundPx(raw, up);
        uint256 step = 1;
        while (r / step >= 100_000) step *= 10;
        assertEq(r % step, 0, "five significant figures");
        if (up) assertGe(r, raw);
        else assertLe(r, raw);
        assertLe(r > raw ? r - raw : raw - r, raw / 10_000 + 1, "within 0.01%");
    }

    function test_Reads_Units() public {
        CoreLibUser u = new CoreLibUser();
        usdc.mint(address(u), 5_000e6);
        vm.startPrank(address(u));
        usdc.approve(address(wallet), type(uint256).max);
        wallet.deposit(4_000e6, 0);
        wallet.deposit(1_000e6, type(uint32).max);
        vm.stopPrank();
        u.order(159, 2, false, 2_500, PX * 99 / 100, false); // short 25 HYPE
        sim.step();
        (uint256 px, int256 szi, int256 value, uint256 spot) = u.read(159);
        assertEq(px, PX);
        assertEq(szi, -2_500);
        assertEq(value, 4_000e6 - int256(25 * 60e6 * 45 / 100_000), "margin less the taker fee");
        assertEq(spot, 1_000e6);
        sim.setPx(PX * 110 / 100);
        (,, value,) = u.read(159);
        assertEq(value, 4_000e6 - int256(25 * 60e6 * 45 / 100_000) - 150e6, "a short loses when the price rises");
    }

    // ------------------------------------------------------------------ HedgeLib: the rules about the short

    function test_Short_OpensToTheTarget() public {
        open(2_400e6); // 40% of $6,000
        assertEq(h.targetSz(), 10_000);
        assertEq(short(), 10_000);
    }

    function test_Short_NoLargerThanTheMarginCarries() public {
        open(600e6); // 10% of the $6,000 to hedge
        // at the lower line (25%) $600 carries a short of $2,400: 40 HYPE
        assertEq(short(), 4_000);
        usdc.mint(address(h), 1_800e6);
        h.fund(1_800e6);
        assertTrue(h.hedge(false));
        nextBlocks(6);
        assertEq(short(), 10_000, "with the margin there, the rest follows");
    }

    function test_Emergency_CutsTheShort() public {
        open(2_400e6);
        sim.setPx(PX * 130 / 100); // +30% and nobody tended: the margin is at 7.7% of the short
        int256 value = sim.accountValue(address(h));
        assertLt(value * 10_000 / int256(sim.notional(address(h))), 1_200);
        assertTrue(h.hedge(false));
        nextBlocks(6);
        // cut to what the margin carries at its lower line, although the vault still holds 100 HYPE
        assertLt(short(), 3_200);
        assertGt(short(), 2_800);
        assertEq(h.targetSz(), 10_000);
        uint256 ratio = uint256(sim.accountValue(address(h))) * 10_000 / sim.notional(address(h));
        assertApproxEqAbs(ratio, 2_500, 100, "margin back at the lower line");
        assertFalse(h.hedge(false), "and it is not sold up again while the margin does not carry it");
        assertEq(sim.liquidations(), 0);
    }

    function test_OneOrderPerGap() public {
        hype.mint(address(h), 100e18);
        usdc.mint(address(h), 2_400e6);
        h.fund(2_400e6);
        assertTrue(h.hedge(true));
        assertFalse(h.hedge(true), "same block: the first order has not landed");
        nextBlocks(4);
        assertFalse(h.hedge(true), "four blocks later: still waiting");
        nextBlocks(1);
        assertFalse(h.hedge(true), "five blocks later it may send, but the short is on target");
        assertEq(short(), 10_000);
    }

    function test_SmallDifferences_AreLeftAlone() public {
        open(2_400e6);
        hype.mint(address(h), 0.15e18); // $9 more to hedge: under the smallest order
        nextBlocks(6);
        assertFalse(h.hedge(true));
        hype.mint(address(h), 0.1e18); // $15 in all
        assertTrue(h.hedge(true));
        nextBlocks(6);
        assertEq(short(), 10_025);
    }

    function test_FullClose_IsSentEvenWhenSmall() public {
        hype.mint(address(h), 0.5e18);
        usdc.mint(address(h), 100e6);
        h.fund(100e6);
        h.hedge(true);
        nextBlocks(6);
        assertEq(short(), 50);
        vm.prank(address(h));
        hype.transfer(address(1), 0.4e18);
        h.hedge(true);
        nextBlocks(6);
        assertEq(short(), 10, "$6 of short left");
        // the vault's HYPE is gone: the $6 that is left of the short is under the smallest order, and is sent anyway
        vm.prank(address(h));
        hype.transfer(address(1), 0.1e18);
        assertTrue(h.hedge(true));
        nextBlocks(6);
        assertEq(short(), 0);
    }

    /// @dev Whether HyperCore takes a closing order under $10 is not known yet. If it does not, the
    /// remainder stays (and is counted in the vault's value like everything else on the account).
    function test_FullClose_IfHyperCoreRefusesSmallCloses() public {
        sim.setMinOrderOnClose(true);
        hype.mint(address(h), 0.5e18);
        usdc.mint(address(h), 100e6);
        h.fund(100e6);
        h.hedge(true);
        nextBlocks(6);
        vm.prank(address(h));
        hype.transfer(address(1), 0.4e18);
        h.hedge(true);
        nextBlocks(6);
        vm.prank(address(h));
        hype.transfer(address(1), 0.1e18);
        h.hedge(true);
        nextBlocks(6);
        assertEq(short(), 10, "refused: the remainder stays");
    }

    function test_AskBack_NotTwiceOnTheSameReading() public {
        open(6_000e6); // twice what the short needs
        assertTrue(h.askBack(1_000e6));
        assertTrue(h.askBack(500e6), "the same block may add to its own request");
        nextBlocks(1);
        assertFalse(h.askBack(1_000e6), "the next blocks may not: the first may not have been carried out yet");
        nextBlocks(4);
        assertTrue(h.askBack(1_000e6));
        nextBlocks(1);
        // all three arrived, less HyperCore's one-time dollar and its small charge for each send, and less
        // the float, which the third request filled up again after the dollar had been taken out of it
        assertApproxEqAbs(usdc.balanceOf(address(h)), 2_500e6 - 1.0037e6 - 1.05e6, 0.005e6);
        (,, uint256 spot8) = sim.accounts(address(h));
        assertLe(spot8, 1.05e8, "what is left there is the float, or less");
        assertEq(sim.transfersRejected(), 0, "no send was refused");
    }
}
