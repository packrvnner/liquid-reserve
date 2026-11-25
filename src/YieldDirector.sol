// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ISwapper} from "./interfaces/ISwapper.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {SwapConfig} from "./SwapConfig.sol";
import {LockedReserve} from "./LockedReserve.sol";

interface IDropFeeder {
    function addLiquid(uint256 amount) external returns (uint256 liquidToDrop, uint256 liquidBurned);
}

interface IRewardPool {
    function notifyRewardAmount(uint256 amount) external;
}

/// @title YieldDirector
/// @notice Decides where the reserve's yield goes.
///
/// The locked reserve only ever lets its yield out. A fifth of that yield goes to the creator. The rest arrives
/// here, as kHYPE, and `distribute` splits it between a list of destinations by shares that add up to 100%:
///
/// - Compound: it buys kHYPE (or is kHYPE already) and is locked in the reserve again.
/// - The drop: it buys $liquid, handed to the drop feeder, which puts it in the drop or burns it once the drop
///   is full.
/// - A reward pool: it buys $liquid, added to that pool's rewards. People who deposit their staking token
///   there earn it over the following week.
/// - A plain address: it buys $liquid, sent there (for an incentive contract that only needs to receive it).
///
/// Who can change what:
/// - The manager (the owner's wallet) changes the shares, at once, at any time. It cannot add a destination.
/// - The timelock (48 hours, in public) adds destinations, names a new manager, and can name a successor
///   contract that takes the yield instead. So the yield can never be switched to a place nobody saw coming,
///   and never faster than 48 hours to a new one.
/// A destination is never removed; its share is simply set to zero.
///
/// Every purchase is held to the reserve's 30-minute average price less the slippage limit in SwapConfig, and
/// what arrives is measured. Anyone may call `distribute`. This contract holds nothing between calls except
/// yield that has not been distributed yet.
contract YieldDirector is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Kind {
        COMPOUND,
        DROP,
        POOL,
        SEND
    }

    struct Destination {
        Kind kind;
        address target; // the reward pool or receiving address; unused for COMPOUND and DROP
        uint16 bps; // its share of the yield
    }

    uint256 private constant BPS = 10_000;
    /// @notice Most destinations there can ever be, so `distribute` always fits in a block.
    uint256 public constant MAX_DESTINATIONS = 16;

    address public immutable timelock;
    IERC20 public immutable khype;
    IERC20 public immutable liquid;
    LockedReserve public immutable reserve;
    IDropFeeder public immutable feeder;
    /// @notice The reserve's real price source and swap contract.
    IPriceOracle public immutable oracle;
    ISwapper public immutable swapper;
    /// @notice Where the slippage limit is read from.
    SwapConfig public immutable swapConfig;

    address public manager;
    /// @notice If set, all yield is passed on to this address instead of being split here.
    address public successor;
    Destination[] private _destinations;

    event SharesSet(uint16[] bps);
    event DestinationAdded(uint256 indexed index, Kind kind, address target);
    event ManagerSet(address indexed manager);
    event SuccessorSet(address indexed successor);
    /// @notice `amount` of `token` was split: `khypeToReserve` kHYPE locked again, `liquidBought` $liquid shared
    /// between the other destinations.
    event Distributed(address indexed token, uint256 amount, uint256 khypeToReserve, uint256 liquidBought);
    event PassedOn(address indexed successor, address indexed token, uint256 amount);

    error ZeroAddress();
    error NotTimelock();
    error NotManager();
    error BadShares();
    error BadDestination();
    error TooManyDestinations();
    error NothingToDistribute();
    error QuoteZero(address tokenIn, address tokenOut, uint256 amountIn);
    error InsufficientOutput(uint256 received, uint256 minOut);

    /// @param pools reward pools to start with, after "compound" (index 0) and "the drop" (index 1)
    /// @param bps the first shares, one per destination in that order; they must add up to 10,000
    constructor(
        address timelock_,
        address manager_,
        IERC20 khype_,
        IERC20 liquid_,
        LockedReserve reserve_,
        IDropFeeder feeder_,
        IPriceOracle oracle_,
        ISwapper swapper_,
        SwapConfig swapConfig_,
        address[] memory pools,
        uint16[] memory bps
    ) {
        if (
            timelock_ == address(0) || manager_ == address(0) || address(khype_) == address(0) || address(liquid_) == address(0)
                || address(reserve_) == address(0) || address(feeder_) == address(0) || address(oracle_) == address(0)
                || address(swapper_) == address(0) || address(swapConfig_) == address(0)
        ) revert ZeroAddress();
        timelock = timelock_;
        manager = manager_;
        khype = khype_;
        liquid = liquid_;
        reserve = reserve_;
        feeder = feeder_;
        oracle = oracle_;
        swapper = swapper_;
        swapConfig = swapConfig_;

        _destinations.push(Destination(Kind.COMPOUND, address(0), 0));
        emit DestinationAdded(0, Kind.COMPOUND, address(0));
        _destinations.push(Destination(Kind.DROP, address(0), 0));
        emit DestinationAdded(1, Kind.DROP, address(0));
        for (uint256 i; i < pools.length; ++i) {
            if (pools[i] == address(0)) revert ZeroAddress();
            _destinations.push(Destination(Kind.POOL, pools[i], 0));
            emit DestinationAdded(i + 2, Kind.POOL, pools[i]);
        }
        if (_destinations.length > MAX_DESTINATIONS) revert TooManyDestinations();
        emit ManagerSet(manager_);
        _setShares(bps);
    }

    modifier onlyTimelock() {
        if (msg.sender != timelock) revert NotTimelock();
        _;
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function destinationCount() external view returns (uint256) {
        return _destinations.length;
    }

    function destinations() external view returns (Destination[] memory) {
        return _destinations;
    }

    // ---------------------------------------------------------------------
    // The manager: shares
    // ---------------------------------------------------------------------

    /// @notice Sets every destination's share at once. One number per destination, in order, adding up to 10,000.
    function setShares(uint16[] calldata bps) external {
        if (msg.sender != manager) revert NotManager();
        _setShares(bps);
    }

    function _setShares(uint16[] memory bps) private {
        uint256 n = _destinations.length;
        if (bps.length != n) revert BadShares();
        uint256 total;
        for (uint256 i; i < n; ++i) {
            _destinations[i].bps = bps[i];
            total += bps[i];
        }
        if (total != BPS) revert BadShares();
        emit SharesSet(bps);
    }

    // ---------------------------------------------------------------------
    // The timelock: destinations, manager, successor
    // ---------------------------------------------------------------------

    /// @notice Adds a reward pool or a receiving address. It starts with a share of zero.
    function addDestination(Kind kind, address target) external onlyTimelock returns (uint256 index) {
        if (kind != Kind.POOL && kind != Kind.SEND) revert BadDestination();
        if (target == address(0)) revert ZeroAddress();
        index = _destinations.length;
        if (index >= MAX_DESTINATIONS) revert TooManyDestinations();
        _destinations.push(Destination(kind, target, 0));
        emit DestinationAdded(index, kind, target);
    }

    function setManager(address manager_) external onlyTimelock {
        if (manager_ == address(0)) revert ZeroAddress();
        manager = manager_;
        emit ManagerSet(manager_);
    }

    /// @notice Names the contract that takes over. From then on `distribute` only passes the yield on to it.
    /// Zero switches that off again.
    function setSuccessor(address successor_) external onlyTimelock {
        successor = successor_;
        emit SuccessorSet(successor_);
    }

    // ---------------------------------------------------------------------
    // Distributing
    // ---------------------------------------------------------------------

    /// @notice Splits up to `maxAmount` of the `token` waiting here by the current shares. A smaller `maxAmount`
    /// lets a large amount go through thin pools in pieces.
    function distribute(address token, uint256 maxAmount) external nonReentrant returns (uint256 khypeToReserve, uint256 liquidBought) {
        uint256 amount = IERC20(token).balanceOf(address(this));
        if (amount > maxAmount) amount = maxAmount;
        if (amount == 0) revert NothingToDistribute();

        address next = successor;
        if (next != address(0)) {
            IERC20(token).safeTransfer(next, amount);
            emit PassedOn(next, token, amount);
            return (0, 0);
        }

        // "compound" is destination 0; everything else is paid in $liquid, bought in one go
        uint256 compoundBps = _destinations[0].bps;
        uint256 forReserve = amount * compoundBps / BPS;
        uint256 forLiquid = amount - forReserve;

        if (forReserve > 0) {
            khypeToReserve = _convert(token, address(khype), forReserve);
            khype.forceApprove(address(reserve), khypeToReserve);
            // forge-lint: disable-next-line(unused-return)
            reserve.deposit(address(khype), khypeToReserve);
        }
        if (forLiquid > 0) {
            liquidBought = _convert(token, address(liquid), forLiquid);
            _share(liquidBought, BPS - compoundBps);
        }
        emit Distributed(token, amount, khypeToReserve, liquidBought);
    }

    /// @dev Hands `bought` $liquid to the destinations after "compound", by their shares of `liquidBps`. The last
    /// one with a share takes what rounding left over.
    function _share(uint256 bought, uint256 liquidBps) private {
        uint256 n = _destinations.length;
        uint256 last;
        for (uint256 i = 1; i < n; ++i) {
            if (_destinations[i].bps > 0) last = i;
        }
        uint256 left = bought;
        for (uint256 i = 1; i < n; ++i) {
            Destination memory d = _destinations[i];
            if (d.bps == 0) continue;
            uint256 part = i == last ? left : bought * d.bps / liquidBps;
            left -= part;
            if (part == 0) continue;
            if (d.kind == Kind.DROP) {
                liquid.forceApprove(address(feeder), part);
                // forge-lint: disable-next-line(unused-return)
                feeder.addLiquid(part);
            } else if (d.kind == Kind.POOL) {
                liquid.forceApprove(d.target, part);
                IRewardPool(d.target).notifyRewardAmount(part);
            } else {
                liquid.safeTransfer(d.target, part);
            }
        }
    }

    /// @dev `amount` of `tokenIn` as `tokenOut`, held here: unchanged if they are the same token, otherwise
    /// swapped at no worse than the oracle's average price less the slippage limit. Returns what arrived.
    function _convert(address tokenIn, address tokenOut, uint256 amount) private returns (uint256 received) {
        if (tokenIn == tokenOut) return amount;
        uint256 expected = oracle.quote(tokenIn, tokenOut, amount);
        if (expected == 0) revert QuoteZero(tokenIn, tokenOut, amount);
        uint256 minOut = expected * (BPS - swapConfig.maxSlippageBps()) / BPS;

        uint256 before = IERC20(tokenOut).balanceOf(address(this));
        IERC20(tokenIn).forceApprove(address(swapper), amount);
        // The adapter's return value is ignored on purpose: what actually arrived is measured below.
        // forge-lint: disable-next-line(unused-return)
        swapper.swap(tokenIn, tokenOut, amount, minOut, address(this));
        IERC20(tokenIn).forceApprove(address(swapper), 0);
        received = IERC20(tokenOut).balanceOf(address(this)) - before;
        if (received < minOut) revert InsufficientOutput(received, minOut);
    }
}
