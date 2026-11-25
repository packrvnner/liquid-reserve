// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {GuardedSwap} from "./base/GuardedSwap.sol";
import {SwapConfig} from "./SwapConfig.sol";
import {LiquidReserveStaking} from "./LiquidReserveStaking.sol";

/// @title YieldRouter
/// @notice Receives all yield harvested from the Locked Reserve and splits it:
///
/// | 20% | creator payout                                         |
/// | 20% | buy $liquid and burn it                                     |
/// | 20% | compound back into the reserve (via InflowAllocator)   |
/// | 20% | ecosystem: half buys and burns KNTQ, half HYPE         |
/// | 10% | holders: buy $liquid, stream to $liquid stakers                  |
/// | 10% | liquidity: 20% buys $liquid as LP bonus, 80% to the $liquid vault|
///
/// @dev The percentages are constants. The owner (a TimelockController) can only
/// set where the 10% liquidity share goes once the $liquid vault exists (Phase 3).
/// Until both liquidity destinations are set, that share compounds into the reserve.
contract YieldRouter is GuardedSwap, ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    /// @notice Where bought KNTQ and HYPE are burned.
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    uint16 public constant CREATOR_BPS = 2_000;
    uint16 public constant BURN_LIQUID_RESERVE_BPS = 2_000;
    uint16 public constant COMPOUND_BPS = 2_000;
    uint16 public constant ECOSYSTEM_BPS = 2_000;
    uint16 public constant HOLDERS_BPS = 1_000;
    uint16 public constant LIQUIDITY_BPS = 1_000;
    /// @notice Part of the liquidity share that buys $liquid as a bonus for $liquid vault depositors.
    uint16 public constant LP_BONUS_BPS = 2_000;

    address public immutable creatorPayout;
    address public immutable allocator;
    LiquidReserveStaking public immutable staking;
    address public immutable liquidReserve;
    address public immutable kntq;
    address public immutable whype;
    /// @notice Where bought $liquid is burned. Ascend tokens reject 0x...dEaD, so on
    /// Elysium this is Ascend's BurnSink (a contract that reverts on every call
    /// and can never move tokens out).
    address public immutable liquidReserveBurnSink;

    address public liquidityVault;
    address public lpBonusRecipient;

    struct Split {
        uint256 creator;
        uint256 burnLiquidReserve;
        uint256 compound;
        uint256 ecosystemKntq;
        uint256 ecosystemHype;
        uint256 holders;
        uint256 lpBonus;
        uint256 liquidity;
    }

    event Routed(address indexed token, uint256 amountIn, Split split);
    event LiquidityDestinationsSet(address indexed liquidityVault, address indexed lpBonusRecipient);

    error NothingToRoute();

    constructor(
        SwapConfig swapConfig_,
        address owner_,
        address creatorPayout_,
        address allocator_,
        LiquidReserveStaking staking_,
        address liquidReserve_,
        address kntq_,
        address whype_,
        address liquidReserveBurnSink_
    ) GuardedSwap(swapConfig_) Ownable(owner_) {
        if (
            creatorPayout_ == address(0) || allocator_ == address(0) || address(staking_) == address(0)
                || liquidReserve_ == address(0) || kntq_ == address(0) || whype_ == address(0) || liquidReserveBurnSink_ == address(0)
        ) revert ZeroAddress();
        liquidReserveBurnSink = liquidReserveBurnSink_;
        creatorPayout = creatorPayout_;
        allocator = allocator_;
        staking = staking_;
        liquidReserve = liquidReserve_;
        kntq = kntq_;
        whype = whype_;
    }

    /// @notice Splits this contract's whole balance of `token` through the waterfall.
    function route(address token) external nonReentrant returns (Split memory s) {
        s = _route(token, type(uint256).max);
    }

    /// @notice Same as `route`, but processes at most `maxAmount`, so a large
    /// balance can go through a thin pool in pieces within the slippage limit.
    function routePartial(address token, uint256 maxAmount) external nonReentrant returns (Split memory s) {
        s = _route(token, maxAmount);
    }

    function _route(address token, uint256 maxAmount) private returns (Split memory s) {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > maxAmount) bal = maxAmount;
        if (bal == 0) revert NothingToRoute();

        uint256 creatorAmt = bal * CREATOR_BPS / BPS;
        uint256 burnAmt = bal * BURN_LIQUID_RESERVE_BPS / BPS;
        uint256 compoundAmt = bal * COMPOUND_BPS / BPS;
        uint256 ecoAmt = bal * ECOSYSTEM_BPS / BPS;
        uint256 holdersAmt = bal * HOLDERS_BPS / BPS;
        uint256 liquidityAmt = bal - creatorAmt - burnAmt - compoundAmt - ecoAmt - holdersAmt;

        // 20% creator payout (converted by CreatorPayout)
        if (creatorAmt > 0) IERC20(token).safeTransfer(creatorPayout, creatorAmt);
        s.creator = creatorAmt;

        // 20% buy and burn $liquid
        s.burnLiquidReserve = _swapTo(token, liquidReserve, burnAmt, liquidReserveBurnSink);

        // 20% ecosystem: half KNTQ, half HYPE, both burned
        (s.ecosystemKntq, s.ecosystemHype) = _routeEcosystem(token, ecoAmt);

        // 10% holders: buy $liquid, stream to stakers
        s.holders = _routeHolders(token, holdersAmt);

        // 10% liquidity, or compound until the $liquid vault exists
        uint256 unrouted;
        (s.lpBonus, s.liquidity, unrouted) = _routeLiquidity(token, liquidityAmt);

        // 20% (+ liquidity share if no vault yet) compounds into the reserve
        compoundAmt += unrouted;
        if (compoundAmt > 0) IERC20(token).safeTransfer(allocator, compoundAmt);
        s.compound = compoundAmt;

        emit Routed(token, bal, s);
    }

    function _routeEcosystem(address token, uint256 amount) private returns (uint256 kntqBurned, uint256 hypeBurned) {
        uint256 half = amount / 2;
        kntqBurned = _swapTo(token, kntq, half, BURN_ADDRESS);
        hypeBurned = _swapTo(token, whype, amount - half, BURN_ADDRESS);
    }

    function _routeHolders(address token, uint256 amount) private returns (uint256 liquidReserveForStakers) {
        liquidReserveForStakers = _swapTo(token, liquidReserve, amount, address(this));
        if (liquidReserveForStakers > 0) {
            IERC20(liquidReserve).forceApprove(address(staking), liquidReserveForStakers);
            staking.notifyRewardAmount(liquidReserveForStakers);
        }
    }

    /// @return lpBonus $liquid sent to the LP bonus recipient
    /// @return toVault amount of `token` sent to the liquidity vault
    /// @return unrouted amount left for compounding (all of it, if no vault is set)
    function _routeLiquidity(address token, uint256 amount)
        private
        returns (uint256 lpBonus, uint256 toVault, uint256 unrouted)
    {
        address vault = liquidityVault;
        address bonusTo = lpBonusRecipient;
        if (vault == address(0) || bonusTo == address(0)) return (0, 0, amount);

        uint256 bonusAmt = amount * LP_BONUS_BPS / BPS;
        lpBonus = _swapTo(token, liquidReserve, bonusAmt, bonusTo);
        toVault = amount - bonusAmt;
        if (toVault > 0) IERC20(token).safeTransfer(vault, toVault);
    }

    /// @notice Sets where the 10% liquidity share goes (Phase 3). Setting either
    /// to address(0) sends that share back to compounding.
    function setLiquidityDestinations(address liquidityVault_, address lpBonusRecipient_) external onlyOwner {
        liquidityVault = liquidityVault_;
        lpBonusRecipient = lpBonusRecipient_;
        emit LiquidityDestinationsSet(liquidityVault_, lpBonusRecipient_);
    }
}
