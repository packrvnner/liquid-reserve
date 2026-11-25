// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

/// @notice Test only. Swaps in a hookless v4 pool of two ERC-20 tokens up to a price limit, taking what the swap
/// needs from the caller (who must have approved this contract). It lets a test push a pool's price past all of
/// its liquidity, which a swap that has to be filled completely cannot do.
contract PoolPusher is IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function push(PoolKey calldata key, bool zeroForOne, uint256 maxIn, int24 limitTick) external returns (int128 d0, int128 d1) {
        (d0, d1) = abi.decode(pm.unlock(abi.encode(msg.sender, key, zeroForOne, maxIn, limitTick)), (int128, int128));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "pool manager only");
        (address payer, PoolKey memory key, bool zeroForOne, uint256 maxIn, int24 limitTick) = abi.decode(data, (address, PoolKey, bool, uint256, int24));
        BalanceDelta d = pm.swap(
            key, IPoolManager.SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(maxIn), sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(limitTick)}), ""
        );
        _settle(key.currency0, payer, d.amount0());
        _settle(key.currency1, payer, d.amount1());
        return abi.encode(d.amount0(), d.amount1());
    }

    function _settle(Currency c, address payer, int128 amount) private {
        if (amount < 0) {
            pm.sync(c);
            IERC20(Currency.unwrap(c)).transferFrom(payer, address(pm), uint128(-amount));
            pm.settle();
        } else if (amount > 0) {
            pm.take(c, payer, uint128(amount));
        }
    }
}
