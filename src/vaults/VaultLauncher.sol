// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {FeeInbox} from "../FeeInbox.sol";
import {LiquidityVault} from "./LiquidityVault.sol";

/// @title VaultLauncher
/// @notice Deploys the first two Liquid Reserve vaults in one transaction:
/// HYPE-USDC and HYPE-KNTQ on Elysium's hookless 0.3% Uniswap v4 pools, plus
/// the inbox that collects their performance fees.
///
/// Everything is fixed by the constructor arguments, so when this is deployed
/// through a CREATE2 factory the three addresses are known before launch. The
/// launcher itself holds nothing and can do nothing afterwards.
///
/// The performance fees wait in the inbox until `owner` points it, once, at
/// Liquid Reserve's FeeRouter (80% locked reserve, 20% creator).
contract VaultLauncher {
    struct Config {
        IPoolManager poolManager;
        address whype;
        address usdc;
        address kntq;
        /// @dev Owns both vaults (range widths, keeper, pause, caps) and sets the inbox target.
        address owner;
        /// @dev The only address that can move the ranges to a new price.
        address keeper;
        uint24 poolFee;
        int24 tickSpacing;
        int24 mainWidth;
        int24 altWidth;
        uint256 capUsdc;
        uint256 capKntq;
    }

    FeeInbox public immutable feeInbox;
    LiquidityVault public immutable hypeUsdc;
    LiquidityVault public immutable hypeKntq;

    event Launched(address feeInbox, address hypeUsdc, address hypeKntq, address owner, address keeper);

    constructor(Config memory c) {
        feeInbox = new FeeInbox(c.owner);
        hypeUsdc = _vault(c, c.usdc, "Liquid Reserve Vault HYPE-USDC", "lrvHYPE-USDC", c.capUsdc);
        hypeKntq = _vault(c, c.kntq, "Liquid Reserve Vault HYPE-KNTQ", "lrvHYPE-KNTQ", c.capKntq);
        emit Launched(address(feeInbox), address(hypeUsdc), address(hypeKntq), c.owner, c.keeper);
    }

    function _vault(Config memory c, address quote, string memory name, string memory symbol, uint256 cap)
        private
        returns (LiquidityVault)
    {
        return new LiquidityVault(
            LiquidityVault.Params({
                // Native HYPE is currency0 (the zero address sorts first).
                key: PoolKey(Currency.wrap(address(0)), Currency.wrap(quote), c.poolFee, c.tickSpacing, IHooks(address(0))),
                poolManager: c.poolManager,
                feeRecipient: address(feeInbox),
                whype: c.whype,
                owner: c.owner,
                keeper: c.keeper,
                name: name,
                symbol: symbol,
                mainWidth: c.mainWidth,
                altWidth: c.altWidth,
                depositCap: cap
            })
        );
    }
}
