// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ISwapper} from "./interfaces/ISwapper.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";

/// @title SwapConfig
/// @notice One place that holds the swap adapter, the price oracle and the
/// slippage limit used by the routing contracts (allocator, yield router,
/// creator payout). The owner is meant to be a TimelockController.
/// @dev The LockedReserve never reads this contract and never swaps, so nothing
/// set here can touch reserve principal. The worst a bad setting can do is
/// make in-transit swaps fail or lose up to `maxSlippageBps`.
contract SwapConfig is Ownable2Step {
    /// @notice Hard cap on the slippage limit (3%).
    uint16 public constant MAX_SLIPPAGE_CAP_BPS = 300;

    ISwapper public swapper;
    IPriceOracle public oracle;
    uint16 public maxSlippageBps;

    event SwapperSet(address indexed swapper);
    event OracleSet(address indexed oracle);
    event MaxSlippageSet(uint16 bps);

    error ZeroAddress();
    error SlippageTooHigh(uint16 bps);

    constructor(address owner_, ISwapper swapper_, IPriceOracle oracle_, uint16 maxSlippageBps_) Ownable(owner_) {
        _setSwapper(swapper_);
        _setOracle(oracle_);
        _setMaxSlippage(maxSlippageBps_);
    }

    function setSwapper(ISwapper swapper_) external onlyOwner {
        _setSwapper(swapper_);
    }

    function setOracle(IPriceOracle oracle_) external onlyOwner {
        _setOracle(oracle_);
    }

    function setMaxSlippageBps(uint16 bps) external onlyOwner {
        _setMaxSlippage(bps);
    }

    function _setSwapper(ISwapper swapper_) private {
        if (address(swapper_) == address(0)) revert ZeroAddress();
        swapper = swapper_;
        emit SwapperSet(address(swapper_));
    }

    function _setOracle(IPriceOracle oracle_) private {
        if (address(oracle_) == address(0)) revert ZeroAddress();
        oracle = oracle_;
        emit OracleSet(address(oracle_));
    }

    function _setMaxSlippage(uint16 bps) private {
        if (bps > MAX_SLIPPAGE_CAP_BPS) revert SlippageTooHigh(bps);
        maxSlippageBps = bps;
        emit MaxSlippageSet(bps);
    }
}
