// The yield split end to end: the three owner steps built by script/yield-data.py, sent exactly as
// site/tools/yield.html sends them, then the bot's real yield job passing the reserve's yield to the director and
// having it split. On a LOCAL anvil fork of Elysium (never a real network). Another session may be using port
// 8597, so the port is an argument:
//   anvil --fork-url https://rpc.elysium.kinetiq.xyz --port 8611, then: cast rpc anvil_mine 0x1 --rpc-url http://127.0.0.1:8611
//   python3 script/drop-data.py --local --port 8611 && python3 script/yield-data.py --local --port 8611
//   npx tsx hosted/test-yield-split-fork.ts 8611                (from keeper/)
import { Wallet, utils } from "ethers";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runYield, YIELD_CONFIG } from "./yield.js";

const RPC = `http://127.0.0.1:${process.argv[2] ?? "8597"}`;
const tool = (f: string) => JSON.parse(readFileSync(`${process.cwd()}/../site/tools/${f}`, "utf8"));
const Y = tool("yield-data.local.json"), DR = tool("drop-data.local.json");
if (Y.rpc !== RPC || DR.rpc !== RPC) { console.log(`the local data files are not for ${RPC}. Rebuild them with --local --port.`); process.exit(1); }
const cfg = { ...YIELD_CONFIG, rpc: RPC, rpcGapMs: 0 };
const OWNER = Y.owner, TL = Y.timelock, DIRECTOR = Y.director, LIQUID = DR.liquid, RESERVE = DR.reserve, WHYPE = "0xbA876237B0F021A6c6D852d6c26E107997cC5E81";
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", BOT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const TKEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", TRADER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const sh = (c: string) => execSync(`export PATH="$HOME/.foundry/bin:$PATH"; cd ${process.cwd()}/..; ${c}`, { encoding: "utf8", shell: "/bin/bash", stdio: ["ignore", "pipe", "pipe"] }).trim();
const cast = (c: string) => sh(`cast ${c} --rpc-url ${RPC}`);
const as = (who: string, c: string) => sh(`cast send ${c} --from ${who} --unlocked --rpc-url ${RPC} > /dev/null`);
const send = (c: string) => sh(`cast send ${c} --private-key ${TKEY} --rpc-url ${RPC} > /dev/null`);
const fails = (who: string, c: string) => { try { as(who, c); return false; } catch { return true; } };
const first = (s: string) => s.split("\n").map((l) => l.trim().split(" ")[0]);
const big = (s: string) => BigInt(first(s)[0]);
const bal = (token: string, who: string) => big(cast(`call ${token} "balanceOf(address)(uint256)" ${who}`));
const addr = (to: string, sig: string) => first(cast(`call ${to} "${sig}"`))[0].toLowerCase();
const stamp = (id: string) => big(cast(`call ${TL} "getTimestamp(bytes32)(uint256)" ${id}`));
const warp = (s: number) => { cast(`rpc evm_increaseTime ${s}`); cast("rpc evm_mine"); };
const f = (v: bigint, dec = 18) => utils.formatUnits(v.toString(), dec);
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failed++; };

// The fork reports a higher network fee than Elysium really has; the job is told the real figure.
const world: typeof fetch = async (url: any, init?: any) => {
  const body = init?.body ? JSON.parse(init.body) : {};
  if (String(url) === RPC && body.method === "eth_gasPrice") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1dcd6500" }));
  if (String(url) !== RPC) throw new Error("the yield job asks no outside market");
  return fetch(url, init);
};
const deps = { ethers: { Wallet, utils }, fetch: world, env: (k: string) => ({ KEEPER_PRIVATE_KEY: KEY } as Record<string, string>)[k] };
const job = () => runYield(deps, cfg);
const acts = (r: any) => r.actions.map((a: any) => `${a.what}${a.confirmed ? " [ok]" : a.note ? ` [${a.note}]` : ""}`).join("\n          ") || "(nothing sent)";
async function until(done: (r: any) => boolean, n = 9) {
  let r = await job();
  console.log(`       yield job 1 -> ${r.status}: ${r.reason}`);
  for (let k = 2; k <= n && !done(r); k++) { warp(600); r = await job(); console.log(`       yield job ${k} -> ${r.status}: ${r.reason}`); }
  return r;
}
const pos = () => ({ rest: bal(cfg.khype, cfg.yieldRest), dir: bal(cfg.khype, DIRECTOR), reserve: bal(cfg.khype, RESERVE), drop: bal(LIQUID, DR.drop), hype: bal(LIQUID, Y.hypePool), kntq: bal(LIQUID, Y.kntqPool) });

// ---------- setup (fork only)
for (const a of [BOT, TRADER]) { cast(`rpc anvil_setCode ${a} 0x`); cast(`rpc anvil_setBalance ${a} 0x56BC75E2D63100000`); }
cast("rpc anvil_autoImpersonateAccount true");
for (const a of [OWNER, TL]) cast(`rpc anvil_setBalance ${a} 0x56BC75E2D63100000`);
cast("rpc evm_mine");
as(TL, `${cfg.oracle} "setKeeper(address,bool)" ${BOT} true`);
send(`${WHYPE} "approve(address,uint256)" ${DR.swapper} $(cast max-uint)`);
/** Yield arrives where it waits: kHYPE bought with HYPE through the reserve's swapper. */
const yieldArrives = (hype: string) => { send(`${WHYPE} "deposit()" --value ${hype}ether`); send(`${DR.swapper} "swap(address,address,uint256,uint256,address)" ${WHYPE} ${cfg.khype} ${utils.parseEther(hype)} 0 ${cfg.yieldRest}`); };
const shares = (bps: number[]) => as(OWNER, `${DIRECTOR} "setShares(uint16[])" "[${bps.join(",")}]"`);

console.log("1. before anything exists the yield job does nothing, and says why");
let r = await job();
console.log(`       -> ${r.status}: ${r.reason}`);
if (cast(`code ${DIRECTOR}`) === "0x") check("off: no director yet", r.status === "off" && /not on-chain yet/.test(r.reason) && r.actions.length === 0);
else check("off: the director exists, the yield is not pointed at it yet", r.status === "off" && /not pointed at the director yet/.test(r.reason) && r.actions.length === 0);

console.log("2. the three owner steps, with the exact data the page sends");
if (addr(cfg.yieldRest, "target()(address)") !== DIRECTOR.toLowerCase()) {
  if (cast(`code ${DIRECTOR}`) === "0x") send(`${Y.multicall} ${Y.create}`); // anyone may create them, in one transaction
  check("one transaction creates the two pools and the director", [DIRECTOR, Y.hypePool, Y.kntqPool].every((a) => cast(`code ${a}`) !== "0x"));
  check("the director's manager is the owner wallet, and it hands the drop's share to the feeder", addr(DIRECTOR, "manager()(address)") === OWNER.toLowerCase() && addr(DIRECTOR, "feeder()(address)") === DR.feeder.toLowerCase());
  r = await job();
  console.log(`       -> ${r.status}: ${r.reason}`);
  check("still off: the yield is not pointed at it; it reports the first shares", r.status === "off" && /not pointed at the director yet/.test(r.reason) && JSON.stringify(r.shares) === "[25,25,25,25]");
  const at = stamp(Y.id); // 0 = not started, otherwise when the last step opens
  if (at === 0n) {
    check("only the owner wallet can start the 48 hours", fails(TRADER, `${TL} ${Y.schedule}`));
    as(OWNER, `${TL} ${Y.schedule}`);
    warp(47 * 3600);
    check("the last step is refused before the 48 hours are up", fails(OWNER, `${TL} ${Y.execute}`));
    warp(3600 + 60);
  } else {
    console.log("       (steps 1 and 2 are already on the real network, sent by the owner on 2026-11-22)");
    check("step 2 cannot be sent a second time", fails(OWNER, `${TL} ${Y.schedule}`));
    const left = Number(at) - Number(first(cast("block latest --field timestamp"))[0]);
    if (left > 0) { check("the last step is refused before the 48 hours are up", fails(OWNER, `${TL} ${Y.execute}`), `${(left / 3600).toFixed(1)} hours to go`); warp(left + 60); }
  }
  check("only the owner wallet can finish", fails(TRADER, `${TL} ${Y.execute}`));
  as(OWNER, `${TL} ${Y.execute}`);
} else console.log("       (already done on this fork)");
check("the reserve's yield now goes to the director, for good", addr(cfg.yieldRest, "target()(address)") === DIRECTOR.toLowerCase() && fails(TL, `${cfg.yieldRest} "setTarget(address)" ${TRADER}`));
check("it cannot be sent twice", fails(OWNER, `${TL} ${Y.execute}`));

console.log("3. yield arrives, but part of it is for the drop and the drop's feeder does not exist yet");
yieldArrives("0.2");
let p0 = pos();
r = await job();
console.log(`       -> ${r.status}: ${r.reason}`);
if (cast(`code ${DR.feeder}`) === "0x") {
  check("the job waits and says why, without spending anything", r.status === "warming" && /for the drop, whose feeder does not exist yet/.test(r.reason) && r.actions.length === 0 && pos().rest === p0.rest);
  send(`${DR.factory} ${DR.create}`); // step 1 of the drop's own page
}

console.log("4. with the feeder there, the job distributes by the shares in force (a quarter each)");
p0 = pos();
r = await until((x) => x.status === "paid", 9);
console.log(`          ${acts(r)}`);
let p1 = pos();
const liq = (p1.drop - p0.drop) + (p1.hype - p0.hype) + (p1.kntq - p0.kntq);
check("the yield was passed on and used up", r.status === "paid" && p1.rest === 0n && p1.dir === 0n, `${f(p0.rest)} kHYPE`);
check("a quarter was locked in the reserve again, as it is", p1.reserve - p0.reserve === (p0.rest * 2500n) / 10000n, `${f(p1.reserve - p0.reserve)} kHYPE`);
check("the rest bought $liquid, in three equal parts: the drop and the two pools", liq > 0n && [p1.drop - p0.drop, p1.hype - p0.hype].every((x) => x === (liq * 2500n) / 7500n), `${Number(f(liq)).toFixed(0)} $liquid`);
check("the job names the split it used", r.actions.some((a: any) => /25% compound, 25% the drop, 25% pool 1, 25% pool 2/.test(a.what)));

console.log("5. the owner switches everything to compounding: no price is needed, so no reading is taken");
shares([10000, 0, 0, 0]);
warp(3 * 3600); // the price readings are hours old by now
yieldArrives("0.1");
p0 = pos();
r = await job();
console.log(`       -> ${r.status}: ${r.reason}\n          ${acts(r)}`);
p1 = pos();
check("all of it is locked again at once", r.status === "paid" && p1.reserve - p0.reserve === p0.rest && p1.drop === p0.drop && p1.hype === p0.hype);
check("without a price reading", !r.actions.some((a: any) => /price reading/.test(a.what)) && JSON.stringify(r.shares) === "[100,0,0,0]");

console.log("6. back to the stakers' pools: stale prices are refreshed first");
shares([0, 0, 5000, 5000]);
yieldArrives("0.1");
p0 = pos();
r = await until((x) => x.status === "paid", 9);
console.log(`          ${acts(r)}`);
p1 = pos();
check("the job took readings and waited for 30 minutes of them", r.status === "paid" && p1.rest === 0n);
check("everything went to the two pools, half each, nothing to the drop or the reserve", p1.hype - p0.hype > 0n && p1.hype - p0.hype === (p1.kntq - p0.kntq) || (p1.kntq - p0.kntq) - (p1.hype - p0.hype) <= 1n, `${Number(f(p1.hype - p0.hype)).toFixed(0)} $liquid each`);
check("nothing to the drop or the reserve", p1.drop === p0.drop && p1.reserve === p0.reserve);

console.log("7. an amount too small to be worth it waits");
yieldArrives("0.002"); // about 12 cents
r = await job();
console.log(`       -> ${r.status}: ${r.reason}`);
check("it is left where it is", r.status === "idle" && r.actions.length === 0 && bal(cfg.khype, cfg.yieldRest) > 0n);
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
