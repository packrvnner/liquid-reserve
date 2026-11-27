// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {CoreLib} from "./CoreLib.sol";
import {PoolLib} from "./PoolLib.sol";
import {HedgeLib, Core} from "./HedgeLib.sol";
import "./HedgedTypes.sol";

/// @title FlowLib
/// @notice Money in and money out of the hedged vault. Deployed on its own and called by the vault
/// with delegatecall. The vault mints and burns the shares; this library does the rest.
library FlowLib {
    using SafeERC20 for IERC20;

    // An allowance is kept back from every deposit and every withdrawal (`entryBps`, `exitBps` in the
    // config). It goes to nobody: it stays in the vault, for the people who stay, and pays for what the
    // deposit or withdrawal makes the vault do. A deposit makes it swap about half the money in the
    // pool (half the pool's fee) and open more short; a withdrawal makes it close some short, while the
    // person leaving pays for the sale of their own slice themselves.
    uint256 internal constant MINIMUM_SHARES = 1_000;
    uint256 internal constant PERFORMANCE_FEE_BPS = 2_000;

    /// @notice Collects the trading fees earned so far. The performance fee leaves; the rest stays idle.
    function collectFees(Vault storage v) public {
        if (v.liquidity == 0) return;
        IV3Pool pool = IV3Pool(v.c.pool);
        pool.burn(v.lower, v.upper, 0);
        (uint256 fee0, uint256 fee1) = pool.collect(address(this), v.lower, v.upper, type(uint128).max, type(uint128).max);
        if (fee0 == 0 && fee1 == 0) return;
        uint256 perf0 = fee0 * PERFORMANCE_FEE_BPS / 10_000;
        uint256 perf1 = fee1 * PERFORMANCE_FEE_BPS / 10_000;
        v.totalFees0 += fee0;
        v.totalFees1 += fee1;
        if (perf0 > 0) IERC20(v.c.asset).safeTransfer(v.c.feeRecipient, perf0);
        if (perf1 > 0) IERC20(v.c.usdc).safeTransfer(v.c.feeRecipient, perf1);
        emit IHedgedVaultEvents.FeesCollected(fee0, fee1, perf0, perf1);
    }

    /// @notice Takes `assets` USDC from the caller and says how many shares that buys.
    /// @return shares for a first deposit this includes the MINIMUM_SHARES the vault sends to the dead address
    function deposit(Vault storage v, uint256 assets, uint256 supply) external returns (uint256 shares) {
        if (v.depositsPaused) revert DepositsArePaused();
        if (v.closing) revert Closing();
        // The pool price must agree with the oracle, or the position could be mispriced on purpose.
        PoolLib.requireInLine(v, CoreLib.oraclePx(v.c.perp));
        collectFees(v); // those already in keep everything earned so far
        uint256 value = HedgeLib.totalValue(v);
        uint256 cap = v.depositCap;
        if (cap != 0 && value + assets > cap) revert CapExceeded(value + assets, cap);

        IERC20(v.c.usdc).safeTransferFrom(msg.sender, address(this), assets);
        uint256 net = assets - assets * v.c.entryBps / 10_000;
        if (supply == 0) {
            if (net <= MINIMUM_SHARES) revert ZeroShares();
            shares = net;
        } else {
            if (value == 0) revert Underwater();
            shares = net * supply / value;
        }
        if (shares == 0) revert ZeroShares();
    }

    /// @notice Pays out `shares` of `supply`: that slice of every pot. Never paused, and it needs no
    /// price to be right: it is a slice of what is really there.
    /// @return paidUsdc sent to the receiver now
    /// @return paidAsset token0 the pool's price limit left unsold, sent as it is
    /// @return owedNow USDC still on HyperCore; the receiver collects it with `claim` once it has arrived
    function withdraw(Vault storage v, uint256 shares, uint256 supply, address receiver)
        external
        returns (uint256 paidUsdc, uint256 paidAsset, uint256 owedNow)
    {
        Core memory c = HedgeLib.read(v);
        collectFees(v);

        // the slice of everything that is USDC or as good as, and the idle USDC not promised to anyone
        int256 rest = _rest(v, c) * int256(shares) / int256(supply);
        uint256 free = _free(v);

        // the slice of the position, with its token0 (and the slice of idle token0) sold for USDC
        uint256 fromPool;
        (fromPool, paidAsset) = _poolSlice(v, shares, supply);

        // pay now what is here and not promised to someone else; the rest is owed
        (paidUsdc, owedNow) = _pay(v, receiver, int256(fromPool) + rest, fromPool + free);
        if (paidAsset > 0) IERC20(v.c.asset).safeTransfer(receiver, paidAsset);

        // the short shrinks by the same slice, and what is owed is asked back from HyperCore
        HedgeLib.hedge(v, c, true);
        HedgeLib.askBackForOwed(v, c);
    }

    /// @dev Idle USDC and the HyperCore account, less what is owed to people who left earlier.
    /// Negative when HyperCore has lost more than is here: a shortfall is shared like everything else.
    function _rest(Vault storage v, Core memory c) private view returns (int256 rest) {
        rest = int256(IERC20(v.c.usdc).balanceOf(address(this))) + HedgeLib.perpNow(v, c) + int256(c.spot)
            - int256(v.owedTotal);
        if (v.pullBlock == block.number) rest += int256(uint256(v.pullAmount)); // asked back, not gone
    }

    function _free(Vault storage v) private view returns (uint256) {
        uint256 here = IERC20(v.c.usdc).balanceOf(address(this));
        return here > v.owedTotal ? here - v.owedTotal : 0;
    }

    /// @param gross what the slice is worth before the allowance
    /// @param here USDC that can be paid at once
    function _pay(Vault storage v, address receiver, int256 gross, uint256 here)
        private
        returns (uint256 paid, uint256 owedNow)
    {
        uint256 total = gross > 0 ? uint256(gross) : 0;
        total -= total * v.c.exitBps / 10_000;
        paid = total < here ? total : here;
        owedNow = total - paid;
        if (owedNow > 0) {
            v.owed[receiver] += owedNow;
            v.owedTotal += owedNow;
        }
        if (paid > 0) IERC20(v.c.usdc).safeTransfer(receiver, paid);
    }

    /// @dev Takes the slice out of the position and sells its token0, with the slice of idle token0.
    /// @return usdcOut USDC from the position and from the sale
    /// @return unsold token0 that the pool's price limit left unsold
    function _poolSlice(Vault storage v, uint256 shares, uint256 supply) private returns (uint256 usdcOut, uint256 unsold) {
        uint256 sell = IERC20(v.c.asset).balanceOf(address(this)) * shares / supply;
        uint256 out0;
        (out0, usdcOut) = PoolLib.remove(v, shares, supply);
        sell += out0;
        if (sell == 0) return (usdcOut, 0);
        if (IV3Pool(v.c.pool).liquidity() == 0) return (usdcOut, sell);
        (uint256 spent, uint256 got) = PoolLib.swap(v, true, sell);
        return (usdcOut + got, sell - spent);
    }

    /// @notice Pays a receiver what is owed to them, as far as it has arrived.
    function claim(Vault storage v, address receiver) external returns (uint256 paid) {
        uint256 due = v.owed[receiver];
        if (due == 0) revert NothingOwed();
        uint256 here = IERC20(v.c.usdc).balanceOf(address(this));
        paid = due < here ? due : here;
        if (paid == 0) revert NothingToDo();
        v.owed[receiver] = due - paid;
        v.owedTotal -= paid;
        IERC20(v.c.usdc).safeTransfer(receiver, paid);
        emit IHedgedVaultEvents.Claimed(receiver, paid);
    }
}
