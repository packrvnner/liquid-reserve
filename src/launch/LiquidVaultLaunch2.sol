// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {LiquidityVault} from "../vaults/LiquidityVault.sol";

/// @notice One transaction that opens a HYPE / $liquid liquidity vault on a plain pool
/// with a chosen fee. Trading apps on Elysium route through plain native-HYPE pools with
/// a 0.5% fee and a tick spacing of 100, which neither Ascend's pool nor the first vault's
/// 2% pool is; this is the vault for that kind of pool.
///
/// It creates the pool at the price Ascend's pool shows in the same instant (if somebody
/// already created it, it is left as it is) and deploys a LiquidityVault on it, the same
/// contract as the other vaults, with the same fee recipient, owner and keeper.
/// It keeps no powers and holds no funds.
///
/// One thing can still be done through it, by anyone: while the vault's pool holds no
/// liquidity at all, `realign()` moves its price to wherever Ascend's pool is now. An
/// empty pool's price cannot follow the market by itself, and a first deposit at a stale
/// price would lose value. With no liquidity in the pool this moves no money, and once
/// the pool holds liquidity at its current price it cannot be called.
contract LiquidVaultLaunch2 {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    LiquidityVault public immutable vault;
    IPoolManager public immutable poolManager;
    address public immutable whype;
    address public immutable liquid;
    /// Ascend's $liquid / WHYPE pool: the price reference.
    PoolId public immutable ascendPoolId;
    PoolId public immutable poolId;
    uint24 public immutable poolFee;
    int24 public immutable tickSpacing;
    /// The price the pool was created at (or already had), as sqrtPriceX96 of $liquid per HYPE.
    uint160 public immutable startSqrtPriceX96;
    bool public immutable createdPool;

    error WrongChain();
    error NoMarket();
    error PoolHasLiquidity();
    error NotPoolManager();
    error MovedFunds();

    event Realigned(uint160 fromSqrtPriceX96, uint160 toSqrtPriceX96);

    struct Config {
        IPoolManager poolManager;
        address whype;
        address liquid;
        bytes32 ascendPoolId;
        uint24 poolFee; // in hundredths of a basis point: 5000 = 0.5%
        int24 tickSpacing;
        int24 rangeWidth; // half-width of each range, in tick spacings
        address feeRecipient;
        address owner;
        address keeper;
        uint256 depositCap; // in $liquid, measured on the vault's whole value
        string name;
        string symbol;
    }

    constructor(Config memory c) {
        if (block.chainid != 99901) revert WrongChain();
        poolManager = c.poolManager;
        whype = c.whype;
        liquid = c.liquid;
        ascendPoolId = PoolId.wrap(c.ascendPoolId);
        poolFee = c.poolFee;
        tickSpacing = c.tickSpacing;
        uint160 start = _marketPrice(c.poolManager, PoolId.wrap(c.ascendPoolId), c.liquid, c.whype);

        PoolKey memory key = _key(c.liquid, c.poolFee, c.tickSpacing);
        (uint160 existing,,,) = c.poolManager.getSlot0(key.toId());
        bool created = existing == 0;
        if (created) c.poolManager.initialize(key, start);
        poolId = key.toId();
        createdPool = created;
        startSqrtPriceX96 = created ? start : existing;

        vault = new LiquidityVault(
            LiquidityVault.Params({
                key: key,
                poolManager: c.poolManager,
                feeRecipient: c.feeRecipient,
                whype: c.whype,
                owner: c.owner,
                keeper: c.keeper,
                name: c.name,
                symbol: c.symbol,
                mainWidth: c.rangeWidth,
                altWidth: c.rangeWidth,
                depositCap: c.depositCap
            })
        );
    }

    /// @notice While the vault's pool holds no liquidity at its price, moves that price to Ascend's current price. Anyone may call it.
    function realign() external {
        if (poolManager.getLiquidity(poolId) != 0) revert PoolHasLiquidity();
        poolManager.unlock("");
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        if (poolManager.getLiquidity(poolId) != 0) revert PoolHasLiquidity();
        (uint160 current,,,) = poolManager.getSlot0(poolId);
        uint160 target = _marketPrice(poolManager, ascendPoolId, liquid, whype);
        if (current != target) {
            // With no liquidity in the way, a swap moves the price to its limit and exchanges nothing.
            // If it would touch any liquidity on the way, it reverts instead.
            BalanceDelta delta = poolManager.swap(
                _key(liquid, poolFee, tickSpacing),
                IPoolManager.SwapParams({zeroForOne: target < current, amountSpecified: -1, sqrtPriceLimitX96: target}),
                ""
            );
            if (BalanceDelta.unwrap(delta) != 0) revert MovedFunds();
            emit Realigned(current, target);
        }
        return "";
    }

    function _key(address liquid_, uint24 fee, int24 spacing) private pure returns (PoolKey memory) {
        return PoolKey(Currency.wrap(address(0)), Currency.wrap(liquid_), fee, spacing, IHooks(address(0)));
    }

    /// Ascend's pool holds the two tokens in address order. The vault's pool holds native HYPE
    /// (the zero address) first, so it quotes $liquid per HYPE.
    function _marketPrice(IPoolManager pm, PoolId ascend, address liquid_, address whype_) private view returns (uint160) {
        (uint160 a,,,) = pm.getSlot0(ascend);
        if (a == 0) revert NoMarket();
        return liquid_ < whype_ ? uint160((uint256(1) << 192) / a) : a;
    }
}
