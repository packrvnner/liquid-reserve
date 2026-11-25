// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {GuardedSwap} from "./base/GuardedSwap.sol";
import {SwapConfig} from "./SwapConfig.sol";

/// @title CreatorPayout
/// @notice Converts everything it receives into 50% USDC, 20% HYPE (as WHYPE),
/// 20% KNTQ, 10% $liquid and sends it to the payout address.
/// @dev Only the current payout address can hand the role to a new address,
/// in two steps (propose, then accept from the new address). Nobody else,
/// including the timelock, can redirect the payout.
contract CreatorPayout is GuardedSwap, ReentrancyGuard {
    uint16 public constant USDC_BPS = 5_000;
    uint16 public constant HYPE_BPS = 2_000;
    uint16 public constant KNTQ_BPS = 2_000;
    uint16 public constant LIQUID_RESERVE_BPS = 1_000;

    address public immutable usdc;
    address public immutable whype;
    address public immutable kntq;
    address public immutable liquidReserve;

    address public payoutAddress;
    address public pendingPayoutAddress;

    event PaidOut(address indexed token, uint256 amountIn, uint256 usdcOut, uint256 hypeOut, uint256 kntqOut, uint256 liquidReserveOut);
    event PayoutAddressProposed(address indexed current, address indexed proposed);
    event PayoutAddressChanged(address indexed previous, address indexed next);

    error NothingToPay();
    error NotPayoutAddress();
    error NotPendingPayoutAddress();

    constructor(SwapConfig swapConfig_, address payoutAddress_, address usdc_, address whype_, address kntq_, address liquidReserve_)
        GuardedSwap(swapConfig_)
    {
        if (
            payoutAddress_ == address(0) || usdc_ == address(0) || whype_ == address(0) || kntq_ == address(0)
                || liquidReserve_ == address(0)
        ) revert ZeroAddress();
        payoutAddress = payoutAddress_;
        usdc = usdc_;
        whype = whype_;
        kntq = kntq_;
        liquidReserve = liquidReserve_;
    }

    /// @notice Converts this contract's whole balance of `token` and pays it out.
    function payout(address token) external nonReentrant {
        _payout(token, type(uint256).max);
    }

    /// @notice Same as `payout`, but processes at most `maxAmount`, so a large
    /// balance can go through a thin pool in pieces within the slippage limit.
    function payoutPartial(address token, uint256 maxAmount) external nonReentrant {
        _payout(token, maxAmount);
    }

    function _payout(address token, uint256 maxAmount) private {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > maxAmount) bal = maxAmount;
        if (bal == 0) revert NothingToPay();

        uint256 toUsdc = bal * USDC_BPS / BPS;
        uint256 toHype = bal * HYPE_BPS / BPS;
        uint256 toKntq = bal * KNTQ_BPS / BPS;
        uint256 toLr = bal - toUsdc - toHype - toKntq;

        address to = payoutAddress;
        uint256 usdcOut = _swapTo(token, usdc, toUsdc, to);
        uint256 hypeOut = _swapTo(token, whype, toHype, to);
        uint256 kntqOut = _swapTo(token, kntq, toKntq, to);
        uint256 liquidReserveOut = _swapTo(token, liquidReserve, toLr, to);
        emit PaidOut(token, bal, usdcOut, hypeOut, kntqOut, liquidReserveOut);
    }

    /// @notice Step 1: the current payout address proposes a new one.
    /// Proposing address(0) cancels a pending proposal.
    function proposePayoutAddress(address next) external {
        if (msg.sender != payoutAddress) revert NotPayoutAddress();
        pendingPayoutAddress = next;
        emit PayoutAddressProposed(msg.sender, next);
    }

    /// @notice Step 2: the proposed address accepts.
    function acceptPayoutAddress() external {
        if (msg.sender != pendingPayoutAddress) revert NotPendingPayoutAddress();
        emit PayoutAddressChanged(payoutAddress, msg.sender);
        payoutAddress = msg.sender;
        pendingPayoutAddress = address(0);
    }
}
