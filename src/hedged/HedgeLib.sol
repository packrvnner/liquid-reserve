// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {CoreLib, ICoreDepositWallet} from "./CoreLib.sol";
import {PoolLib} from "./PoolLib.sol";
import "./HedgedTypes.sol";

/// @notice What the vault's HyperCore account looks like in this block.
struct Core {
    uint256 px; // oracle price of the hedge perp, raw
    int256 perp; // perp account value, USDC 6 decimals
    uint256 spot; // USDC on the spot side that counts as the vault's: what is there above the float
    uint256 spotAll; // all USDC on the spot side, 6 decimals
    int256 szi; // position in size units, negative is short
}

/// @title HedgeLib
/// @notice The HyperCore side of the hedged vault: what the account is worth, how large the short
/// should be, and the orders and transfers that keep it there. Deployed on its own and called by the
/// vault with delegatecall, so the HyperCore account it acts for is the vault's own.
library HedgeLib {
    using SafeERC20 for IERC20;

    /// @dev An order's limit is this far beyond the oracle price.
    uint256 internal constant ORDER_SLIP_BPS = 50;
    /// @dev Blocks to wait after an order before sending the next: the first must have landed and be
    /// visible, or the same difference would be traded twice.
    uint256 internal constant ORDER_GAP = 5;
    /// @dev HyperCore refuses orders worth less than $10.
    uint256 internal constant MIN_ORDER = 11e6;
    /// @dev Amounts under 1 USDC are not moved to or from HyperCore.
    uint256 internal constant MIN_MOVE = 1e6;
    /// @dev HyperCore charges an account 1 USDC the first time it sends anything out, and about a tenth of
    /// a cent for every send after that (seen on mainnet on 2026-11-26: 1.001222 USDC). It takes the
    /// charge from what is left on the spot side, and refuses, without any error, a send that does not
    /// leave enough. So up to this much USDC stays on the vault's spot side for good. The vault does not
    /// count it as its own, so nobody is ever owed a share of it.
    uint256 internal constant SPOT_FLOAT = 1_050_000;
    /// @dev Asked back on top of what is owed, so that HyperCore's charge for the send does not leave the
    /// payout a fraction of a cent short.
    uint256 internal constant OWED_CUSHION = 10_000;
    /// @dev The least that is asked back from HyperCore. Smaller than MIN_MOVE on purpose: the last cents
    /// owed to someone who left must still be fetched.
    uint256 internal constant MIN_PULL = 50_000;

    // ------------------------------------------------------------------ reading

    function read(Vault storage v) public view returns (Core memory c) {
        c.px = CoreLib.oraclePx(v.c.perp);
        c.perp = CoreLib.accountValue(address(this));
        c.spotAll = CoreLib.spotUsdc(address(this));
        c.spot = c.spotAll > SPOT_FLOAT ? c.spotAll - SPOT_FLOAT : 0;
        c.szi = CoreLib.positionSz(address(this), v.c.perp);
    }

    /// @notice The perp account's value as it will be once what this block sent and asked back has landed.
    function perpNow(Vault storage v, Core memory c) public view returns (int256 p) {
        p = c.perp;
        if (v.sentBlock == block.number) p += int256(uint256(v.sentAmount));
        if (v.pullBlock == block.number) p -= int256(uint256(v.pullAmount));
    }

    /// @notice Value of an amount of token0 in USDC at a raw price.
    function assetValue(Vault storage v, uint256 amount0, uint256 px) public view returns (uint256) {
        return amount0 * px / 10 ** (18 - v.c.szDecimals);
    }

    /// @notice The size the short should have: the token0 the vault holds, in the position and idle.
    /// The position is read at the oracle price, not at the pool's price of the moment, so pushing
    /// the pool cannot make the vault trade.
    function targetSz(Vault storage v, uint256 px) public view returns (uint256) {
        (uint256 a0,) = PoolLib.amountsAt(v, PoolLib.sqrtPriceAt(v, px));
        a0 += IERC20(v.c.asset).balanceOf(address(this));
        return a0 * 10 ** v.c.szDecimals / 1e18;
    }

    /// @notice Everything the vault owns, in USDC, less what it owes. Token0 counts at the oracle price.
    function totalValue(Vault storage v) public view returns (uint256) {
        Core memory c = read(v);
        (uint160 p,) = PoolLib.price(v);
        (uint256 a0, uint256 a1) = PoolLib.amountsAt(v, p);
        a0 += IERC20(v.c.asset).balanceOf(address(this));
        int256 total = int256(a1 + IERC20(v.c.usdc).balanceOf(address(this)) + assetValue(v, a0, c.px) + c.spot)
            + c.perp - int256(v.owedTotal);
        if (v.sentBlock == block.number) total += int256(uint256(v.sentAmount));
        return total > 0 ? uint256(total) : 0;
    }

    /// @notice The margin to keep for a short of the larger of what it is and what it should be.
    function marginWanted(Vault storage v, Core memory c, uint256 target) public view returns (uint256) {
        uint256 short = c.szi < 0 ? uint256(-c.szi) : 0;
        return (short > target ? short : target) * c.px * v.marginBps / 10_000;
    }

    // ------------------------------------------------------------------ moving USDC

    /// @notice Sends USDC from the vault to its perp account.
    function fund(Vault storage v, uint256 usdc) external {
        IERC20(v.c.usdc).forceApprove(v.c.coreDeposit, usdc);
        ICoreDepositWallet(v.c.coreDeposit).deposit(usdc, CoreLib.PERP_DEX);
        if (v.sentBlock != block.number) (v.sentBlock, v.sentAmount) = (uint64(block.number), 0);
        v.sentAmount += uint128(usdc);
        emit IHedgedVaultEvents.MarginSent(usdc);
    }

    /// @notice Asks HyperCore to move `usdc` from the perp account to the spot side and to send home
    /// everything that is then on the spot side above the float (so USDC left there by a transfer that
    /// stopped halfway goes along). It arrives in a later block, or not at all if HyperCore refuses;
    /// nothing here may count on it.
    function askBack(Vault storage v, Core memory c, uint256 usdc) public returns (bool) {
        // A request from an earlier block may not have been carried out yet: asking again on the same
        // reading would take the same money twice. Wait as long as for an order.
        if (v.pullBlock != block.number && block.number < v.pullBlock + ORDER_GAP) return false;
        if (usdc < MIN_PULL) usdc = 0;
        uint256 send = usdc;
        if (v.pullBlock != block.number) {
            // the first request of this block settles the spot side: the float is filled from it
            send = c.spotAll + usdc > SPOT_FLOAT ? c.spotAll + usdc - SPOT_FLOAT : 0;
        }
        if (usdc == 0 && send < MIN_PULL) return false;
        if (usdc > 0) CoreLib.perpToSpot(usdc);
        if (send > 0) CoreLib.spotToEvm(send);
        if (v.pullBlock != block.number) (v.pullBlock, v.pullAmount) = (uint64(block.number), 0);
        v.pullAmount += uint128(usdc);
        emit IHedgedVaultEvents.MarginAskedBack(usdc);
        return true;
    }

    /// @notice What to ask back so that what is owed to withdrawers and not in the vault yet arrives, as
    /// far as the margin can give it and stay above its lower line. It is what is missing, a cent for
    /// HyperCore's charge, and whatever the float is short of: the first request of a block fills the
    /// float before anything is sent home, and that must not come out of what someone is owed.
    function owedBack(Vault storage v, Core memory c) public view returns (uint256 back) {
        uint256 here = IERC20(v.c.usdc).balanceOf(address(this));
        if (v.owedTotal <= here) return 0;
        uint256 low = marginWanted(v, c, targetSz(v, c.px)) * 5 / 8;
        int256 p = perpNow(v, c);
        if (p <= int256(low)) return 0;
        back = v.owedTotal - here + OWED_CUSHION;
        if (c.spotAll < SPOT_FLOAT && v.pullBlock != block.number) back += SPOT_FLOAT - c.spotAll;
        if (back > uint256(p) - low) back = uint256(p) - low;
    }

    function askBackForOwed(Vault storage v, Core memory c) external returns (bool) {
        return askBack(v, c, owedBack(v, c));
    }

    // ------------------------------------------------------------------ the short

    /// @notice Sends the order that brings the short to its target, if one is due.
    /// @param force true after the vault itself changed what it holds: the band is then ignored
    /// @dev Sells go up to the target and no further; buys are reduce-only. So the account is never
    /// long and never short more than the token0 the vault holds. A short is not made larger than the
    /// margin carries at its lower line, and it is made smaller, whatever the target, when the margin
    /// is under its emergency line.
    function hedge(Vault storage v, Core memory c, bool force) external returns (bool sent) {
        if (block.number < v.lastOrderBlock + ORDER_GAP) return false;
        uint256 short = c.szi < 0 ? uint256(-c.szi) : 0;
        uint256 target;
        (target, force) = _target(v, c, perpNow(v, c), short, force);

        bool isBuy = short > target;
        uint256 sz = isBuy ? short - target : target - short;
        if (sz == 0 || (sz * c.px < MIN_ORDER && !(isBuy && target == 0))) return false;
        if (!force && _insideBand(v, c.px, sz * c.px)) return false;
        uint256 limit = CoreLib.order(
            v.c.perp,
            v.c.szDecimals,
            isBuy,
            sz,
            c.px * (isBuy ? 10_000 + ORDER_SLIP_BPS : 10_000 - ORDER_SLIP_BPS) / 10_000,
            isBuy
        );
        v.lastOrderBlock = uint64(block.number);
        emit IHedgedVaultEvents.OrderSent(isBuy, sz, limit, isBuy, c.szi, target);
        return true;
    }

    /// @dev The target after the margin has had its say.
    function _target(Vault storage v, Core memory c, int256 perp, uint256 short, bool force)
        private
        view
        returns (uint256 target, bool forced)
    {
        target = targetSz(v, c.px);
        forced = force;
        // what the margin carries at its lower line (5/8 of the target margin)
        uint256 carried = perp > 0 ? uint256(perp) * 16_000 / (uint256(v.marginBps) * c.px) : 0;
        if (short > 0 && perp * 100_000 < int256(short * c.px * v.marginBps * 3)) {
            // under the emergency line (3/10 of the target margin)
            if (target > carried) target = carried;
            forced = true;
        } else if (target > short) {
            uint256 allowed = carried > short ? carried : short;
            if (target > allowed) target = allowed;
        }
    }

    /// @dev True when an order of this value is smaller than the band of the position's value.
    function _insideBand(Vault storage v, uint256 px, uint256 value) private view returns (bool) {
        (uint256 a0, uint256 a1) = PoolLib.amountsAt(v, PoolLib.sqrtPriceAt(v, px));
        return value * 10_000 < (a1 + assetValue(v, a0, px)) * v.bandBps;
    }
}
