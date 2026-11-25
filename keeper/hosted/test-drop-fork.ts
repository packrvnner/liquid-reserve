// The $liquid drop end to end: the three owner steps built by script/drop-data.py, sent exactly as
// site/tools/drop.html sends them, then the bot's real drop job feeding the reserve and the drop, the drop
// filling up and the burn taking over, and finally the whole of flywheel v2 on one fee (the HYPE-only router,
// the reserve job, then the drop job). On a LOCAL anvil fork of Elysium (never a real network). Another session
// may be using port 8597, so the port is an argument:
//   anvil --fork-url https://rpc.elysium.kinetiq.xyz --port 8611, then: cast rpc anvil_mine 0x1 --rpc-url http://127.0.0.1:8611
//   python3 script/drop-data.py --local --port 8611 && python3 script/hype-only-data.py --local --port 8611
//   npx tsx hosted/test-drop-fork.ts 8611                       (from keeper/)
import { Wallet, utils } from "ethers";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runDrop, DROP_CONFIG } from "./drop.js";
import { runReserve, RESERVE_CONFIG } from "./reserve.js";

const RPC = `http://127.0.0.1:${process.argv[2] ?? "8597"}`;
const tool = (f: string) => JSON.parse(readFileSync(`${process.cwd()}/../site/tools/${f}`, "utf8"));
const D = tool("drop-data.local.json"), H = tool("hype-only-data.local.json"), LR = tool("liquid-route-data.json");
if (D.rpc !== RPC || H.rpc !== RPC) { console.log(`the local data files are not for ${RPC}. Rebuild them with --local --port.`); process.exit(1); }
const cfg = { ...DROP_CONFIG, rpc: RPC, rpcGapMs: 0 };
const rcfg = { ...RESERVE_CONFIG, rpc: RPC, rpcGapMs: 0, yieldEverySec: 1e12 };
const T = rcfg.tokens, OWNER = D.owner, TL = D.timelock, FEEDER = D.feeder, DROP = D.drop, PM = "0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1";
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
const view = (to: string, sig: string) => big(cast(`call ${to} "${sig}"`));
const addr = (to: string, sig: string) => first(cast(`call ${to} "${sig}"`))[0].toLowerCase();
const stamp = (id: string) => big(cast(`call ${TL} "getTimestamp(bytes32)(uint256)" ${id}`));
const warp = (s: number) => { cast(`rpc evm_increaseTime ${s}`); cast("rpc evm_mine"); };
const f = (v: bigint, dec = 18) => utils.formatUnits(v.toString(), dec);
const M = (n: number) => BigInt(n) * 10n ** 24n; // millions of $liquid
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failed++; };
const tickOf = (pool: string) => Number(first(cast(`call ${cfg.stateView} "getSlot0(bytes32)(uint160,int24,uint24,uint24)" ${pool}`))[1]);

// The fork reports a higher network fee than Elysium really has; the jobs are told the real figure. Hyperliquid is
// not asked: a fork's pool prices stand still while the real market moves on, so the test answers in its place.
const world: typeof fetch = async (url: any, init?: any) => {
  const body = init?.body ? JSON.parse(init.body) : {};
  if (String(url) === RPC && body.method === "eth_gasPrice") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1dcd6500" }));
  if (String(url) === cfg.hyperliquid && body.type === "spotMeta")
    return new Response(JSON.stringify({ tokens: ["USDC", "HYPE", "KNTQ", "ANTX"].map((name, index) => ({ name, index })), universe: [{ name: "@H", tokens: [1, 0] }, { name: "@K", tokens: [2, 0] }, { name: "@A", tokens: [3, 0] }] }));
  if (String(url) === cfg.hyperliquid && body.type === "allMids") {
    const hype = 1.0001 ** tickOf(cfg.feeds.hypeUsdc) * 1e12, kntq = hype / 1.0001 ** tickOf(rcfg.feeds.hypeKntq);
    return new Response(JSON.stringify({ "@H": String(hype), "@K": String(kntq), "@A": "1" }));
  }
  if (String(url) === cfg.hyperliquid) throw new Error("the test does not ask Hyperliquid");
  return fetch(url, init);
};
const deps = { ethers: { Wallet, utils }, fetch: world, env: (k: string) => ({ KEEPER_PRIVATE_KEY: KEY } as Record<string, string>)[k] };
const drop = () => runDrop(deps, cfg);
const acts = (r: any) => r.actions.map((a: any) => `${a.what}${a.confirmed ? " [ok]" : a.note ? ` [${a.note}]` : ""}`).join("\n          ") || "(nothing sent)";
async function until(run: () => Promise<any>, done: (r: any) => boolean, n = 9, label = "drop job") {
  let r = await run();
  console.log(`       ${label} 1 -> ${r.status}: ${r.reason}`);
  for (let k = 2; k <= n && !done(r); k++) { warp(600); r = await run(); console.log(`       ${label} ${k} -> ${r.status}: ${r.reason}`); }
  return r;
}
const pos = () => ({ wait: bal(cfg.usdc, cfg.liquidWait), feeder: bal(cfg.usdc, FEEDER), khype: bal(T.KHYPE, rcfg.reserve), drop: bal(cfg.liquid, DROP), sink: bal(cfg.liquid, D.burnSink), kntq: bal(T.KNTQ, rcfg.bridgeOut) });

// ---------- setup (fork only)
for (const a of [BOT, TRADER]) { cast(`rpc anvil_setCode ${a} 0x`); cast(`rpc anvil_setBalance ${a} 0x56BC75E2D63100000`); }
cast("rpc anvil_autoImpersonateAccount true");
for (const a of [OWNER, TL, PM]) cast(`rpc anvil_setBalance ${a} 0x56BC75E2D63100000`);
cast("rpc evm_mine");
as(TL, `${cfg.oracle} "setKeeper(address,bool)" ${BOT} true`);
const whypeTo = (to: string, hype: string) => { send(`${T.WHYPE} "deposit()" --value ${hype}ether`); send(`${T.WHYPE} "transfer(address,uint256)" ${to} ${utils.parseEther(hype)}`); };
/** More of the USDC share arrives at the waiting contract (bought with HYPE through the reserve's swapper). */
const usdcShare = (hype: string) => { send(`${T.WHYPE} "deposit()" --value ${hype}ether`); send(`${T.WHYPE} "approve(address,uint256)" ${D.swapper} $(cast max-uint)`); send(`${D.swapper} "swap(address,address,uint256,uint256,address)" ${T.WHYPE} ${cfg.usdc} ${utils.parseEther(hype)} 0 ${cfg.liquidWait}`); };

console.log("1. before anything exists the drop job does nothing, and says why");
let r = await drop();
console.log(`       -> ${r.status}: ${r.reason}`);
if (cast(`code ${FEEDER}`) === "0x") check("off: no feeder yet", r.status === "off" && /not on-chain yet/.test(r.reason) && r.actions.length === 0);

console.log("2. the three owner steps, with the exact data the page sends");
if (addr(cfg.liquidWait, "target()(address)") !== FEEDER.toLowerCase()) {
  if (cast(`code ${FEEDER}`) === "0x") send(`${D.factory} ${D.create}`); // anyone may create it
  check("the feeder is created at the address the page shows", cast(`code ${FEEDER}`) !== "0x", FEEDER);
  check("it names the bot's wallet as the drop, and the timelock as its owner", addr(FEEDER, "drop()(address)") === DROP.toLowerCase() && addr(FEEDER, "owner()(address)") === TL.toLowerCase());
  r = await drop();
  console.log(`       -> ${r.status}: ${r.reason}`);
  check("still off: the set-aside share is not pointed at it", r.status === "off" && /not pointed at the feeder yet/.test(r.reason) && r.drop?.cap === "50000000.0", `drop is full at ${r.drop?.cap} $liquid`);
  if (stamp(D.id) === 0n) {
    check("only the owner wallet can start the 48 hours", fails(TRADER, `${TL} ${D.schedule}`));
    as(OWNER, `${TL} ${D.schedule}`);
    warp(47 * 3600);
    check("the last step is refused before the 48 hours are up", fails(OWNER, `${TL} ${D.execute}`));
    warp(3600 + 60);
  }
  if (stamp(LR.id) !== 1n) {
    check("and refused while the $liquid route's own last step is not done", fails(OWNER, `${TL} ${D.execute}`));
    const left = Number(stamp(LR.id)) - Number(first(cast("block latest --field timestamp"))[0]);
    if (left > 0) warp(left + 60);
    as(OWNER, `${TL} ${LR.execute}`); // the $liquid route's last step, with its own page's data
  }
  check("only the owner wallet can finish", fails(TRADER, `${TL} ${D.execute}`));
  as(OWNER, `${TL} ${D.execute}`);
} else console.log("       (already done on this fork)");
check("the set-aside share now goes to the feeder", addr(cfg.liquidWait, "target()(address)") === FEEDER.toLowerCase());
check("and that can never be changed", fails(TL, `${cfg.liquidWait} "setTarget(address)" ${TRADER}`));
check("the oracle can price USDC into $liquid", (cast(`call ${cfg.oracle} "getRoute(address,address)(bytes32[],uint24[])" ${cfg.usdc} ${cfg.liquid}`).split("\n")[0].match(/0x[0-9a-fA-F]{64}/g) ?? []).length === 2);
check("it cannot be sent twice", fails(OWNER, `${TL} ${D.execute}`));

console.log("3. the bot's drop job uses what really waits today (real settings)");
let p0 = pos();
r = await until(drop, (x) => x.status === "fed", 9);
console.log(`          ${acts(r)}`);
let p1 = pos();
const hypeUsd = 1.0001 ** tickOf(cfg.feeds.hypeUsdc) * 1e12, khypeUsd = hypeUsd * 1.0001 ** tickOf(cfg.feeds.khypeWhype);
const liquidUsd = hypeUsd * 1.0001 ** tickOf(cfg.feeds.ascend);
const usdIn = Number(p0.wait + p0.feeder) / 1e6, toReserveUsd = (Number(p1.khype - p0.khype) / 1e18) * khypeUsd, toDropUsd = (Number(p1.drop - p0.drop) / 1e18) * liquidUsd;
check("the waiting share was used up", r.status === "fed" && p1.wait === 0n && p1.feeder === 0n, `$${usdIn.toFixed(2)}`);
check("half became kHYPE locked in the reserve", Math.abs(toReserveUsd / usdIn - 0.5) < 0.01, `${f(p1.khype - p0.khype)} kHYPE = ${(toReserveUsd / usdIn * 100).toFixed(1)}%`);
check("half became $liquid in the drop (Ascend's 2% fee applies)", toDropUsd / usdIn > 0.475 && toDropUsd / usdIn < 0.5, `${Number(f(p1.drop - p0.drop)).toFixed(0)} $liquid = ${(toDropUsd / usdIn * 100).toFixed(1)}%`);
check("nothing was burned", p1.sink === p0.sink);
r = await drop();
check("the job reports the drop's level", r.drop?.held === f(p1.drop) && r.drop?.full === false && r.status === "idle", `${Number(r.drop?.held).toFixed(0)} of ${r.drop?.cap}`);

console.log("4. an amount too small to be worth it waits");
usdcShare("0.002"); // about 12 cents
r = await drop();
console.log(`       -> ${r.status}: ${r.reason}`);
check("it is left where it is", r.status === "idle" && r.actions.length === 0 && bal(cfg.usdc, cfg.liquidWait) > 0n);

console.log("5. the drop fills up: what fits goes in, the rest burns, and after that everything burns");
as(PM, `${cfg.liquid} "transfer(address,uint256)" ${DROP} ${view(FEEDER, "room()(uint256)") - 200_000n * 10n ** 18n}`); // 200,000 short of full
usdcShare("0.05"); // about $3: half of it buys roughly 450,000 $liquid
p0 = pos();
r = await until(drop, (x) => x.status === "fed", 6);
console.log(`          ${acts(r)}`);
p1 = pos();
check("exactly what fitted went into the drop", p1.drop - p0.drop === 200_000n * 10n ** 18n, `${f(p1.drop - p0.drop)} $liquid`);
check("the rest went to Ascend's burn address", p1.sink > p0.sink, `${Number(f(p1.sink - p0.sink)).toFixed(0)} $liquid burned`);
check("the feeder counted it", view(FEEDER, "burned()(uint256)") === p1.sink - p0.sink && view(FEEDER, "room()(uint256)") === 0n);
usdcShare("0.05");
p0 = pos();
r = await until(drop, (x) => x.status === "fed", 6);
console.log(`          ${acts(r)}`);
p1 = pos();
check("now full: the $liquid half burns whole, and the job says so", p1.drop === p0.drop && p1.sink > p0.sink && r.actions.some((a: any) => /for the burn \(the drop is full\)/.test(a.what)), `${Number(f(p1.sink - p0.sink)).toFixed(0)} more burned`);
check("the reserve's half is still locked", p1.khype > p0.khype);

console.log("6. the whole flywheel on one fee: the HYPE-only router, the reserve job, then the drop job");
if (addr(H.swapConfig, "swapper()(address)") !== H.router.toLowerCase()) {
  if (cast(`code ${H.router}`) === "0x") send(`${H.factory} ${H.create}`);
  if (stamp(H.id) === 0n) { as(OWNER, `${TL} ${H.schedule}`); warp(48 * 3600 + 60); }
  as(OWNER, `${TL} ${H.execute}`);
}
check("the reserve is pointed at the HYPE-only router", addr(H.swapConfig, "swapper()(address)") === H.router.toLowerCase());
whypeTo(rcfg.feeInbox, "0.2");
p0 = pos();
const inboxHype = Number(bal(T.WHYPE, rcfg.feeInbox)) / 1e18;
const rr = await until(() => runReserve(deps, rcfg), (x) => x.status === "moving" && bal(T.WHYPE, rcfg.feeInbox) === 0n, 9, "reserve job");
console.log(`          ${acts(rr)}`);
r = await until(drop, (x) => x.status === "fed", 6);
console.log(`          ${acts(r)}`);
p1 = pos();
const toAllocator = inboxHype * 0.8; // the older splitter sets 20% aside first; it follows through the creator job
const lockedHype = (Number(p1.khype - p0.khype) / 1e18) * 1.0001 ** tickOf(cfg.feeds.khypeWhype);
const burnedHype = ((Number(p1.sink - p0.sink) / 1e18) * 1.0001 ** tickOf(cfg.feeds.ascend));
check("no KNTQ was bought", p1.kntq === p0.kntq);
check("90% of the fee ended as staked HYPE in the reserve", Math.abs(lockedHype / toAllocator - 0.9) < 0.012, `${(lockedHype / toAllocator * 100).toFixed(1)}% of ${toAllocator.toFixed(4)} HYPE`);
check("10% bought $liquid, burned because the drop is full", burnedHype / toAllocator > 0.09 && burnedHype / toAllocator < 0.101 && p1.drop === p0.drop, `${(burnedHype / toAllocator * 100).toFixed(1)}%: ${Number(f(p1.sink - p0.sink)).toFixed(0)} $liquid`);
check("nothing is left waiting", p1.wait === 0n && p1.feeder === 0n);
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
