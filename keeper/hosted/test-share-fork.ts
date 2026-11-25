// The bot's creator-share payouts (share.ts), against a LOCAL anvil fork of Elysium mainnet as it is now
// (never a real network):
//   anvil --fork-url https://rpc.elysium.kinetiq.xyz --port 8597   then   cast rpc evm_mine --rpc-url http://127.0.0.1:8597
//   python3 script/creator-share-data.py --local
//   npx tsx hosted/test-share-fork.ts
import { Wallet, utils } from "ethers";
import { execSync } from "node:child_process";
import fs from "node:fs";
import { runShare, SHARE_CONFIG, ShareConfig, ShareReport } from "./share.js";

const RPC = "http://127.0.0.1:8597";
const D = JSON.parse(fs.readFileSync(new URL("../../site/tools/creator-share-data.local.json", import.meta.url), "utf8"));
const cfg: ShareConfig = { ...SHARE_CONFIG, rpc: RPC, rpcGapMs: 0 };
const sh = (c: string) => execSync(`export PATH="$HOME/.foundry/bin:$PATH"; ${c}`, { encoding: "utf8", shell: "/bin/bash", stdio: ["ignore", "pipe", "pipe"] }).trim();
const cast = (c: string) => sh(`cast ${c} --rpc-url ${RPC}`);
const first = (s: string) => s.split(/\s+/)[0];
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const balOf = (token: string, who: string) => BigInt(first(cast(`call ${token} "balanceOf(address)(uint256)" ${who}`)));
const warp = (secs: number) => { cast(`rpc evm_increaseTime ${secs}`); cast("rpc evm_mine"); };
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil account #1
const T = Object.fromEntries([...cfg.feeTokens, ...cfg.yieldTokens].map((t) => [t.sym, t.address]));
const E18 = 10n ** 18n;
const run = (env: Record<string, string> = {}) => runShare({ ethers: { Wallet, utils }, fetch, env: (k) => ({ KEEPER_PRIVATE_KEY: KEY, ...env } as Record<string, string>)[k] }, cfg);
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failed++; };
const show = (r: ShareReport) => console.log(`     -> ${r.status}: ${r.reason} | ${r.actions.map((a) => `${a.what.slice(0, 70)}${a.confirmed ? " [confirmed]" : a.note ? ` [${a.note}]` : ""}`).join("; ") || "no actions"}`);
const did = (r: ShareReport, start: string) => r.actions.filter((a) => a.what.startsWith(start) && a.confirmed === true).length;
/** Adds `amount` of a token to `who` on the fork by writing its balance slot. */
function give(token: string, who: string, amount: bigint) {
  const want = balOf(token, who) + amount;
  for (const s of ["0", "1", "2", "3", "51", "101", "0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00"]) {
    const key = sh(`cast index address ${who} ${s}`);
    const before = cast(`storage ${token} ${key}`);
    cast(`rpc anvil_setStorageAt ${token} ${key} 0x${want.toString(16).padStart(64, "0")}`);
    if (balOf(token, who) === want) return;
    cast(`rpc anvil_setStorageAt ${token} ${key} ${before}`);
  }
  throw new Error(`could not hand out ${token} on the fork`);
}
cast(`rpc anvil_impersonateAccount ${D.owner}`); cast(`rpc anvil_setBalance ${D.owner} 0x56BC75E2D63100000`);
const asOwner = (to: string, data: string) => sh(`cast send ${to} ${data} --from ${D.owner} --unlocked --rpc-url ${RPC} > /dev/null`);

let r: ShareReport;
// The contracts were created on mainnet on 2026-11-17; on an older fork they are created here first.
if (cast(`code ${D.vaultFeeSplit}`) === "0x") {
  console.log("1. before the contracts exist");
  r = await run(); show(r);
  check("off: does nothing", r.status === "off" && r.actions.length === 0);
  sh(`cast send ${D.multicall} ${D.deploy} --private-key ${KEY} --rpc-url ${RPC} > /dev/null`);
} else console.log("1. the contracts already exist on this fork");

console.log("2. the contracts exist, nothing has reached them");
r = await run(); show(r);
check("idle", r.status === "idle" && r.actions.length === 0);

console.log("3. vault fees: a worthwhile amount is paid out at once");
give(T.WHYPE, D.vaultFeeSplit, E18 / 2n);
let c0 = balOf(T.WHYPE, D.creator), i0 = balOf(T.WHYPE, D.vaultFeeInbox);
r = await run({ KEEPER_PRIVATE_KEY: "" }); show(r);
check("no wallet: reports, sends nothing", r.actions.length === 1 && !r.actions[0].tx && balOf(T.WHYPE, D.vaultFeeSplit) === E18 / 2n);
r = await run({ DRY_RUN: "1" });
check("dry run: sends nothing", r.actions.length === 1 && !r.actions[0].tx && balOf(T.WHYPE, D.vaultFeeSplit) === E18 / 2n);
r = await run(); show(r);
check("paid out: 0.1 HYPE to your wallet, 0.4 to the reserve's fee inbox", did(r, "pay out") === 1 && balOf(T.WHYPE, D.creator) - c0 === E18 / 10n && balOf(T.WHYPE, D.vaultFeeInbox) - i0 === (E18 * 4n) / 10n);

console.log("4. vault fees: small amounts go at most once a day");
give(T.WHYPE, D.vaultFeeSplit, E18 / 1000n); give(T.KNTQ, D.vaultFeeSplit, E18 / 2n);
r = await run(); show(r);
check("a payout just happened: the small amounts wait", r.actions.length === 0 && r.status === "idle");
warp(86_400 + 60);
c0 = balOf(T.KNTQ, D.creator);
r = await run(); show(r);
check("a day later: both small amounts are paid out", did(r, "pay out") === 2 && balOf(T.KNTQ, D.creator) - c0 === E18 / 10n && balOf(T.WHYPE, D.vaultFeeSplit) === 0n);
give(T.WHYPE, D.vaultFeeSplit, 10n ** 13n);
warp(86_400 + 60);
r = await run();
check("dust is left alone", r.actions.length === 0);
give(T["$liquid"], D.vaultFeeSplit, 400_000n * E18);
c0 = balOf(T["$liquid"], D.creator);
r = await run(); show(r);
check("$liquid fees are paid out the same way", balOf(T["$liquid"], D.creator) - c0 === 80_000n * E18 && balOf(T["$liquid"], D.vaultFeeInbox) >= 320_000n * E18);

console.log("5. reserve yield: nothing until the timelock step is done");
give(T.kHYPE, D.yieldWait, E18 / 100n);
r = await run(); show(r);
check("yield waits untouched", !r.actions.some((a) => a.what.includes("reserve yield")) && balOf(T.kHYPE, D.yieldWait) >= E18 / 100n);
asOwner(D.timelock, D.schedule); warp(172_800 + 60); asOwner(D.timelock, D.execute);
check("the yield contract now points at the splitter", same(first(cast(`call ${D.yieldWait} "target()(address)"`)), D.yieldSplit));

console.log("6. reserve yield: passed to the splitter and paid out, at least once a day");
c0 = balOf(T.kHYPE, D.creator);
let rest0 = balOf(T.kHYPE, D.yieldRest);
const waiting = balOf(T.kHYPE, D.yieldWait);
r = await run(); show(r);
check("first payout: 20% to your wallet, 80% held", did(r, "pass") === 1 && did(r, "pay out") === 1 && balOf(T.kHYPE, D.creator) - c0 === waiting / 5n && balOf(T.kHYPE, D.yieldRest) - rest0 === waiting - waiting / 5n && balOf(T.kHYPE, D.yieldWait) === 0n);
give(T.KNTQ, D.yieldWait, E18);
r = await run(); show(r);
check("more yield the same day: waits", r.actions.length === 0);
warp(86_400 + 60);
c0 = balOf(T.KNTQ, D.creator);
r = await run(); show(r);
check("the next day: paid out", did(r, "pass") === 1 && did(r, "pay out") === 1 && balOf(T.KNTQ, D.creator) - c0 === E18 / 5n);
give(T.KNTQ, D.yieldWait, 5n * E18);
c0 = balOf(T.KNTQ, D.creator);
r = await run(); show(r);
check("a large amount does not wait for the next day", did(r, "pay out") === 1 && balOf(T.KNTQ, D.creator) - c0 === E18);
give(T.kHYPE, D.yieldWait, E18 / 1000n);
warp(3 * 3600);
r = await run();
check("three hours later, default setting: a small amount waits", r.actions.length === 0);
r = await run({ PAYOUT_EVERY_HOURS: "2" }); show(r);
check("PAYOUT_EVERY_HOURS changes how often", did(r, "pay out") === 1);

console.log("7. kill switch");
give(T.WHYPE, D.vaultFeeSplit, E18);
r = await run({ CREATOR_PAUSED: "1" });
check("paused: does nothing", r.status === "paused" && r.actions.length === 0 && balOf(T.WHYPE, D.vaultFeeSplit) >= E18);

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
