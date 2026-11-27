// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolLib} from "./PoolLib.sol";
import {HedgeLib, Core} from "./HedgeLib.sol";
import {FlowLib} from "./FlowLib.sol";
import "./HedgedTypes.sol";

/// @title KeepLib
/// @notice The upkeep of the hedged vault: putting idle money to work, keeping the margin between
/// its lines and the short at its target, moving the range. Deployed on its own and called by the
/// vault with delegatecall.
///
/// Who may do what follows one rule: whatever makes the vault swap in its pool is the keeper's, with
/// the tick it expects stated, because a swap is the one thing a stranger could profit from by
/// choosing the moment. Whatever keeps the hedge safe needs no swap and is open to anyone.
library KeepLib {
    /// @dev Idle USDC kept in the vault so that withdrawals can be paid at once, as a share of everything.
    uint256 internal constant BUFFER_BPS = 200;
    /// @dev Less than this is not worth putting to work.
    uint256 internal constant MIN_DEPLOY = 5e6;
    int24 internal constant MAX_DRIFT = 200;
    uint256 internal constant REBALANCE_COOLDOWN = 15 minutes;

    /// @notice Puts idle money to work: the margin's share goes to HyperCore, the rest into the
    /// position, and the order for the added token0 is sent. The keeper only (checked by the vault).
    function deploy(Vault storage v, int24 expectedTick, int24 maxDrift) external {
        if (v.closing) revert Closing();
        Core memory c = _guard(v, expectedTick, maxDrift);
        FlowLib.collectFees(v);
        uint256 budget = _budget(v);
        if (budget + HedgeLib.assetValue(v, IERC20(v.c.asset).balanceOf(address(this)), c.px) < MIN_DEPLOY) {
            revert NothingToDo();
        }
        // Of every new dollar, the short will need margin for the share that becomes token0.
        uint256 mh = uint256(v.marginBps) * PoolLib.assetShare(v) / 10_000; // 1e18
        uint256 toMargin = budget * mh / (1e18 + mh);
        if (toMargin >= HedgeLib.MIN_MOVE) HedgeLib.fund(v, toMargin);
        else toMargin = 0;
        PoolLib.fill(v, budget - toMargin);
        HedgeLib.hedge(v, c, true);
    }

    /// @notice Takes the position out and opens it again around the pool price. During a wind-down it
    /// takes the position out and sells its token0 instead. The keeper only (checked by the vault).
    function rebalance(Vault storage v, int24 expectedTick, int24 maxDrift) external {
        if (!v.closing) {
            uint256 availableAt = v.lastRebalance + REBALANCE_COOLDOWN;
            if (v.lastRebalance != 0 && block.timestamp < availableAt) revert TooSoon(availableAt);
        }
        Core memory c = _guard(v, expectedTick, maxDrift);
        FlowLib.collectFees(v);
        PoolLib.remove(v, 1, 1);
        if (v.closing) PoolLib.swap(v, true, IERC20(v.c.asset).balanceOf(address(this)));
        else PoolLib.fill(v, _budget(v));
        v.lastRebalance = uint64(block.timestamp);
        HedgeLib.hedge(v, c, true);
    }

    /// @notice Everything that keeps the hedge safe and in place, in one call that anyone may make:
    /// tops the margin up when it is under its lower line, asks back what is over its upper line or
    /// owed to withdrawers, and resizes the short when it is outside its band. During a wind-down it
    /// also takes the position out of the pool. Reverts when there is nothing to do.
    function tend(Vault storage v) external {
        Core memory c = HedgeLib.read(v);
        bool did;
        if (v.closing && v.liquidity > 0) {
            FlowLib.collectFees(v);
            PoolLib.remove(v, 1, 1);
            did = true;
        }

        uint256 want = HedgeLib.marginWanted(v, c, HedgeLib.targetSz(v, c.px));
        int256 perp = HedgeLib.perpNow(v, c);
        if (perp < int256(want * 5 / 8)) {
            if (_topUp(v, uint256(int256(want) - perp))) did = true;
        } else {
            // what is over the upper line, or what is owed to withdrawers if that is more; USDC that a
            // transfer left on the spot side goes home with it
            uint256 back = HedgeLib.owedBack(v, c);
            if (perp > int256(want * 13 / 8) && uint256(perp) - want > back) back = uint256(perp) - want;
            if (HedgeLib.askBack(v, c, back)) did = true;
        }
        if (HedgeLib.hedge(v, c, v.closing)) did = true;
        if (!did) revert NothingToDo();
    }

    // ------------------------------------------------------------------ internals

    /// @dev The pool is where the keeper expects it, and it agrees with the oracle.
    function _guard(Vault storage v, int24 expectedTick, int24 maxDrift) private view returns (Core memory c) {
        if (maxDrift < 0 || maxDrift > MAX_DRIFT) revert BadParams();
        (, int24 tick) = PoolLib.price(v);
        int24 diff = tick > expectedTick ? tick - expectedTick : expectedTick - tick;
        if (diff > maxDrift) revert PriceMoved(tick, expectedTick);
        c = HedgeLib.read(v);
        PoolLib.requireInLine(v, c.px);
    }

    /// @dev USDC that may go to work: what is here, less what is owed and less the buffer.
    function _budget(Vault storage v) private view returns (uint256) {
        uint256 here = IERC20(v.c.usdc).balanceOf(address(this));
        uint256 keep = v.owedTotal + HedgeLib.totalValue(v) * BUFFER_BPS / 10_000;
        return here > keep ? here - keep : 0;
    }

    /// @dev Sends `need` USDC to the margin: idle USDC first, then as much of the position as it takes
    /// for its USDC side to cover the rest. Nothing is swapped: the token0 that comes out with it waits
    /// in the vault, where the short still covers it, until the keeper puts it back to work.
    function _topUp(Vault storage v, uint256 need) private returns (bool) {
        uint256 free = _free(v);
        if (free < need && v.liquidity > 0) {
            FlowLib.collectFees(v);
            (uint160 p,) = PoolLib.price(v);
            (, uint256 usdcIn) = PoolLib.amountsAt(v, p);
            if (usdcIn > 0) {
                uint256 missing = need - free;
                PoolLib.remove(v, missing < usdcIn ? missing : usdcIn, usdcIn);
                free = _free(v);
            }
        }
        if (free > need) free = need;
        if (free < HedgeLib.MIN_MOVE) return false;
        HedgeLib.fund(v, free);
        return true;
    }

    function _free(Vault storage v) private view returns (uint256) {
        uint256 here = IERC20(v.c.usdc).balanceOf(address(this));
        return here > v.owedTotal ? here - v.owedTotal : 0;
    }
}
