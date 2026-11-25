// The wNVDAx-USDC vault and the bot's real jobs, on a LOCAL anvil fork of Elysium (never a real network).
// The second vault on a pair without HYPE, the only liquidity in its pool, and the first whose pool has the stock
// token FIRST and the dollar second (the wANTx pool is the other way round):
//   - the bot weighs the fees waiting against the network fee correctly (the fee is paid in HYPE, the pool has
//     none; the HYPE-USDC pool prices it in this vault's second token)
//   - it compounds when that is worth it; exactly 20% of the fees go to the vault fee splitter, in both tokens
//   - the splitter pays a fifth of each to the creator's wallet and the rest to the vault fee inbox
//   - after a price run the bot does NOT move the range while the pool disagrees with Hyperliquid's NVDAX/USDC
//     market, and does once they agree
// Needs the vault on the fork: either a fork taken after the real launch, or
//   anvil --fork-url https://rpc.elysium.kinetiq.xyz --port 8611
//   python3 script/nvda-vault-data.py --verify --no-deposit     (from the project folder; launches it on the fork)
// then, from keeper/:   npx tsx hosted/test-nvda-fork.ts [port]
import { Wallet, utils } from "ethers";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runKeeper, CONFIG } from "./core.js";
import { runShare, SHARE_CONFIG } from "./share.js";

const RPC = `http://127.0.0.1:${process.argv[2] ?? "8611"}`;
const D = JSON.parse(readFileSync(`${process.cwd()}/../site/tools/nvda-vault-data.json`, "utf8"));
const VAULT = D.elysium.vault, WNVDAX = D.elysium.wnvdax, USDC = D.elysium.usdc, PM = D.elysium.poolManager, WNVDAX_L1 = D.hyperevm.wnvdax;
const SPLIT = D.feeTo, INBOX = D.feeInbox, CREATOR = D.creator, OWNER = D.owner, Z = "0x0000000000000000000000000000000000000000";
const KEYT = `(${WNVDAX},${USDC},3000,60,${Z})`, WHYPE = "0xbA876237B0F021A6c6D852d6c26E107997cC5E81";
const L2_GATEWAY = "0x5DC84e4Cb0F9082246E92a5585C5395592B1aF1f";
const GATEWAY_ALIAS = "0xEa8c30de0Ba0C2eAeE942afcE77530e06c5F233d"; // the HyperEVM token gateway, as Elysium sees it
const NAME = "wNVDAx-USDC";
// anvil's public test accounts stand in for the bot and for a trader who is also the depositor
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", BOT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const TKEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", TRADER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

const sh = (c: string) => execSync(`export PATH="$HOME/.foundry/bin:$PATH"; export ETH_RPC_TIMEOUT=180; cd ${process.cwd()}/..; ${c}`, { encoding: "utf8", shell: "/bin/bash", stdio: ["ignore", "pipe", "pipe"] }).trim();
const cast = (c: string) => sh(`cast ${c} --rpc-url ${RPC}`);
const send = (c: string, key = TKEY) => JSON.parse(sh(`cast send ${c} --private-key ${key} --rpc-url ${RPC} --json`));
const as = (who: string, c: string) => JSON.parse(sh(`cast send ${c} --from ${who} --unlocked --rpc-url ${RPC} --json`));
const first = (s: string) => s.split("\n").map((l) => l.trim().split(" ")[0]);
const big = (s: string) => BigInt(first(s)[0]);
const bal = (token: string, who: string) => big(cast(`call ${token} "balanceOf(address)(uint256)" ${who}`));
const mine = (secs: number, blocks: number) => { for (let i = 0; i < blocks; i++) { cast(`rpc evm_increaseTime ${Math.round(secs / blocks)}`); cast("rpc evm_mine"); } };
const f = (v: bigint, dec = 18) => utils.formatUnits(v.toString(), dec);
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failed++; };

if (cast("chain-id") !== "99901") { console.log("That port is not a fork of Elysium."); process.exit(1); }
if (cast(`code ${VAULT}`) === "0x") { console.log("The vault is not on this fork. See the top of this file for how to put it there."); process.exit(1); }

// The fork reports a higher network fee than Elysium really has (0.5 gwei); the bot's jobs are told the real figure.
// `nvda` (dollars) replaces Hyperliquid's NVDAX price when a step needs the outside market to say something else.
let nvda: number | null = null;
const world: typeof fetch = async (url: any, init?: any) => {
  const body = init?.body ? JSON.parse(init.body) : {};
  if (String(url) === RPC && body.method === "eth_gasPrice") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1dcd6500" }));
  if (String(url) === CONFIG.hyperliquid && body.type === "allMids" && nvda !== null) {
    const mids = await (await fetch(url, init)).json();
    return new Response(JSON.stringify({ ...mids, [D.hyperliquid.coin]: String(nvda) }));
  }
  return fetch(url, init);
};
const deps = { ethers: { Wallet, utils }, fetch: world, env: (k: string) => ({ KEEPER_PRIVATE_KEY: KEY } as Record<string, string>)[k] };
let lastRun: Awaited<ReturnType<typeof runKeeper>>;
const bot = async (over: Partial<typeof CONFIG> = {}) => {
  lastRun = await runKeeper(deps, { ...CONFIG, rpc: RPC, rpcGapMs: 0, ...over });
  const row = lastRun.vaults.find((x) => x.name === NAME)!;
  console.log(`       ${NAME}: ${row ? `${row.action}, ${row.reason}` : "not in the bot's list"}`);
  return row;
};
const state = () => {
  const [t0, t1] = first(cast(`call ${VAULT} "balances()(uint256,uint256)"`)).map(BigInt);
  const m = first(cast(`call ${VAULT} "main()(int24,int24,uint128)"`));
  const [sqrtP, tick] = first(cast(`call ${VAULT} "price()(uint160,int24)"`));
  return { t0, t1, lo: +m[0], hi: +m[1], liq: BigInt(m[2]), tick: +tick, dollars: (Number(BigInt(sqrtP)) / 2 ** 96) ** 2 * 1e12 };
};
const mids = async () => (await (await fetch(CONFIG.hyperliquid, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "allMids" }) })).json()) as Record<string, string>;
const hlMid = async () => Number((await mids())[D.hyperliquid.coin]);
const hypeDollars = async () => Number((await mids())["@107"]);

// ---------- setup (fork only)
for (const a of [BOT, TRADER]) { cast(`rpc anvil_setCode ${a} 0x`); cast(`rpc anvil_setBalance ${a} 0x56BC75E2D63100000`); }
cast("rpc anvil_autoImpersonateAccount true");
for (const a of [OWNER, GATEWAY_ALIAS, PM]) cast(`rpc anvil_setBalance ${a} 0x56BC75E2D63100000`);
mine(3700, 2); // past the bot's one-hour gap between compoundings, in case this fork has been used before
as(OWNER, `${VAULT} "setKeeper(address)" ${BOT}`); // on the fork, the test's bot wallet is the keeper
// wNVDAx arrives for the trader the way the bridge brings it; USDC comes from the pool manager's holdings
const info = sh(`cast abi-encode "f(bytes,bytes,bytes)" $(cast abi-encode "f(string)" "Wrapped NVIDIA xStock") $(cast abi-encode "f(string)" wNVDAx) $(cast abi-encode "f(uint8)" 18)`);
if (bal(WNVDAX, TRADER) < 200n * 10n ** 18n) as(GATEWAY_ALIAS, `${L2_GATEWAY} "finalizeInboundTransfer(address,address,address,uint256,bytes)" ${WNVDAX_L1} ${TRADER} ${TRADER} 400000000000000000000 $(cast abi-encode "f(bytes,bytes)" ${info} 0x)`);
if (bal(USDC, TRADER) < 60_000n * 10n ** 6n) as(PM, `${USDC} "transfer(address,uint256)" ${TRADER} 80000000000`);
const dep = (path: string, args: string) => /Deployed to: (0x[0-9a-fA-F]{40})/.exec(sh(`forge create ${path} --private-key ${TKEY} --rpc-url ${RPC} --broadcast --constructor-args ${args} 2>&1`))![1];
const SWAP = dep("src/adapters/UniswapV4Swapper.sol:UniswapV4Swapper", `${TRADER} ${PM} ${WHYPE}`);
const PUSH = dep("test/mocks/PoolPusher.sol:PoolPusher", PM);
const ROUTE = "setRoute(address,address,(uint8,(address,address,uint24,int24,address),bool,address)[])";
send(`${SWAP} "${ROUTE}" ${USDC} ${WNVDAX} "[(0,${KEYT},false,${Z})]"`); // USDC is the pool's second token
send(`${SWAP} "${ROUTE}" ${WNVDAX} ${USDC} "[(0,${KEYT},true,${Z})]"`);
for (const t of [USDC, WNVDAX]) for (const who of [SWAP, PUSH, VAULT]) send(`${t} "approve(address,uint256)" ${who} $(cast max-uint)`);
const swap = (a: string, b: string, amt: bigint) => send(`${SWAP} "swap(address,address,uint256,uint256,address)" ${a} ${b} ${amt} 0 ${TRADER}`);
const round = (usdc: bigint) => { const before = bal(WNVDAX, TRADER); swap(USDC, WNVDAX, usdc); swap(WNVDAX, USDC, bal(WNVDAX, TRADER) - before); };

console.log("1. the bot's list, with its real settings");
let row = await bot();
check("the wNVDAx-USDC vault is in the bot's list", !!row);
for (const other of lastRun!.vaults.filter((x) => x.name !== NAME)) console.log(`       ${other.name}: ${other.action}, ${other.reason}`);
check("no vault in the list reports an error", lastRun!.ok && lastRun!.vaults.every((x) => !/^error|did not answer/.test(x.reason)));
const supply0 = big(cast(`call ${VAULT} "totalSupply()(uint256)"`));
if (supply0 === 0n) check("an empty vault is left alone", row.action === "none" && /no deposits yet/.test(row.reason), row.reason);

console.log("2. a deposit of both tokens; no fees yet");
let s = state();
console.log(`       the pool is at $${s.dollars.toFixed(2)} per wNVDAx; Hyperliquid says $${(await hlMid()).toFixed(2)}`);
const usdcIn = BigInt(Math.round(20 * s.dollars * 1e6));
if (supply0 === 0n) send(`${VAULT} "deposit(uint256,uint256,uint256,address)" 1 20000000000000000000 ${usdcIn} ${TRADER}`);
else { // someone deposited already (the launch rehearsal does): join pro-rata
  const [want, need0, need1] = first(cast(`call ${VAULT} "previewDeposit(uint256,uint256)(uint256,uint256,uint256)" 20000000000000000000 ${usdcIn}`)).map(BigInt);
  send(`${VAULT} "deposit(uint256,uint256,uint256,address)" ${want} ${(need0 * 1005n) / 1000n} ${(need1 * 1005n) / 1000n} ${TRADER}`);
}
s = state();
check("the vault holds both tokens and its main range earns", s.t0 > 0n && s.t1 > 0n && s.liq > 0n && s.tick >= s.lo && s.tick < s.hi, `${f(s.t0)} wNVDAx, ${f(s.t1, 6)} USDC`);
row = await bot();
check("in range, nothing to compound", row.action === "none" && /no fees waiting/.test(row.reason), row.reason);

console.log("3. a little trading: the fees are weighed against the network fee, which is paid in HYPE");
round(4_000000n); // $4 each way: about 2.4 cents of fees
const [f0, f1] = first(cast(`call ${VAULT} "pendingFees()(uint256,uint256)"`)).map(BigInt);
const feesUsd = (Number(f0) / 1e18) * state().dollars + Number(f1) / 1e6;
const gasUnits = Number(BigInt(cast(`estimate ${VAULT} "harvest()" --from ${BOT}`)));
const costUsd = ((gasUnits * 0.5e9) / 1e18) * (await hypeDollars());
const expected = (feesUsd * 0.8) / costUsd;
row = await bot();
const said = Number(/are (\d+) times the network fee/.exec(row.reason)?.[1] ?? NaN);
console.log(`       fees waiting $${feesUsd.toFixed(4)}; collecting them costs about $${costUsd.toFixed(4)} (${gasUnits.toLocaleString()} gas at 0.5 gwei); depositors' share is ${expected.toFixed(1)} times that`);
check("the bot's figure matches a sum done by hand", row.action === "none" && Math.abs(said - expected) <= Math.max(1, expected * 0.15), `bot says ${said}, worked out by hand ${expected.toFixed(1)}`);
check("so it waits for 10 times", /compounding at 10 times/.test(row.reason) && said < 10);

console.log("4. more trading: the bot compounds, and 20% of the fees leave for the fee splitter");
for (let i = 0; i < 4; i++) round(1500_000000n);
const [g0, g1] = first(cast(`call ${VAULT} "pendingFees()(uint256,uint256)"`)).map(BigInt);
const at0 = bal(WNVDAX, SPLIT), at1 = bal(USDC, SPLIT);
row = await bot();
check("the bot compounds the fees", row.action === "harvest" && row.confirmed === true, row.reason);
const cut0 = bal(WNVDAX, SPLIT) - at0, cut1 = bal(USDC, SPLIT) - at1;
const near = (a: bigint, b: bigint) => (a > b ? a - b : b - a) <= 2n;
check("exactly 20% of the wNVDAx fees went to the vault fee splitter", near(cut0, (g0 * 2000n) / 10000n), `${f(cut0)} of ${f(g0)} wNVDAx`);
check("and exactly 20% of the USDC fees", near(cut1, (g1 * 2000n) / 10000n), `${f(cut1, 6)} of ${f(g1, 6)} USDC`);

console.log("5. the fee-sharing job pays the splitter out: a fifth to the creator's wallet, the rest to the vault fee inbox");
const b4 = { c0: bal(WNVDAX, CREATOR), c1: bal(USDC, CREATOR), i0: bal(WNVDAX, INBOX), i1: bal(USDC, INBOX), s0: bal(WNVDAX, SPLIT), s1: bal(USDC, SPLIT) };
const share = await runShare(deps, { ...SHARE_CONFIG, rpc: RPC, rpcGapMs: 0 });
for (const a of share.actions) console.log(`       ${a.what}${a.confirmed ? " [ok]" : ""}`);
check("creator's wallet: 20% of the wNVDAx cut", bal(WNVDAX, CREATOR) - b4.c0 === (b4.s0 * 2000n) / 10000n && b4.s0 > 0n, `${f(bal(WNVDAX, CREATOR) - b4.c0)} wNVDAx`);
check("creator's wallet: 20% of the USDC cut", bal(USDC, CREATOR) - b4.c1 === (b4.s1 * 2000n) / 10000n && b4.s1 > 0n, `${f(bal(USDC, CREATOR) - b4.c1, 6)} USDC`);
check("vault fee inbox: the other 80% of the wNVDAx, where it waits", bal(WNVDAX, INBOX) - b4.i0 === b4.s0 - (b4.s0 * 2000n) / 10000n, `${f(bal(WNVDAX, INBOX) - b4.i0)} wNVDAx`);
check("vault fee inbox: the other 80% of the USDC", bal(USDC, INBOX) - b4.i1 === b4.s1 - (b4.s1 * 2000n) / 10000n, `${f(bal(USDC, INBOX) - b4.i1, 6)} USDC`);
check("nothing left at the splitter", bal(USDC, SPLIT) === 0n && bal(WNVDAX, SPLIT) === 0n);

console.log("6. buyers take the price out of the vault's range; the pool now disagrees with the outside market");
s = state();
send(`${PUSH} "push((address,address,uint24,int24,address),bool,uint256,int24)" "${KEYT}" false 50000000000 ${s.hi + 120}`);
mine(11 * 60, 22); // eleven minutes pass, the price stays where it is
s = state();
check("out of range", s.tick >= s.hi, `pool at $${s.dollars.toFixed(2)}, vault holds ${f(s.t0)} wNVDAx and ${f(s.t1, 6)} USDC`);
row = await bot();
check("the bot does not move the range: Hyperliquid disagrees with the pool", row.action === "skip" && /not moving: pool price is [\d.]+% away from Hyperliquid/.test(row.reason), row.reason);

console.log("7. once the outside market agrees with the pool, the bot moves the range");
nvda = s.dollars * 0.99;
const tickBefore = s.tick;
row = await bot();
check("the bot moves the range", row.action === "rebalance" && row.confirmed === true, row.reason);
s = state();
check("the new range is around the price, and moving it did not move the price", s.lo <= s.tick && s.tick < s.hi && s.tick === tickBefore, `range ${s.lo}..${s.hi}, tick ${s.tick}`);
nvda = null;

console.log("8. leaving still works");
const sharesNow = bal(VAULT, TRADER), u0 = bal(USDC, TRADER), w0 = bal(WNVDAX, TRADER);
send(`${VAULT} "withdraw(uint256,uint256,uint256,address,bool)" ${sharesNow} 0 0 ${TRADER} false`);
check("the depositor withdraws everything", bal(VAULT, TRADER) === 0n && bal(USDC, TRADER) + bal(WNVDAX, TRADER) > u0 + w0, `${f(bal(WNVDAX, TRADER) - w0)} wNVDAx and ${f(bal(USDC, TRADER) - u0, 6)} USDC`);
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
