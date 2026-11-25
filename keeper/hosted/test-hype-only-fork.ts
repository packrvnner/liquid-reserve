// The HYPE-only reserve end to end: the three owner steps built by script/hype-only-data.py, sent exactly as
// site/tools/hype-only.html sends them, and then the bot's real reserve job moving a fee through the re-pointed
// reserve. On a LOCAL anvil fork of Elysium (never a real network). Another session may be using port 8597, so
// the port is an argument:
//   anvil --fork-url https://rpc.elysium.kinetiq.xyz --port 8611, then: cast rpc anvil_mine 0x1 --rpc-url http://127.0.0.1:8611
//   python3 script/hype-only-data.py --local --port 8611        (from the project folder)
//   npx tsx hosted/test-hype-only-fork.ts 8611                  (from keeper/)
import { Wallet, utils } from "ethers";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runReserve, RESERVE_CONFIG } from "./reserve.js";

const RPC = `http://127.0.0.1:${process.argv[2] ?? "8597"}`;
const D = JSON.parse(readFileSync(`${process.cwd()}/../site/tools/hype-only-data.local.json`, "utf8"));
if (D.rpc !== RPC) { console.log(`hype-only-data.local.json is for ${D.rpc}, not ${RPC}. Rebuild it with --local --port.`); process.exit(1); }
const cfg = { ...RESERVE_CONFIG, rpc: RPC, rpcGapMs: 0, yieldEverySec: 1e12 };
const T = cfg.tokens, OWNER = D.owner, TL = D.timelock, ROUTER = D.router;
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
const warp = (s: number) => { cast(`rpc evm_increaseTime ${s}`); cast("rpc evm_mine"); };
const f = (v: bigint, dec = 18) => utils.formatUnits(v.toString(), dec);
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failed++; };
const tickOf = (pool: string) => Number(first(cast(`call ${cfg.stateView} "getSlot0(bytes32)(uint160,int24,uint24,uint24)" ${pool}`))[1]);

// The fork reports a higher network fee than Elysium really has; the job is told the real figure. Hyperliquid is
// not asked: a fork's pool prices stand still while the real market moves on, so the test answers in its place.
const world: typeof fetch = async (url: any, init?: any) => {
  const body = init?.body ? JSON.parse(init.body) : {};
  if (String(url) === RPC && body.method === "eth_gasPrice") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1dcd6500" }));
  if (String(url) === cfg.hyperliquid && body.type === "spotMeta")
    return new Response(JSON.stringify({ tokens: ["USDC", "HYPE", "KNTQ", "ANTX"].map((name, index) => ({ name, index })), universe: [{ name: "@H", tokens: [1, 0] }, { name: "@K", tokens: [2, 0] }, { name: "@A", tokens: [3, 0] }] }));
  if (String(url) === cfg.hyperliquid && body.type === "allMids") {
    const hype = 1.0001 ** tickOf(cfg.feeds.hypeUsdc) * 1e12, kntq = hype / 1.0001 ** tickOf(cfg.feeds.hypeKntq);
    return new Response(JSON.stringify({ "@H": String(hype), "@K": String(kntq), "@A": "1" }));
  }
  if (String(url) === cfg.hyperliquid) throw new Error("the test does not ask Hyperliquid");
  return fetch(url, init);
};
const deps = { ethers: { Wallet, utils }, fetch: world, env: (k: string) => ({ KEEPER_PRIVATE_KEY: KEY } as Record<string, string>)[k] };
const run = () => runReserve(deps, cfg);
const acts = (r: any) => r.actions.map((a: any) => `${a.what}${a.confirmed ? " [ok]" : a.note ? ` [${a.note}]` : ""}`).join("\n          ") || "(nothing sent)";
const pos = () => ({ inbox: bal(T.WHYPE, cfg.feeInbox), alloc: bal(T.WHYPE, cfg.allocator), khype: bal(T.KHYPE, cfg.reserve), kntq: bal(T.KNTQ, cfg.bridgeOut), usdc: bal(T.USDC, cfg.liquidWait), cw: bal(T.WHYPE, cfg.creatorWait) });
async function until(done: (r: any) => boolean, n = 9) {
  let r = await run();
  console.log(`       run 1 -> ${r.status}: ${r.reason}`);
  for (let k = 2; k <= n && !done(r); k++) { warp(600); r = await run(); console.log(`       run ${k} -> ${r.status}: ${r.reason}`); }
  return r;
}

// ---------- setup (fork only)
for (const a of [BOT, TRADER]) { cast(`rpc anvil_setCode ${a} 0x`); cast(`rpc anvil_setBalance ${a} 0x56BC75E2D63100000`); }
cast("rpc anvil_autoImpersonateAccount true");
for (const a of [OWNER, TL]) cast(`rpc anvil_setBalance ${a} 0x56BC75E2D63100000`);
cast("rpc evm_mine");
as(TL, `${cfg.oracle} "setKeeper(address,bool)" ${BOT} true`);
const fees = (hype: string) => { send(`${T.WHYPE} "deposit()" --value ${hype}ether`); send(`${T.WHYPE} "transfer(address,uint256)" ${cfg.feeInbox} ${utils.parseEther(hype)}`); };
const pointed = () => addr(D.swapConfig, "swapper()(address)") === ROUTER.toLowerCase() && addr(D.swapConfig, "oracle()(address)") === ROUTER.toLowerCase();

console.log("1. the three owner steps, with the exact data the page sends");
if (!pointed()) {
  if (cast(`code ${ROUTER}`) === "0x") send(`${D.factory} ${D.create}`); // anyone may create it
  check("the router is created at the address the page shows", cast(`code ${ROUTER}`) !== "0x", ROUTER);
  if (big(cast(`call ${TL} "getTimestamp(bytes32)(uint256)" ${D.id}`)) === 0n) {
    check("only the owner wallet can start the 48 hours", fails(TRADER, `${TL} ${D.schedule}`));
    as(OWNER, `${TL} ${D.schedule}`);
    warp(47 * 3600);
    check("the last step is refused before the 48 hours are up", fails(OWNER, `${TL} ${D.execute}`));
    warp(3600 + 60);
  }
  as(OWNER, `${TL} ${D.execute}`);
} else console.log("       (already done on this fork, through the page)");
check("the reserve now asks the router for prices and swaps", pointed());
check("the router reads the reserve's real oracle and swapper", addr(ROUTER, "realOracle()(address)") === cfg.oracle.toLowerCase() && addr(ROUTER, "realSwapper()(address)") === D.swapper.toLowerCase());
check("and locks into the live reserve", addr(ROUTER, "reserve()(address)") === cfg.reserve.toLowerCase());
check("it cannot be sent twice", fails(OWNER, `${TL} ${D.execute}`));

console.log("2. a fee arrives in HYPE; the bot's reserve job moves it (real settings)");
fees("0.2");
const p0 = pos();
const r = await until((x) => x.status === "moving" && bal(T.WHYPE, cfg.feeInbox) === 0n, 9);
console.log(`          ${acts(r)}`);
const p1 = pos();
const hypeUsd = r.prices!.hypeUsd, khypeInHype = 1.0001 ** tickOf(cfg.feeds.khypeWhype);
const toAllocator = (Number(p0.inbox) / 1e18) * 0.8 + Number(p0.alloc) / 1e18; // the older splitter sets 20% aside first
const lockedHype = (Number(p1.khype - p0.khype) / 1e18) * khypeInHype, parkedHype = Number(p1.usdc - p0.usdc) / 1e6 / hypeUsd;
check("the fee was moved", r.status === "moving" && p1.inbox === 0n && p1.alloc === 0n);
check("the job says what really happens to it", r.actions.some((a: any) => /buy and lock with .*: 80% kHYPE, 20% USDC$/.test(a.what)) && !r.actions.some((a: any) => /KNTQ/.test(a.what)));
check("no KNTQ was bought", p1.kntq === p0.kntq, `${f(p1.kntq)} KNTQ at the bridge, as before`);
check("80% of what reached the allocator is locked as staked HYPE", Math.abs(lockedHype / toAllocator - 0.8) < 0.012, `${f(p1.khype - p0.khype)} kHYPE = ${(lockedHype / toAllocator * 100).toFixed(1)}% of ${toAllocator.toFixed(4)} HYPE`);
check("20% is still set aside as USDC", Math.abs(parkedHype / toAllocator - 0.2) < 0.006, `${f(p1.usdc - p0.usdc, 6)} USDC = ${(parkedHype / toAllocator * 100).toFixed(1)}%`);
check("the router kept nothing", bal(T.WHYPE, ROUTER) === 0n && bal(T.KHYPE, ROUTER) === 0n && bal(T.USDC, ROUTER) === 0n);
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
