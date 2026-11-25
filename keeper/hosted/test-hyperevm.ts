// Tests for the bot's HyperEVM job.
//
//   npx tsx hosted/test-hyperevm.ts claims   read-only, against the REAL chains: walks the claim logic over
//                                            other people's real bridge withdrawals and simulates (never sends)
//                                            the outbox call for ones that are confirmed but unclaimed
//   npx tsx hosted/test-hyperevm.ts fork     against a LOCAL anvil fork of HyperEVM on port 8598:
//                                            stake, yield harvest, unstake, bridge back
import { Wallet, utils } from "ethers";
import { execSync } from "node:child_process";
import { runHyperEvm, HYPER_CONFIG, HyperConfig, HyperReport, HyperState } from "./hyperevm.js";

const which = process.argv[2] ?? "claims";
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failed++; };
const show = (r: HyperReport) => console.log(`       -> ${r.status}: ${r.reason}${r.actions.length ? "\n          " + r.actions.map((a) => `${a.what}${a.note ? ` [${a.note}]` : a.confirmed ? " [confirmed]" : " [NOT confirmed]"}`).join("\n          ") : ""}${r.warnings.length ? "\n          warnings: " + r.warnings.join("; ") : ""}`);
const rpc = async (url: string, method: string, params: unknown[]) => {
  const j: any = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": "liquid-reserve-keeper/1" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
};

if (which === "claims") {
  // Real withdrawals made by anyone.
  const E = HYPER_CONFIG.elysium.rpc;
  const head = Number(await rpc(E, "eth_blockNumber", []));
  const topic = utils.id("L2ToL1Tx(address,address,uint256,uint256,uint256,uint256,uint256,uint256,bytes)");
  const logs: any[] = [];
  // An old window (long since confirmed by the bridge) and the newest one (not confirmed yet).
  for (const [a, b] of [[head - 4_000_000, head - 3_500_001], [head - 500_000, head]]) {
    logs.push(...(await rpc(E, "eth_getLogs", [{ address: "0x0000000000000000000000000000000000000064", topics: [topic], fromBlock: "0x" + a.toString(16), toBlock: "0x" + b.toString(16) }])));
    await new Promise((r) => setTimeout(r, 400));
  }
  const step = Math.max(1, Math.floor(logs.length / 14));
  const sample = logs.filter((_, i) => i % step === 0 || i >= logs.length - 2).map((l) => l.transactionHash as string);
  console.log(`${logs.length} real withdrawals found; checking ${sample.length} of them`);
  const state: HyperState = { scanBlock: head, withdrawals: Object.fromEntries(sample.map((t) => [t, "PENDING" as const])) };
  const throwaway = Wallet.createRandom(); // empty wallet: only used as the "from" of simulations
  const env: Record<string, string> = { KEEPER_PRIVATE_KEY: throwaway.privateKey, DRY_RUN: "1" };
  const { report, state: after } = await runHyperEvm({ ethers: { Wallet, utils }, fetch, env: (k) => env[k] }, state, { ...HYPER_CONFIG, maxClaimsPerRun: 4 });
  const count = (s: string) => report.batches.filter((b) => b.state === s).length;
  console.log(`  claimed ${count("claimed")}, ready to claim ${count("ready to claim")}, not confirmed yet ${count("not confirmed yet")}, unreadable ${count("unreadable")}`);
  for (const a of report.actions) console.log(`       ${a.what} [${a.note}]`);
  const sims = report.actions.filter((a) => a.what.startsWith("claim"));
  check("every sampled withdrawal was read", count("unreadable") === 0 && report.batches.length >= sample.length);
  check("old ones are seen as claimed or ready, the newest as not confirmed", count("not confirmed yet") >= 1 && count("claimed") + count("ready to claim") >= 1);
  check("claimed ones are dropped from the to-do list", Object.values(after.withdrawals).filter((s) => s === "EXECUTED").length >= Math.min(1, count("claimed")));
  if (sims.length) check("the outbox accepts the claim it builds (simulated, nothing sent)", sims.some((a) => a.note === "dry run: would have been sent"), `${sims.filter((a) => a.note === "dry run: would have been sent").length} of ${sims.length} simulated claims accepted`);
  else console.log("  note: no confirmed-but-unclaimed withdrawal in the sample, so no claim could be simulated");
} else {
  const RPC = "http://127.0.0.1:8598";
  const cfg: HyperConfig = { ...HYPER_CONFIG, hyperevm: { ...HYPER_CONFIG.hyperevm, rpc: RPC, rpcGapMs: 0 }, minYieldKntq: "0.05" };
  const sh = (c: string) => execSync(`export PATH="$HOME/.foundry/bin:$PATH"; ${c}`, { encoding: "utf8", shell: "/bin/bash" }).trim();
  const cast = (c: string) => sh(`cast ${c} --rpc-url ${RPC}`);
  const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil account #1
  const GATEWAY = "0xd97B30dE0bA0C2eAeE942afce77530e06c5F122c"; // the bridge's KNTQ escrow on HyperEVM
  const h = cfg.hyperevm;
  const balOf = (token: string, who: string) => BigInt(cast(`call ${token} "balanceOf(address)(uint256)" ${who}`).split(" ")[0]);
  const warp = (secs: number) => { cast(`rpc evm_increaseTime ${secs}`); cast("rpc evm_mine"); };
  const fromGateway = (to: string, amount: string) => sh(`cast send ${h.kntq} "transfer(address,uint256)" ${to} $(cast to-wei ${amount}) --from ${GATEWAY} --unlocked --rpc-url ${RPC} > /dev/null`);
  let state: HyperState | null = null;
  const run = async (env: Record<string, string> = { KEEPER_PRIVATE_KEY: KEY }) => { const o = await runHyperEvm({ ethers: { Wallet, utils }, fetch, env: (k) => env[k] }, state, cfg); state = o.state; show(o.report); return o.report; };
  cast(`rpc anvil_impersonateAccount ${GATEWAY}`); cast(`rpc anvil_setBalance ${GATEWAY} 0x56BC75E2D63100000`);
  cast(`rpc anvil_setBalance 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 0x56BC75E2D63100000`);

  console.log("1. nothing has arrived");
  let r = await run();
  // "waiting" when a real batch is crossing the bridge at the time of the fork
  check("nothing sent", (r.status === "idle" || r.status === "waiting") && r.actions.length === 0, r.status);
  check("remembers how far it scanned Elysium", (state as any).scanBlock > cfg.elysium.scanFromBlock);

  console.log("2. KNTQ arrives from the bridge: staked and locked");
  fromGateway(h.stakeAndLock, "10000");
  r = await run({});
  check("no wallet: reports, sends nothing", r.actions.length === 1 && !r.actions[0].tx && balOf(h.kntq, h.stakeAndLock) > 0n);
  r = await run();
  check("staked", r.status === "acted" && balOf(h.kntq, h.stakeAndLock) === 0n && balOf(h.skntq, h.reserve) > 0n, `${utils.formatEther(balOf(h.skntq, h.reserve).toString())} sKNTQ locked`);

  console.log("3. the sKNTQ rate rises: yield is collected, unstaked, bridged back");
  fromGateway(h.skntq, "500000"); warp(90 * 86400);
  r = await run();
  check("yield collected", r.actions.some((a) => a.what.startsWith("collect") && a.confirmed === true) && balOf(h.skntq, h.yieldBridge) > 0n);
  r = await run();
  check("unstake started", r.actions.some((a) => a.what.startsWith("start unstaking") && a.confirmed === true) && balOf(h.skntq, h.yieldBridge) === 0n);
  r = await run();
  check("waits out the 7 days", r.status === "waiting" && Number(r.holdings!.yieldUnstaking) > 0 && r.actions.length === 0, `${r.holdings!.yieldUnstaking} KNTQ unstaking`);
  warp(7 * 86400 + 60);
  const escrow = balOf(h.kntq, GATEWAY);
  r = await run();
  const bridged = balOf(h.kntq, GATEWAY) - escrow;
  check("unstake collected and KNTQ bridged back to Elysium", r.actions.some((a) => a.what.startsWith("bridge") && a.confirmed === true) && bridged > 0n && balOf(h.kntq, h.yieldBridge) === 0n, `${utils.formatEther(bridged.toString())} KNTQ into the bridge`);
  check("the locked principal never moved", balOf(h.skntq, h.reserve) > 0n);
  r = await run();
  check("then idle", r.actions.length === 0);

  console.log("3b. the daily rhythm: yield is collected at most once a day, however small");
  const names = (x: any) => x.actions.map((a: any) => a.what.split(" ").slice(0, 2).join(" ")).join(", ");
  fromGateway(h.skntq, "500000");
  r = await run();
  check("the last collection was a week ago: collects", r.actions.some((a) => a.what.startsWith("collect") && a.confirmed === true), names(r));
  fromGateway(h.skntq, "500000"); warp(3600);
  r = await run();
  check("an hour later: starts that unstake, does not collect again", !r.actions.some((a) => a.what.startsWith("collect")) && r.actions.some((a) => a.what.startsWith("start unstaking") && a.confirmed === true), names(r));
  warp(86400);
  r = await run();
  check("a day later: collected again", r.actions.some((a) => a.what.startsWith("collect") && a.confirmed === true), names(r));
  fromGateway(h.skntq, "500000"); warp(2 * 3600 + 60);
  r = await run();
  check("two hours later, default setting: not yet", !r.actions.some((a) => a.what.startsWith("collect")), names(r));
  r = await run({ KEEPER_PRIVATE_KEY: KEY, YIELD_EVERY_HOURS: "2" });
  check("two hours later with YIELD_EVERY_HOURS=2: collected", r.actions.some((a) => a.what.startsWith("collect") && a.confirmed === true), names(r));
  check("the locked principal still never moved", balOf(h.skntq, h.reserve) > 0n);

  console.log("4. kill switch");
  r = await run({ KEEPER_PRIVATE_KEY: KEY, HYPEREVM_PAUSED: "1" });
  check("paused", r.status === "paused");
}
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
