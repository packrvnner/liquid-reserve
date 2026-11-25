// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockRateToken} from "./mocks/MockRateToken.sol";
import {MockOracle} from "./mocks/MockOracle.sol";
import {MockSwapper} from "./mocks/MockSwapper.sol";
import {SwapConfig} from "../src/SwapConfig.sol";
import {ISwapper} from "../src/interfaces/ISwapper.sol";
import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";
import {IRateProvider} from "../src/interfaces/IRateProvider.sol";
import {LiquidReserveStaking} from "../src/LiquidReserveStaking.sol";
import {CreatorPayout} from "../src/CreatorPayout.sol";
import {InflowAllocator} from "../src/InflowAllocator.sol";
import {YieldRouter} from "../src/YieldRouter.sol";
import {LockedReserve} from "../src/LockedReserve.sol";
import {FeeSplitter} from "../src/FeeSplitter.sol";

/// @notice Deploys the full Phase 1 system against mock tokens, oracle and swapper.
/// All prices default to $1 so amounts are easy to check; tests override them.
abstract contract Fixture is Test {
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address internal constant LR_BURN_SINK = address(0xB0B5);

    MockERC20 internal kntq;
    MockERC20 internal lr;
    MockERC20 internal usdc;
    MockERC20 internal whype;
    MockRateToken internal khype;
    MockRateToken internal skntq;

    MockOracle internal oracle;
    MockSwapper internal swapper;
    SwapConfig internal cfg;

    LiquidReserveStaking internal staking;
    CreatorPayout internal creatorPayout;
    InflowAllocator internal allocator;
    YieldRouter internal yieldRouter;
    LockedReserve internal reserve;
    FeeSplitter internal feeRouter;

    address internal timelock = makeAddr("timelock");
    address internal creator = makeAddr("creator");

    function setUp() public virtual {
        kntq = new MockERC20("Kinetiq", "KNTQ", 18);
        lr = new MockERC20("Liquid Reserve", "LR", 18);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        whype = new MockERC20("Wrapped HYPE", "WHYPE", 18);
        khype = new MockRateToken("Kinetiq Staked HYPE", "kHYPE");
        skntq = new MockRateToken("Staked KNTQ", "sKNTQ");

        oracle = new MockOracle();
        address[6] memory tokens =
            [address(kntq), address(lr), address(usdc), address(whype), address(khype), address(skntq)];
        for (uint256 i; i < tokens.length; ++i) {
            oracle.setPrice(tokens[i], 1e18);
        }
        swapper = new MockSwapper(oracle);
        cfg = new SwapConfig(timelock, ISwapper(address(swapper)), IPriceOracle(address(oracle)), 100);

        staking = new LiquidReserveStaking(lr);
        creatorPayout = new CreatorPayout(cfg, creator, address(usdc), address(whype), address(kntq), address(lr));

        // allocator -> yieldRouter -> reserve form a cycle of immutables, so the
        // reserve's address is predicted before it is deployed.
        uint64 nonce = vm.getNonce(address(this));
        address predictedReserve = vm.computeCreateAddress(address(this), nonce + 2);
        allocator = new InflowAllocator(
            cfg,
            LockedReserve(predictedReserve),
            [address(khype), address(skntq), address(lr)],
            [predictedReserve, predictedReserve, predictedReserve]
        );
        yieldRouter = new YieldRouter(
            cfg,
            timelock,
            address(creatorPayout),
            address(allocator),
            staking,
            address(lr),
            address(kntq),
            address(whype),
            LR_BURN_SINK
        );
        reserve = new LockedReserve(
            [address(khype), address(skntq), address(lr)],
            [IRateProvider(address(khype)), IRateProvider(address(skntq)), IRateProvider(address(0))],
            address(yieldRouter)
        );
        assertEq(address(reserve), predictedReserve, "reserve address prediction");

        feeRouter = new FeeSplitter(address(creatorPayout), 2_000, address(allocator));
    }

    function _depositToReserve(address asset, uint256 amount) internal returns (uint256 underlying) {
        MockERC20(asset).mint(address(this), amount);
        MockERC20(asset).approve(address(reserve), amount);
        underlying = reserve.deposit(asset, amount);
    }
}
