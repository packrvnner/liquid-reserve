// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {UniswapV4Swapper} from "../src/adapters/UniswapV4Swapper.sol";
import {V4TwapOracle} from "../src/adapters/V4TwapOracle.sol";
import {TwapRateProvider} from "../src/adapters/TwapRateProvider.sol";
import {ISwapper} from "../src/interfaces/ISwapper.sol";
import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";
import {IRateProvider} from "../src/interfaces/IRateProvider.sol";
import {SwapConfig} from "../src/SwapConfig.sol";
import {LiquidReserveStaking} from "../src/LiquidReserveStaking.sol";
import {CreatorPayout} from "../src/CreatorPayout.sol";
import {InflowAllocator} from "../src/InflowAllocator.sol";
import {YieldRouter} from "../src/YieldRouter.sol";
import {LockedReserve} from "../src/LockedReserve.sol";
import {FeeSplitter} from "../src/FeeSplitter.sol";
import {FeeInbox} from "../src/FeeInbox.sol";
import {BridgeOut} from "../src/bridge/BridgeOut.sol";
import {StakeAndLock} from "../src/hyperevm/StakeAndLock.sol";
import {YieldUnstakeBridge} from "../src/hyperevm/YieldUnstakeBridge.sol";
import {ERC4626RateProvider} from "../src/adapters/ERC4626RateProvider.sol";
import {ISkntq} from "../src/interfaces/ISkntq.sol";
import {IL1GatewayRouter, IL2GatewayRouter} from "../src/interfaces/IArbitrumGateway.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {LiquidityVault} from "../src/vaults/LiquidityVault.sol";

interface IAscendLaunchpad {
    function currentFee(PoolId id) external view returns (uint24);
}

/// @notice Elysium mainnet (chain 99901) addresses, verified on-chain 2026-11-13.
library Elysium {
    uint256 internal constant CHAIN_ID = 99901;
    IPoolManager internal constant POOL_MANAGER = IPoolManager(0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1);
    address internal constant WHYPE = 0xbA876237B0F021A6c6D852d6c26E107997cC5E81;
    address internal constant USDC = 0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65;
    address internal constant KNTQ = 0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0;
    /// @dev Bridged kHYPE (gateway router's L2 address for HyperEVM kHYPE).
    address internal constant KHYPE = 0x248888D396A546A69A188f3Deb476964e581E9d0;
    address internal constant ASCEND_LAUNCHPAD = 0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC;
    address internal constant ASCEND_BURN_SINK = 0x9F0b0e3B362937b07Cd1E869b50687961e0c7741;
    address internal constant KHYPE_POOL_HOOK = 0x8129bab872318a64B0e6212C6C491feED06C3de3;
    address internal constant L2_GATEWAY_ROUTER = 0x61EbbC3A29f1970aF2Ce862bA9c5364832E14d17;
    /// @dev KNTQ's address on HyperEVM (the bridge's L1 token).
    address internal constant KNTQ_ON_HYPEREVM = 0x000000000000780555bD0BCA3791f89f9542c2d6;
    /// @dev Payout wallet given in the design (MECHANISM.md §6.1). Override with PAYOUT_ADDRESS.
    address internal constant DEFAULT_PAYOUT = 0x822aA88543b9da39c4c3D856857379E17526C1E8;
}

/// @notice HyperEVM mainnet (chain 999) addresses, verified on-chain 2026-11-13.
library HyperEvm {
    uint256 internal constant CHAIN_ID = 999;
    /// @dev Kinetiq staked KNTQ (ERC-4626 over KNTQ, 7-day withdrawal).
    address internal constant SKNTQ = 0x696238e0Ca31c94e24ca4CBe7921754E172E4d0F;
    address internal constant L1_GATEWAY_ROUTER = 0x5D24f760DD7664b4214bDD4B04a3f62B9edd68c0;
    /// @dev Floors for the Elysium bridge ticket (Elysium's base fee is 0.5 gwei).
    uint256 internal constant MIN_BRIDGE_GAS = 300_000;
    uint256 internal constant MIN_BRIDGE_GAS_PRICE = 0.5 gwei;
}

/// @notice Shared deployment logic for Liquid Reserve on Elysium.
abstract contract LiquidReserveDeployer is Script {
    using StateLibrary for IPoolManager;

    struct Config {
        address liquidReserve; // $liquid token (exists only after the Ascend launch)
        address feeInbox; // the address given to Ascend as creator-fee recipient
        address stakeAndLock; // StakeAndLock on HyperEVM (from DeployHyperEvm)
        uint256 bridgeMinAmount; // smallest KNTQ batch BridgeOut will send
        address payoutAddress;
        address keeper; // oracle poker / flywheel runner
        address timelockProposer; // should be a Safe multisig
        uint256 timelockDelay;
        uint16 maxSlippageBps;
    }

    struct Deployed {
        TimelockController timelock;
        UniswapV4Swapper swapper;
        V4TwapOracle oracle;
        SwapConfig swapConfig;
        LiquidReserveStaking staking;
        CreatorPayout creatorPayout;
        TwapRateProvider khypeRate;
        InflowAllocator allocator;
        YieldRouter yieldRouter;
        LockedReserve reserve;
        FeeSplitter feeRouter;
        BridgeOut bridgeOut;
        LiquidityVault vaultHypeUsdc;
        LiquidityVault vaultHypeKntq;
    }

    // Pools (see README "Elysium routes").
    PoolKey internal kntqHype; // native HYPE / KNTQ, 0.3%
    PoolKey internal usdcHype; // native HYPE / USDC, 0.3%
    PoolKey internal khypeWhype; // kHYPE / WHYPE, dynamic fee, hook
    PoolKey internal lrKntq; // $liquid / KNTQ, Ascend hook

    function _deploySystem(Config memory c, address deployer) internal returns (Deployed memory d) {
        require(block.chainid == Elysium.CHAIN_ID, "not Elysium mainnet");
        require(
            c.liquidReserve != address(0) && c.feeInbox != address(0) && c.stakeAndLock != address(0),
            "LIQUID_RESERVE_TOKEN, FEE_INBOX and HYPEREVM_STAKE_AND_LOCK required"
        );
        require(FeeInbox(c.feeInbox).setter() == deployer, "deployer is not the FeeInbox setter");

        // 1. Timelock: owner of every adjustable setting.
        address[] memory roles = new address[](1);
        roles[0] = c.timelockProposer;
        d.timelock = new TimelockController(c.timelockDelay, roles, roles, address(0));

        // 2. Swap adapter and oracle, configured by the deployer, then handed to the timelock.
        d.swapper = new UniswapV4Swapper(deployer, Elysium.POOL_MANAGER, Elysium.WHYPE);
        d.oracle = new V4TwapOracle(deployer, Elysium.POOL_MANAGER, Elysium.WHYPE, 30 minutes, 60, 1 hours, 10);
        d.oracle.setKeeper(c.keeper, true);
        _setPools(c.liquidReserve);
        _setRoutes(d, c.liquidReserve);

        // 3. Core contracts.
        d.swapConfig = new SwapConfig(
            address(d.timelock), ISwapper(address(d.swapper)), IPriceOracle(address(d.oracle)), c.maxSlippageBps
        );
        d.staking = new LiquidReserveStaking(IERC20(c.liquidReserve));
        d.creatorPayout =
            new CreatorPayout(d.swapConfig, c.payoutAddress, Elysium.USDC, Elysium.WHYPE, Elysium.KNTQ, c.liquidReserve);
        d.khypeRate = new TwapRateProvider(d.oracle, khypeWhype.toId(), true);
        // KNTQ bucket: bridged to HyperEVM, staked as sKNTQ and locked there.
        d.bridgeOut = new BridgeOut(
            IL2GatewayRouter(Elysium.L2_GATEWAY_ROUTER),
            IERC20(Elysium.KNTQ),
            Elysium.KNTQ_ON_HYPEREVM,
            c.stakeAndLock,
            c.bridgeMinAmount
        );

        // allocator -> yieldRouter -> reserve reference each other; predict the reserve.
        address predictedReserve = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 2);
        d.allocator = new InflowAllocator(
            d.swapConfig,
            LockedReserve(predictedReserve),
            [Elysium.KHYPE, Elysium.KNTQ, c.liquidReserve],
            [predictedReserve, address(d.bridgeOut), predictedReserve]
        );
        d.yieldRouter = new YieldRouter(
            d.swapConfig,
            address(d.timelock),
            address(d.creatorPayout),
            address(d.allocator),
            d.staking,
            c.liquidReserve,
            Elysium.KNTQ,
            Elysium.WHYPE,
            Elysium.ASCEND_BURN_SINK
        );
        // Elysium reserve assets: kHYPE, $liquid. (Staked KNTQ is locked on HyperEVM.)
        d.reserve = new LockedReserve(
            [Elysium.KHYPE, c.liquidReserve, address(0)],
            [IRateProvider(address(d.khypeRate)), IRateProvider(address(0)), IRateProvider(address(0))],
            address(d.yieldRouter)
        );
        require(address(d.reserve) == predictedReserve, "reserve address prediction failed");
        d.feeRouter = new FeeSplitter(address(d.creatorPayout), 2_000, address(d.allocator));

        // 4. Hand over and wire up.
        d.swapper.transferOwnership(address(d.timelock)); // timelock must acceptOwnership()
        d.oracle.transferOwnership(address(d.timelock)); // timelock must acceptOwnership()
        FeeInbox(c.feeInbox).setTarget(address(d.feeRouter));

        // 5. Auto-compounding vaults on hookless Elysium pools. Performance fees go
        //    to the FeeRouter (80% reserve / 20% creator). Launch with deposit caps.
        d.vaultHypeUsdc = _vault(d, deployer, usdcHype, "Liquid Reserve Vault HYPE-USDC", "lrvHYPE-USDC", 50_000e6);
        d.vaultHypeKntq = _vault(d, deployer, kntqHype, "Liquid Reserve Vault HYPE-KNTQ", "lrvHYPE-KNTQ", 175_000e18);
    }

    function _vault(Deployed memory d, address deployer, PoolKey memory key, string memory name, string memory symbol, uint256 cap)
        internal
        returns (LiquidityVault v)
    {
        v = new LiquidityVault(
            LiquidityVault.Params({
                key: key,
                poolManager: Elysium.POOL_MANAGER,
                feeRecipient: address(d.feeRouter),
                whype: Elysium.WHYPE,
                owner: deployer,
                keeper: deployer, // the owner points this at the keeper bot with setKeeper()
                name: name,
                symbol: symbol,
                mainWidth: 30,
                altWidth: 30,
                depositCap: cap
            })
        );
        v.transferOwnership(address(d.timelock)); // timelock must acceptOwnership()
    }

    function _setPools(address liquidReserve) internal {
        kntqHype = PoolKey(Currency.wrap(address(0)), Currency.wrap(Elysium.KNTQ), 3000, 60, IHooks(address(0)));
        usdcHype = PoolKey(Currency.wrap(address(0)), Currency.wrap(Elysium.USDC), 3000, 60, IHooks(address(0)));
        khypeWhype = PoolKey(
            Currency.wrap(Elysium.KHYPE), Currency.wrap(Elysium.WHYPE), 0x800000, 1, IHooks(Elysium.KHYPE_POOL_HOOK)
        );
        (address a, address b) = liquidReserve < Elysium.KNTQ ? (liquidReserve, Elysium.KNTQ) : (Elysium.KNTQ, liquidReserve);
        lrKntq = PoolKey(Currency.wrap(a), Currency.wrap(b), 0x800000, 200, IHooks(Elysium.ASCEND_LAUNCHPAD));
    }

    /// Every conversion the allocator, yield router and creator payout need.
    function _setRoutes(Deployed memory d, address liquidReserve) internal {
        address K = Elysium.KNTQ;
        address KH = Elysium.KHYPE;
        address W = Elysium.WHYPE;
        address U = Elysium.USDC;
        // Allocator: inflows -> kHYPE / KNTQ / $liquid
        _route(d, K, KH, _p(kntqHype, khypeWhype));
        _route(d, K, liquidReserve, _p(lrKntq));
        _route(d, KH, K, _p(khypeWhype, kntqHype));
        _route(d, KH, liquidReserve, _p(khypeWhype, kntqHype, lrKntq));
        _route(d, liquidReserve, KH, _p(lrKntq, kntqHype, khypeWhype));
        _route(d, liquidReserve, K, _p(lrKntq));
        // Creator payout and burns: -> USDC / HYPE
        _route(d, K, U, _p(kntqHype, usdcHype));
        _route(d, K, W, _p(kntqHype));
        _route(d, KH, U, _p(khypeWhype, usdcHype));
        _route(d, KH, W, _p(khypeWhype));
        _route(d, liquidReserve, U, _p(lrKntq, kntqHype, usdcHype));
        _route(d, liquidReserve, W, _p(lrKntq, kntqHype));
        // Vault performance fees arrive as WHYPE and USDC.
        _route(d, W, KH, _p(khypeWhype));
        _route(d, W, K, _p(kntqHype));
        _route(d, W, liquidReserve, _p(kntqHype, lrKntq));
        _route(d, W, U, _p(usdcHype));
        _route(d, U, W, _p(usdcHype));
        _route(d, U, KH, _p(usdcHype, khypeWhype));
        _route(d, U, K, _p(usdcHype, kntqHype));
        _route(d, U, liquidReserve, _p(usdcHype, kntqHype, lrKntq));
    }

    /// Sets the same path on the swapper and the oracle, working out each hop's
    /// direction and fee.
    function _route(Deployed memory d, address tokenIn, address tokenOut, PoolKey[] memory path) internal {
        UniswapV4Swapper.Hop[] memory hops = new UniswapV4Swapper.Hop[](path.length);
        PoolId[] memory ids = new PoolId[](path.length);
        uint24[] memory fees = new uint24[](path.length);
        address current = tokenIn;
        for (uint256 i; i < path.length; ++i) {
            address t0 = _asToken(path[i].currency0);
            address t1 = _asToken(path[i].currency1);
            bool zeroForOne = current == t0;
            require(zeroForOne || current == t1, "route does not connect");
            hops[i].kind = UniswapV4Swapper.HopKind.V4_SWAP;
            hops[i].key = path[i];
            hops[i].zeroForOne = zeroForOne;
            ids[i] = path[i].toId();
            fees[i] = _feeOf(path[i]);
            (,, uint32 lastTime,,,,) = d.oracle.feeds(ids[i]);
            if (lastTime == 0) d.oracle.addFeed(path[i]);
            current = zeroForOne ? t1 : t0;
        }
        d.swapper.setRoute(tokenIn, tokenOut, hops);
        d.oracle.setRoute(tokenIn, tokenOut, ids, fees);
    }

    function _feeOf(PoolKey memory key) internal view returns (uint24) {
        if (address(key.hooks) == Elysium.ASCEND_LAUNCHPAD) {
            return IAscendLaunchpad(Elysium.ASCEND_LAUNCHPAD).currentFee(key.toId());
        }
        if (key.fee == 0x800000) {
            (,,, uint24 lpFee) = Elysium.POOL_MANAGER.getSlot0(key.toId());
            return lpFee;
        }
        return key.fee;
    }

    function _asToken(Currency c) internal pure returns (address) {
        return c.isAddressZero() ? Elysium.WHYPE : Currency.unwrap(c);
    }

    function _p(PoolKey memory a) internal pure returns (PoolKey[] memory p) {
        p = new PoolKey[](1);
        p[0] = a;
    }

    function _p(PoolKey memory a, PoolKey memory b) internal pure returns (PoolKey[] memory p) {
        p = new PoolKey[](2);
        p[0] = a;
        p[1] = b;
    }

    function _p(PoolKey memory a, PoolKey memory b, PoolKey memory c) internal pure returns (PoolKey[] memory p) {
        p = new PoolKey[](3);
        p[0] = a;
        p[1] = b;
        p[2] = c;
    }

    function _configFromEnv(address deployer) internal view returns (Config memory c) {
        c.liquidReserve = vm.envAddress("LIQUID_RESERVE_TOKEN");
        c.feeInbox = vm.envAddress("FEE_INBOX");
        c.stakeAndLock = vm.envAddress("HYPEREVM_STAKE_AND_LOCK");
        c.bridgeMinAmount = vm.envOr("BRIDGE_MIN_KNTQ", uint256(1_000e18));
        c.payoutAddress = vm.envOr("PAYOUT_ADDRESS", Elysium.DEFAULT_PAYOUT);
        c.keeper = vm.envOr("KEEPER", deployer);
        c.timelockProposer = vm.envAddress("TIMELOCK_PROPOSER");
        c.timelockDelay = vm.envOr("TIMELOCK_DELAY", uint256(48 hours));
        c.maxSlippageBps = uint16(vm.envOr("MAX_SLIPPAGE_BPS", uint256(100)));
    }

    function _log(Config memory c, Deployed memory d) internal pure {
        console2.log("TimelockController :", address(d.timelock));
        console2.log("UniswapV4Swapper   :", address(d.swapper));
        console2.log("V4TwapOracle       :", address(d.oracle));
        console2.log("SwapConfig         :", address(d.swapConfig));
        console2.log("LiquidReserveStaking          :", address(d.staking));
        console2.log("CreatorPayout      :", address(d.creatorPayout));
        console2.log("kHYPE rate provider:", address(d.khypeRate));
        console2.log("InflowAllocator    :", address(d.allocator));
        console2.log("YieldRouter        :", address(d.yieldRouter));
        console2.log("LockedReserve      :", address(d.reserve));
        console2.log("FeeRouter          :", address(d.feeRouter));
        console2.log("BridgeOut (KNTQ)   :", address(d.bridgeOut));
        console2.log("Vault HYPE-USDC    :", address(d.vaultHypeUsdc));
        console2.log("Vault HYPE-KNTQ    :", address(d.vaultHypeKntq));
        console2.log("  -> HyperEVM StakeAndLock:", c.stakeAndLock);
        console2.log("FeeInbox -> target :", c.feeInbox);
        console2.log("Payout address     :", c.payoutAddress);
        console2.log("NEXT: the timelock must call acceptOwnership() on the swapper, the oracle and both vaults.");
        console2.log("NEXT: keeper pokes the oracle for 30+ min before the first allocate/route/payout.");
        console2.log("NEXT: on HyperEVM, run SetHyperEvmYieldRecipient with ELYSIUM_YIELD_ROUTER =", address(d.yieldRouter));
    }
}

/// @notice Step 1, BEFORE launching $liquid on Ascend. Give the printed address to
/// Ascend as the creator-fee payout recipient.
///   forge script script/Deploy.s.sol:DeployInbox --rpc-url elysium --account <keystore> --broadcast
contract DeployInbox is Script {
    function run() external returns (FeeInbox inbox) {
        require(block.chainid == Elysium.CHAIN_ID, "not Elysium mainnet");
        vm.startBroadcast();
        inbox = new FeeInbox(msg.sender);
        vm.stopBroadcast();
        console2.log("FeeInbox:", address(inbox), "setter:", msg.sender);
    }
}

/// @notice Step 2, AFTER the Ascend launch, from the same deployer as step 1.
///   LIQUID_RESERVE_TOKEN=0x... FEE_INBOX=0x... TIMELOCK_PROPOSER=<safe> \
///   forge script script/Deploy.s.sol:DeploySystem --rpc-url elysium --account <keystore> --broadcast
contract DeploySystem is LiquidReserveDeployer {
    function run() external returns (Deployed memory d) {
        Config memory c = _configFromEnv(msg.sender);
        vm.startBroadcast();
        d = _deploySystem(c, msg.sender);
        vm.stopBroadcast();
        _log(c, d);
    }
}

/// @notice Dry run of steps 1 and 2 on a fork, with an existing Ascend coin
/// standing in for $liquid. Sends nothing.
///   forge script script/Deploy.s.sol:SimulateOnFork --fork-url elysium
contract SimulateOnFork is LiquidReserveDeployer {
    function run() external returns (Deployed memory d) {
        address deployer = msg.sender;
        vm.deal(deployer, 10 ether); // gas for the simulation only
        Config memory c;
        c.liquidReserve = vm.envOr("LIQUID_RESERVE_TOKEN", address(0x75E2fF9730AC84eb995D7733971821E9125c7f38));
        c.payoutAddress = vm.envOr("PAYOUT_ADDRESS", Elysium.DEFAULT_PAYOUT);
        c.keeper = deployer;
        c.timelockProposer = deployer;
        c.stakeAndLock = vm.envOr("HYPEREVM_STAKE_AND_LOCK", address(0x5AFE)); // placeholder on a fork
        c.bridgeMinAmount = 1_000e18;
        c.timelockDelay = 48 hours;
        c.maxSlippageBps = 100;

        vm.startBroadcast(deployer);
        c.feeInbox = address(new FeeInbox(deployer));
        d = _deploySystem(c, deployer);
        vm.stopBroadcast();
        _log(c, d);
    }
}

/// @notice Step 0, on HyperEVM: the staked-KNTQ side of the reserve.
///   forge script script/Deploy.s.sol:DeployHyperEvm --rpc-url hyperevm --account <keystore> --broadcast
/// Dry run: forge script script/Deploy.s.sol:DeployHyperEvm --fork-url hyperevm
contract DeployHyperEvm is Script {
    struct HyperEvmDeployed {
        ERC4626RateProvider skntqRate;
        YieldUnstakeBridge yieldBridge;
        LockedReserve reserve;
        StakeAndLock stakeAndLock;
    }

    function run() external returns (HyperEvmDeployed memory d) {
        require(block.chainid == HyperEvm.CHAIN_ID, "not HyperEVM mainnet");
        vm.startBroadcast();
        d.skntqRate = new ERC4626RateProvider(IERC4626(HyperEvm.SKNTQ));
        d.yieldBridge = new YieldUnstakeBridge(
            ISkntq(HyperEvm.SKNTQ),
            IL1GatewayRouter(HyperEvm.L1_GATEWAY_ROUTER),
            msg.sender,
            HyperEvm.MIN_BRIDGE_GAS,
            HyperEvm.MIN_BRIDGE_GAS_PRICE
        );
        d.reserve = new LockedReserve(
            [HyperEvm.SKNTQ, address(0), address(0)],
            [IRateProvider(address(d.skntqRate)), IRateProvider(address(0)), IRateProvider(address(0))],
            address(d.yieldBridge)
        );
        d.stakeAndLock = new StakeAndLock(IERC4626(HyperEvm.SKNTQ), d.reserve);
        vm.stopBroadcast();

        console2.log("sKNTQ rate provider   :", address(d.skntqRate));
        console2.log("YieldUnstakeBridge    :", address(d.yieldBridge));
        console2.log("LockedReserve (sKNTQ) :", address(d.reserve));
        console2.log("StakeAndLock          :", address(d.stakeAndLock));
        console2.log("NEXT: use StakeAndLock as HYPEREVM_STAKE_AND_LOCK in DeploySystem on Elysium.");
    }
}

/// @notice Last step, on HyperEVM: point the yield bridge at the Elysium
/// YieldRouter (once, from the same deployer as DeployHyperEvm).
///   YIELD_BRIDGE=0x... ELYSIUM_YIELD_ROUTER=0x... \
///   forge script script/Deploy.s.sol:SetHyperEvmYieldRecipient --rpc-url hyperevm --account <keystore> --broadcast
contract SetHyperEvmYieldRecipient is Script {
    function run() external {
        require(block.chainid == HyperEvm.CHAIN_ID, "not HyperEVM mainnet");
        YieldUnstakeBridge bridge = YieldUnstakeBridge(vm.envAddress("YIELD_BRIDGE"));
        address router = vm.envAddress("ELYSIUM_YIELD_ROUTER");
        vm.startBroadcast();
        bridge.setL2Recipient(router);
        vm.stopBroadcast();
        console2.log("YieldUnstakeBridge now bridges to Elysium YieldRouter:", router);
    }
}
