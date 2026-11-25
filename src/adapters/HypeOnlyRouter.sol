// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ISwapper} from "../interfaces/ISwapper.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";
import {SwapConfig} from "../SwapConfig.sol";
import {LockedReserve} from "../LockedReserve.sol";

/// @title HypeOnlyRouter
/// @notice Makes the reserve HYPE only. It sits between the reserve's allocator and its swap and price
/// contracts, so that the part of every fee the allocator would turn into KNTQ becomes staked HYPE (kHYPE),
/// locked in the reserve, instead.
///
/// The allocator cannot be changed. It splits every fee into three and asks the swapper named in SwapConfig
/// for kHYPE, KNTQ and USDC, checking each against the price source named there. What the timelock that owns
/// SwapConfig can change is which swapper and which price source that is. This contract is meant to be set as
/// both.
///
/// - As the price source: every pair is answered by the real oracle, except "anything to KNTQ", which is
///   answered with 1, the smallest amount that is not zero. The allocator's minimum for that leg then rounds
///   down to zero, so it accepts that no KNTQ arrives.
/// - As the swapper: every pair is passed to the real swapper unchanged, except "anything to KNTQ". That
///   amount is swapped to kHYPE, checked against the real oracle's price with the slippage limit set in
///   SwapConfig, and deposited into the locked reserve. No KNTQ is bought.
///
/// One thing it cannot reach: a fee that arrives as KNTQ. The allocator hands its KNTQ part straight to the
/// bridge without asking any swapper, so that part is still staked as KNTQ.
///
/// `lock` lets anyone turn a token into kHYPE locked in the reserve the same way (the drop's HYPE rewards use
/// it). No owner, no settings of its own, and it holds nothing between calls.
contract HypeOnlyRouter is ISwapper, IPriceOracle, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;

    /// @notice The reserve's real price source and swap contract, which do all the work.
    IPriceOracle public immutable realOracle;
    ISwapper public immutable realSwapper;
    /// @notice Where the slippage limit is read from, so the timelock's setting keeps applying here.
    SwapConfig public immutable swapConfig;
    LockedReserve public immutable reserve;
    address public immutable khype;
    address public immutable kntq;

    /// @notice `amountIn` of `tokenIn` became `khypeLocked` kHYPE in the reserve.
    event Locked(address indexed tokenIn, uint256 amountIn, uint256 khypeLocked, address indexed from);

    error ZeroAddress();
    error ZeroAmount();
    error NoKntq();
    error QuoteZero(address tokenIn, uint256 amountIn);
    error InsufficientOutput(uint256 received, uint256 minOut);

    constructor(IPriceOracle realOracle_, ISwapper realSwapper_, SwapConfig swapConfig_, LockedReserve reserve_, address khype_, address kntq_) {
        if (
            address(realOracle_) == address(0) || address(realSwapper_) == address(0) || address(swapConfig_) == address(0)
                || address(reserve_) == address(0) || khype_ == address(0) || kntq_ == address(0)
        ) revert ZeroAddress();
        realOracle = realOracle_;
        realSwapper = realSwapper_;
        swapConfig = swapConfig_;
        reserve = reserve_;
        khype = khype_;
        kntq = kntq_;
    }

    // ---------------------------------------------------------------------
    // As the price source
    // ---------------------------------------------------------------------

    /// @inheritdoc IPriceOracle
    /// @dev "Anything to KNTQ" is 1, so the caller's minimum for that leg rounds to zero. Everything else is the
    /// real oracle's answer, with its own staleness and history checks.
    function quote(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256) {
        if (tokenOut == kntq) return 1;
        return realOracle.quote(tokenIn, tokenOut, amountIn);
    }

    // ---------------------------------------------------------------------
    // As the swapper
    // ---------------------------------------------------------------------

    /// @inheritdoc ISwapper
    /// @dev For `tokenOut` = KNTQ nothing is sent to `recipient`: the amount is locked in the reserve as kHYPE
    /// and 0 is returned. A caller that insists on receiving KNTQ (`minOut` above zero) is refused.
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        if (tokenOut == kntq) {
            if (minOut != 0) revert NoKntq();
            _lock(tokenIn, amountIn);
            return 0;
        }
        IERC20(tokenIn).forceApprove(address(realSwapper), amountIn);
        amountOut = realSwapper.swap(tokenIn, tokenOut, amountIn, minOut, recipient);
        IERC20(tokenIn).forceApprove(address(realSwapper), 0);
    }

    /// @notice Takes `amount` of `token` from the caller, turns it into kHYPE at no worse than the reserve's
    /// average price less the slippage limit, and locks it in the reserve for good.
    /// @return khypeLocked kHYPE deposited into the reserve
    function lock(address token, uint256 amount) external nonReentrant returns (uint256 khypeLocked) {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        khypeLocked = _lock(token, amount);
    }

    function _lock(address token, uint256 amount) private returns (uint256 received) {
        if (amount == 0) revert ZeroAmount();
        if (token == khype) {
            received = amount;
        } else {
            uint256 expected = realOracle.quote(token, khype, amount);
            if (expected == 0) revert QuoteZero(token, amount);
            uint256 minOut = expected * (BPS - swapConfig.maxSlippageBps()) / BPS;

            uint256 before = IERC20(khype).balanceOf(address(this));
            IERC20(token).forceApprove(address(realSwapper), amount);
            // The adapter's return value is ignored on purpose: what actually arrived is measured below.
            // forge-lint: disable-next-line(unused-return)
            realSwapper.swap(token, khype, amount, minOut, address(this));
            IERC20(token).forceApprove(address(realSwapper), 0);
            received = IERC20(khype).balanceOf(address(this)) - before;
            if (received < minOut) revert InsufficientOutput(received, minOut);
        }
        IERC20(khype).forceApprove(address(reserve), received);
        // forge-lint: disable-next-line(unused-return)
        reserve.deposit(khype, received);
        emit Locked(token, amount, received, msg.sender);
    }
}
