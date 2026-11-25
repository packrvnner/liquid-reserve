// Read-only snapshot of the whole system: npm run status
import { BigNumber } from "ethers";
import { loadConfig } from "./config.js";
import { connect } from "./chain.js";
import { buildCtx, fmt } from "./context.js";
import { loadState } from "./state.js";
import { registerElysium } from "./networks.js";
import { confirmedSendCount } from "./outbox.js";

process.env.DRY_RUN ??= "1";
const cfg = loadConfig();
registerElysium();
const { elysium, hyperevm, keeper } = await connect(cfg);
const ctx = await buildCtx(cfg, elysium, hyperevm, keeper, loadState(cfg.stateFile));
const line = (k: string, v: string) => console.log(`  ${k.padEnd(34)} ${v}`);

console.log(`Keeper ${keeper}`);
console.log(`  Elysium HYPE: ${fmt(await elysium.provider.getBalance(keeper))}${hyperevm ? `   HyperEVM HYPE: ${fmt(await hyperevm.provider.getBalance(keeper))}` : ""}`);

const r = ctx.e.reserve;
if (r) {
  console.log("\nElysium reserve (locked forever)");
  const n = (await r.assetCount()).toNumber();
  for (let i = 0; i < n; i++) {
    const a = await r.assetAt(i);
    const t = ctx.tokens.find((x) => x.address.toLowerCase() === a.toLowerCase());
    line(`${t?.symbol ?? a} principal / value / yield`, `${fmt(await r.principal(a))} / ${fmt(await r["valueOf(address)"](a))} / ${fmt(await r.pendingYield(a))}`);
  }
}
console.log("\nWaiting to be processed (Elysium)");
for (const [name, c] of Object.entries(ctx.e)) {
  if (!c || ["oracle", "reserve", "escrow", "staking"].includes(name)) continue;
  for (const t of ctx.tokens) {
    const b: BigNumber = await t.contract.balanceOf(c.address);
    if (b.gt(0)) line(`${name} ${t.symbol}`, fmt(b, t.decimals));
  }
}
if (ctx.e.escrow && ctx.e.feeInbox) {
  line("Ascend escrow claimable / held", `${fmt(await ctx.e.escrow.claimable(ctx.e.feeInbox.address))} / ${fmt(await ctx.e.escrow.held())}`);
}
if (ctx.e.oracle) {
  const logs = await elysium.provider.getLogs({ address: ctx.e.oracle.address, topics: [ctx.e.oracle.interface.getEventTopic("FeedAdded")], fromBlock: cfg.elysium.deployBlock, toBlock: "latest" });
  const now = (await elysium.provider.getBlock("latest")).timestamp;
  let stalest = 0;
  for (const l of logs) stalest = Math.max(stalest, now - (await ctx.e.oracle.feeds(l.topics[1])).lastTime);
  line("oracle feeds / stalest poke", `${logs.length} / ${stalest}s ago`);
}

if (hyperevm && ctx.h.reserve && ctx.h.vault) {
  console.log("\nHyperEVM reserve (sKNTQ, locked forever)");
  const v = ctx.h.vault.address;
  line("sKNTQ principal / value / yield (KNTQ)", `${fmt(await ctx.h.reserve.principal(v))} / ${fmt(await ctx.h.reserve["valueOf(address)"](v))} / ${fmt(await ctx.h.reserve.pendingYield(v))}`);
  if (ctx.h.stakeAndLock && ctx.h.kntq) line("KNTQ waiting to stake", fmt(await ctx.h.kntq.balanceOf(ctx.h.stakeAndLock.address)));
  if (ctx.h.yieldBridge && ctx.h.kntq) {
    line("sKNTQ yield waiting to unstake", fmt(await ctx.h.vault.balanceOf(ctx.h.yieldBridge.address)));
    line("KNTQ yield waiting to bridge", fmt(await ctx.h.kntq.balanceOf(ctx.h.yieldBridge.address)));
  }
  const pendingW = Object.entries(ctx.state.withdrawals).filter(([, s]) => s === "PENDING");
  if (pendingW.length) {
    const { sendCount } = await confirmedSendCount(hyperevm.provider, elysium.provider);
    line("withdrawals to claim (Elysium->HyperEVM)", `${pendingW.length} pending; bridge confirmed up to #${sendCount}`);
  }
  const pendingT = Object.values(ctx.state.tickets).filter((s) => s !== "REDEEMED");
  if (pendingT.length) line("tickets not yet redeemed (HyperEVM->Elysium)", String(pendingT.length));
}
