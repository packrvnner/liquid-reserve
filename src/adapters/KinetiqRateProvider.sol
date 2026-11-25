// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IRateProvider} from "../interfaces/IRateProvider.sol";

/// @notice Kinetiq's staking accountant, which prices kHYPE in HYPE.
/// @dev TODO(phase 0): confirm the contract address and function name for
/// kHYPE on Elysium before deployment. On HyperEVM this is exposed as
/// `kHYPEToHYPE(uint256)`.
interface IKinetiqAccountant {
    function kHYPEToHYPE(uint256 kHYPEAmount) external view returns (uint256);
}

contract KinetiqRateProvider is IRateProvider {
    IKinetiqAccountant public immutable accountant;

    constructor(IKinetiqAccountant accountant_) {
        accountant = accountant_;
    }

    function getRate() external view returns (uint256) {
        return accountant.kHYPEToHYPE(1e18);
    }
}
