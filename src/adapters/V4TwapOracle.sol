// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

/// @title V4TwapOracle
/// @notice Time-weighted average prices for Uniswap v4 pools on Elysium.
///
/// v4 pools (including Ascend's) keep no price history, so this contract builds
/// one. Keepers "poke" each feed; a poke credits the previously recorded tick for
/// the time that passed, then records the pool's current tick.
///
/// Why it resists manipulation:
/// - A tick recorded in a poke only gains weight as time passes afterwards. An
///   attacker who moves the price, pokes and moves it back in one transaction
///   gets zero weight in that transaction.
/// - Only keepers can poke while a feed is fresh, so attackers can't choose when
///   prices are recorded. Anyone can poke a stale feed, so the oracle stays live.
/// - The recorded tick can move at most `maxTickChangePerSecond` per second of
///   elapsed time, so no single poke can jump the price.
/// - Swaps use a `window`-long average (e.g. 30 minutes) and revert if the feed
///   is stale.
///
/// The owner (TimelockController) adds feeds and sets token routes. A feed can
/// never be changed or removed once added, so contracts that read a feed
/// directly (the reserve's kHYPE rate provider) get a fixed price source.
contract V4TwapOracle is IPriceOracle, Ownable2Step {
    using StateLibrary for IPoolManager;

    uint256 public constant CARDINALITY = 128;
    /// @notice Highest per-hop pool fee a route may declare (10%, Ascend's maximum).
    uint24 public constant MAX_HOP_FEE_PIPS = 100_000;

    IPoolManager public immutable poolManager;
    address public immutable whype;
    /// @notice Length of the averaging window used by `quote`, in seconds.
    uint32 public immutable window;
    /// @notice Minimum seconds between stored observations.
    uint32 public immutable observationSpacing;
    /// @notice `quote` reverts if a feed wasn't poked within this many seconds.
    uint32 public immutable maxStaleness;
    /// @notice Fastest the recorded tick may move (1 tick ≈ 0.01%).
    uint24 public immutable maxTickChangePerSecond;

    struct Observation {
        uint32 time;
        int56 tickCumulative;
    }

    struct Feed {
        Currency currency0;
        Currency currency1;
        uint32 lastTime;
        int24 lastTick;
        int56 tickCumulative;
        uint16 latestIndex;
        uint16 count;
    }

    mapping(PoolId id => Feed) public feeds;
    mapping(PoolId id => Observation[CARDINALITY]) private _observations;
    mapping(bytes32 routeId => PoolId[]) private _routes;
    /// @notice Pool fee charged on each hop of a route, in pips (1e6 = 100%).
    mapping(bytes32 routeId => uint24[]) private _routeFees;
    mapping(address account => bool) public isKeeper;

    event FeedAdded(PoolId indexed id, Currency currency0, Currency currency1, int24 tick);
    event Poked(PoolId indexed id, int24 spotTick, int24 recordedTick);
    event RouteSet(address indexed tokenIn, address indexed tokenOut, PoolId[] path, uint24[] feesPips);
    event KeeperSet(address indexed account, bool allowed);

    error ZeroAddress();
    error BadParams();
    error FeedExists(PoolId id);
    error UnknownFeed(PoolId id);
    error PoolNotInitialized(PoolId id);
    error NotKeeper();
    error InsufficientHistory(PoolId id);
    error StalePrice(PoolId id);
    error NoRoute(address tokenIn, address tokenOut);
    error BadRoute(uint256 hopIndex);
    error AmountTooLarge();

    constructor(
        address owner_,
        IPoolManager poolManager_,
        address whype_,
        uint32 window_,
        uint32 observationSpacing_,
        uint32 maxStaleness_,
        uint24 maxTickChangePerSecond_
    ) Ownable(owner_) {
        if (address(poolManager_) == address(0) || whype_ == address(0)) revert ZeroAddress();
        // The ring buffer must hold a full window of observations.
        if (
            observationSpacing_ == 0 || window_ < observationSpacing_
                || uint256(window_) / observationSpacing_ + 2 > CARDINALITY || maxStaleness_ == 0
                || maxTickChangePerSecond_ == 0
        ) revert BadParams();
        poolManager = poolManager_;
        whype = whype_;
        window = window_;
        observationSpacing = observationSpacing_;
        maxStaleness = maxStaleness_;
        maxTickChangePerSecond = maxTickChangePerSecond_;
    }

    // ---------------------------------------------------------------------
    // Owner: feeds, routes, keepers
    // ---------------------------------------------------------------------

    function addFeed(PoolKey calldata key) external onlyOwner returns (PoolId id) {
        id = key.toId();
        if (feeds[id].lastTime != 0) revert FeedExists(id);
        (uint160 sqrtPriceX96, int24 tick,,) = poolManager.getSlot0(id);
        if (sqrtPriceX96 == 0) revert PoolNotInitialized(id);

        Feed storage f = feeds[id];
        f.currency0 = key.currency0;
        f.currency1 = key.currency1;
        f.lastTime = uint32(block.timestamp);
        f.lastTick = tick;
        f.count = 1;
        _observations[id][0] = Observation(uint32(block.timestamp), 0);
        emit FeedAdded(id, key.currency0, key.currency1, tick);
    }

    /// @notice Sets the pools used to price `tokenIn` in `tokenOut`, and the fee
    /// each pool charges (e.g. 3000 for a 0.3% pool, 20000 for Ascend's 2%), so
    /// quotes are what a swap should actually return before price impact.
    function setRoute(address tokenIn, address tokenOut, PoolId[] calldata path, uint24[] calldata feesPips)
        external
        onlyOwner
    {
        if (path.length == 0 || feesPips.length != path.length) revert BadRoute(0);
        address current = tokenIn;
        for (uint256 i; i < path.length; ++i) {
            Feed storage f = feeds[path[i]];
            if (f.lastTime == 0) revert UnknownFeed(path[i]);
            address t0 = _asToken(f.currency0);
            address t1 = _asToken(f.currency1);
            if (current == t0) current = t1;
            else if (current == t1) current = t0;
            else revert BadRoute(i);
            if (feesPips[i] > MAX_HOP_FEE_PIPS) revert BadRoute(i);
        }
        if (current != tokenOut) revert BadRoute(path.length);
        _routes[_routeId(tokenIn, tokenOut)] = path;
        _routeFees[_routeId(tokenIn, tokenOut)] = feesPips;
        emit RouteSet(tokenIn, tokenOut, path, feesPips);
    }

    function setKeeper(address account, bool allowed) external onlyOwner {
        isKeeper[account] = allowed;
        emit KeeperSet(account, allowed);
    }

    // ---------------------------------------------------------------------
    // Poke
    // ---------------------------------------------------------------------

    /// @notice Records current prices. Keepers can poke any time; anyone can
    /// poke a feed that hasn't been poked within `maxStaleness`.
    function poke(PoolId[] calldata ids) external {
        bool keeper = isKeeper[msg.sender];
        for (uint256 i; i < ids.length; ++i) {
            Feed storage f = feeds[ids[i]];
            if (f.lastTime == 0) revert UnknownFeed(ids[i]);
            if (!keeper && block.timestamp - f.lastTime < maxStaleness) revert NotKeeper();
            _poke(ids[i], f);
        }
    }

    function _poke(PoolId id, Feed storage f) private {
        uint32 nowTs = uint32(block.timestamp);
        uint32 elapsed = nowTs - f.lastTime;
        if (elapsed == 0) return;

        // Credit the previously recorded tick for the time that passed.
        f.tickCumulative += int56(f.lastTick) * int56(uint56(elapsed));

        // Record the current tick, limited to maxTickChangePerSecond * elapsed.
        (, int24 spot,,) = poolManager.getSlot0(id);
        int256 maxMove = int256(uint256(maxTickChangePerSecond)) * int256(uint256(elapsed));
        int256 recorded = spot;
        int256 last = f.lastTick;
        if (recorded > last + maxMove) recorded = last + maxMove;
        else if (recorded < last - maxMove) recorded = last - maxMove;
        // Lies between the previous tick and the spot tick, so it fits in int24.
        // forge-lint: disable-next-line(unsafe-typecast)
        f.lastTick = int24(recorded);
        f.lastTime = nowTs;

        if (nowTs - _observations[id][f.latestIndex].time >= observationSpacing) {
            uint16 next = uint16((uint256(f.latestIndex) + 1) % CARDINALITY);
            _observations[id][next] = Observation(nowTs, f.tickCumulative);
            f.latestIndex = next;
            if (f.count < CARDINALITY) ++f.count;
        }
        emit Poked(id, spot, f.lastTick);
    }

    // ---------------------------------------------------------------------
    // Prices
    // ---------------------------------------------------------------------

    /// @inheritdoc IPriceOracle
    /// @dev Window-average price minus each hop's pool fee. Reverts if any feed
    /// on the route is stale or lacks a full window of history.
    function quote(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256 amountOut) {
        bytes32 rid = _routeId(tokenIn, tokenOut);
        PoolId[] storage path = _routes[rid];
        uint24[] storage fees = _routeFees[rid];
        if (path.length == 0) revert NoRoute(tokenIn, tokenOut);
        amountOut = amountIn;
        address current = tokenIn;
        for (uint256 i; i < path.length; ++i) {
            Feed storage f = feeds[path[i]];
            bool baseIs0 = current == _asToken(f.currency0);
            amountOut = quoteAtTick(_meanTick(path[i], true), amountOut, baseIs0) * (1e6 - fees[i]) / 1e6;
            current = baseIs0 ? _asToken(f.currency1) : _asToken(f.currency0);
        }
    }

    /// @notice Price from a single feed's window average, without the staleness
    /// check (a stale feed keeps its last recorded price). Used by rate providers.
    function quoteFeed(PoolId id, uint256 amount, bool baseIsCurrency0) external view returns (uint256) {
        return quoteAtTick(_meanTick(id, false), amount, baseIsCurrency0);
    }

    /// @notice Average tick of a feed over at least `window` seconds.
    function meanTick(PoolId id) external view returns (int24) {
        return _meanTick(id, false);
    }

    /// @notice Average tick over at least `secondsAgo` seconds (e.g. a short
    /// window for vault "calm market" checks). Reverts if the feed is stale.
    function meanTickSince(PoolId id, uint32 secondsAgo) external view returns (int24) {
        return _meanTickOver(id, secondsAgo, true);
    }

    function getRoute(address tokenIn, address tokenOut)
        external
        view
        returns (PoolId[] memory path, uint24[] memory feesPips)
    {
        bytes32 rid = _routeId(tokenIn, tokenOut);
        return (_routes[rid], _routeFees[rid]);
    }

    function _meanTick(PoolId id, bool requireFresh) private view returns (int24) {
        return _meanTickOver(id, window, requireFresh);
    }

    function _meanTickOver(PoolId id, uint32 span_, bool requireFresh) private view returns (int24) {
        Feed storage f = feeds[id];
        if (f.lastTime == 0) revert UnknownFeed(id);
        uint32 nowTs = uint32(block.timestamp);
        if (requireFresh && nowTs - f.lastTime > maxStaleness) revert StalePrice(id);

        int56 cumNow = f.tickCumulative + int56(f.lastTick) * int56(uint56(nowTs - f.lastTime));
        if (nowTs < span_) revert InsufficientHistory(id);
        uint32 target = nowTs - span_;

        // Newest observation at least `window` old.
        uint256 idx = f.latestIndex;
        for (uint256 n; n < f.count; ++n) {
            Observation memory o = _observations[id][idx];
            if (o.time <= target) {
                int56 span = int56(uint56(nowTs - o.time));
                int56 delta = cumNow - o.tickCumulative;
                int56 mean = delta / span;
                if (delta < 0 && delta % span != 0) --mean; // round toward negative infinity
                // An average of int24 ticks fits in int24.
                // forge-lint: disable-next-line(unsafe-typecast)
                return int24(mean);
            }
            idx = idx == 0 ? CARDINALITY - 1 : idx - 1;
        }
        revert InsufficientHistory(id);
    }

    /// @notice Converts `amount` of the base currency at `tick`
    /// (price = 1.0001^tick, currency1 per currency0).
    function quoteAtTick(int24 tick, uint256 amount, bool baseIsCurrency0) public pure returns (uint256) {
        if (amount > type(uint128).max) revert AmountTooLarge();
        uint160 sqrtPriceX96 = TickMath.getSqrtPriceAtTick(tick);
        if (sqrtPriceX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtPriceX96) * sqrtPriceX96;
            return baseIsCurrency0
                ? FullMath.mulDiv(ratioX192, amount, 1 << 192)
                : FullMath.mulDiv(1 << 192, amount, ratioX192);
        }
        uint256 ratioX128 = FullMath.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 64);
        return baseIsCurrency0
            ? FullMath.mulDiv(ratioX128, amount, 1 << 128)
            : FullMath.mulDiv(1 << 128, amount, ratioX128);
    }

    function _asToken(Currency c) private view returns (address) {
        return c.isAddressZero() ? whype : Currency.unwrap(c);
    }

    function _routeId(address tokenIn, address tokenOut) private pure returns (bytes32) {
        return keccak256(abi.encode(tokenIn, tokenOut));
    }
}
