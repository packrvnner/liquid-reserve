// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IRateProvider} from "../interfaces/IRateProvider.sol";

/// @notice Rate provider for an ERC-4626 staking vault (e.g. staked KNTQ, if it
/// is a 4626 vault on Elysium; to be confirmed).
contract ERC4626RateProvider is IRateProvider {
    IERC4626 public immutable vault;

    constructor(IERC4626 vault_) {
        vault = vault_;
    }

    function getRate() external view returns (uint256) {
        return vault.convertToAssets(10 ** vault.decimals());
    }
}
