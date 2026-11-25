// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {LiquidityVault} from "../vaults/LiquidityVault.sol";

/// @notice One transaction that opens the HYPE / $liquid liquidity vault.
///
/// Ascend's own $liquid pool refuses outside liquidity, so the vault gets a pool
/// of its own: native HYPE / $liquid, no hook, with the same 2% fee as Ascend's
/// pool so that it does not undercut it. This contract
///   1. creates that pool at the price Ascend's pool shows in the same instant
///      (if somebody already created it, it is left as it is), and
///   2. deploys the vault on it: the same LiquidityVault as the HYPE-USDC and
///      HYPE-KNTQ vaults, with the same fee recipient, owner and keeper.
/// It keeps no powers and holds no funds.
contract LiquidVaultLaunch {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    uint24 public constant POOL_FEE = 20_000; // 2%
    int24 public constant TICK_SPACING = 200;

    LiquidityVault public immutable vault;
    PoolId public immutable poolId;
    /// The price the pool was created at (or already had), as sqrtPriceX96 of $liquid per HYPE.
    uint160 public immutable startSqrtPriceX96;
    bool public immutable createdPool;

    error WrongChain();
    error NoMarket();

    struct Config {
        IPoolManager poolManager;
        address whype;
        address liquid;
        bytes32 ascendPoolId; // Ascend's $liquid / WHYPE pool, the price reference
        address feeRecipient;
        address owner;
        address keeper;
        uint256 depositCap; // in $liquid, measured on the vault's whole value
    }

    constructor(Config memory c) {
        if (block.chainid != 99901) revert WrongChain();
        (uint160 ascend,,,) = c.poolManager.getSlot0(PoolId.wrap(c.ascendPoolId));
        if (ascend == 0) revert NoMarket();
        // Ascend's pool holds the two tokens in address order. The new pool holds native HYPE
        // (the zero address) first, so it quotes $liquid per HYPE.
        uint160 start = c.liquid < c.whype ? uint160((uint256(1) << 192) / ascend) : ascend;

        PoolKey memory key =
            PoolKey(Currency.wrap(address(0)), Currency.wrap(c.liquid), POOL_FEE, TICK_SPACING, IHooks(address(0)));
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
                name: "Liquid Reserve Vault HYPE-liquid",
                symbol: "lrvHYPE-LIQUID",
                mainWidth: 30,
                altWidth: 30,
                depositCap: c.depositCap
            })
        );
    }
}
