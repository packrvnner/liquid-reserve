// Fees paid in $liquid reach the reserve: the timelock batch built by script/liquid-route-data.py, sent exactly as
// site/tools/liquid-route.html sends it, and then the bot's real reserve job, on a LOCAL anvil fork of Elysium
// (never a real network):
//   anvil --fork-url https://rpc.elysium.kinetiq.xyz --port 8597, then: cast rpc evm_mine --rpc-url http://127.0.0.1:8597
//   npx tsx hosted/test-liquid-route-fork.ts          (from keeper/)
import { Wallet, utils } from "ethers";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runReserve, RESERVE_CONFIG } from "./reserve.js";
import { runCreator, CREATOR_CONFIG } from "./creator.js";

const RPC = "http://127.0.0.1:8597";
const D = JSON.parse(readFileSync(`${process.cwd()}/../site/tools/liquid-route-data.json`, "utf8"));
const cfg = { ...RESERVE_CONFIG, rpc: RPC, rpcGapMs: 0, yieldEverySec: 1e12 };
const T = cfg.tokens, LQ = cfg.liquid!.token, Z = "0x0000000000000000000000000000000000000000";
const PM = "0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1", OWNER = D.owner, TL = D.timelock;
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", BOT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const TKEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", TRADER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const sh = (c: string) => execSync(`export PATH="$HOME/.foundry/bin:$PATH"; cd ${process.cwd()}/..; ${c}`, { encoding: "utf8", shell: "/bin/bash", stdio: ["ignore", "pipe", "pipe"] }).trim();
const cast = (c: string) => sh(`cast ${c} --rpc-url ${RPC}`);
const as = (who: string, c: string) => sh(`cast send ${c} --from ${who} --unlocked --rpc-url ${RPC} > /dev/null`);
const send = (c: string) => sh(`cast send ${c} --private-key ${TKEY} --rpc-url ${RPC} > /dev/null`);
const fails = (who: string, c: string) => { try { as(who, c); return false; } catch { return true; } };
const first = (s: string) => s.split("\n").map((l) => l.trim().split(" ")[0]);
const bal = (token: string, who: string) => BigInt(first(cast(`call ${token} "balanceOf(address)(uint256)" ${who}`))[0]);
const warp = (s: number) => { cast(`rpc evm_increaseTime ${s}`); cast("rpc evm_mine"); };
const f = (v: bigint, dec = 18) => utils.formatUnits(v.toString(), dec);
const E = (n: number) => BigInt(n) * 10n ** 18n;
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failed++; };
const realGas: typeof fetch = async (url: any, init?: any) => {
  if (String(url) === RPC && init?.body && JSON.parse(init.body).method === "eth_gasPrice") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1dcd6500" }));
  return fetch(url, init);
};
const deps = { ethers: { Wallet, utils }, fetch: realGas, env: (k: string) => ({ KEEPER_PRIVATE_KEY: KEY } as Record<string, string>)[k] };
const run = () => runReserve(deps, cfg);
const acts = (r: any) => r.actions.map((a: any) => `${a.what}${a.confirmed ? " [ok]" : a.note ? ` [${a.note}]` : ""}`).join("\n          ");
const pos = () => ({ inbox: bal(LQ, cfg.feeInbox), alloc: bal(LQ, cfg.allocator), cw: bal(LQ, cfg.creatorWait), khype: bal(T.KHYPE, cfg.reserve), kntq: bal(T.KNTQ, cfg.bridgeOut), usdc: bal(T.USDC, cfg.liquidWait), whype: bal(T.WHYPE, cfg.feeInbox) });
/** Runs the job every 10 minutes until `done`, at most `n` times. */
async function until(done: (r: any) => boolean, n = 9, label = "run") {
  let r = await run();
  console.log(`       ${label} 1 -> ${r.status}: ${r.reason}`);
  for (let k = 2; k <= n && !done(r); k++) { warp(600); r = await run(); console.log(`       ${label} ${k} -> ${r.status}: ${r.reason}`); }
  return r;
}

// ---------- setup (fork only): test wallets, and the test key stands in for the bot as the oracle's price reader
for (const a of [BOT, TRADER]) { cast(`rpc anvil_setCode ${a} 0x`); cast(`rpc anvil_setBalance ${a} 0x56BC75E2D63100000`); }
for (const a of [OWNER, TL]) { cast(`rpc anvil_impersonateAccount ${a}`); cast(`rpc anvil_setBalance ${a} 0x56BC75E2D63100000`); }
cast("rpc evm_mine");
as(TL, `${cfg.oracle} "setKeeper(address,bool)" ${BOT} true`);
const fees = (n: number) => as(OWNER, `${LQ} "transfer(address,uint256)" ${cfg.feeInbox} ${E(n)}`); // stands in for $liquid fees from the vault

// Where the owner's two steps stand on the real network when the copy was made: 0 = not started, 1 = both done,
// anything else = step 1 sent (the number is when step 2 opens). The owner sent step 1 on 2026-11-20.
const stage = BigInt(first(cast(`call ${TL} "getTimestamp(bytes32)(uint256)" ${D.id}`))[0]);
console.log("1. before the route exists: $liquid in the fee inbox is left alone, and nothing else changes");
fees(500_000);
let p0 = pos();
let r = await run();
console.log(`       -> ${r.status}: ${r.reason}`);
if (stage !== 1n) check("the job does not touch $liquid", !("LIQUID" in (r.waiting ?? {})) && !r.actions.some((a: any) => /liquid/i.test(a.what)) && pos().inbox === p0.inbox, `${f(p0.inbox)} $liquid waiting`);
else console.log("       (both owner steps are already done on the real network; skipped)");

console.log("2. the two owner steps, with the exact data the page sends");
if (stage === 0n) {
  check("only the owner wallet can start it", fails(TRADER, `${TL} ${D.schedule}`));
  as(OWNER, `${TL} ${D.schedule}`);
  check("step 1 starts the 48 hours", BigInt(first(cast(`call ${TL} "getTimestamp(bytes32)(uint256)" ${D.id}`))[0]) > 1n);
  warp(47 * 3600);
  check("step 2 is refused before the 48 hours are up", fails(OWNER, `${TL} ${D.execute}`));
  warp(3600 + 60);
  as(OWNER, `${TL} ${D.execute}`);
} else if (stage > 1n) {
  console.log("       (step 1 is already on the real network, sent by the owner)");
  check("step 1 cannot be sent a second time", fails(OWNER, `${TL} ${D.schedule}`));
  const left = Number(stage) - Number(first(cast("block latest --field timestamp"))[0]);
  if (left > 0) { check("step 2 is refused before the 48 hours are up", fails(OWNER, `${TL} ${D.execute}`), `${(left / 3600).toFixed(1)} hours to go`); warp(left + 60); }
  check("only the owner wallet can finish it", fails(TRADER, `${TL} ${D.execute}`));
  as(OWNER, `${TL} ${D.execute}`);
} else console.log("       (both steps are already done on the real network)");
const routeLen = (c: string, sig: string, out: string) => (cast(`call ${c} "${sig}" ${LQ} ${out}`).match(/0x[0-9a-fA-F]{64}|\(0,/g) ?? []).length;
check("step 2 goes through after 48 hours", first(cast(`call ${TL} "isOperationDone(bytes32)(bool)" ${D.id}`))[0] === "true");
check("the oracle can now price $liquid into all three assets", [T.KHYPE, T.KNTQ, T.USDC].every((o) => routeLen(cfg.oracle, "getRoute(address,address)(bytes32[],uint24[])", o) === 2));
check("the swapper has the three routes", [T.KHYPE, T.KNTQ, T.USDC].every((o) => routeLen(D.swapper, "getRoute(address,address)((uint8,(address,address,uint24,int24,address),bool,address)[])", o) === 2));
check("it cannot be sent twice", fails(OWNER, `${TL} ${D.execute}`));

console.log("3. the bot's reserve job now converts the $liquid (real settings)");
p0 = pos();
r = await until((x) => x.status === "moving" && bal(LQ, cfg.feeInbox) === 0n, 9);
console.log(`          ${acts(r)}`);
let p1 = pos();
const px = r.prices!.hypeUsd, liqUsd = Number(first(cast(`call ${cfg.stateView} "getSlot0(bytes32)(uint160,int24,uint24,uint24)" ${cfg.liquid!.feed}`))[1]);
const usdIn = (Number(p0.inbox) / 1e18) * px * 1.0001 ** liqUsd * 0.8; // the 80% that goes to the allocator
const usdOut = (Number(p1.khype - p0.khype) / 1e18) * px + (Number(p1.kntq - p0.kntq) / 1e18) * r.prices!.kntqUsd + Number(p1.usdc - p0.usdc) / 1e6;
check("the fee inbox was emptied of $liquid", r.status === "moving" && p1.inbox === 0n && p1.alloc === 0n, `${f(p0.inbox)} -> 0`);
check("the older splitter set its 20% aside (it follows below)", p1.cw - p0.cw === (p0.inbox * 2000n) / 10000n, `${f(p1.cw - p0.cw)} $liquid`);
check("kHYPE was bought and locked", p1.khype > p0.khype, `+${f(p1.khype - p0.khype)} kHYPE`);
check("KNTQ was bought and sent on to be staked", p1.kntq > p0.kntq, `+${f(p1.kntq - p0.kntq)} KNTQ`);
check("USDC was parked", p1.usdc > p0.usdc, `+${f(p1.usdc - p0.usdc, 6)} USDC`);
check("the conversion cost stays near Ascend's 2% plus pool fees", usdOut / usdIn > 0.955 && usdOut / usdIn < 1.01, `$${usdIn.toFixed(3)} of $liquid became $${usdOut.toFixed(3)}: ${((1 - usdOut / usdIn) * 100).toFixed(1)}% cost`);

console.log("4. the set-aside 20% is passed on and locked too, once enough has collected");
const ccfg = { ...CREATOR_CONFIG, rpc: RPC, rpcGapMs: 0 };
let c = await runCreator(deps, ccfg);
console.log(`       creator job -> ${c.status}: ${c.reason}`);
check("a small amount waits", bal(LQ, cfg.creatorWait) === p1.cw);
fees(2_000_000);
r = await until((x) => x.status === "moving" && bal(LQ, cfg.feeInbox) === 0n, 6);
c = await runCreator(deps, ccfg);
console.log(`       creator job -> ${c.status}: ${c.reason}`);
r = await until((x) => x.status === "moving" && bal(LQ, cfg.allocator) === 0n, 4);
let p2 = pos();
check("then it goes into the reserve as well", p2.cw === 0n && p2.alloc === 0n && p2.khype > p1.khype, `kHYPE +${f(p2.khype - p1.khype)} in total this round`);

console.log("5. a sudden $liquid price move holds back the $liquid only; other fees still move");
const out = sh(`forge create src/adapters/UniswapV4Swapper.sol:UniswapV4Swapper --private-key ${TKEY} --rpc-url ${RPC} --broadcast --constructor-args ${TRADER} ${PM} ${T.WHYPE} 2>&1`);
const SWAP = /Deployed to: (0x[0-9a-fA-F]{40})/.exec(out)![1];
send(`${T.WHYPE} "deposit()" --value 5ether`);
send(`${T.WHYPE} "approve(address,uint256)" ${SWAP} $(cast max-uint)`);
send(`${SWAP} "setRoute(address,address,(uint8,(address,address,uint24,int24,address),bool,address)[])" ${T.WHYPE} ${LQ} "[(0,(${LQ},${T.WHYPE},8388608,200,0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC),false,${Z})]"`);
send(`${SWAP} "swap(address,address,uint256,uint256,address)" ${T.WHYPE} ${LQ} ${E(1)} 0 ${TRADER}`); // someone buys 1 HYPE of $liquid
fees(600_000);
send(`${T.WHYPE} "transfer(address,uint256)" ${cfg.feeInbox} 30000000000000000`); // and 0.03 HYPE of ordinary fees arrives
p0 = pos();
r = await run();
console.log(`       -> ${r.status}: ${r.reason}\n          ${acts(r)}`);
p1 = pos();
check("the $liquid is held back, with the reason", p1.inbox === p0.inbox && r.actions.some((a: any) => /leave .*\$liquid/.test(a.what) && /30-minute average/.test(a.note ?? "")));
check("the HYPE fees were moved all the same", p1.whype === 0n && p0.whype > 0n && p1.khype > p0.khype);
r = await until((x) => x.status === "moving" && bal(LQ, cfg.feeInbox) === 0n, 8);
check("once the price has settled the $liquid is converted", bal(LQ, cfg.feeInbox) === 0n && bal(LQ, cfg.allocator) === 0n);

console.log("6. an amount too small to be worth it waits");
fees(68);
r = await run();
console.log(`       -> ${r.status}: ${r.reason}`);
check("68 $liquid (a fraction of a cent) is left in the fee inbox", bal(LQ, cfg.feeInbox) === E(68) && !r.actions.some((a: any) => /liquid/i.test(a.what)));
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
