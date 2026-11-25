// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";

/// @title EmptyPoolPrice
/// @notice Puts a Uniswap v4 pool that holds no liquidity at a chosen price. Anyone may call it, for any
/// hookless pool.
///
/// Why it exists: a vault can be the only liquidity in its pool (a token with no other pool on the chain).
/// While such a pool is empty its price cannot follow the market by itself, and a first deposit at a stale
/// price would lose value to the first trader. So before a first deposit, the pool is put at the market price.
///
/// Why it is safe to leave open to everyone: with no liquidity, moving a pool's price exchanges nothing, and
/// anyone can already do it with a contract of their own. This one refuses to do anything else: if the pool
/// holds liquidity at its price it reverts, and if the move would touch any liquidity on the way (so that
/// even one wei changed hands) it reverts. It holds no funds, has no owner and no settings.
/// @dev Unaudited.
contract EmptyPoolPrice is IUnlockCallback {
    using StateLibrary for IPoolManager;

    IPoolManager public immutable poolManager;

    event PriceSet(PoolId indexed id, uint160 fromSqrtPriceX96, uint160 toSqrtPriceX96);

    error HookedPool();
    error PoolHasLiquidity();
    error MovedFunds();
    error NotPoolManager();

    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
    }

    /// @notice Creates the pool at `sqrtPriceX96` if it does not exist yet. If it exists and holds no
    /// liquidity at its price, moves its price there.
    function set(PoolKey calldata key, uint160 sqrtPriceX96) external {
        if (address(key.hooks) != address(0)) revert HookedPool();
        PoolId id = key.toId();
        (uint160 current,,,) = poolManager.getSlot0(id);
        if (current == 0) {
            poolManager.initialize(key, sqrtPriceX96);
        } else if (current != sqrtPriceX96) {
            if (poolManager.getLiquidity(id) != 0) revert PoolHasLiquidity();
            poolManager.unlock(abi.encode(key, sqrtPriceX96));
        }
        emit PriceSet(id, current, sqrtPriceX96);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, uint160 target) = abi.decode(data, (PoolKey, uint160));
        PoolId id = key.toId();
        if (poolManager.getLiquidity(id) != 0) revert PoolHasLiquidity();
        (uint160 current,,,) = poolManager.getSlot0(id);
        // With no liquidity in the way, a swap moves the price to its limit and exchanges nothing.
        BalanceDelta delta = poolManager.swap(
            key, IPoolManager.SwapParams({zeroForOne: target < current, amountSpecified: -1, sqrtPriceLimitX96: target}), ""
        );
        if (BalanceDelta.unwrap(delta) != 0) revert MovedFunds();
        return "";
    }
}
