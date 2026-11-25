import { BigNumber, Contract } from "ethers";
import { VAULT } from "../abis.js";
import { act } from "../tx.js";
import { afterSuccess, firstTry, shrink } from "../chunk.js";
import { Ctx, fmt, logsChunked } from "../context.js";
import { alert, info, warn } from "../log.js";

/** Keeps the TWAP oracle fresh. Only keepers may poke a fresh feed. */
export async function pokeOracle(ctx: Ctx) {
  const oracle = ctx.e.oracle;
  if (!oracle) return;
  if (!ctx.feedIds || ctx.state.lastRun["oracle.feeds"] === undefined || Date.now() / 1000 - ctx.state.lastRun["oracle.feeds"] > 3600) {
    const logs = await ctx.elysium.provider.getLogs({
      address: oracle.address,
      topics: [oracle.interface.getEventTopic("FeedAdded")],
      fromBlock: ctx.cfg.elysium.deployBlock,
      toBlock: "latest",
    });
    ctx.feedIds = logs.map((l) => l.topics[1]);
    ctx.state.lastRun["oracle.feeds"] = Math.floor(Date.now() / 1000);
    if (!(await oracle.isKeeper(ctx.keeper))) alert(`keeper ${ctx.keeper} is not an oracle keeper; pokes will fail`);
  }
  if (ctx.feedIds.length === 0) return;
  await act(ctx.elysium, `oracle.poke(${ctx.feedIds.length} feeds)`, oracle, "poke", [ctx.feedIds]);
}

/** Ascend escrow -> FeeInbox -> FeeRouter (20% creator / 80% reserve). */
export async function collectFees(ctx: Ctx) {
  const { escrow, feeInbox, feeRouter } = ctx.e;
  if (escrow && feeInbox) {
    await act(ctx.elysium, "escrow.settle", escrow, "settle");
    const claimable: BigNumber = await escrow.claimable(feeInbox.address);
    if (claimable.gt(0)) await act(ctx.elysium, `escrow.claim(${fmt(claimable)})`, escrow, "claim", [feeInbox.address]);
  }
  for (const t of ctx.tokens) {
    if (feeInbox && (await t.contract.balanceOf(feeInbox.address)).gt(0)) {
      await act(ctx.elysium, `feeInbox.forward(${t.symbol})`, feeInbox, "forward", [t.address]);
    }
    if (feeRouter && (await t.contract.balanceOf(feeRouter.address)).gt(0)) {
      await act(ctx.elysium, `feeRouter.distribute(${t.symbol})`, feeRouter, "distribute", [t.address]);
    }
  }
}

/** One adaptively sized piece per contract and token per tick. */
async function processPieces(ctx: Ctx, name: string, contract: Contract | undefined, method: string) {
  if (!contract) return;
  for (const t of ctx.tokens) {
    const balance = BigInt((await t.contract.balanceOf(contract.address)).toString());
    if (balance === 0n) continue;
    const key = `${name}:${t.address}`;
    const remembered = ctx.state.chunks[key] ? BigInt(ctx.state.chunks[key]) : undefined;
    let amount: bigint | undefined = firstTry(remembered, balance);
    while (amount !== undefined) {
      const label = `${name}.${method}(${t.symbol}, ${fmt(BigNumber.from(amount), t.decimals)} of ${fmt(BigNumber.from(balance), t.decimals)})`;
      const o = await act(ctx.elysium, label, contract, method, [t.address, amount.toString()]);
      if (o.kind === "sent" || o.kind === "dry") {
        ctx.state.chunks[key] = afterSuccess(amount).toString();
        break;
      }
      if (o.kind !== "price") break;
      const next = shrink(amount, balance);
      if (next === undefined) {
        warn(`${name} ${t.symbol}: no piece fits the slippage limit right now (${o.reason}); retrying next tick`);
        ctx.state.chunks[key] = (balance / 64n).toString();
      }
      amount = next;
    }
  }
}

/** Allocator (40/40/20), creator payout (50/20/20/10), yield waterfall. */
export async function processSwaps(ctx: Ctx) {
  await processPieces(ctx, "allocator", ctx.e.allocator, "allocatePartial");
  await processPieces(ctx, "creatorPayout", ctx.e.creatorPayout, "payoutPartial");
  await processPieces(ctx, "yieldRouter", ctx.e.yieldRouter, "routePartial");
}

/** Non-reserve tokens that land in the reserve (e.g. holder rewards) go to the waterfall. */
export async function sweepReserve(ctx: Ctx) {
  const r = ctx.e.reserve;
  if (!r) return;
  for (const t of ctx.tokens) {
    if (await r.isReserveAsset(t.address)) continue;
    if ((await t.contract.balanceOf(r.address)).gt(0)) await act(ctx.elysium, `reserve.sweep(${t.symbol})`, r, "sweep", [t.address]);
  }
}

export async function pokeStaking(ctx: Ctx) {
  const s = ctx.e.staking;
  if (!s) return;
  const [finish, queued, duration] = await Promise.all([s.periodFinish(), s.queuedRewards(), s.DURATION()]);
  const now = (await ctx.elysium.provider.getBlock("latest")).timestamp;
  if (finish.lte(now) && queued.gte(duration)) await act(ctx.elysium, "staking.poke", s, "poke");
}

export async function harvestElysium(ctx: Ctx) {
  const r = ctx.e.reserve;
  if (!r) return;
  const n = (await r.assetCount()).toNumber();
  let any = false;
  for (let i = 0; i < n; i++) if ((await r.pendingYield(await r.assetAt(i))).gt(0)) any = true;
  if (any) await act(ctx.elysium, "reserve.harvestAll (Elysium)", r, "harvestAll");
}

/** Sends the KNTQ bucket to HyperEVM once it reaches BridgeOut's minimum. */
export async function bridgeOut(ctx: Ctx) {
  const b = ctx.e.bridgeOut;
  if (!b) return;
  const o = await act(ctx.elysium, "bridgeOut.bridge", b, "bridge");
  if (o.kind === "sent") {
    ctx.state.withdrawals[o.receipt.transactionHash] = "PENDING";
    info(`withdrawal ${o.receipt.transactionHash} queued; claimable on HyperEVM once confirmed`);
  }
}

/** Picks up BridgeOut withdrawals made by anyone, so none is left unclaimed. */
export async function scanBridgeOut(ctx: Ctx) {
  const b = ctx.e.bridgeOut;
  if (!b) return;
  const latest = await ctx.elysium.provider.getBlockNumber();
  const from = (ctx.state.elysiumScanBlock ?? ctx.cfg.elysium.deployBlock) + 1;
  if (from > latest) return;
  const logs = await logsChunked(ctx.elysium.provider, { address: b.address, topics: [b.interface.getEventTopic("Bridged")] }, from, latest, 500_000);
  for (const l of logs) ctx.state.withdrawals[l.transactionHash] ??= "PENDING";
  ctx.state.elysiumScanBlock = latest;
}

/** Auto-compounding vaults. The vaults work without this; the keeper only
 *  makes them earn more:
 *  - harvest (collect fees, 20% fee, add the rest back) every vaultHarvestEverySec
 *    when fees are waiting. Anyone may do this.
 *  - rebalance (move the ranges to the price) when the price has left the main
 *    range. Only the vault's keeper address may do this, so it is skipped
 *    unless this wallet is the keeper. The price read here is passed along and
 *    the vault refuses to move if the pool is more than vaultMaxDriftTicks away. */
export async function harvestVaults(ctx: Ctx) {
  const me = (await ctx.elysium.signer.getAddress()).toLowerCase();
  for (const addr of ctx.cfg.elysium.vaults ?? []) {
    const v = new Contract(addr, VAULT, ctx.elysium.provider);
    if ((await v.totalSupply()).eq(0)) continue;
    const name = `vault ${addr.slice(0, 10)}…`;
    const now = Math.floor(Date.now() / 1000);
    const [, tick] = await v.price();
    const [lower, upper] = await v.main();

    if (tick < lower || tick >= upper) {
      if ((await v.keeper()).toLowerCase() !== me) {
        info(`${name}: price is out of range, but this wallet is not the vault's keeper`);
      } else if (now < (await v.lastRebalance()).add(await v.REBALANCE_COOLDOWN()).toNumber()) {
        info(`${name}: out of range, waiting for the rebalance cooldown`);
      } else {
        await act(ctx.elysium, `${name}.rebalance at tick ${tick}`, v, "rebalance", [tick, ctx.cfg.tuning.vaultMaxDriftTicks]);
        continue;
      }
    }
    if (now - (await v.lastHarvest()).toNumber() < ctx.cfg.tuning.vaultHarvestEverySec) continue;
    const [fee0, fee1] = await v.pendingFees();
    if (fee0.isZero() && fee1.isZero()) continue;
    await act(ctx.elysium, `${name}.harvest`, v, "harvest");
  }
}
