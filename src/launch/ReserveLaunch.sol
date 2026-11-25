// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {UniswapV4Swapper} from "../adapters/UniswapV4Swapper.sol";
import {V4TwapOracle} from "../adapters/V4TwapOracle.sol";
import {TwapRateProvider} from "../adapters/TwapRateProvider.sol";
import {ERC4626RateProvider} from "../adapters/ERC4626RateProvider.sol";
import {ISwapper} from "../interfaces/ISwapper.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";
import {IRateProvider} from "../interfaces/IRateProvider.sol";
import {ISkntq} from "../interfaces/ISkntq.sol";
import {IL1GatewayRouter, IL2GatewayRouter} from "../interfaces/IArbitrumGateway.sol";
import {SwapConfig} from "../SwapConfig.sol";
import {InflowAllocator} from "../InflowAllocator.sol";
import {LockedReserve} from "../LockedReserve.sol";
import {FeeSplitter} from "../FeeSplitter.sol";
import {FeeInbox} from "../FeeInbox.sol";
import {BridgeOut} from "../bridge/BridgeOut.sol";
import {StakeAndLock} from "../hyperevm/StakeAndLock.sol";
import {YieldUnstakeBridge} from "../hyperevm/YieldUnstakeBridge.sol";

// The reserve before the $liquid token exists.
//
// Vault fees are split 20% creator / 80% reserve. The reserve's 80% is split
// 40 / 40 / 20: kHYPE is bought and locked on Elysium, KNTQ is bought, bridged
// to HyperEVM, staked as sKNTQ and locked there, and the last 20% (the $liquid
// share) is turned into USDC and parked until the token exists.
//
// Three FeeInbox contracts act as waiting rooms. Each holds what arrives until
// its target is set, once and for good:
//   creatorWait  the creator's 20%                 (target set by the owner wallet)
//   liquidWait   USDC for the $liquid share        (target set through the timelock)
//   yieldWait    what the locked assets earn       (target set through the timelock)
//
// Four deployments, each one transaction through the CREATE2 factory, so every
// address is known beforehand:
//   Elysium   ReserveLaunchA   timelock, swaps, price oracle, waiting rooms
//   HyperEVM  ReserveLaunchH1  sKNTQ rate, yield bridge (pointed at yieldWait)
//   HyperEVM  ReserveLaunchH2  sKNTQ locked reserve, stake-and-lock
//   Elysium   ReserveLaunchB   bridge out, kHYPE locked reserve, allocator, fee splitter
// The launch contracts keep no powers afterwards. A stays the owner of the swap
// adapter and oracle (so their settings are frozen) until the timelock accepts
// ownership.

library ElysiumAddrs {
    uint256 internal constant CHAIN_ID = 99901;
    IPoolManager internal constant POOL_MANAGER = IPoolManager(0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1);
    address internal constant WHYPE = 0xbA876237B0F021A6c6D852d6c26E107997cC5E81;
    address internal constant USDC = 0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65;
    address internal constant KNTQ = 0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0;
    address internal constant KHYPE = 0x248888D396A546A69A188f3Deb476964e581E9d0;
    address internal constant KHYPE_POOL_HOOK = 0x8129bab872318a64B0e6212C6C491feED06C3de3;
    address internal constant L2_GATEWAY_ROUTER = 0x61EbbC3A29f1970aF2Ce862bA9c5364832E14d17;
    address internal constant KNTQ_ON_HYPEREVM = 0x000000000000780555bD0BCA3791f89f9542c2d6;
}

library HyperEvmAddrs {
    uint256 internal constant CHAIN_ID = 999;
    address internal constant SKNTQ = 0x696238e0Ca31c94e24ca4CBe7921754E172E4d0F;
    address internal constant L1_GATEWAY_ROUTER = 0x5D24f760DD7664b4214bDD4B04a3f62B9edd68c0;
    uint256 internal constant MIN_BRIDGE_GAS = 300_000;
    uint256 internal constant MIN_BRIDGE_GAS_PRICE = 0.5 gwei;
}

error WrongChain();

/// @notice Elysium, first transaction.
contract ReserveLaunchA {
    using StateLibrary for IPoolManager;

    TimelockController public immutable timelock;
    UniswapV4Swapper public immutable swapper;
    V4TwapOracle public immutable oracle;
    SwapConfig public immutable swapConfig;
    TwapRateProvider public immutable khypeRate;
    FeeInbox public immutable creatorWait;
    FeeInbox public immutable liquidWait;
    FeeInbox public immutable yieldWait;

    constructor(address owner, address keeper, uint256 timelockDelay, uint16 maxSlippageBps) {
        if (block.chainid != ElysiumAddrs.CHAIN_ID) revert WrongChain();

        address[] memory roles = new address[](1);
        roles[0] = owner;
        timelock = new TimelockController(timelockDelay, roles, roles, address(0));

        swapper = new UniswapV4Swapper(address(this), ElysiumAddrs.POOL_MANAGER, ElysiumAddrs.WHYPE);
        oracle =
            new V4TwapOracle(address(this), ElysiumAddrs.POOL_MANAGER, ElysiumAddrs.WHYPE, 30 minutes, 60, 1 hours, 10);
        oracle.setKeeper(keeper, true);
        oracle.setKeeper(owner, true);

        PoolKey memory kntqHype = PoolKey(
            Currency.wrap(address(0)), Currency.wrap(ElysiumAddrs.KNTQ), 3000, 60, IHooks(address(0))
        );
        PoolKey memory usdcHype = PoolKey(
            Currency.wrap(address(0)), Currency.wrap(ElysiumAddrs.USDC), 3000, 60, IHooks(address(0))
        );
        PoolKey memory khypeWhype = PoolKey(
            Currency.wrap(ElysiumAddrs.KHYPE),
            Currency.wrap(ElysiumAddrs.WHYPE),
            0x800000,
            1,
            IHooks(ElysiumAddrs.KHYPE_POOL_HOOK)
        );
        address K = ElysiumAddrs.KNTQ;
        address KH = ElysiumAddrs.KHYPE;
        address W = ElysiumAddrs.WHYPE;
        address U = ElysiumAddrs.USDC;
        // Vault fees arrive as WHYPE, USDC and KNTQ; they become kHYPE, KNTQ and USDC.
        _route(W, KH, _p(khypeWhype));
        _route(W, K, _p(kntqHype));
        _route(W, U, _p(usdcHype));
        _route(U, W, _p(usdcHype));
        _route(U, KH, _p(usdcHype, khypeWhype));
        _route(U, K, _p(usdcHype, kntqHype));
        _route(K, KH, _p(kntqHype, khypeWhype));
        _route(K, U, _p(kntqHype, usdcHype));
        _route(K, W, _p(kntqHype));
        // What the locked kHYPE earns is paid out as kHYPE.
        _route(KH, K, _p(khypeWhype, kntqHype));
        _route(KH, U, _p(khypeWhype, usdcHype));
        _route(KH, W, _p(khypeWhype));

        swapConfig =
            new SwapConfig(address(timelock), ISwapper(address(swapper)), IPriceOracle(address(oracle)), maxSlippageBps);
        khypeRate = new TwapRateProvider(oracle, khypeWhype.toId(), true);

        creatorWait = new FeeInbox(owner);
        liquidWait = new FeeInbox(address(timelock));
        yieldWait = new FeeInbox(address(timelock));

        swapper.transferOwnership(address(timelock)); // the timelock must acceptOwnership()
        oracle.transferOwnership(address(timelock)); // the timelock must acceptOwnership()
    }

    /// Sets the same path on the swapper and the oracle.
    function _route(address tokenIn, address tokenOut, PoolKey[] memory path) private {
        UniswapV4Swapper.Hop[] memory hops = new UniswapV4Swapper.Hop[](path.length);
        PoolId[] memory ids = new PoolId[](path.length);
        uint24[] memory fees = new uint24[](path.length);
        address current = tokenIn;
        for (uint256 i; i < path.length; ++i) {
            address t0 = _asToken(path[i].currency0);
            address t1 = _asToken(path[i].currency1);
            bool zeroForOne = current == t0;
            hops[i].kind = UniswapV4Swapper.HopKind.V4_SWAP;
            hops[i].key = path[i];
            hops[i].zeroForOne = zeroForOne;
            ids[i] = path[i].toId();
            fees[i] = path[i].fee;
            if (fees[i] == 0x800000) (,,, fees[i]) = ElysiumAddrs.POOL_MANAGER.getSlot0(ids[i]);
            (,, uint32 lastTime,,,,) = oracle.feeds(ids[i]);
            if (lastTime == 0) oracle.addFeed(path[i]);
            current = zeroForOne ? t1 : t0;
        }
        swapper.setRoute(tokenIn, tokenOut, hops);
        oracle.setRoute(tokenIn, tokenOut, ids, fees);
    }

    function _asToken(Currency c) private pure returns (address) {
        return c.isAddressZero() ? ElysiumAddrs.WHYPE : Currency.unwrap(c);
    }

    function _p(PoolKey memory a) private pure returns (PoolKey[] memory p) {
        p = new PoolKey[](1);
        p[0] = a;
    }

    function _p(PoolKey memory a, PoolKey memory b) private pure returns (PoolKey[] memory p) {
        p = new PoolKey[](2);
        p[0] = a;
        p[1] = b;
    }
}

/// @notice Elysium, second transaction. `stakeAndLock` is the HyperEVM contract
/// that receives the bridged KNTQ (ReserveLaunchH2.stakeAndLock()).
contract ReserveLaunchB {
    BridgeOut public immutable bridgeOut;
    LockedReserve public immutable reserve;
    InflowAllocator public immutable allocator;
    FeeSplitter public immutable feeSplitter;

    constructor(ReserveLaunchA a, address stakeAndLock, uint256 bridgeMinAmount) {
        if (block.chainid != ElysiumAddrs.CHAIN_ID) revert WrongChain();
        bridgeOut = new BridgeOut(
            IL2GatewayRouter(ElysiumAddrs.L2_GATEWAY_ROUTER),
            IERC20(ElysiumAddrs.KNTQ),
            ElysiumAddrs.KNTQ_ON_HYPEREVM,
            stakeAndLock,
            bridgeMinAmount
        );
        reserve = new LockedReserve(
            [ElysiumAddrs.KHYPE, address(0), address(0)],
            [IRateProvider(address(a.khypeRate())), IRateProvider(address(0)), IRateProvider(address(0))],
            address(a.yieldWait())
        );
        // 40% kHYPE -> locked here. 40% KNTQ -> bridge -> sKNTQ locked on HyperEVM.
        // 20% USDC -> waits for the $liquid token.
        allocator = new InflowAllocator(
            a.swapConfig(),
            reserve,
            [ElysiumAddrs.KHYPE, ElysiumAddrs.KNTQ, ElysiumAddrs.USDC],
            [address(reserve), address(bridgeOut), address(a.liquidWait())]
        );
        feeSplitter = new FeeSplitter(address(a.creatorWait()), 2_000, address(allocator));
    }
}

/// @notice HyperEVM, first transaction. `l2YieldRecipient` is ReserveLaunchA.yieldWait() on Elysium.
contract ReserveLaunchH1 {
    ERC4626RateProvider public immutable skntqRate;
    YieldUnstakeBridge public immutable yieldBridge;

    constructor(address l2YieldRecipient) {
        if (block.chainid != HyperEvmAddrs.CHAIN_ID) revert WrongChain();
        skntqRate = new ERC4626RateProvider(IERC4626(HyperEvmAddrs.SKNTQ));
        yieldBridge = new YieldUnstakeBridge(
            ISkntq(HyperEvmAddrs.SKNTQ),
            IL1GatewayRouter(HyperEvmAddrs.L1_GATEWAY_ROUTER),
            address(this),
            HyperEvmAddrs.MIN_BRIDGE_GAS,
            HyperEvmAddrs.MIN_BRIDGE_GAS_PRICE
        );
        yieldBridge.setL2Recipient(l2YieldRecipient);
    }
}

/// @notice HyperEVM, second transaction.
contract ReserveLaunchH2 {
    LockedReserve public immutable reserve;
    StakeAndLock public immutable stakeAndLock;

    constructor(ReserveLaunchH1 h1) {
        if (block.chainid != HyperEvmAddrs.CHAIN_ID) revert WrongChain();
        reserve = new LockedReserve(
            [HyperEvmAddrs.SKNTQ, address(0), address(0)],
            [IRateProvider(address(h1.skntqRate())), IRateProvider(address(0)), IRateProvider(address(0))],
            address(h1.yieldBridge())
        );
        stakeAndLock = new StakeAndLock(IERC4626(HyperEvmAddrs.SKNTQ), reserve);
    }
}
