// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolId} from "v4-core/src/types/PoolId.sol";
import {IRateProvider} from "../interfaces/IRateProvider.sol";
import {V4TwapOracle} from "./V4TwapOracle.sol";

/// @title TwapRateProvider
/// @notice Exchange rate of a yield-bearing token from one fixed oracle feed,
/// e.g. bridged kHYPE on Elysium, which has no on-chain Kinetiq rate. Returns
/// how much of the underlying (WHYPE) 1e18 of the token is worth, using the
/// feed's window average.
/// @dev Fully immutable: the oracle can't change or remove a feed once added.
/// The LockedReserve additionally caps how fast this rate may grow (25%/yr), so
/// a mispriced market can't turn principal into "yield".
contract TwapRateProvider is IRateProvider {
    V4TwapOracle public immutable oracle;
    PoolId public immutable feed;
    /// @notice True if the yield-bearing token is currency0 of the feed's pool.
    bool public immutable tokenIsCurrency0;

    constructor(V4TwapOracle oracle_, PoolId feed_, bool tokenIsCurrency0_) {
        oracle = oracle_;
        feed = feed_;
        tokenIsCurrency0 = tokenIsCurrency0_;
        (,, uint32 lastTime,,,,) = oracle_.feeds(feed_);
        if (lastTime == 0) revert V4TwapOracle.UnknownFeed(feed_);
    }

    function getRate() external view returns (uint256) {
        return oracle.quoteFeed(feed, 1e18, tokenIsCurrency0);
    }
}
