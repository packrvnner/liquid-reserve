// Does the Ascend job pay the coin's second recipient (the creator's wallet) its share of the trade fee?
// Runs against a LOCAL anvil fork of Elysium (port 8597), never a real network:
//   anvil --fork-url https://rpc.elysium.kinetiq.xyz --port 8597, then: cast rpc evm_mine --rpc-url http://127.0.0.1:8597
//   npx tsx hosted/test-ascend-share-fork.ts
import { Wallet, utils } from "ethers";
import { execSync } from "node:child_process";
import { runAscend, ASCEND_CONFIG } from "./ascend.js";

const RPC = "http://127.0.0.1:8597";
const cfg = { ...ASCEND_CONFIG, rpc: RPC, rpcGapMs: 0 };
const sh = (c: string) => execSync(`export PATH="$HOME/.foundry/bin:$PATH"; ${c}`, { encoding: "utf8", shell: "/bin/bash", stdio: ["ignore", "pipe", "pipe"] }).trim();
const cast = (c: string) => sh(`cast ${c} --rpc-url ${RPC}`);
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", BOT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // anvil account #1 stands in for the bot
const SEAT = "0x7D5b955B49F53E452853D0a087f9B3307DfA9B99", CREATOR = "0x9324605c9C707b2F805CCF2AC099fCA5d561DC37", WHYPE = "0xbA876237B0F021A6c6D852d6c26E107997cC5E81";
const bal = (who: string) => BigInt(cast(`call ${WHYPE} "balanceOf(address)(uint256)" ${who}`).split(/\s+/)[0]);
const owed = (i: number) => BigInt(cast(`call ${SEAT} "claimable(uint256,bool)(uint256)" ${i} false`).split(/\s+/)[0]);
const seen = (i: number) => Number(cast(`call ${SEAT} "slot(uint256)(address,uint16,address,uint40)" ${i}`).split("\n")[3].split(/\s+/)[0]);
const f = (v: bigint) => utils.formatEther(v.toString());
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failed++; };
const head = Number(cast("block-number"));
const run = () => runAscend({ ethers: { Wallet, utils }, fetch, env: (k) => ({ KEEPER_PRIVATE_KEY: KEY } as Record<string, string>)[k] }, { seats: [SEAT], scanBlock: head }, cfg);

const before = { creator: bal(CREATOR), bot: bal(BOT), inbox: bal(cfg.payee), owed0: owed(0), owed1: owed(1), seen1: seen(1) };
console.log(`waiting at the seat: ${f(before.owed0)} for the fee contract, ${f(before.owed1)} for the creator's wallet`);
const due = before.owed1 >= utils.parseEther("0.0025").toBigInt();

console.log("1. one run of the job");
const r = (await run()).report;
console.log(`     -> ${r.status}: ${r.reason}\n        ${r.actions.map((a) => `${a.what}${a.confirmed ? " [ok]" : a.note ? ` [${a.note}]` : ""}`).join("\n        ")}`);
const after = { creator: bal(CREATOR), bot: bal(BOT), inbox: bal(cfg.payee), owed1: owed(1), seen1: seen(1) };
if (due) {
  check("the creator's wallet received exactly what was waiting for it", after.creator - before.creator === before.owed1, `+${f(after.creator - before.creator)} WHYPE`);
  check("nothing is left waiting for it at the seat", after.owed1 === 0n);
} else {
  check("too little was waiting, so nothing was sent for the creator's wallet", after.creator === before.creator && !r.actions.some((a) => a.what.startsWith("pay ")));
}
check("the bot kept nothing for itself", after.bot === before.bot);
const claimed0 = r.actions.some((a) => a.what.startsWith("claim ") && a.confirmed);
check("the fee contract's share only went where it always goes", after.inbox - before.inbox === (claimed0 ? before.owed0 : 0n), claimed0 ? `claimed ${f(before.owed0)}` : "below its own minimum, left waiting");
const rec = r.coins[0]?.recipients ?? [];
check("the report lists the creator's wallet with its 20% share", rec.length === 1 && rec[0].account === CREATOR && rec[0].sharePct === 20, JSON.stringify(rec));
check("a claim by the bot does not renew the wallet's place (only its own claim does)", after.seen1 === before.seen1, `${rec[0]?.daysUntilRemovable} days left`);

console.log("2. a second run straight after");
const r2 = (await run()).report;
console.log(`     -> ${r2.status}: ${r2.reason}`);
check("has nothing more to pay", !r2.actions.some((a) => a.what.startsWith("pay ")) && bal(CREATOR) === after.creator);

console.log("3. near the 180-day limit the job warns that the wallet has to claim once itself");
cast(`rpc evm_increaseTime ${125 * 86400}`); cast("rpc evm_mine");
const r3 = (await run()).report;
check("warning raised for the creator's wallet", r3.warnings.some((w) => w.includes(CREATOR) && w.includes("own wallet")), r3.warnings.join(" | ").slice(0, 200));

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
