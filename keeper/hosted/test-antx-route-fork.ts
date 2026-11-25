// Fees paid in wANTx reach the reserve: the timelock batch built by script/antx-route-data.py, sent exactly as
// site/tools/antx-route.html sends it, and then the bot's real reserve job, on a LOCAL anvil fork of Elysium taken
// after the wANTx-USDC vault's launch (never a real network):
//   anvil --fork-url https://rpc.elysium.kinetiq.xyz --port 8597, then: cast rpc anvil_mine 0x1 --rpc-url http://127.0.0.1:8597
//   npx tsx hosted/test-antx-route-fork.ts          (from keeper/)
import { Wallet, utils } from "ethers";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runReserve, RESERVE_CONFIG } from "./reserve.js";
import { runCreator, CREATOR_CONFIG } from "./creator.js";

const RPC = "http://127.0.0.1:8597";
const D = JSON.parse(readFileSync(`${process.cwd()}/../site/tools/antx-route-data.json`, "utf8"));
const V = JSON.parse(readFileSync(`${process.cwd()}/../site/tools/antx-vault-data.json`, "utf8"));
const cfg = { ...RESERVE_CONFIG, rpc: RPC, rpcGapMs: 0, yieldEverySec: 1e12 };
const T = cfg.tokens, AX = cfg.antx!.token, POOL = cfg.antx!.feed, Z = "0x0000000000000000000000000000000000000000";
const VAULT = V.elysium.vault, PM = V.elysium.poolManager, OWNER = D.owner, TL = D.timelock;
const KEYT = `(${T.USDC},${AX},3000,60,${Z})`;
const GATEWAY_ALIAS = "0xEa8c30de0Ba0C2eAeE942afcE77530e06c5F233d"; // the HyperEVM token gateway, as Elysium sees it
const LIQUID_OP = "0x3e3514f7f93704c5e6509c1c678fee539ab39778dd9e3845fb26774693e67da6"; // the $liquid route's own timelock step
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", BOT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const TKEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", TRADER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const sh = (c: string) => execSync(`export PATH="$HOME/.foundry/bin:$PATH"; cd ${process.cwd()}/..; ${c}`, { encoding: "utf8", shell: "/bin/bash", stdio: ["ignore", "pipe", "pipe"] }).trim();
const cast = (c: string) => sh(`cast ${c} --rpc-url ${RPC}`);
const as = (who: string, c: string) => sh(`cast send ${c} --from ${who} --unlocked --rpc-url ${RPC} > /dev/null`);
const send = (c: string) => sh(`cast send ${c} --private-key ${TKEY} --rpc-url ${RPC} > /dev/null`);
const fails = (who: string, c: string) => { try { as(who, c); return false; } catch { return true; } };
/** Why a call would fail, as the node reports it ("" when it would go through). */
const why = (who: string, c: string) => { try { cast(`call ${c} --from ${who}`); return ""; } catch (e: any) { return String(e.stderr ?? e.message); } };
const first = (s: string) => s.split("\n").map((l) => l.trim().split(" ")[0]);
const big = (s: string) => BigInt(first(s)[0]);
const bal = (token: string, who: string) => big(cast(`call ${token} "balanceOf(address)(uint256)" ${who}`));
const warp = (s: number) => { cast(`rpc evm_increaseTime ${s}`); cast("rpc evm_mine"); };
const f = (v: bigint, dec = 18) => utils.formatUnits(v.toString(), dec);
const W = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n; // wANTx, to six places
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failed++; };
const slot0 = (pool: string) => first(cast(`call ${cfg.stateView} "getSlot0(bytes32)(uint160,int24,uint24,uint24)" ${pool}`));
/** Dollars per wANTx in the vault's pool right now. */
const poolUsd = () => 1e12 / (Number(BigInt(slot0(POOL)[0])) / 2 ** 96) ** 2;

if (cast(`code ${VAULT}`) === "0x") { console.log("The wANTx-USDC vault is not on this fork: take the fork after its launch (2026-11-21)."); process.exit(1); }

// The fork reports a higher network fee than Elysium really has (0.5 gwei); the job is told the real figure.
// Hyperliquid is not asked at all: a fork's pool prices stand still while the real market moves on, so the test
// answers in its place. HYPE and KNTQ are given at the fork's own pool prices; `antx` (dollars) is the ANTX price.
let antx = 0;
const tickOf = (pool: string) => Number(slot0(pool)[1]);
const world: typeof fetch = async (url: any, init?: any) => {
  const body = init?.body ? JSON.parse(init.body) : {};
  if (String(url) === RPC && body.method === "eth_gasPrice") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1dcd6500" }));
  if (String(url) === cfg.hyperliquid && body.type === "spotMeta")
    return new Response(JSON.stringify({ tokens: ["USDC", "HYPE", "KNTQ", "ANTX"].map((name, index) => ({ name, index })), universe: [{ name: "@H", tokens: [1, 0] }, { name: "@K", tokens: [2, 0] }, { name: "@A", tokens: [3, 0] }] }));
  if (String(url) === cfg.hyperliquid && body.type === "allMids") {
    const hype = 1.0001 ** tickOf(cfg.feeds.hypeUsdc) * 1e12, kntq = hype / 1.0001 ** tickOf(cfg.feeds.hypeKntq);
    return new Response(JSON.stringify({ "@H": String(hype), "@K": String(kntq), "@A": String(antx) }));
  }
  if (String(url) === cfg.hyperliquid) throw new Error("the test does not ask Hyperliquid");
  return fetch(url, init);
};
const deps = { ethers: { Wallet, utils }, fetch: world, env: (k: string) => ({ KEEPER_PRIVATE_KEY: KEY } as Record<string, string>)[k] };
const run = () => runReserve(deps, cfg);
const acts = (r: any) => r.actions.map((a: any) => `${a.what}${a.confirmed ? " [ok]" : a.note ? ` [${a.note}]` : ""}`).join("\n          ") || "(nothing sent)";
const pos = () => ({ inbox: bal(AX, cfg.feeInbox), split: bal(AX, cfg.feeSplitter), alloc: bal(AX, cfg.allocator), cw: bal(AX, cfg.creatorWait), khype: bal(T.KHYPE, cfg.reserve), kntq: bal(T.KNTQ, cfg.bridgeOut), usdc: bal(T.USDC, cfg.liquidWait), whype: bal(T.WHYPE, cfg.feeInbox) });
/** Runs the job every 10 minutes until `done`, at most `n` times. */
async function until(done: (r: any) => boolean, n = 9, label = "run") {
  let r = await run();
  console.log(`       ${label} 1 -> ${r.status}: ${r.reason}`);
  for (let k = 2; k <= n && !done(r); k++) { warp(600); r = await run(); console.log(`       ${label} ${k} -> ${r.status}: ${r.reason}`); }
  return r;
}

// ---------- setup (fork only): test wallets; the test key stands in for the bot as the oracle's price reader
for (const a of [BOT, TRADER]) { cast(`rpc anvil_setCode ${a} 0x`); cast(`rpc anvil_setBalance ${a} 0x56BC75E2D63100000`); }
cast("rpc anvil_autoImpersonateAccount true");
for (const a of [OWNER, TL, GATEWAY_ALIAS, PM]) cast(`rpc anvil_setBalance ${a} 0x56BC75E2D63100000`);
cast("rpc evm_mine");
as(TL, `${cfg.oracle} "setKeeper(address,bool)" ${BOT} true`);
// wANTx arrives for the trader the way the bridge brings it; USDC comes from the pool manager's holdings
const info = sh(`cast abi-encode "f(bytes,bytes,bytes)" $(cast abi-encode "f(string)" "Wrapped Anthropic xStock") $(cast abi-encode "f(string)" wANTx) $(cast abi-encode "f(uint8)" 18)`);
as(GATEWAY_ALIAS, `${V.elysium.gateway} "finalizeInboundTransfer(address,address,address,uint256,bytes)" ${V.hyperevm.wantx} ${TRADER} ${TRADER} 400000000000000000000 $(cast abi-encode "f(bytes,bytes)" ${info} 0x)`);
as(PM, `${T.USDC} "transfer(address,uint256)" ${TRADER} 20000000000`);
const fees = (n: number) => send(`${AX} "transfer(address,uint256)" ${cfg.feeInbox} ${W(n)}`); // stands in for the vault's fee cut, paid in wANTx
antx = poolUsd();
console.log(`the pool is at $${antx.toFixed(2)} per wANTx; the outside market is set to the same for now`);

const stage = big(cast(`call ${TL} "getTimestamp(bytes32)(uint256)" ${D.id}`)); // 0 = not started, 1 = done, else when step 2 opens
const liquidOp = big(cast(`call ${TL} "getTimestamp(bytes32)(uint256)" ${LIQUID_OP}`));
console.log("1. before the route exists: wANTx in the fee inbox is left alone");
fees(0.05);
let p0 = pos();
let r = await run();
console.log(`       -> ${r.status}: ${r.reason}`);
if (stage !== 1n) check("the job does not touch wANTx, and does not list it", !("WANTX" in (r.waiting ?? {})) && !r.actions.some((a: any) => /wANTx/i.test(a.what)) && pos().inbox === p0.inbox, `${f(p0.inbox)} wANTx waiting`);
else console.log("       (both owner steps are already done on the real network; skipped)");
check("a stranger cannot make the reserve sell it either: there is no route", /81fff07f|NoRoute/.test(why(TRADER, `${cfg.oracle} "quote(address,address,uint256)(uint256)" ${AX} ${T.USDC} 1000000000000000000`)) || stage === 1n);

console.log("2. the two owner steps, with the exact data the page sends");
if (stage === 0n) {
  check("only the owner wallet can start it", fails(TRADER, `${TL} ${D.schedule}`));
  as(OWNER, `${TL} ${D.schedule}`);
  check("step 1 starts the 48 hours", big(cast(`call ${TL} "getTimestamp(bytes32)(uint256)" ${D.id}`)) > 1n);
  warp(47 * 3600);
  check("step 2 is refused before the 48 hours are up", fails(OWNER, `${TL} ${D.execute}`));
  warp(3600 + 60);
  check("only the owner wallet can finish it", fails(TRADER, `${TL} ${D.execute}`));
  as(OWNER, `${TL} ${D.execute}`);
} else if (stage > 1n) {
  console.log("       (step 1 is already on the real network, sent by the owner)");
  check("step 1 cannot be sent a second time", fails(OWNER, `${TL} ${D.schedule}`));
  const left = Number(stage) - Number(first(cast("block latest --field timestamp"))[0]);
  if (left > 0) { check("step 2 is refused before the 48 hours are up", fails(OWNER, `${TL} ${D.execute}`), `${(left / 3600).toFixed(1)} hours to go`); warp(left + 60); }
  check("only the owner wallet can finish it", fails(TRADER, `${TL} ${D.execute}`));
  as(OWNER, `${TL} ${D.execute}`);
} else console.log("       (both steps are already done on the real network)");
const hops = (c: string, sig: string, out: string) => (cast(`call ${c} "${sig}" ${AX} ${out}`).match(/\(0, \(/g) ?? []).length;
const path = (out: string) => (cast(`call ${cfg.oracle} "getRoute(address,address)(bytes32[],uint24[])" ${AX} ${out}`).split("\n")[0].match(/0x[0-9a-fA-F]{64}/g) ?? []).length;
check("step 2 goes through after 48 hours", first(cast(`call ${TL} "isOperationDone(bytes32)(bool)" ${D.id}`))[0] === "true");
check("the oracle can now price wANTx into all three assets", path(T.KHYPE) === 3 && path(T.KNTQ) === 3 && path(T.USDC) === 1, `${path(T.KHYPE)}, ${path(T.KNTQ)} and ${path(T.USDC)} pools`);
const SWAP_SIG = "getRoute(address,address)((uint8,(address,address,uint24,int24,address),bool,address)[])";
check("the swapper has the three routes", hops(D.swapper, SWAP_SIG, T.KHYPE) === 3 && hops(D.swapper, SWAP_SIG, T.KNTQ) === 3 && hops(D.swapper, SWAP_SIG, T.USDC) === 1);
check("it cannot be sent twice", fails(OWNER, `${TL} ${D.execute}`));
check("the $liquid route's own timelock step is untouched", big(cast(`call ${TL} "getTimestamp(bytes32)(uint256)" ${LIQUID_OP}`)) === liquidOp);

console.log("3. the vault has no deposits yet, so its pool has no liquidity: the wANTx stays where it is");
p0 = pos();
r = await run();
console.log(`       -> ${r.status}: ${r.reason}\n          ${acts(r)}`);
if (big(cast(`call ${VAULT} "totalSupply()(uint256)"`)) === 0n) {
  check("the job now lists the wANTx as waiting", r.waiting?.WANTX === f(p0.inbox));
  check("it is not moved, and the report says why", pos().inbox === p0.inbox && !r.actions.some((a: any) => /forward .*wANTx|with .*wANTx/.test(a.what)) && /wANTx waits: its pool has too little liquidity/.test(r.reason + acts(r)));
  check("the contracts would refuse the sale anyway", why(TRADER, `${cfg.allocator} "allocate(address)" ${AX}`) !== "" && pos().alloc === 0n);
} else console.log("       (someone has deposited on the real network already; skipped)");

console.log("4. a depositor arrives; the bot's reserve job converts the wANTx (real settings)");
for (const t of [T.USDC, AX]) send(`${t} "approve(address,uint256)" ${VAULT} $(cast max-uint)`);
const usdcIn = BigInt(Math.round(20 * poolUsd() * 1e6));
if (big(cast(`call ${VAULT} "totalSupply()(uint256)"`)) === 0n) send(`${VAULT} "deposit(uint256,uint256,uint256,address)" 1 ${usdcIn} 20000000000000000000 ${TRADER}`);
else {
  const [want, need0, need1] = first(cast(`call ${VAULT} "previewDeposit(uint256,uint256)(uint256,uint256,uint256)" ${usdcIn} 20000000000000000000`)).map(BigInt);
  send(`${VAULT} "deposit(uint256,uint256,uint256,address)" ${want} ${(need0 * 1005n) / 1000n} ${(need1 * 1005n) / 1000n} ${TRADER}`);
}
check("the pool has liquidity now", big(cast(`call ${cfg.stateView} "getLiquidity(bytes32)(uint128)" ${POOL}`)) > 0n);
p0 = pos();
r = await until((x) => x.status === "moving" && bal(AX, cfg.feeInbox) === 0n, 9);
console.log(`          ${acts(r)}`);
let p1 = pos();
const khypeUsd = r.prices!.hypeUsd * 1.0001 ** Number(slot0(cfg.feeds.khypeWhype)[1]);
const usdIn = (Number(p0.inbox) / 1e18) * antx * 0.8; // the 80% that goes to the allocator
const usdOut = (Number(p1.khype - p0.khype) / 1e18) * khypeUsd + (Number(p1.kntq - p0.kntq) / 1e18) * r.prices!.kntqUsd + Number(p1.usdc - p0.usdc) / 1e6;
check("the fee inbox was emptied of wANTx", r.status === "moving" && p1.inbox === 0n && p1.split === 0n && p1.alloc === 0n, `${f(p0.inbox)} -> 0`);
check("the older splitter set its 20% aside (it follows below)", p1.cw - p0.cw === (p0.inbox * 2000n) / 10000n, `${f(p1.cw - p0.cw)} wANTx`);
check("kHYPE was bought and locked", p1.khype > p0.khype, `+${f(p1.khype - p0.khype)} kHYPE`);
check("KNTQ was bought and sent on to be staked", p1.kntq > p0.kntq, `+${f(p1.kntq - p0.kntq)} KNTQ`);
check("USDC was parked", p1.usdc > p0.usdc, `+${f(p1.usdc - p0.usdc, 6)} USDC`);
check("the conversion costs about the pool fees on the way", usdOut / usdIn > 0.975 && usdOut / usdIn < 1.005, `$${usdIn.toFixed(3)} of wANTx became $${usdOut.toFixed(3)}: ${((1 - usdOut / usdIn) * 100).toFixed(2)}% cost`);

console.log("5. the set-aside 20% is passed on and locked too, once enough has collected");
const ccfg = { ...CREATOR_CONFIG, rpc: RPC, rpcGapMs: 0 };
let c = await runCreator(deps, ccfg);
console.log(`       creator job -> ${c.status}: ${c.reason}`);
check("a small amount waits", bal(AX, cfg.creatorWait) === p1.cw && c.waiting?.wANTx === f(p1.cw), `${f(p1.cw)} wANTx`);
fees(0.1);
r = await until((x) => x.status === "moving" && bal(AX, cfg.feeInbox) === 0n, 6);
c = await runCreator(deps, ccfg);
console.log(`       creator job -> ${c.status}: ${c.reason}\n          ${c.actions.map((a: any) => `${a.what}${a.confirmed ? " [ok]" : ""}`).join("\n          ")}`);
r = await until((x) => x.status === "moving" && bal(AX, cfg.allocator) === 0n, 4);
let p2 = pos();
check("then it goes into the reserve as well", p2.cw === 0n && p2.alloc === 0n && p2.khype > p1.khype, `kHYPE +${f(p2.khype - p1.khype)} in total this round`);

console.log("6. the pool prices wANTx below the outside market: the wANTx is held back, other fees still move");
antx = poolUsd() * 1.05;
fees(0.05);
send(`${T.WHYPE} "deposit()" --value 5ether`);
send(`${T.WHYPE} "transfer(address,uint256)" ${cfg.feeInbox} 30000000000000000`); // 0.03 HYPE of ordinary fees arrives too
p0 = pos();
r = await until((x) => x.status === "moving", 3);
console.log(`          ${acts(r)}`);
p1 = pos();
check("the wANTx is held back, with the reason", p1.inbox === p0.inbox && r.actions.some((a: any) => /leave .*wANTx/.test(a.what) && /pool prices wANTx [\d.]+% below Hyperliquid \(limit 3%\)/.test(a.note ?? "")));
check("the HYPE fees were moved all the same", p1.whype === 0n && p0.whype > 0n && p1.khype > p0.khype);
antx = poolUsd();
r = await until((x) => x.status === "moving" && bal(AX, cfg.feeInbox) === 0n, 4);
check("once the two agree again the wANTx is converted", bal(AX, cfg.feeInbox) === 0n && bal(AX, cfg.allocator) === 0n);

console.log("7. a sudden move of the pool price: the contracts refuse to sell, the bot waits for the average");
const out = sh(`forge create src/adapters/UniswapV4Swapper.sol:UniswapV4Swapper --private-key ${TKEY} --rpc-url ${RPC} --broadcast --constructor-args ${TRADER} ${PM} ${T.WHYPE} 2>&1`);
const SWAP = /Deployed to: (0x[0-9a-fA-F]{40})/.exec(out)![1];
send(`${AX} "approve(address,uint256)" ${SWAP} $(cast max-uint)`);
send(`${SWAP} "setRoute(address,address,(uint8,(address,address,uint24,int24,address),bool,address)[])" ${AX} ${T.USDC} "[(0,${KEYT},false,${Z})]"`);
warp(60);
await run(); // a fresh price reading, so the next check is about the price and not about old readings
const before = poolUsd();
send(`${SWAP} "swap(address,address,uint256,uint256,address)" ${AX} ${T.USDC} ${W(3)} 0 ${TRADER}`); // someone sells 3 wANTx into the pool
antx = poolUsd(); // suppose the outside market fell just as far, so only the average is in the way
console.log(`       the pool went from $${before.toFixed(2)} to $${antx.toFixed(2)} (${((antx / before - 1) * 100).toFixed(1)}%)`);
send(`${AX} "transfer(address,uint256)" ${cfg.allocator} ${W(0.01)}`); // a stranger puts wANTx straight into the allocator
check("a stranger's sale at the moved price is refused by the 1% limit", /2c19b8b8|InsufficientOutput/.test(why(TRADER, `${cfg.allocator} "allocate(address)" ${AX}`)));
fees(0.05);
p0 = pos();
r = await run();
console.log(`       -> ${r.status}: ${r.reason}\n          ${acts(r)}`);
check("the bot holds the wANTx back, with the reason", pos().inbox === p0.inbox && pos().alloc === p0.alloc && /wANTx price is [\d.]+% away from its 30-minute average/.test(r.reason + acts(r)));
r = await until((x) => x.status === "moving" && bal(AX, cfg.feeInbox) === 0n && bal(AX, cfg.allocator) === 0n, 8);
check("once the average has caught up the wANTx is converted", bal(AX, cfg.feeInbox) === 0n && bal(AX, cfg.allocator) === 0n);

console.log("8. an amount too small to be worth it waits");
fees(0.0005);
r = await run();
console.log(`       -> ${r.status}: ${r.reason}`);
check("0.0005 wANTx (about four cents) is left in the fee inbox", bal(AX, cfg.feeInbox) === W(0.0005) && !r.actions.some((a: any) => /wANTx/i.test(a.what)));

console.log("9. every depositor leaves: what liquidity is left is too little, and the job spends nothing on the wANTx");
send(`${VAULT} "withdraw(uint256,uint256,uint256,address,bool)" ${bal(VAULT, TRADER)} 0 0 ${TRADER} false`);
const dust = big(cast(`call ${cfg.stateView} "getLiquidity(bytes32)(uint128)" ${POOL}`));
fees(0.05);
p0 = pos();
r = await run();
console.log(`       -> ${r.status}: ${r.reason}\n          ${acts(r)}`);
check("the wANTx stays in the fee inbox", pos().inbox === p0.inbox && pos().alloc === 0n, `pool liquidity left: ${dust}`);
check("no price reading is paid for and the report says why", !r.actions.some((a: any) => /price reading|wANTx/.test(a.what)) && r.status === "idle" && /wANTx waits: its pool has too little liquidity/.test(r.reason));
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
