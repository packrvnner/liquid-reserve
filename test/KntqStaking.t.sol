// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockSkntq} from "./mocks/MockBridge.sol";
import {LockedReserve} from "../src/LockedReserve.sol";
import {FeeSplitter} from "../src/FeeSplitter.sol";
import {ERC4626RateProvider} from "../src/adapters/ERC4626RateProvider.sol";
import {IRateProvider} from "../src/interfaces/IRateProvider.sol";
import {IL1GatewayRouter} from "../src/interfaces/IArbitrumGateway.sol";
import {KntqVault} from "../src/staking/KntqVault.sol";
import {SkntqLock, ILockedReserveDeposit} from "../src/staking/KntqStakingVault.sol";
import {KntqStakeAgent, KntqAgentFactory, StakeSalt} from "../src/staking/KntqStakeBridge.sol";
import {KntqStakeQueue, StakeBox, IL2Router} from "../src/staking/KntqStakeQueue.sol";

/// A token as the bridge makes it on Elysium: only the bridge mints and burns.
contract BridgedToken is ERC20 {
    address public immutable bridge;

    constructor() ERC20("bridged", "BR") {
        bridge = msg.sender;
    }

    function bridgeMint(address to, uint256 amount) external {
        require(msg.sender == bridge, "bridge only");
        _mint(to, amount);
    }

    function bridgeBurn(address from, uint256 amount) external {
        require(msg.sender == bridge, "bridge only");
        _burn(from, amount);
    }
}

/// Both ends of the canonical bridge in one place, for a test that plays both chains in one EVM. Tokens leaving
/// "Elysium" are burned and wait to be released on "HyperEVM" from escrow; tokens leaving "HyperEVM" are put in
/// escrow and wait to be minted on "Elysium". The test decides when each side arrives.
contract BridgeSim {
    struct Move {
        address token; // the HyperEVM token
        address to;
        uint256 amount;
    }

    Move[] public toL1; // waiting to be released on HyperEVM
    Move[] public toL2; // waiting to be minted on Elysium
    uint256 public lastValue;
    uint256 public lastMaxGas;

    // ---- Elysium router
    function calculateL2TokenAddress(address l1Token) public view returns (address) {
        bytes32 h = keccak256(
            abi.encodePacked(bytes1(0xff), address(this), bytes32(uint256(uint160(l1Token))), keccak256(type(BridgedToken).creationCode))
        );
        return address(uint160(uint256(h)));
    }

    function outboundTransfer(address l1Token, address to, uint256 amount, bytes calldata) external payable returns (bytes memory) {
        BridgedToken(calculateL2TokenAddress(l1Token)).bridgeBurn(msg.sender, amount);
        toL1.push(Move(l1Token, to, amount));
        return "";
    }

    // ---- HyperEVM router (it is its own gateway here)
    function getGateway(address) external view returns (address) {
        return address(this);
    }

    function outboundTransferCustomRefund(address token, address, address to, uint256 amount, uint256 maxGas, uint256, bytes calldata)
        external
        payable
        returns (bytes memory)
    {
        lastValue = msg.value;
        lastMaxGas = maxGas;
        IERC20(token).transferFrom(msg.sender, address(this), amount);
        toL2.push(Move(token, to, amount));
        _logTicket(maxGas);
        return "";
    }

    // What the real inbox and bridge log for every ticket to Elysium (the bot finds a ticket's id from these).
    event InboxMessageDelivered(uint256 indexed messageNum, bytes data);
    event MessageDelivered(
        uint256 indexed messageIndex,
        bytes32 indexed beforeInboxAcc,
        address inbox,
        uint8 kind,
        address sender,
        bytes32 messageDataHash,
        uint256 baseFeeL1,
        uint64 timestamp
    );

    uint256 public messageCount;

    function _logTicket(uint256 maxGas) private {
        bytes memory data = abi.encodePacked(
            uint256(uint160(address(this))), // to
            uint256(0), // value on Elysium
            msg.value, // paid in
            uint256(1e12), // submission fee
            uint256(uint160(msg.sender)), // refunds
            uint256(uint160(msg.sender)),
            maxGas,
            uint256(0.5 gwei),
            uint256(4),
            bytes4(0x2e567b36)
        );
        emit MessageDelivered(messageCount, bytes32(0), address(this), 9, msg.sender, keccak256(data), block.basefee, uint64(block.timestamp));
        emit InboxMessageDelivered(messageCount++, data);
    }

    /// How many transfers are still waiting to be minted on Elysium (a ticket that has not run).
    function pendingToElysium() external view returns (uint256) {
        return toL2.length;
    }

    /// The inbox's quote for a bridge ticket (the bot asks for it before it pays one).
    function calculateRetryableSubmissionFee(uint256, uint256) external pure returns (uint256) {
        return 1e12;
    }

    // ---- the test's hands
    /// The challenge period is over: everything sent from Elysium is released on HyperEVM.
    function arriveOnHyperEvm() external {
        for (uint256 i; i < toL1.length; ++i) IERC20(toL1[i].token).transfer(toL1[i].to, toL1[i].amount);
        delete toL1;
    }

    /// The bridge tickets ran: everything sent from HyperEVM is minted on Elysium (the first one of a token
    /// creates its Elysium contract, as the real bridge does).
    function arriveOnElysium() external {
        for (uint256 i; i < toL2.length; ++i) {
            address l2 = calculateL2TokenAddress(toL2[i].token);
            if (l2.code.length == 0) new BridgedToken{salt: bytes32(uint256(uint160(toL2[i].token)))}();
            BridgedToken(l2).bridgeMint(toL2[i].to, toL2[i].amount);
        }
        delete toL2;
    }

    /// Bridges `amount` of a HyperEVM token to `to` on Elysium at once (sets up Elysium balances).
    function seed(address token, address to, uint256 amount) external {
        IERC20(token).transferFrom(msg.sender, address(this), amount);
        address l2 = calculateL2TokenAddress(token);
        if (l2.code.length == 0) new BridgedToken{salt: bytes32(uint256(uint160(token)))}();
        BridgedToken(l2).bridgeMint(to, amount);
    }
}

/// KNTQ with a hook: while armed, every transfer first calls back into `target` and keeps what came back.
/// (Real KNTQ has no hooks. This stands in for a token that would, to check nothing can re-enter the vault.)
contract HookKntq is ERC20 {
    address public target;
    bytes public callData;
    bool public called;
    bool public succeeded;
    bytes public returned;

    constructor() ERC20("Hook KNTQ", "hKNTQ") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target_, bytes calldata callData_) external {
        target = target_;
        callData = callData_;
        called = false;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (target != address(0) && !called) {
            called = true;
            (succeeded, returned) = target.call(callData);
        }
        super._update(from, to, value);
    }
}

/// KNTQ staking from Elysium, both chains played in one EVM: the vault and agents ("HyperEVM") against a
/// stand-in for sKNTQ, the queue ("Elysium"), and a simulated bridge between them.
contract KntqStakingTest is Test {
    uint8 constant DEPOSIT = 1;
    uint8 constant EXIT = 2;
    uint256 constant GAS = 300_000;
    uint256 constant GAS_PRICE = 0.5 gwei;
    uint256 constant FEE = 0.01 ether;

    MockERC20 kntqL1;
    MockSkntq skntq;
    BridgeSim bridge;
    IERC20 kntq; // on Elysium
    IERC20 share; // liquidKNTQ on Elysium

    LockedReserve reserve;
    SkntqLock lock;
    FeeSplitter splitter;
    KntqVault vault;
    KntqAgentFactory factory;
    KntqStakeQueue queue;

    address owner = makeAddr("owner");
    address creator = makeAddr("creator");
    address keeper = makeAddr("keeper");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address bot = makeAddr("bot");

    function setUp() public {
        vm.warp(1_800_000_000);
        kntqL1 = new MockERC20("Kinetiq", "KNTQ", 18);
        skntq = new MockSkntq(IERC20(address(kntqL1)));
        bridge = new BridgeSim();

        // HyperEVM: the reserve that locks sKNTQ, the fee path, the vault, the agent factory
        ERC4626RateProvider rate = new ERC4626RateProvider(IERC4626(address(skntq)));
        reserve = new LockedReserve(
            [address(skntq), address(0), address(0)],
            [IRateProvider(address(rate)), IRateProvider(address(0)), IRateProvider(address(0))],
            makeAddr("yield router")
        );
        lock = new SkntqLock(IERC20(address(skntq)), ILockedReserveDeposit(address(reserve)));
        splitter = new FeeSplitter(creator, 2000, address(lock));
        vault = new KntqVault(owner, IERC4626(address(skntq)), address(splitter), 5_000_000e18);
        factory = new KntqAgentFactory(vault, IL1GatewayRouter(address(bridge)), GAS, GAS_PRICE);

        // Elysium: KNTQ as bridged, and the queue
        kntqL1.mint(address(this), 10_000_000e18);
        kntqL1.approve(address(bridge), type(uint256).max);
        for (uint256 i; i < 3; ++i) bridge.seed(address(kntqL1), [alice, bob, carol][i], 100_000e18);
        kntq = IERC20(bridge.calculateL2TokenAddress(address(kntqL1)));
        queue = new KntqStakeQueue(
            KntqStakeQueue.Params({
                owner: owner,
                kntq: kntq,
                kntqL1: address(kntqL1),
                shareL1: address(vault),
                router: IL2Router(address(bridge)),
                agentFactory: address(factory),
                agentImpl: factory.agentImpl(),
                minDeposits: 500e18,
                minExits: 500e18
            })
        );
        share = queue.share();
        vm.prank(owner);
        queue.setKeeper(keeper);
        for (uint256 i; i < 3; ++i) {
            vm.prank([alice, bob, carol][i]);
            kntq.approve(address(queue), type(uint256).max);
        }
        vm.deal(bot, 10 ether);
    }

    // ------------------------------------------------------------------ helpers

    function _agent(uint8 kind, uint256 id) internal returns (KntqStakeAgent) {
        return KntqStakeAgent(factory.open(kind, id, queue.boxOf(kind, id)));
    }

    /// One deposit batch, all the way: sent, arrived on HyperEVM, staked, liquidKNTQ back on Elysium.
    function _runDeposits() internal returns (uint256 id) {
        id = queue.sendDeposits();
        bridge.arriveOnHyperEvm();
        KntqStakeAgent agent = _agent(DEPOSIT, id);
        vm.prank(bot);
        agent.stake{value: FEE}(GAS, GAS_PRICE, 0.001 ether);
        bridge.arriveOnElysium();
    }

    function _rewards(uint256 amount) internal {
        kntqL1.mint(address(skntq), amount); // Kinetiq pays stakers: sKNTQ's rate rises
    }

    // ------------------------------------------------------------------ addresses

    function test_BothSidesAgreeOnEveryBatchAddress() public {
        for (uint8 kind = 1; kind <= 2; ++kind) {
            for (uint256 id; id < 3; ++id) {
                address box = queue.boxOf(kind, id);
                assertEq(queue.agentOf(kind, id), factory.agentFor(kind, id, box), "the queue predicts the agent the factory creates");
                KntqStakeAgent agent = KntqStakeAgent(factory.open(kind, id, box));
                assertEq(address(agent), queue.agentOf(kind, id));
                assertEq(agent.kind(), kind);
                assertEq(agent.id(), id);
                assertEq(agent.l2Box(), box, "an agent can only send home to its own batch's box");
                assertEq(factory.open(kind, id, box), address(agent), "opening twice changes nothing");
            }
        }
        assertTrue(queue.agentOf(DEPOSIT, 0) != queue.agentOf(EXIT, 0));
        assertTrue(queue.agentOf(DEPOSIT, 0) != queue.agentOf(DEPOSIT, 1));
        // an agent opened with a different box is a different address: nothing was ever sent there
        assertTrue(factory.agentFor(DEPOSIT, 0, address(0xBEEF)) != queue.agentOf(DEPOSIT, 0));
    }

    function test_AgentAndBoxCannotBeTakenOver() public {
        KntqStakeAgent agent = _agent(DEPOSIT, 0);
        vm.expectRevert(KntqStakeAgent.NotFactory.selector);
        agent.init(EXIT, 7, address(this));
        KntqStakeAgent impl = KntqStakeAgent(factory.agentImpl());
        vm.expectRevert(KntqStakeAgent.NotFactory.selector);
        impl.init(DEPOSIT, 0, address(this));
        // the box only answers to the queue
        vm.prank(alice);
        queue.deposit(1_000e18, alice);
        _runDeposits();
        StakeBox box = StakeBox(queue.boxOf(DEPOSIT, 0));
        queue.collect(DEPOSIT, 0); // creates the box
        vm.expectRevert(StakeBox.NotQueue.selector);
        box.sweep(share);
    }

    // ------------------------------------------------------------------ staking from Elysium

    function test_StakeFromElysium_SharedOutByWhatEachPutIn() public {
        vm.prank(alice);
        queue.deposit(600e18, alice);
        vm.prank(bob);
        queue.deposit(400e18, bob);
        assertEq(kntq.balanceOf(address(queue)), 1_000e18);

        uint256 id = queue.sendDeposits();
        assertEq(id, 0);
        assertEq(queue.openBatch(DEPOSIT), 1, "the next deposit starts a new batch");
        assertEq(kntq.balanceOf(address(queue)), 0, "the KNTQ left Elysium");
        (uint256 r,) = queue.claimable(DEPOSIT, 0, alice);
        assertEq(r, 0, "nothing to claim while it is on the bridge");

        // a day later it is released on HyperEVM, at the batch's agent address (which does not exist yet)
        bridge.arriveOnHyperEvm();
        address agentAddr = queue.agentOf(DEPOSIT, 0);
        assertEq(kntqL1.balanceOf(agentAddr), 1_000e18);
        assertEq(agentAddr.code.length, 0);

        KntqStakeAgent agent = _agent(DEPOSIT, 0);
        vm.prank(bot);
        (bool staked, uint256 sent) = agent.stake{value: FEE}(GAS, GAS_PRICE, 0.001 ether);
        assertTrue(staked);
        assertEq(sent, 1_000e18, "the first liquidKNTQ is 1 for 1 with sKNTQ");
        assertEq(bridge.lastValue(), FEE, "the caller's bridge fee is passed on");
        assertEq(skntq.balanceOf(address(vault)), 1_000e18, "the vault holds the sKNTQ");
        assertEq(address(share).code.length, 0, "liquidKNTQ does not exist on Elysium until it arrives");

        bridge.arriveOnElysium();
        (uint256 a,) = queue.claimable(DEPOSIT, 0, alice);
        (uint256 b,) = queue.claimable(DEPOSIT, 0, bob);
        assertEq(a, 600e18);
        assertEq(b, 400e18);

        // anyone can make the claim; the tokens go to the depositor
        vm.prank(bot);
        queue.claim(DEPOSIT, 0, alice);
        queue.claim(DEPOSIT, 0, bob);
        assertEq(share.balanceOf(alice), 600e18);
        assertEq(share.balanceOf(bob), 400e18);
        (uint256 again,) = queue.claim(DEPOSIT, 0, alice);
        assertEq(again, 0, "a second claim pays nothing");
        assertEq(share.balanceOf(address(queue)), 0);
        (uint256 none,) = queue.claim(DEPOSIT, 0, carol);
        assertEq(none, 0, "someone who was not in the batch gets nothing");
    }

    function test_CancelBeforeTheBatchIsSent() public {
        vm.prank(alice);
        queue.deposit(700e18, alice);
        vm.prank(carol);
        queue.deposit(300e18, carol);
        vm.prank(carol);
        queue.cancelDeposit(300e18);
        assertEq(kntq.balanceOf(carol), 100_000e18, "carol has all her KNTQ back");
        vm.expectRevert();
        vm.prank(carol);
        queue.cancelDeposit(1);
        vm.expectRevert();
        vm.prank(bob);
        queue.cancelDeposit(1); // bob never deposited
        _runDeposits();
        queue.claim(DEPOSIT, 0, alice);
        assertEq(share.balanceOf(alice), 700e18, "the batch is alice's alone");
        // once sent, there is nothing left to cancel in that batch
        vm.expectRevert();
        vm.prank(alice);
        queue.cancelDeposit(1);
    }

    function test_SmallBatchesWaitUnlessTheKeeperSendsThem() public {
        vm.expectRevert(KntqStakeQueue.NothingToSend.selector);
        queue.sendDeposits();
        vm.prank(alice);
        queue.deposit(100e18, alice);
        vm.expectRevert(abi.encodeWithSelector(KntqStakeQueue.BelowMinimum.selector, 100e18, 500e18));
        queue.sendDeposits();
        vm.prank(keeper);
        queue.sendDeposits();
        assertEq(queue.batch(DEPOSIT, 0).total, 100e18);
        assertGt(queue.batch(DEPOSIT, 0).sentAt, 0);
    }

    function test_LaterBatchesGetFewerSharesOnceThereIsYield() public {
        vm.prank(alice);
        queue.deposit(1_000e18, alice);
        _runDeposits();
        _rewards(100e18); // sKNTQ: 1.0 -> 1.1 KNTQ
        vm.prank(bob);
        queue.deposit(1_100e18, bob);
        uint256 id = _runDeposits();
        queue.claim(DEPOSIT, 0, alice);
        queue.claim(DEPOSIT, id, bob);
        // bob's 1,100 KNTQ bought 1,000 sKNTQ; the vault had set aside the fee on alice's yield first, so one
        // liquidKNTQ already stood for a little less than one sKNTQ and bob gets slightly more than 1,000
        assertApproxEqRel(share.balanceOf(bob), 1_000e18, 0.02e18);
        assertGt(share.balanceOf(bob), 1_000e18);
        assertEq(share.balanceOf(alice), 1_000e18);
    }

    // ------------------------------------------------------------------ the vault refuses a batch

    function test_IfTheVaultRefusesTheBatch_TheKntqComesHome() public {
        vm.prank(alice);
        queue.deposit(600e18, alice);
        vm.prank(bob);
        queue.deposit(400e18, bob);
        uint256 id = queue.sendDeposits();
        bridge.arriveOnHyperEvm();
        vm.prank(owner);
        vault.setDepositsPaused(true); // or the cap is full
        KntqStakeAgent agent = _agent(DEPOSIT, id);
        vm.prank(bot);
        (bool staked, uint256 sent) = agent.stake{value: FEE}(GAS, GAS_PRICE, 0.001 ether);
        assertFalse(staked);
        assertEq(sent, 1_000e18);
        assertEq(kntqL1.balanceOf(address(agent)), 0, "nothing is left stranded on HyperEVM");
        bridge.arriveOnElysium();
        (uint256 r, uint256 back) = queue.claimable(DEPOSIT, id, alice);
        assertEq(r, 0);
        assertEq(back, 600e18);
        queue.claim(DEPOSIT, id, alice);
        queue.claim(DEPOSIT, id, bob);
        assertEq(kntq.balanceOf(alice), 100_000e18, "alice has her KNTQ back");
        assertEq(kntq.balanceOf(bob), 100_000e18);
    }

    function test_ABatchOverTheCapComesHomeWhole() public {
        vm.prank(owner);
        vault.setDepositCap(900e18);
        vm.prank(alice);
        queue.deposit(1_000e18, alice);
        uint256 id = queue.sendDeposits();
        bridge.arriveOnHyperEvm();
        KntqStakeAgent agent = _agent(DEPOSIT, id);
        (bool staked,) = agent.stake{value: FEE}(GAS, GAS_PRICE, 0.001 ether);
        assertFalse(staked);
        assertEq(vault.totalSupply(), 0);
        bridge.arriveOnElysium();
        queue.claim(DEPOSIT, id, alice);
        assertEq(kntq.balanceOf(alice), 100_000e18);
    }

    // ------------------------------------------------------------------ unstaking to Elysium

    function test_UnstakeToElysium_SevenDaysThenKntq() public {
        vm.prank(alice);
        queue.deposit(600e18, alice);
        vm.prank(bob);
        queue.deposit(400e18, bob);
        _runDeposits();
        queue.claim(DEPOSIT, 0, alice);
        queue.claim(DEPOSIT, 0, bob);
        vm.warp(block.timestamp + 90 days);
        _rewards(50e18); // +5% while they are staked

        vm.startPrank(alice);
        share.approve(address(queue), type(uint256).max);
        queue.requestExit(600e18, alice);
        vm.stopPrank();
        assertEq(share.balanceOf(alice), 0);
        uint256 id = queue.sendExits();
        assertEq(share.totalSupply(), 400e18, "alice's liquidKNTQ left Elysium");

        bridge.arriveOnHyperEvm();
        KntqStakeAgent agent = _agent(EXIT, id);
        assertEq(vault.balanceOf(address(agent)), 600e18);
        (uint256 requestId, uint256 due) = agent.startExit();
        assertEq(requestId, 1);
        // 600 of 1,000 liquidKNTQ, of 1,050 KNTQ, less the 20% fee on the 50 of yield
        assertApproxEqAbs(due, 600e18 + 30e18 * 8 / 10, 1e6, "her deposit and 80% of her yield");
        assertEq(vault.balanceOf(address(agent)), 0);

        uint256[] memory ids = new uint256[](1);
        ids[0] = requestId;
        vm.expectRevert(); // Kinetiq's delay has not passed
        agent.finishExit{value: FEE}(ids, GAS, GAS_PRICE, 0.001 ether);
        vm.warp(block.timestamp + 7 days);
        vm.prank(bot);
        uint256 home = agent.finishExit{value: FEE}(ids, GAS, GAS_PRICE, 0.001 ether);
        assertEq(home, due);

        bridge.arriveOnElysium();
        (uint256 claimable,) = queue.claimable(EXIT, id, alice);
        assertEq(claimable, due);
        queue.claim(EXIT, id, alice);
        assertEq(kntq.balanceOf(alice), 100_000e18 - 600e18 + due, "alice is back in KNTQ, with her yield");
        // bob is untouched
        assertEq(share.balanceOf(bob), 400e18);
    }

    function test_CancelAnExitBeforeItIsSent() public {
        vm.prank(alice);
        queue.deposit(1_000e18, alice);
        _runDeposits();
        queue.claim(DEPOSIT, 0, alice);
        vm.startPrank(alice);
        share.approve(address(queue), type(uint256).max);
        queue.requestExit(1_000e18, alice);
        queue.cancelExit(400e18);
        vm.stopPrank();
        assertEq(share.balanceOf(alice), 400e18);
        assertEq(queue.batch(EXIT, 0).total, 600e18);
    }

    // ------------------------------------------------------------------ arrivals in pieces, and gifts

    function test_TokensCanArriveInPieces_AndGiftsCannotStealABatch() public {
        vm.prank(alice);
        queue.deposit(750e18, alice);
        vm.prank(bob);
        queue.deposit(250e18, bob);
        uint256 id = queue.sendDeposits();

        // someone sends 4 liquidKNTQ to the batch's box before the real thing arrives (they staked on HyperEVM
        // themselves and bridged it): a gift to the batch, nothing more
        kntqL1.mint(carol, 4e18);
        vm.startPrank(carol);
        kntqL1.approve(address(vault), 4e18);
        vault.depositKntq(4e18, carol);
        vault.approve(address(bridge), 4e18);
        bridge.seed(address(vault), queue.boxOf(DEPOSIT, id), 4e18);
        vm.stopPrank();
        queue.claim(DEPOSIT, id, alice);
        assertEq(share.balanceOf(alice), 3e18, "alice's share of the gift");

        // the real liquidKNTQ arrives afterwards and is shared out in full
        bridge.arriveOnHyperEvm();
        _agent(DEPOSIT, id).stake{value: FEE}(GAS, GAS_PRICE, 0.001 ether);
        bridge.arriveOnElysium();
        queue.claim(DEPOSIT, id, alice);
        queue.claim(DEPOSIT, id, bob);
        // (to within the 1,000 wei the vault's first deposit, carol's, locked for good)
        assertApproxEqAbs(share.balanceOf(alice), 753e18, 1e6);
        assertApproxEqAbs(share.balanceOf(bob), 251e18, 1e6);
        assertLe(share.balanceOf(address(queue)), 1, "all of it was shared out");
    }

    function test_BatchesInFlightTogetherStaySeparate() public {
        vm.prank(alice);
        queue.deposit(1_000e18, alice);
        uint256 first = queue.sendDeposits();
        vm.prank(bob);
        queue.deposit(2_000e18, bob);
        uint256 second = queue.sendDeposits();
        bridge.arriveOnHyperEvm();
        // the second batch is staked first
        _agent(DEPOSIT, second).stake{value: FEE}(GAS, GAS_PRICE, 0.001 ether);
        _agent(DEPOSIT, first).stake{value: FEE}(GAS, GAS_PRICE, 0.001 ether);
        bridge.arriveOnElysium();
        queue.claim(DEPOSIT, first, alice);
        queue.claim(DEPOSIT, second, bob);
        (uint256 wrong,) = queue.claim(DEPOSIT, second, alice);
        assertEq(wrong, 0);
        // bob's batch was the vault's very first deposit, which locks 1,000 wei of shares for good; alice, coming
        // after, gets that fraction more per sKNTQ
        assertApproxEqAbs(share.balanceOf(alice), 1_000e18, 1_000);
        assertEq(share.balanceOf(bob), 2_000e18);
    }

    // ------------------------------------------------------------------ the fee

    function test_FeeIsTwentyPercentOfYield_ToCreatorAndLockedReserve() public {
        vm.prank(alice);
        queue.deposit(10_000e18, alice);
        _runDeposits();
        assertEq(vault.pendingFees(), 0);
        assertEq(vault.collectFees(), 0, "no yield, no fee");

        vm.warp(block.timestamp + 180 days);
        _rewards(500e18); // sKNTQ gains 5%: 500 KNTQ of yield on the vault's 10,000
        uint256 rate = skntq.convertToAssets(1e18);
        uint256 feeKntq = vault.pendingFees() * rate / 1e18;
        assertApproxEqAbs(feeKntq, 100e18, 1e6, "20% of the 500 KNTQ of yield");
        assertApproxEqAbs(vault.totalAssets() * vault.currentRate() / 1e18, 10_400e18, 1e6, "depositors keep 80% of it");

        uint256 collected = vault.collectFees();
        assertEq(skntq.balanceOf(address(splitter)), collected);
        splitter.distribute(address(skntq));
        assertEq(skntq.balanceOf(creator), collected * 2000 / 10_000, "20% of the fee to the creator's wallet");
        uint256 toReserve = skntq.balanceOf(address(lock));
        assertEq(toReserve, collected - collected * 2000 / 10_000, "80% on its way to the reserve");

        uint256 before = reserve.principal(address(skntq));
        lock.lock();
        assertEq(skntq.balanceOf(address(reserve)), toReserve);
        assertApproxEqAbs(reserve.principal(address(skntq)) - before, toReserve * rate / 1e18, 1e6, "locked as principal, in KNTQ terms");
        assertEq(reserve.pendingYield(address(skntq)), 0, "it does not count as yield that could flow out again");
        vm.expectRevert(SkntqLock.NothingToLock.selector);
        lock.lock();
    }

    function test_NoFeeWhileSkntqPaysNothing() public {
        vm.prank(alice);
        queue.deposit(10_000e18, alice);
        _runDeposits();
        vm.warp(block.timestamp + 365 days);
        assertEq(vault.pendingFees(), 0);
        assertEq(vault.collectFees(), 0);
        assertEq(vault.totalAssets(), 10_000e18, "a year at 0%: every sKNTQ is still the depositors'");
    }

    function test_TheRateCanOnlyCountSoFast() public {
        vm.prank(alice);
        queue.deposit(10_000e18, alice);
        _runDeposits();
        vm.warp(block.timestamp + 1 days);
        _rewards(10_000e18); // the rate doubles overnight
        // only 25% a year of it counts: for one day, 10,000 * 25% / 365 of yield, 20% of that as the fee
        uint256 feeKntq = vault.pendingFees() * vault.currentRate() / 1e18;
        assertApproxEqRel(feeKntq, uint256(10_000e18) * 2500 / 10_000 / 365 * 2000 / 10_000, 0.001e18);
    }

    // ------------------------------------------------------------------ on HyperEVM directly

    function test_OnHyperEvmDirectly_KntqInSkntqOut() public {
        kntqL1.mint(alice, 1_000e18);
        vm.startPrank(alice);
        kntqL1.approve(address(vault), 1_000e18);
        uint256 shares = vault.depositKntq(1_000e18, alice);
        assertEq(shares, 1_000e18);
        assertEq(vault.balanceOf(alice), 1_000e18);
        assertEq(vault.totalSupply(), 1_000e18 + 1_000, "the first deposit also locks 1,000 wei of shares");
        uint256 out = vault.redeem(shares, alice, alice);
        vm.stopPrank();
        assertApproxEqAbs(out, 1_000e18, 1_000);
        assertEq(skntq.balanceOf(alice), out, "leaving the vault is in sKNTQ, at once");
    }

    function test_NameSymbolAndTwoStepOwner() public {
        assertEq(vault.name(), "Liquid Reserve Staked KNTQ");
        assertEq(vault.symbol(), "liquidKNTQ");
        assertEq(vault.decimals(), 18);
        assertEq(vault.asset(), address(skntq));
        assertEq(address(vault.kntq()), address(kntqL1));
        assertEq(vault.feeRecipient(), address(splitter));
        assertEq(vault.FEE_BPS(), 2000);
        // handing the owner role on takes two steps: nothing changes until the new owner accepts
        vm.prank(owner);
        vault.transferOwnership(alice);
        assertEq(vault.owner(), owner);
        vm.prank(alice);
        vault.acceptOwnership();
        assertEq(vault.owner(), alice);
    }

    function test_NothingCanReenterTheVaultMidDeposit() public {
        HookKntq hk = new HookKntq();
        MockSkntq sk = new MockSkntq(IERC20(address(hk)));
        KntqVault v = new KntqVault(owner, IERC4626(address(sk)), address(splitter), 5_000_000e18);
        hk.mint(alice, 3_000e18);
        vm.startPrank(alice);
        hk.approve(address(v), type(uint256).max);
        v.depositKntq(1_000e18, alice);
        bytes[5] memory tries = [
            abi.encodeCall(v.deposit, (1e18, alice)),
            abi.encodeCall(v.mint, (1e18, alice)),
            abi.encodeCall(v.withdraw, (1e18, alice, alice)),
            abi.encodeCall(v.redeem, (1e18, alice, alice)),
            abi.encodeCall(v.collectFees, ())
        ];
        for (uint256 i; i < tries.length; ++i) {
            hk.arm(address(v), tries[i]);
            v.depositKntq(100e18, alice); // the hook fires inside, on the KNTQ transfer
            assertTrue(hk.called(), "the hook ran");
            assertFalse(hk.succeeded(), "and was turned away");
            assertEq(bytes4(hk.returned()), bytes4(keccak256("ReentrancyGuardReentrantCall()")));
        }
        hk.arm(address(v), abi.encodeCall(v.depositKntq, (1e18, alice)));
        v.depositKntq(100e18, alice);
        assertFalse(hk.succeeded());
        vm.stopPrank();
        assertApproxEqAbs(v.balanceOf(alice), 1_600e18, 1_000, "only the six real deposits counted"); // +dust from the 1,000 locked shares
        // and the guard lets go afterwards
        vm.prank(alice);
        v.redeem(100e18, alice, alice);
    }

    function test_OwnerCanOnlyPauseAndCap() public {
        vm.prank(alice);
        queue.deposit(1_000e18, alice);
        _runDeposits();
        queue.claim(DEPOSIT, 0, alice);
        vm.startPrank(owner);
        queue.setDepositsPaused(true);
        vault.setDepositsPaused(true);
        vm.stopPrank();
        vm.expectRevert(KntqStakeQueue.DepositsArePaused.selector);
        vm.prank(bob);
        queue.deposit(1_000e18, bob);
        // leaving still works, on both chains
        vm.startPrank(alice);
        share.approve(address(queue), type(uint256).max);
        queue.requestExit(1_000e18, alice);
        vm.stopPrank();
        vm.prank(keeper);
        uint256 id = queue.sendExits();
        bridge.arriveOnHyperEvm();
        (, uint256 due) = _agent(EXIT, id).startExit();
        assertApproxEqAbs(due, 1_000e18, 1_000);
        // nobody but the owner
        vm.expectRevert();
        vm.prank(alice);
        queue.setKeeper(alice);
        vm.expectRevert();
        vm.prank(alice);
        vault.setDepositCap(0);
    }

    function test_AgentChecks() public {
        KntqStakeAgent dep = _agent(DEPOSIT, 5);
        KntqStakeAgent exit_ = _agent(EXIT, 5);
        uint256[] memory none = new uint256[](0);
        vm.expectRevert(KntqStakeAgent.NothingHere.selector);
        dep.stake{value: FEE}(GAS, GAS_PRICE, 0.001 ether);
        vm.expectRevert(KntqStakeAgent.WrongKind.selector);
        dep.startExit();
        vm.expectRevert(KntqStakeAgent.WrongKind.selector);
        dep.finishExit{value: FEE}(none, GAS, GAS_PRICE, 0.001 ether);
        vm.expectRevert(KntqStakeAgent.WrongKind.selector);
        exit_.stake{value: FEE}(GAS, GAS_PRICE, 0.001 ether);
        vm.expectRevert(KntqStakeAgent.NothingHere.selector);
        exit_.startExit();
        // a caller cannot starve the bridge ticket of gas
        kntqL1.mint(address(dep), 1_000e18);
        vm.expectRevert(KntqStakeAgent.GasTooLow.selector);
        dep.stake{value: FEE}(GAS - 1, GAS_PRICE, 0.001 ether);
        vm.expectRevert(KntqStakeAgent.GasTooLow.selector);
        dep.stake{value: FEE}(GAS, GAS_PRICE - 1, 0.001 ether);
    }
}
