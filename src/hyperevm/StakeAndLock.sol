// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {LockedReserve} from "../LockedReserve.sol";

/// @title StakeAndLock
/// @notice HyperEVM. Receives KNTQ bridged from Elysium, stakes it into sKNTQ
/// and deposits the sKNTQ into the HyperEVM LockedReserve as principal.
/// @dev No owner. Permissionless `stake`.
contract StakeAndLock is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable asset; // KNTQ
    IERC4626 public immutable vault; // sKNTQ
    LockedReserve public immutable reserve;

    event StakedAndLocked(uint256 assets, uint256 shares);

    error ZeroAddress();
    error NothingToStake();

    constructor(IERC4626 vault_, LockedReserve reserve_) {
        if (address(vault_) == address(0) || address(reserve_) == address(0)) revert ZeroAddress();
        vault = vault_;
        asset = IERC20(vault_.asset());
        reserve = reserve_;
    }

    function stake() external nonReentrant returns (uint256 shares) {
        uint256 amount = asset.balanceOf(address(this));
        if (amount == 0) revert NothingToStake();
        asset.forceApprove(address(vault), amount);
        shares = vault.deposit(amount, address(this));
        IERC20(address(vault)).forceApprove(address(reserve), shares);
        reserve.deposit(address(vault), shares);
        emit StakedAndLocked(amount, shares);
    }
}
