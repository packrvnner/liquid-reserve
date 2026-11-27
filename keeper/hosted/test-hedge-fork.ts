// A whole pilot of the hedged vault with the bot's real job, on a LOCAL copy of HyperEVM (never a real network):
//   the launch, a deposit, the bot putting it to work, the price moving, the margin thinning, the price leaving
//   the range, a pushed pool, a withdrawal that is partly owed, fees collected and bridged, Hyperliquid refusing
//   orders, the bot without the keeper role, without a key, switched off, and a wind-down.
// Hyperliquid itself is a stand-in (test/hedged/CoreSim.sol); the pool, USDC, WHYPE and the bridge are the real ones.
// The owner narrows the range to about 4% either side for this rehearsal, so that the price can leave it without
// a deep pool having to be traded 20% away on a copy that fetches every tick from the real network.
//
//   python3 script/hedged-vault-data.py rehearse      (from the repository; leave it running)
//   npx tsx hosted/test-hedge-fork.ts                 (from keeper/)
import { Wallet, utils } from "ethers";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runHedge, HEDGE_CONFIG, type HedgeState, type HedgeReport } from "./hedge.js";

const D = JSON.parse(readFileSync(new URL("../../site/tools/hedged-vault-data.local.json", import.meta.url), "utf8"));
const RPC: string = D.chains["999"].rpc;
if (!/^http:\/\/127\.0\.0\.1/.test(RPC)) throw new Error("this test only runs against a local copy");
const { vault: VAULT, lens: LENS, forwarder: FWD, sim: SIM, pool: POOL, usdc: USDC, whype: WHYPE, owner: OWNER } = D;
const GATEWAY = "0xd97B30dE0bA0C2eAeE942afce77530e06c5F122c"; // the bridge's escrow: this copy's source of test USDC
// anvil's public test accounts: a depositor, the bot, a trader
const USER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", UKEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const BOT = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", BKEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const TRADER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906", TKEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";

// The copy fetches every piece of state it has not seen yet from the real network, and the public RPC drops a
// request now and then. Such a failure comes before anything is sent, so the command is simply tried again.
const DROPPED = /MPP HTTP request|error sending request|Connection reset|timed out|failed to get (account|storage)/i;
const sh = (c: string): string => {
  for (let i = 0; ; i++) {
    try {
      return execSync(`export PATH="$HOME/.foundry/bin:$PATH" ETH_RPC_TIMEOUT=900; cd ${process.cwd()}/..; ${c}`, { encoding: "utf8", shell: "/bin/bash", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch (e: any) {
      if (i >= 7 || !DROPPED.test(`${e?.stdout ?? ""}${e?.stderr ?? ""}`)) throw e;
      execSync("sleep 10");
    }
  }
};
const cast = (c: string) => sh(`cast ${c} --rpc-url ${RPC}`);
const send = (c: string, key = UKEY) => sh(`cast send ${c} --private-key ${key} --rpc-url ${RPC} --json`);
const as = (who: string, c: string) => sh(`cast send ${c} --from ${who} --unlocked --rpc-url ${RPC} --json`);
const tries = (f: () => unknown) => { try { f(); return true; } catch { return false; } };
const num = (s: string) => BigInt(s.split("\n")[0].trim().split(" ")[0]);
const bal = (token: string, who: string) => num(cast(`call ${token} "balanceOf(address)(uint256)" ${who}`));
const mine = (n = 1) => { for (let i = 0; i < n; i++) cast("rpc evm_mine"); };
const warp = (s: number) => { cast(`rpc evm_increaseTime ${s}`); cast("rpc evm_mine"); };
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failed++; };

const LENS_I = new utils.Interface(["function state(address) view returns (tuple(uint256 totalValue, uint256 totalSupply, uint256 oraclePx, uint160 poolSqrtPriceX96, int24 poolTick, int24 lower, int24 upper, uint256 positionAsset, uint256 positionUsdc, uint256 idleAsset, uint256 idleUsdc, int256 perpValue, uint256 spotUsdc, int256 shortSz, uint256 targetSz, uint256 marginBpsNow, uint256 owedTotal, bool priceInLine))"]);
const st = () => {
  const s = LENS_I.decodeFunctionResult("state", cast(`call ${LENS} ${LENS_I.encodeFunctionData("state", [VAULT])}`))[0];
  const b = (k: string) => BigInt(s[k].toString());
  return { value: b("totalValue"), supply: b("totalSupply"), px: b("oraclePx"), sqrtP: b("poolSqrtPriceX96"), tick: Number(s.poolTick), lower: Number(s.lower), upper: Number(s.upper),
    posHype: b("positionAsset"), posUsdc: b("positionUsdc"), idleHype: b("idleAsset"), idleUsdc: b("idleUsdc"), perp: b("perpValue"), short: -b("shortSz"), target: b("targetSz"), margin: b("marginBpsNow"), owed: b("owedTotal") };
};
const poolRaw = () => { const p = st().sqrtP; return (p * p * 10n ** 16n) >> 192n; };
const usd = (v: bigint) => (Number(v) / 1e6).toFixed(2);

// The stand-in's blocks: carry out what was sent. (The rehearse script does this once a second too.)
const core = () => { tries(() => sh(`cast send ${SIM} "step()" --private-key ${TKEY} --rpc-url ${RPC}`)); mine(6); };

// ---------- the bot
const env: Record<string, string> = { KEEPER_PRIVATE_KEY: BKEY };
// Elysium is not part of the copy: the job is told its usual gas price (0.5 gwei) instead of asking it.
const fetchLocal: typeof fetch = async (url: any, init?: any) => {
  if (String(url) !== RPC && init?.body && JSON.parse(init.body).method === "eth_gasPrice") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1dcd6500" }));
  for (let i = 0; ; i++) {
    const text = await (await fetch(url, init)).text();
    // a read the copy could not fetch from the real network is asked again; nothing is sent twice (a send that
    // reached the copy answers with a hash, not with this error)
    if (i < 7 && DROPPED.test(text) && /"error"/.test(text)) { await new Promise((r) => setTimeout(r, 10_000)); continue; }
    return new Response(text, { headers: { "content-type": "application/json" } });
  }
};
const cfg = { ...HEDGE_CONFIG, rpc: RPC, rpcGapMs: 0, vault: VAULT, lens: LENS, forwarder: FWD };
let state: HedgeState | null = null;
async function bot(overrides: Record<string, string | undefined> = {}, c = cfg): Promise<HedgeReport> {
  const e = { ...env, ...overrides };
  const out = await runHedge({ ethers: { Wallet, utils }, fetch: fetchLocal, env: (k) => e[k], sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))) }, state, c);
  state = out.state;
  return out.report;
}
const did = (r: HedgeReport, re: RegExp) => r.actions.some((a) => re.test(a.what) && a.confirmed === true);
const noted = (r: HedgeReport, re: RegExp, note: RegExp) => r.actions.some((a) => re.test(a.what) && note.test(a.note ?? ""));
/** Bot runs with the stand-in's blocks in between, until the bot has nothing more to send. */
async function settle(max = 8): Promise<HedgeReport> {
  let r = await bot();
  for (let i = 0; i < max && r.actions.some((a) => a.confirmed); i++) { core(); r = await bot(); }
  core();
  return r;
}
const hedged = () => {
  const s = st(), diff = s.short > s.target ? s.short - s.target : s.target - s.short;
  return diff * s.px <= ((s.posUsdc + (s.posHype * s.px) / 10n ** 16n) * 500n) / 10_000n + 11_000_000n + s.px;
};

// ---------- the pool's other traders
let WHALE = "";
/** Someone trades the pool to `factor` times its price, 3% at a time; `follow` moves Hyperliquid's price with it. */
function move(factor: number, follow = true) {
  const target = (st().sqrtP * BigInt(Math.round(Math.sqrt(factor) * 1e9))) / 10n ** 9n;
  for (let i = 0; i < 40; i++) {
    const p = st().sqrtP;
    if (p === target) break;
    const next = (p * (target > p ? 1015n : 985n)) / 1000n;
    send(`${WHALE} "moveTo(uint160)" ${(target > p ? next >= target : next <= target) ? target : next}`, TKEY);
  }
  if (follow) as(OWNER, `${SIM} "setPx(uint256)" ${poolRaw()}`);
}

async function main() {
  console.log("setup (local copy only)");
  for (const a of [BOT, TRADER, OWNER, GATEWAY]) { if (a === BOT || a === TRADER) cast(`rpc anvil_setCode ${a} 0x`); cast(`rpc anvil_setBalance ${a} 0x56BC75E2D63100000`); }
  for (const a of [OWNER, GATEWAY]) cast(`rpc anvil_impersonateAccount ${a}`);

  // 0. before the launch
  let r = await bot({ KEEPER_PRIVATE_KEY: undefined });
  const launched = cast(`code ${VAULT}`) !== "0x";
  if (!launched) check("before the launch the job says so and does nothing", r.status === "not-deployed" && r.actions.length === 0, r.reason);

  // 1. the launch: the page's seven transactions, as they are
  if (!launched) for (const s of D.steps) sh(`cast send ${s.to} ${s.data} --private-key ${UKEY} --rpc-url ${RPC} --gas-limit 1990000 > /dev/null`);
  check("the seven launch transactions create the vault", cast(`code ${VAULT}`) !== "0x" && cast(`code ${LENS}`) !== "0x" && cast(`code ${FWD}`) !== "0x");
  r = await bot({ KEEPER_PRIVATE_KEY: undefined });
  check("with no key the job only watches an empty vault", r.mode === "watch-only" && r.status === "idle" && /empty/.test(r.reason), r.reason);

  // the pilot's setup: on the real network the keeper is the bot's own wallet from the start; here a test wallet takes its place
  as(OWNER, `${VAULT} "setKeeper(address)" ${BOT}`);
  as(OWNER, `${VAULT} "setDepositCap(uint256)" 20000000000`);
  as(OWNER, `${VAULT} "setSettings(uint16,uint16,int24)" 500 4000 40`);
  const out = sh(`forge create test/fork/HedgedVault.t.sol:Whale --private-key ${TKEY} --rpc-url ${RPC} --broadcast --constructor-args ${POOL} 2>&1`);
  WHALE = /Deployed to: (0x[0-9a-fA-F]{40})/.exec(out)![1];
  // the trader's money: 30,000,000 USDC written straight into the copy's storage (this pool is deep), and wrapped HYPE
  for (let slot = 0; slot < 16 && bal(USDC, WHALE) === 0n; slot++) {
    const at = sh(`cast index address ${WHALE} ${slot}`), was = cast(`storage ${USDC} ${at}`);
    cast(`rpc anvil_setStorageAt ${USDC} ${at} 0x${(30_000_000n * 10n ** 6n).toString(16).padStart(64, "0")}`);
    if (bal(USDC, WHALE) === 0n) cast(`rpc anvil_setStorageAt ${USDC} ${at} ${was}`);
  }
  if (bal(USDC, WHALE) !== 30_000_000n * 10n ** 6n) throw new Error("could not give the trader USDC on the copy");
  cast(`rpc anvil_setBalance ${TRADER} 0x${(70_000n * 10n ** 18n).toString(16)}`);
  send(`${WHYPE} "deposit()" --value 60000ether`, TKEY);
  send(`${WHYPE} "transfer(address,uint256)" ${WHALE} 60000000000000000000000`, TKEY);
  as(OWNER, `${SIM} "setPx(uint256)" ${poolRaw()}`);
  send(`${USDC} "approve(address,uint256)" ${VAULT} $(cast max-uint)`);

  // 2. a deposit, and the bot puts it to work
  console.log("a deposit");
  send(`${VAULT} "deposit(uint256,uint256,address)" 4000000000 0 ${USER}`);
  r = await bot({ KEEPER_PRIVATE_KEY: undefined });
  check("with no key the job says what it would do", r.mode === "watch-only" && noted(r, /idle money to work/, /no keeper wallet/), r.actions.map((a) => a.what).join(" | "));
  r = await bot({ HEDGE_DRY_RUN: "1" });
  check("in a dry run it decides and sends nothing", r.mode === "dry-run" && noted(r, /idle money to work/, /dry run/) && st().posUsdc === 0n);
  r = await bot({ HEDGE_PAUSED: "1" });
  check("its switch stops it", r.status === "paused" && r.actions.length === 0);
  r = await bot();
  check("the bot puts the deposit to work", did(r, /idle money to work/), r.actions.map((a) => `${a.what}: ${a.note ?? a.confirmed}`).join(" | "));
  core();
  r = await settle();
  let s = st();
  check("short equals the HYPE held", s.target > 0n && hedged(), `short ${s.short}, target ${s.target} (0.01 HYPE)`);
  check("margin about 40% of the short", s.margin > 3_700n && s.margin < 4_300n, `${Number(s.margin) / 100}%`);
  check("value within half a percent of the deposit", s.value > 3_980_000_000n && s.value < 4_001_000_000n, usd(s.value));
  check("then the bot has nothing to do", r.status === "idle" && /nothing to do/.test(r.reason) && r.warnings.length === 0, `${r.reason} ${r.warnings.join("; ")}`);
  const start = s.value;

  // 3. the price moves; the bot keeps the short in place
  console.log("the price moves");
  let tended = 0;
  for (let i = 0; i < 2; i++) { move(1.01); r = await settle(); if (r.status !== "idle") tended++; }
  s = st();
  check("after +2% in two steps the short is within its band", hedged(), `short ${s.short}, target ${s.target}`);
  check("value did not follow the price", s.value > (start * 990n) / 1000n && s.value < (start * 1005n) / 1000n, `${usd(start)} -> ${usd(s.value)}`);

  // 4. the margin thins (here: the short is charged funding worth 18% of its size): the bot tops it up
  console.log("thin margin");
  as(OWNER, `${SIM} ${new utils.Interface(["function payFunding(address,int256)"]).encodeFunctionData("payFunding", [VAULT, "-18000000"])}`);
  mine(2);
  s = st();
  const thin = s.margin;
  r = await bot();
  check("with the margin under its lower line the bot tops it up", thin < 2_500n && did(r, /top the margin up/), `${Number(thin) / 100}%: ${r.actions.map((a) => a.what).join(" | ")}`);
  core();
  check("the HYPE that came out with the top-up waits in the vault", st().idleHype > 0n);
  r = await settle();
  s = st();
  check("margin back between its lines, the idle HYPE at work again, short in place", s.margin >= 2_500n && hedged() && (s.idleHype * s.px) / 10n ** 16n < 25_000_000n, `was ${Number(thin) / 100}%, now ${Number(s.margin) / 100}%`);
  check("no liquidation on the stand-in", num(cast(`call ${SIM} "liquidations()(uint256)"`)) === 0n);

  // 5. the price leaves the range: the bot waits, then moves the range
  console.log("out of the range");
  while (st().tick < st().upper) move(1.01);
  r = await settle();
  s = st();
  check("outside the range the bot waits before moving it", s.tick >= s.upper && !r.actions.some((a) => /move the range/.test(a.what)) && /outside the range/.test(r.reason), r.reason);
  const lowerBefore = s.lower;
  warp(11 * 60);
  as(OWNER, `${SIM} "setPx(uint256)" ${poolRaw()}`);
  r = await bot();
  for (let i = 0; i < 3 && !did(r, /move the range/); i++) { core(); r = await bot(); } // a tend may come first
  check("ten minutes later it moves the range", did(r, /move the range/), r.actions.map((a) => `${a.what}: ${a.note ?? a.confirmed}`).join(" | "));
  core();
  r = await settle();
  s = st();
  check("the range is around the price again and the short matches", s.lower > lowerBefore && s.tick >= s.lower && s.tick < s.upper && hedged(), `short ${s.short}, target ${s.target}`);
  check("value held through the move, but for what the funding charge took", s.value > (start * 940n) / 1000n, `${usd(start)} -> ${usd(s.value)}`);

  // 6. a pushed pool: nothing that swaps is sent until pool and Hyperliquid agree
  console.log("a pushed pool");
  send(`${VAULT} "deposit(uint256,uint256,address)" 1000000000 0 ${USER}`);
  move(1.006, false); // the pool 0.6% up, Hyperliquid's price where it was
  r = await bot();
  check("with the pool 0.6% off the bot holds the deposit back", noted(r, /idle money to work/, /from Hyperliquid's price/) && r.warnings.some((w) => /nothing that swaps/.test(w)), r.warnings.join("; "));
  move(1 / 1.006, false);
  as(OWNER, `${SIM} "setPx(uint256)" ${poolRaw()}`);
  r = await bot();
  check("once they agree it puts the deposit to work", did(r, /idle money to work/));
  core();
  await settle();

  // 7. a withdrawal that is partly owed
  console.log("a withdrawal");
  const shares = bal(VAULT, USER), before = bal(USDC, USER);
  send(`${VAULT} "withdraw(uint256,uint256,address)" ${shares / 2n} 0 ${USER}`);
  const owed = num(cast(`call ${VAULT} "owed(address)(uint256)" ${USER}`));
  check("half taken out: part paid at once, part owed", bal(USDC, USER) > before && owed > 0n, `paid ${usd(bal(USDC, USER) - before)}, owed ${usd(owed)}`);
  core();
  r = await settle();
  check("the bot brings the owed USDC back", bal(USDC, VAULT) >= owed);
  send(`${VAULT} "claim(address)" ${USER}`);
  check("and it is claimed in full", num(cast(`call ${VAULT} "owed(address)(uint256)" ${USER}`)) === 0n && hedged());

  // 8. fees: collected once a day, the vault's fee bridged to the splitter on Elysium
  console.log("fees");
  for (let i = 0; i < 6; i++) move(i % 2 ? 1 / 1.012 : 1.012);
  as(OWNER, `${SIM} "setPx(uint256)" ${poolRaw()}`);
  warp(86_400 + 60);
  as(OWNER, `${SIM} "setPx(uint256)" ${poolRaw()}`);
  const escrow = bal(USDC, GATEWAY);
  let harvested = false;
  for (let i = 0; i < 6 && !harvested; i++) { r = await bot(); harvested = did(r, /trading fees/); core(); }
  check("after a day the bot collects the trading fees", harvested, r.actions.map((a) => a.what).join(" | "));
  check("the vault's fee is at the forwarder", bal(USDC, FWD) > 0n && bal(WHYPE, FWD) > 0n, `${usd(bal(USDC, FWD))} USDC, ${Number(bal(WHYPE, FWD)) / 1e18} HYPE`);
  r = await bot({}, { ...cfg, minForwardUsdc: "0.01" });
  check("the bot bridges both fee tokens to the splitter on Elysium", r.actions.filter((a) => /fee splitter on Elysium/.test(a.what) && a.confirmed).length === 2 && bal(USDC, FWD) === 0n && bal(WHYPE, FWD) === 0n && bal(USDC, GATEWAY) > escrow,
    r.actions.map((a) => `${a.what}: ${a.note ?? a.confirmed}`).join(" | "));
  core();
  await settle();

  // 9. Hyperliquid refuses orders: the bot keeps trying and says so
  console.log("Hyperliquid refuses orders");
  as(OWNER, `${SIM} "setRejectOrders(bool)" true`);
  move(0.975);
  for (let i = 0; i < 3; i++) { r = await bot(); core(); }
  warp(6 * 60);
  as(OWNER, `${SIM} "setPx(uint256)" ${poolRaw()}`);
  r = await bot();
  check("the bot warns that the short stays off its target", r.warnings.some((w) => /off its target/.test(w)), r.warnings.join("; "));
  as(OWNER, `${SIM} "setRejectOrders(bool)" false`);
  core();
  r = await settle();
  check("once orders go through again the short is back in place", hedged());

  // 10. the bot without the keeper role
  console.log("not the keeper");
  as(OWNER, `${VAULT} "setKeeper(address)" ${TRADER}`);
  send(`${VAULT} "deposit(uint256,uint256,address)" 500000000 0 ${USER}`);
  r = await bot();
  check("without the keeper role the bot cannot put money to work, and says so", noted(r, /idle money to work/, /only the vault's keeper/) && r.warnings.some((w) => /not the bot/.test(w)));
  as(OWNER, `${VAULT} "setKeeper(address)" ${BOT}`);
  await settle();

  // 11. the wind-down
  console.log("the wind-down");
  const worth = st().value;
  as(OWNER, `${VAULT} "windDown()"`);
  for (let i = 0; i < 14; i++) { r = await bot(); core(); if (r.status === "idle" && st().short === 0n && st().idleHype < 10n ** 15n) break; }
  s = st();
  check("the bot takes the position out, sells the HYPE, closes the short and brings the margin home",
    s.posHype + s.posUsdc === 0n && s.short === 0n && s.idleHype < 10n ** 15n && s.perp < 2_000_000n, `idle ${usd(s.idleUsdc)} USDC, perp ${usd(s.perp)}, short ${s.short}`);
  check("everything is USDC in the vault, within 1% of what it was worth", s.idleUsdc > (worth * 990n) / 1000n, `${usd(worth)} -> ${usd(s.idleUsdc)}`);
  const left = bal(VAULT, USER), had = bal(USDC, USER);
  send(`${VAULT} "withdraw(uint256,uint256,address)" ${left} 0 ${USER}`);
  check("the depositor takes everything out, paid at once", num(cast(`call ${VAULT} "owed(address)(uint256)" ${USER}`)) === 0n && bal(USDC, USER) - had > (worth * 985n) / 1000n, usd(bal(USDC, USER) - had));
  check("the stand-in refused no transfer and liquidated nothing", num(cast(`call ${SIM} "transfersRejected()(uint256)"`)) === 0n && num(cast(`call ${SIM} "liquidations()(uint256)"`)) === 0n);

  console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
