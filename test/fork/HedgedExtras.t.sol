// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FeeForwarder} from "../../src/hedged/FeeForwarder.sol";
import {CoreSpike} from "../../src/hedged/CoreSpike.sol";
import {ICoreDepositWallet} from "../../src/hedged/CoreLib.sol";
import {IL1GatewayRouter} from "../../src/interfaces/IArbitrumGateway.sol";
import {CoreSim, CorePrecompile, CoreWriterMock, CoreDepositWalletMock} from "../hedged/CoreSim.sol";

/// @notice The hedged vault's two small companions against real HyperEVM state: the fee forwarder
/// with the real bridge, and the live-check contract with `CoreSim` in HyperCore's place.
///
///   HYPEREVM_FORK=true forge test --match-path "test/fork/HedgedExtras.t.sol" -vv
contract HedgedExtrasForkTest is Test {
    IERC20 constant USDC = IERC20(0xb88339CB7199b77E23DB6E890353E22632Ba630f);
    IERC20 constant WHYPE = IERC20(0x5555555555555555555555555555555555555555);
    IL1GatewayRouter constant L1_ROUTER = IL1GatewayRouter(0x5D24f760DD7664b4214bDD4B04a3f62B9edd68c0);
    address constant VAULT_FEE_SPLIT = 0xB92c756347de468d7086a97EF112801b3371a408; // on Elysium
    address constant CORE_WRITER = 0x3333333333333333333333333333333333333333;

    function setUp() public {
        if (!vm.envOr("HYPEREVM_FORK", false)) {
            vm.skip(true);
            return;
        }
        uint256 at = vm.envOr("HYPEREVM_BLOCK", uint256(0));
        if (at == 0) vm.createSelectFork("hyperevm");
        else vm.createSelectFork("hyperevm", at);
    }

    function test_FeeForwarder_BridgesBothTokensToTheSplitter() public {
        FeeForwarder f = new FeeForwarder(L1_ROUTER, VAULT_FEE_SPLIT, 300_000, 0.5 gwei);
        address caller = makeAddr("anyone");
        vm.deal(caller, 1 ether);
        uint256 fee = 4e14 + 300_000 * 0.5 gwei;

        vm.prank(caller);
        vm.expectRevert(FeeForwarder.NothingToForward.selector);
        f.forward{value: fee}(address(USDC), 300_000, 0.5 gwei, 4e14);

        deal(address(USDC), address(f), 1_234e6);
        vm.prank(caller);
        vm.expectRevert(FeeForwarder.GasTooLow.selector);
        f.forward{value: fee}(address(USDC), 100_000, 0.5 gwei, 4e14);

        address gateway = L1_ROUTER.getGateway(address(USDC));
        uint256 escrow = USDC.balanceOf(gateway);
        vm.prank(caller);
        assertEq(f.forward{value: fee}(address(USDC), 300_000, 0.5 gwei, 4e14), 1_234e6);
        assertEq(USDC.balanceOf(address(f)), 0);
        assertEq(USDC.balanceOf(gateway) - escrow, 1_234e6, "USDC is locked in the bridge for the splitter");

        deal(address(WHYPE), address(f), 3e18);
        gateway = L1_ROUTER.getGateway(address(WHYPE));
        console2.log("WHYPE gateway:", gateway);
        vm.prank(caller);
        assertEq(f.forward{value: fee}(address(WHYPE), 300_000, 0.5 gwei, 4e14), 3e18);
        assertEq(WHYPE.balanceOf(address(f)), 0, "WHYPE left through its own gateway");
    }

    /// @dev The HyperEVM half of every step against the real contracts: Circle's deposit wallet takes
    /// the USDC from a contract, and the real CoreWriter and the HYPE system address accept the calls.
    /// What HyperCore then does with them cannot be seen on a fork.
    function test_CoreSpike_RealDepositWalletAndWriter_AcceptTheCalls() public {
        address realWallet = 0x6B9E773128f453f5c2C60935Ee2DE2CBc5390A24;
        address me = makeAddr("owner");
        deal(address(USDC), me, 12e6);
        vm.deal(me, 1 ether);
        vm.startPrank(me);
        CoreSpike spike = new CoreSpike(USDC, ICoreDepositWallet(realWallet), 159, 2);
        USDC.approve(address(spike), type(uint256).max);
        uint256 held = USDC.balanceOf(realWallet);
        vm.recordLogs();
        spike.fund(12e6, false);
        assertEq(USDC.balanceOf(me), 0);
        assertEq(USDC.balanceOf(address(spike)), 0, "the wallet took it from the contract");
        console2.log("USDC now held by the deposit wallet itself (0 means it passed it on):", USDC.balanceOf(realWallet) - held);
        spike.order(false, 25, 610_000, false);
        spike.order(true, 25, 630_000, true);
        spike.perpToSpot(10e6);
        spike.spotToEvm(10e6);
        spike.fundHype{value: 0.01 ether}();
        vm.stopPrank();
        assertEq(address(spike).balance, 0, "the HYPE left for the system address");
    }

    function test_CoreSpike_OwnerOnly_AndRoundTrip() public {
        CoreSim sim = new CoreSim(USDC, 159, 2, 620_000);
        CoreDepositWalletMock wallet = new CoreDepositWalletMock(sim, USDC);
        vm.etch(CORE_WRITER, address(new CoreWriterMock(sim)).code);
        bytes memory pre = address(new CorePrecompile(sim)).code;
        uint160[5] memory at = [uint160(0x0800), 0x0801, 0x0806, 0x0807, 0x080F];
        for (uint256 i; i < at.length; i++) {
            vm.etch(address(at[i]), pre);
        }
        sim.wire(CORE_WRITER, address(wallet));

        address me = makeAddr("owner");
        deal(address(USDC), me, 100e6);
        vm.startPrank(me);
        CoreSpike spike = new CoreSpike(USDC, ICoreDepositWallet(address(wallet)), 159, 2);
        USDC.approve(address(spike), type(uint256).max);
        spike.fund(25e6, false);
        spike.order(false, 25, 620_000 * 99 / 100, false); // sell 0.25 HYPE
        vm.stopPrank();
        sim.step();
        (uint256 px, int256 szi, int256 perpValue,,,,,) = spike.read();
        assertEq(px, 620_000);
        assertEq(szi, -25);
        assertApproxEqAbs(perpValue, 25e6, 0.01e6);

        vm.expectRevert(CoreSpike.NotOwner.selector);
        spike.order(true, 25, 630_000, true);
        vm.expectRevert(CoreSpike.NotOwner.selector);
        spike.sweep(address(USDC));

        vm.startPrank(me);
        spike.order(true, 25, 620_000 * 101 / 100, true);
        vm.stopPrank();
        sim.step();
        vm.startPrank(me);
        spike.perpToSpot(24e6);
        spike.spotToEvm(24e6); // the whole of it: refused, as on mainnet, because nothing is left for the charge
        vm.stopPrank();
        sim.step();
        assertEq(sim.transfersRejected(), 1);
        vm.startPrank(me);
        spike.spotToEvm(22.9e6); // leaving the one-time dollar behind: goes through
        vm.stopPrank();
        sim.step();
        uint256 here;
        (, szi, perpValue,, here,,,) = spike.read();
        assertEq(szi, 0);
        assertEq(here, 22.9e6);
        vm.prank(me);
        spike.sweep(address(USDC));
        assertEq(USDC.balanceOf(me), 97.9e6, "back, but for the trading fees, HyperCore's dollar and what was left with it");
    }
}
