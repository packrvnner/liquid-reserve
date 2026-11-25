// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {GuardedSwap} from "./base/GuardedSwap.sol";
import {SwapConfig} from "./SwapConfig.sol";
import {LockedReserve} from "./LockedReserve.sol";

/// @title InflowAllocator
/// @notice Front door of the Locked Reserve. Everything bound for the reserve
/// (80% of creator fees, compounding yield, vault performance fees) is sent here.
/// `allocate` splits the balance 40/40/20 into three buckets. Each bucket swaps
/// into its asset and either deposits it into the reserve as principal or sends
/// it to a fixed destination. On Elysium:
///   40% -> kHYPE -> Elysium reserve
///   40% -> KNTQ  -> BridgeOut (to HyperEVM, where it is staked as sKNTQ and
///                   locked in the HyperEVM reserve)
///   20% -> $liquid    -> Elysium reserve
/// @dev Permissionless: anyone (usually the keeper) can call `allocate`. Swaps
/// are oracle-guarded by GuardedSwap.
contract InflowAllocator is GuardedSwap, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Share of each inflow per bucket.
    uint16 public constant WEIGHT0_BPS = 4_000;
    uint16 public constant WEIGHT1_BPS = 4_000;
    uint16 public constant WEIGHT2_BPS = 2_000;

    LockedReserve public immutable reserve;

    address public immutable asset0;
    address public immutable asset1;
    address public immutable asset2;
    /// @notice Where each bucket goes; the reserve's address means "deposit as principal".
    address public immutable destination0;
    address public immutable destination1;
    address public immutable destination2;

    event Allocated(address indexed token, uint256 amountIn, uint256[3] delivered);

    error NothingToAllocate();

    /// @param assets_ asset each bucket is converted into
    /// @param destinations_ per bucket: address(reserve_) to deposit as principal,
    ///        or another address to receive the asset directly
    constructor(SwapConfig swapConfig_, LockedReserve reserve_, address[3] memory assets_, address[3] memory destinations_)
        GuardedSwap(swapConfig_)
    {
        if (address(reserve_) == address(0)) revert ZeroAddress();
        for (uint256 i; i < 3; ++i) {
            if (assets_[i] == address(0) || destinations_[i] == address(0)) revert ZeroAddress();
        }
        reserve = reserve_;
        asset0 = assets_[0];
        asset1 = assets_[1];
        asset2 = assets_[2];
        destination0 = destinations_[0];
        destination1 = destinations_[1];
        destination2 = destinations_[2];
    }

    /// @notice Splits this contract's whole balance of `token` into the reserve.
    function allocate(address token) external nonReentrant returns (uint256[3] memory deposited) {
        deposited = _allocate(token, type(uint256).max);
    }

    /// @notice Same as `allocate`, but processes at most `maxAmount`, so a large
    /// balance can go through a thin pool in pieces within the slippage limit.
    function allocatePartial(address token, uint256 maxAmount)
        external
        nonReentrant
        returns (uint256[3] memory deposited)
    {
        deposited = _allocate(token, maxAmount);
    }

    function _allocate(address token, uint256 maxAmount) private returns (uint256[3] memory delivered) {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > maxAmount) bal = maxAmount;
        if (bal == 0) revert NothingToAllocate();

        uint256 a0 = bal * WEIGHT0_BPS / BPS;
        uint256 a1 = bal * WEIGHT1_BPS / BPS;
        uint256 a2 = bal - a0 - a1;

        delivered[0] = _deliver(token, asset0, destination0, a0);
        delivered[1] = _deliver(token, asset1, destination1, a1);
        delivered[2] = _deliver(token, asset2, destination2, a2);
        emit Allocated(token, bal, delivered);
    }

    function _deliver(address token, address asset, address destination, uint256 amount)
        private
        returns (uint256 out)
    {
        if (amount == 0) return 0;
        if (destination != address(reserve)) return _swapTo(token, asset, amount, destination);
        out = _swapTo(token, asset, amount, address(this));
        if (out == 0) return 0;
        IERC20(asset).forceApprove(address(reserve), out);
        reserve.deposit(asset, out);
    }
}
