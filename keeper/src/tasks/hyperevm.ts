import { BigNumber, utils } from "ethers";
import { ParentTransactionReceipt, ParentToChildMessageStatus } from "@arbitrum/sdk";
import { act } from "../tx.js";
import { DRY_RUN } from "../tx.js";
import { Ctx, fmt, logsChunked } from "../context.js";
import { confirmedSendCount, execute, simulateExecute, withdrawalState, withdrawalsInTx } from "../outbox.js";
import { alert, info, warn } from "../log.js";

/** Claims confirmed Elysium -> HyperEVM withdrawals (the KNTQ bucket) on the HyperEVM outbox. */
export async function claimWithdrawals(ctx: Ctx) {
  const H = ctx.hyperevm;
  const pending = Object.entries(ctx.state.withdrawals).filter(([, s]) => s === "PENDING");
  if (!H || pending.length === 0) return;
  const { sendCount } = await confirmedSendCount(H.provider, ctx.elysium.provider);
  for (const [txHash] of pending) {
    const ws = await withdrawalsInTx(ctx.elysium.provider, txHash);
    let allDone = ws.length > 0;
    for (const w of ws) {
      const s = await withdrawalState(w, H.provider, sendCount);
      if (s === "EXECUTED") continue;
      allDone = false;
      if (s === "UNCONFIRMED") {
        info(`withdrawal ${txHash.slice(0, 10)}… (position ${w.position}) not confirmed yet (confirmed up to ${sendCount})`);
        continue;
      }
      try {
        await simulateExecute(w, H.provider, ctx.elysium.provider, sendCount, ctx.keeper);
      } catch (e: any) {
        warn(`claim of withdrawal ${w.position} would fail: ${e?.reason ?? e?.message}`);
        continue;
      }
      if (DRY_RUN) {
        info(`[HyperEVM] outbox claim of withdrawal ${w.position}: OK in simulation (dry run)`);
        continue;
      }
      const tx = await execute(w, H.signer, ctx.elysium.provider, sendCount);
      const r = await tx.wait(1);
      info(`[HyperEVM] claimed withdrawal ${w.position}: ${r.transactionHash}`);
    }
    if (allDone) ctx.state.withdrawals[txHash] = "EXECUTED";
  }
}

/** KNTQ that arrived from Elysium -> sKNTQ -> HyperEVM reserve. */
export async function stake(ctx: Ctx) {
  const { stakeAndLock, kntq } = ctx.h;
  if (!ctx.hyperevm || !stakeAndLock || !kntq) return;
  const bal: BigNumber = await kntq.balanceOf(stakeAndLock.address);
  if (bal.gt(0)) await act(ctx.hyperevm, `stakeAndLock.stake(${fmt(bal)} KNTQ)`, stakeAndLock, "stake");
}

export async function harvestHyperEvm(ctx: Ctx) {
  const { reserve, vault } = ctx.h;
  if (!ctx.hyperevm || !reserve || !vault) return;
  const pending: BigNumber = await reserve.pendingYield(vault.address);
  const min = utils.parseUnits(ctx.cfg.hyperevm!.minYieldToHarvest, 18);
  if (pending.gte(min)) await act(ctx.hyperevm, `reserve.harvest(sKNTQ) ~${fmt(pending)} KNTQ`, reserve, "harvest", [vault.address]);
}

/** sKNTQ yield -> withdrawal request (7 days) -> KNTQ -> bridge to Elysium. */
export async function unstakeAndBridge(ctx: Ctx) {
  const { yieldBridge, vault, kntq, inbox } = ctx.h;
  const H = ctx.hyperevm;
  if (!H || !yieldBridge || !vault || !kntq || !inbox) return;

  if ((await vault.balanceOf(yieldBridge.address)).gt(0)) {
    await act(H, "yieldBridge.requestUnstake", yieldBridge, "requestUnstake");
  }

  // Confirm matured requests, oldest first.
  const next = (await vault.nextWithdrawalRequestId(yieldBridge.address)).toNumber();
  const delay = (await vault.withdrawalDelay()).toNumber();
  const now = (await H.provider.getBlock("latest")).timestamp;
  for (let id = Math.max(1, ctx.state.lastSettledRequestId + 1); id < next; id++) {
    const r = await vault.withdrawalRequest(yieldBridge.address, id);
    if (r.assets.eq(0)) {
      ctx.state.lastSettledRequestId = id; // already confirmed (or never used)
      continue;
    }
    const readyAt = r.timestamp.toNumber() + delay;
    if (now < readyAt) {
      info(`unstake request ${id} (${fmt(r.assets)} KNTQ) ready in ${((readyAt - now) / 3600).toFixed(1)} h`);
      break;
    }
    const o = await act(H, `yieldBridge.confirm(${id})`, yieldBridge, "confirm", [id]);
    if (o.kind === "sent") ctx.state.lastSettledRequestId = id;
    else break;
  }

  // Bridge collected KNTQ to the Elysium YieldRouter.
  const bal: BigNumber = await kntq.balanceOf(yieldBridge.address);
  if (bal.gt(0)) {
    const [minGas, minGasPrice, l2GasPrice, block] = await Promise.all([
      yieldBridge.minGas(), yieldBridge.minGasPrice(), ctx.elysium.provider.getGasPrice(), H.provider.getBlock("latest"),
    ]);
    const maxGas = BigNumber.from(300_000).gt(minGas) ? BigNumber.from(300_000) : minGas;
    const gasPriceBid = l2GasPrice.mul(2).gt(minGasPrice) ? l2GasPrice.mul(2) : minGasPrice;
    const baseFee = block.baseFeePerGas ?? (await H.provider.getGasPrice());
    const submission: BigNumber = await inbox.calculateRetryableSubmissionFee(2_000, baseFee);
    const maxSubmissionCost = submission.mul(2);
    const value = maxSubmissionCost.add(maxGas.mul(gasPriceBid));
    const o = await act(H, `yieldBridge.bridge(${fmt(bal)} KNTQ, fee ${fmt(value)} HYPE)`, yieldBridge, "bridge",
      [maxGas, gasPriceBid, maxSubmissionCost], value);
    if (o.kind === "sent") ctx.state.tickets[o.receipt.transactionHash] = "PENDING";
  }
}

/** Picks up yield bridges made by anyone (HyperEVM RPC caps log ranges at 1,000 blocks). */
export async function scanYieldBridge(ctx: Ctx) {
  const { yieldBridge } = ctx.h;
  const H = ctx.hyperevm;
  if (!H || !yieldBridge) return;
  const latest = await H.provider.getBlockNumber();
  const from = (ctx.state.hyperevmScanBlock ?? Math.max(ctx.cfg.hyperevm!.deployBlock, latest - 5_000)) + 1;
  if (from > latest) return;
  const to = Math.min(latest, from + 50_000); // catch up gradually
  const logs = await logsChunked(H.provider, { address: yieldBridge.address, topics: [yieldBridge.interface.getEventTopic("Bridged")] }, from, to, 1_000);
  for (const l of logs) ctx.state.tickets[l.transactionHash] ??= "PENDING";
  ctx.state.hyperevmScanBlock = to;
}

/** HyperEVM -> Elysium tickets: redeem any that didn't auto-execute (expire after 7 days). */
export async function watchTickets(ctx: Ctx) {
  const H = ctx.hyperevm;
  if (!H) return;
  for (const [txHash, s] of Object.entries(ctx.state.tickets)) {
    if (s !== "PENDING") continue;
    const receipt = await H.provider.getTransactionReceipt(txHash);
    if (!receipt) continue;
    const msgs = await new ParentTransactionReceipt(receipt).getParentToChildMessages(ctx.elysium.signer);
    let done = true;
    for (const m of msgs) {
      const status = await m.status();
      if (status === ParentToChildMessageStatus.REDEEMED) continue;
      if (status === ParentToChildMessageStatus.NOT_YET_CREATED) {
        done = false;
        continue;
      }
      if (status === ParentToChildMessageStatus.FUNDS_DEPOSITED_ON_CHILD) {
        done = false;
        alert(`ticket ${m.retryableCreationId} from ${txHash} did not auto-execute; redeeming`);
        if (!DRY_RUN) {
          const r = await (await m.redeem()).wait();
          info(`[Elysium] redeemed ticket: ${r.transactionHash}`);
        }
        continue;
      }
      alert(`ticket ${m.retryableCreationId} from ${txHash} is ${ParentToChildMessageStatus[status]}: needs attention`);
      ctx.state.tickets[txHash] = "FAILED";
      done = false;
    }
    if (done && msgs.length > 0) ctx.state.tickets[txHash] = "REDEEMED";
  }
}

export async function checkGas(ctx: Ctx) {
  const min = utils.parseEther(ctx.cfg.tuning.minGasBalance);
  for (const c of [ctx.elysium, ctx.hyperevm]) {
    if (!c) continue;
    const bal = await c.provider.getBalance(ctx.keeper);
    if (bal.lt(min)) alert(`keeper has ${fmt(bal)} HYPE on ${c.name} (below ${ctx.cfg.tuning.minGasBalance})`);
  }
}
