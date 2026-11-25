// The three LIVE vaults, end to end, on a LOCAL anvil fork of Elysium (never a real network):
//   - people trade in each vault's pool, both ways
//   - the fees are collected (by a stranger for one vault, by the bot's own job for the others)
//   - exactly 20% of them leaves the vault for the vault's fixed fee address, the rest is put back to work
//   - from the fee address the bot's real jobs carry it on: a fifth of the newer vaults' cut to the creator's
//     wallet, everything else bought, staked and locked in the reserve
//   anvil --fork-url https://rpc.elysium.kinetiq.xyz --port 8597, then: cast rpc evm_mine --rpc-url http://127.0.0.1:8597
//   npx tsx hosted/test-live-vaults-fork.ts          (from keeper/)
import { Wallet, utils } from "ethers";
import { execSync } from "node:child_process";
import { runKeeper, CONFIG } from "./core.js";
import { runShare, SHARE_CONFIG } from "./share.js";
import { runReserve, RESERVE_CONFIG } from "./reserve.js";
import { runCreator, CREATOR_CONFIG } from "./creator.js";

const RPC = "http://127.0.0.1:8597";
const PM = "0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1", Z = "0x0000000000000000000000000000000000000000";
const T = RESERVE_CONFIG.tokens, LIQUID = "0x247c91C14b5Aa1cF57f02d638B0287F5cd69E9f6";
const INBOX = RESERVE_CONFIG.feeInbox, SPLIT = SHARE_CONFIG.vaultFeeSplit, CREATOR = "0x9324605c9C707b2F805CCF2AC099fCA5d561DC37";
const VAULTS = [
  { name: "HYPE-USDC", address: "0x05D6A15d864A633DF9efC082aCFf7a2AB1e44911", t1: T.USDC, sym: "USDC", dec: 6, fee: 3000, spacing: 60, feeTo: INBOX },
  { name: "HYPE-KNTQ", address: "0xB7A3cFE218363E158A748aDfcb1A5a5FeD41c686", t1: T.KNTQ, sym: "KNTQ", dec: 18, fee: 3000, spacing: 60, feeTo: SPLIT },
  { name: "HYPE-$liquid", address: "0xF49AAD222D3b9937371701e411c97018285E6691", t1: LIQUID, sym: "$liquid", dec: 18, fee: 20000, spacing: 200, feeTo: SPLIT },
];
// anvil's public test accounts stand in for the bot and for a trader
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", BOT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const TKEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", TRADER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const FEES_COLLECTED = "0xf5d590414d56d256b8c16b850d0b57f2f5d2ed90686166e150b48a96f0dbdd61";

const sh = (c: string) => execSync(`export PATH="$HOME/.foundry/bin:$PATH"; cd ${process.cwd()}/..; ${c}`, { encoding: "utf8", shell: "/bin/bash", stdio: ["ignore", "pipe", "pipe"] }).trim();
const cast = (c: string) => sh(`cast ${c} --rpc-url ${RPC}`);
const send = (c: string, key = TKEY) => JSON.parse(sh(`cast send ${c} --private-key ${key} --rpc-url ${RPC} --json`));
const first = (s: string) => s.split("\n").map((l) => l.trim().split(" ")[0]);
const big = (s: string) => BigInt(first(s)[0]);
const bal = (token: string, who: string) => big(cast(`call ${token} "balanceOf(address)(uint256)" ${who}`));
const warp = (s: number) => { cast(`rpc evm_increaseTime ${s}`); cast("rpc evm_mine"); };
const f = (v: bigint, dec = 18) => utils.formatUnits(v.toString(), dec);
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failed++; };
// The fork reports a higher network fee than Elysium really has (0.5 gwei); the bot's jobs are told the real figure.
const realGas: typeof fetch = async (url: any, init?: any) => {
  if (String(url) === RPC && init?.body && JSON.parse(init.body).method === "eth_gasPrice") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1dcd6500" }));
  return fetch(url, init);
};
const deps = { ethers: { Wallet, utils }, fetch: realGas, env: (k: string) => ({ KEEPER_PRIVATE_KEY: KEY } as Record<string, string>)[k] };

// ---------- setup (fork only)
for (const a of [BOT, TRADER]) { cast(`rpc anvil_setCode ${a} 0x`); cast(`rpc anvil_setBalance ${a} 0x56BC75E2D63100000`); }
cast("rpc evm_mine");
const oracleOwner = cast(`call ${RESERVE_CONFIG.oracle} "owner()(address)"`);
cast(`rpc anvil_impersonateAccount ${oracleOwner}`); cast(`rpc anvil_setBalance ${oracleOwner} 0x56BC75E2D63100000`);
sh(`cast send ${RESERVE_CONFIG.oracle} "setKeeper(address,bool)" ${BOT} true --from ${oracleOwner} --unlocked --rpc-url ${RPC} > /dev/null`);
const out = sh(`forge create src/adapters/UniswapV4Swapper.sol:UniswapV4Swapper --private-key ${TKEY} --rpc-url ${RPC} --broadcast --constructor-args ${TRADER} ${PM} ${T.WHYPE} 2>&1`);
const SWAP = /Deployed to: (0x[0-9a-fA-F]{40})/.exec(out)![1];
send(`${T.WHYPE} "deposit()" --value 5ether`);
send(`${T.WHYPE} "approve(address,uint256)" ${SWAP} $(cast max-uint)`);
const ROUTE = "setRoute(address,address,(uint8,(address,address,uint24,int24,address),bool,address)[])";
for (const v of VAULTS) {
  const key = `(${Z},${v.t1},${v.fee},${v.spacing},${Z})`;
  send(`${SWAP} "${ROUTE}" ${T.WHYPE} ${v.t1} "[(0,${key},true,${Z})]"`);
  send(`${SWAP} "${ROUTE}" ${v.t1} ${T.WHYPE} "[(0,${key},false,${Z})]"`);
  send(`${v.t1} "approve(address,uint256)" ${SWAP} $(cast max-uint)`);
}
const swap = (a: string, b: string, amt: bigint) => send(`${SWAP} "swap(address,address,uint256,uint256,address)" ${a} ${b} ${amt} 0 ${TRADER}`);
const state = (v: (typeof VAULTS)[number]) => {
  const [t0, t1] = first(cast(`call ${v.address} "balances()(uint256,uint256)"`)).map(BigInt);
  const m = first(cast(`call ${v.address} "main()(int24,int24,uint128)"`));
  const [, tick] = first(cast(`call ${v.address} "price()(uint160,int24)"`));
  const supply = big(cast(`call ${v.address} "totalSupply()(uint256)"`)), value = big(cast(`call ${v.address} "totalValue()(uint256)"`));
  return { t0, t1, lo: +m[0], hi: +m[1], liq: BigInt(m[2]), tick: +tick, perShare: (value * 10n ** 18n) / supply };
};

// ---------- 1. trading, then the fees are collected
console.log("1. what the bot would do with these vaults right now, with its real settings");
const today = await runKeeper(deps, { ...CONFIG, rpc: RPC, rpcGapMs: 0 });
for (const v of VAULTS) { const r = today.vaults.find((x) => x.name === v.name); console.log(`       ${v.name}: ${r ? `${r.action}, ${r.reason}` : "not in the bot's list"}`); }
check("the bot looks after all three live vaults", VAULTS.every((v) => today.vaults.some((x) => x.name === v.name)));

const ROUNDS = 6;
const collected: Record<string, { perf0: bigint; perf1: bigint }> = {};
for (const [i, v] of VAULTS.entries()) {
  console.log(`2.${i + 1} ${v.name}: ${ROUNDS} trades each way in its pool, then its fees are collected`);
  const s0 = state(v), size = (s0.t0 * 3n) / 100n; // each buy is 3% of the vault's HYPE
  check("in range before the trades", s0.liq > 0n && s0.tick >= s0.lo && s0.tick < s0.hi, `holds ${f(s0.t0)} HYPE + ${f(s0.t1, v.dec)} ${v.sym}`);
  let stayed = true;
  for (let k = 0; k < ROUNDS; k++) {
    const had = bal(v.t1, TRADER);
    swap(T.WHYPE, v.t1, size);
    const mid = state(v); stayed &&= mid.tick >= mid.lo && mid.tick < mid.hi;
    swap(v.t1, T.WHYPE, bal(v.t1, TRADER) - had); // sell back exactly what was bought
  }
  check("the price stayed inside the vault's range throughout", stayed);
  const pend = first(cast(`call ${v.address} "pendingFees()(uint256,uint256)"`)).map(BigInt);
  const before = { to0: bal(T.WHYPE, v.feeTo), to1: bal(v.t1, v.feeTo), liq: state(v).liq };
  let receipt: any;
  if (i === 0) {
    receipt = send(`${v.address} "harvest()"`); // a stranger: anyone may collect a vault's fees
    console.log("       collected by a stranger's call (anyone may do this; the money can only go where the vault says)");
  } else {
    const r = await runKeeper(deps, { ...CONFIG, rpc: RPC, rpcGapMs: 0, vaults: CONFIG.vaults.filter((x) => x.name === v.name), harvestGasMultiple: 0, harvestMinGapSec: 0 });
    const row = r.vaults[0];
    console.log(`       the bot's own job (told not to wait for more fees): ${row.action}, ${row.reason}`);
    check("the bot collected the fees", row.action === "harvest" && row.confirmed === true);
    receipt = JSON.parse(cast(`receipt ${row.tx} --json`));
  }
  const log = receipt.logs.find((l: any) => l.address.toLowerCase() === v.address.toLowerCase() && l.topics[0] === FEES_COLLECTED);
  const [fee0, fee1, perf0, perf1] = (log.data.slice(2).match(/.{64}/g) as string[]).map((w) => BigInt("0x" + w));
  const after = { to0: bal(T.WHYPE, v.feeTo), to1: bal(v.t1, v.feeTo), s: state(v) };
  console.log(`       fees earned: ${f(fee0)} HYPE + ${f(fee1, v.dec)} ${v.sym} (the vault had estimated ${f(pend[0])} + ${f(pend[1], v.dec)})`);
  check("trading earned fees on both sides", fee0 > 0n && fee1 > 0n);
  check("the cut is exactly 20% of the fees", perf0 === (fee0 * 2000n) / 10000n && perf1 === (fee1 * 2000n) / 10000n, `${f(perf0)} HYPE + ${f(perf1, v.dec)} ${v.sym}`);
  check(`all of the cut arrived at the vault's fee address (${v.feeTo === INBOX ? "the reserve's fee inbox" : "the 80/20 splitter"})`, after.to0 - before.to0 === perf0 && after.to1 - before.to1 === perf1);
  check("the other 80% was put back to work for depositors", after.s.liq > before.liq && after.s.perShare > s0.perShare, `value per share ${f(s0.perShare)} -> ${f(after.s.perShare)}`);
  check("still in range and earning", after.s.liq > 0n && after.s.tick >= after.s.lo && after.s.tick < after.s.hi);
  collected[v.name] = { perf0, perf1 };
}

// ---------- 2. from the fee addresses to the creator's wallet and the reserve, with the bot's real jobs
console.log("3. the newer vaults' cut: a fifth to the creator's wallet, the rest to the reserve's fee inbox");
// The test trades are tiny, so a larger cut is stood in for: 0.1 HYPE of fees sent to the splitter, as a vault would.
send(`${T.WHYPE} "transfer(address,uint256)" ${SPLIT} 100000000000000000`);
const sp = { split: bal(T.WHYPE, SPLIT), creator: bal(T.WHYPE, CREATOR), inbox: bal(T.WHYPE, INBOX) };
const share = await runShare(deps, { ...SHARE_CONFIG, rpc: RPC, rpcGapMs: 0 });
console.log(`       -> ${share.status}: ${share.reason}\n          ${share.actions.map((a) => `${a.what}${a.confirmed ? " [ok]" : a.note ? ` [${a.note}]` : ""}`).join("\n          ")}`);
const sp2 = { split: bal(T.WHYPE, SPLIT), creator: bal(T.WHYPE, CREATOR), inbox: bal(T.WHYPE, INBOX) };
const toCreator = (sp.split * 2000n) / 10000n;
check("the creator's wallet received exactly 20% of what the splitter held", sp2.creator - sp.creator === toCreator, `+${f(sp2.creator - sp.creator)} HYPE (wrapped)`);
check("the other 80% went to the reserve's fee inbox", sp2.inbox - sp.inbox === sp.split - toCreator && sp2.split === 0n, `+${f(sp2.inbox - sp.inbox)} HYPE`);

console.log("4. the fee inbox into the reserve, with the bot's real settings");
const rcfg = { ...RESERVE_CONFIG, rpc: RPC, rpcGapMs: 0, yieldEverySec: 1e12 };
const pos = () => ({ inbox: bal(T.WHYPE, INBOX), khype: bal(T.KHYPE, rcfg.reserve), kntq: bal(T.KNTQ, rcfg.bridgeOut), usdc: bal(T.USDC, rcfg.liquidWait), cw: bal(T.WHYPE, rcfg.creatorWait), alloc: bal(T.WHYPE, rcfg.allocator) });
const p0 = pos();
let r = await runReserve(deps, rcfg);
console.log(`       run 1 -> ${r.status}: ${r.reason}`);
for (let k = 2; k <= 9 && r.status !== "moving"; k++) { warp(600); r = await runReserve(deps, rcfg); console.log(`       run ${k} -> ${r.status}: ${r.reason}`); }
console.log(`          ${r.actions.map((a) => `${a.what}${a.confirmed ? " [ok]" : a.note ? ` [${a.note}]` : ""}`).join("\n          ")}`);
const p1 = pos();
check("the fee inbox was emptied of HYPE", r.status === "moving" && p1.inbox === 0n, `${f(p0.inbox)} -> ${f(p1.inbox)}`);
check("kHYPE was bought and locked in the reserve", p1.khype > p0.khype, `+${f(p1.khype - p0.khype)} kHYPE`);
check("KNTQ was bought and sent on to be staked and locked", p1.kntq > p0.kntq, `+${f(p1.kntq - p0.kntq)} KNTQ at the bridge`);
check("the $liquid share was parked as USDC", p1.usdc > p0.usdc, `+${f(p1.usdc - p0.usdc, 6)} USDC`);

console.log("5. the older splitter's 20% (once the creator's cut, now the reserve's for good) follows it in");
const c = await runCreator(deps, { ...CREATOR_CONFIG, rpc: RPC, rpcGapMs: 0, tokens: CREATOR_CONFIG.tokens.map((t) => ({ ...t, min: t.sym === "WHYPE" ? "0.001" : t.min })) });
console.log(`       -> ${c.status}: ${c.reason}`);
let r2 = await runReserve(deps, rcfg);
for (let k = 2; k <= 4 && r2.status !== "moving"; k++) { warp(600); r2 = await runReserve(deps, rcfg); }
console.log(`       -> ${r2.status}: ${r2.reason}`);
const p2 = pos();
check("it was passed on and locked too", p1.cw > p0.cw && p2.cw === 0n && p2.alloc === 0n && p2.khype > p1.khype, `+${f(p2.khype - p1.khype)} kHYPE more`);

console.log("6. what is left waiting after all of that");
const left = [
  ["fee inbox", INBOX], ["80/20 splitter", SPLIT],
].map(([n, a]) => `${n}: ${f(bal(T.WHYPE, a))} HYPE, ${f(bal(T.USDC, a), 6)} USDC, ${f(bal(T.KNTQ, a))} KNTQ, ${f(bal(LIQUID, a))} $liquid`);
for (const l of left) console.log(`       ${l}`);
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
