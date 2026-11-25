// The reserve job's daily yield step, against a LOCAL anvil fork of Elysium mainnet as it is now
// (the live reserve, never a real network):
//   anvil --fork-url https://rpc.elysium.kinetiq.xyz --port 8597
//   npx tsx hosted/test-yield-fork.ts
import { Wallet, utils } from "ethers";
import { execSync } from "node:child_process";
import { runReserve, RESERVE_CONFIG, ReserveConfig } from "./reserve.js";

const RPC = "http://127.0.0.1:8597";
const cfg: ReserveConfig = { ...RESERVE_CONFIG, rpc: RPC, rpcGapMs: 0 };
const sh = (c: string) => execSync(`export PATH="$HOME/.foundry/bin:$PATH"; ${c}`, { encoding: "utf8", shell: "/bin/bash" }).trim();
const cast = (c: string) => sh(`cast ${c} --rpc-url ${RPC}`);
const KEEPER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil account #1 (a stranger to the contracts)
const T = cfg.tokens;
const balOf = (token: string, who: string) => BigInt(cast(`call ${token} "balanceOf(address)(uint256)" ${who}`).split(" ")[0]);
const pending = () => BigInt(cast(`call ${cfg.reserve} "pendingYield(address)(uint256)" ${T.KHYPE}`).split(" ")[0]);
const warp = (secs: number) => { cast(`rpc evm_increaseTime ${secs}`); cast("rpc evm_mine"); };
// Hyperliquid is only asked during a fee cycle; no fees are moved in this test.
const run = (env: Record<string, string> = {}) => runReserve({ ethers: { Wallet, utils }, fetch, env: (k) => ({ KEEPER_PRIVATE_KEY: KEEPER_KEY, ...env } as Record<string, string>)[k] }, cfg);
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failed++; };
const show = (r: any) => console.log(`     -> ${r.status}: ${r.reason} | ${r.actions.map((a: any) => `${a.what}${a.confirmed ? " [confirmed]" : a.note ? ` [${a.note}]` : ""}`).join("; ") || "no actions"}`);

const lockedBefore = balOf(T.KHYPE, cfg.reserve), principal = BigInt(cast(`call ${cfg.reserve} "principal(address)(uint256)" ${T.KHYPE}`).split(" ")[0]);
console.log(`fork: ${utils.formatEther(lockedBefore.toString())} kHYPE locked, pending yield ${pending()} wei`);

console.log("1. a quiet day: the kHYPE price reading is over a day old");
let r = await run();
show(r);
check("takes one price reading of the kHYPE feed", r.actions.length === 1 && r.actions[0].what.startsWith("daily price reading") && r.actions[0].confirmed === true);
check("moves no fees and touches nothing else", balOf(T.KHYPE, cfg.reserve) === lockedBefore && r.status === "moving");

console.log("2. straight after: nothing more to do");
r = await run();
show(r);
check("idle, no second reading", r.status === "idle" && r.actions.length === 0);

console.log("3. dry run and watch-only send nothing");
warp(86_400 + 60);
r = await run({ DRY_RUN: "1" });
show(r);
check("dry run: would take the reading, sends nothing", r.actions.length === 1 && !r.actions[0].tx);
r = await run({ KEEPER_PRIVATE_KEY: "" });
show(r);
check("watch-only: does nothing", r.mode === "watch-only" && r.actions.length === 0);
r = await run({ KEEPER_PAUSED: "1" });
check("paused: does nothing", r.status === "paused" && r.actions.length === 0);

console.log("4. a day later: reading again (the daily rhythm)");
r = await run();
show(r);
check("takes the next day's reading", r.actions.length === 1 && r.actions[0].what.startsWith("daily price reading") && r.actions[0].confirmed === true);

console.log("5. yield appears (stand-in: 0.0005 kHYPE more than the principal accounts for)");
// On the fork, kHYPE is handed to the reserve from a holder; on mainnet the same thing happens when kHYPE's price rises.
const holder = cfg.yieldWait; // any address: its balance is set directly on the fork
// find the balance slot by trying the common layouts
let donated = false;
for (const s of ["0", "1", "2", "3", "51", "101", "0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00"]) {
  const key = sh(`cast index address ${holder} ${s}`);
  cast(`rpc anvil_setStorageAt ${T.KHYPE} ${key} 0x${(5n * 10n ** 14n).toString(16).padStart(64, "0")}`);
  if (balOf(T.KHYPE, holder) === 5n * 10n ** 14n) { donated = true; break; }
  cast(`rpc anvil_setStorageAt ${T.KHYPE} ${key} 0x${"0".repeat(64)}`);
}
if (!donated) { console.log("     could not hand out kHYPE on the fork (unknown storage layout); skipping the collection steps"); }
else {
  cast(`rpc anvil_impersonateAccount ${holder}`); cast(`rpc anvil_setBalance ${holder} 0x56BC75E2D63100000`);
  sh(`cast send ${T.KHYPE} "transfer(address,uint256)" ${cfg.reserve} 500000000000000 --from ${holder} --unlocked --rpc-url ${RPC} > /dev/null`);
  const p = pending();
  check("the reserve now shows yield", p > 10n ** 12n, `${utils.formatEther(p.toString())} HYPE worth`);
  const waitBefore = balOf(T.KHYPE, cfg.yieldWait);
  r = await run();
  show(r);
  check("collects it", r.actions.some((a) => a.what.startsWith("collect") && a.confirmed === true));
  const got = balOf(T.KHYPE, cfg.yieldWait) - waitBefore;
  check("the yield lands in the yield contract", got > 4n * 10n ** 14n, `${utils.formatEther(got.toString())} kHYPE`);
  const valueNow = BigInt(cast(`call ${cfg.reserve} "valueOf(address)(uint256)" ${T.KHYPE}`).split(" ")[0]);
  check("the principal is untouched and still fully backed", BigInt(cast(`call ${cfg.reserve} "principal(address)(uint256)" ${T.KHYPE}`).split(" ")[0]) === principal && valueNow >= principal && lockedBefore - balOf(T.KHYPE, cfg.reserve) <= 1n, `value ${utils.formatEther(valueNow.toString())} HYPE vs principal ${utils.formatEther(principal.toString())}`);
  r = await run();
  show(r);
  check("then idle: nothing left to collect", r.status === "idle" && r.actions.length === 0, `pending ${pending()} wei`);
}

console.log("6. YIELD_EVERY_HOURS changes how often");
warp(2 * 3600 + 60);
r = await run();
check("default (24 hours): no reading after 2 hours", r.actions.length === 0);
r = await run({ YIELD_EVERY_HOURS: "2" });
show(r);
check("set to 2 hours: takes a reading", r.actions.length === 1 && r.actions[0].what.startsWith("daily price reading") && r.actions[0].confirmed === true);

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
