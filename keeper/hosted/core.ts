// Hosted vault keeper: one pass over the Liquid Reserve vaults on Elysium.
//
// It does two things, and nothing else:
//   - harvest(): collect and compound trading fees (anyone may call this). It
//     does so when the fees waiting are worth many times the network fee of
//     compounding them, and holds off while the network fee is unusually high.
//   - rebalance(): re-center a vault's ranges on the current price (only the
//     vault's keeper address may call this). It does so in two situations:
//       a. the price has left the main range, or
//       b. the main range is nearly empty although the vault holds both tokens
//          (or holds one token but swaps by itself: LiquidityVaultV2).
//          After (a) a first-version vault holds one token only, parked in a
//          one-sided range next to the price. Once the price has traded into that
//          range it holds both tokens again, and re-centering rebuilds the main
//          range. A version-2 vault swaps its surplus as it re-centers, so (a)
//          alone puts it back to work.
//
// A range move is the one action where a wrong price costs depositors money,
// so before moving a range the bot requires ALL of:
//   1. situation (a) or (b) above holds now
//   2. the price has been steady (and, for (a), outside on the same side) for ~10 minutes
//      (read from the chain's own history, so nothing needs to be stored)
//   3. the pool price agrees with an independent market (Hyperliquid spot)
//   4. the on-chain cooldown has passed
// and then it states the tick it saw; the vault refuses if the pool has moved.
//
// This file has no imports so the same code runs in Deno (Supabase Edge
// Functions) and in Node (tests). ethers v5 is passed in.

export interface Lib {
  Wallet: any;
  utils: any;
}
export interface Deps {
  ethers: Lib;
  fetch: typeof fetch;
  env: (key: string) => string | undefined;
  sleep?: (ms: number) => Promise<void>;
}
export interface VaultConfig {
  name: string;
  address: string;
  pool: string;
  dec0: number;
  dec1: number;
  /** Hyperliquid spot pairs whose price ratio equals the pool price (token1 per token0).
   *  `invert` when the market quotes it the other way round (token0 per token1), as for a pool whose token0 is USDC. */
  reference?: { base: [string, string]; quote?: [string, string]; bandPct: number; invert?: boolean };
  /** For a pool whose token0 is not HYPE: the name of a vault in this list whose pool is HYPE against this vault's
   *  token0. The network fee is paid in HYPE; that pool's price turns it into token0 so it can be weighed against
   *  the fees waiting. */
  gasVia?: string;
  /** Which of this vault's tokens the `gasVia` pool prices HYPE in: 0 (the default) or 1. 1 is for a pool whose
   *  second token is the dollar (wNVDAx/USDC): the HYPE-USDC pool then gives the network fee in token1 directly. */
  gasInto?: 0 | 1;
  /** The vault swaps its surplus token itself when it opens fresh ranges (LiquidityVaultV2/V3), so even a one-token vault can be rebuilt. */
  swaps?: boolean;
  /** For a coin with no outside market: another pool of the same two tokens whose price must agree.
   *  `invert` when that pool lists the tokens the other way round (its tick is the negative of ours). */
  refPool?: { name: string; pool: string; invert: boolean; bandPct: number };
}
export interface Config {
  chainId: number;
  rpc: string;
  multicall: string;
  stateView: string;
  hyperliquid: string;
  vaults: VaultConfig[];
  /** Never compound a vault more often than this. */
  harvestMinGapSec: number;
  /** Compound when depositors' share of the waiting fees is at least this many times the network fee. */
  harvestGasMultiple: number;
  /** Do not compound while the network's gas price is above this (gwei). Normal is about 0.5. */
  maxGasPriceGwei: number;
  maxDriftTicks: number;
  /** How far back to look when checking the price has been steady, in seconds. */
  steadySeconds: number[];
  /** Most the tick may differ across those samples (150 ticks is about 1.5%). */
  steadyBandTicks: number;
  /** Rebuild the main range when it holds less than this share of the vault's value... */
  rebuildMainBelow: number;
  /** ...and the vault's smaller token side is at least this share of its value... */
  rebuildNeedsLesser: number;
  /** ...and the ranges were last moved at least this long ago. */
  rebuildEverySec: number;
  minGasHype: string;
  rpcGapMs: number;
}

export const CONFIG: Config = {
  chainId: 99901,
  rpc: "https://rpc.elysium.kinetiq.xyz",
  multicall: "0xcA11bde05977b3631167028862bE2a173976CA11",
  stateView: "0x27eD73aE0652fdCf71d6793412A7525f32bE9dfE",
  hyperliquid: "https://api.hyperliquid.xyz/info",
  // Only the vaults in use. Replaced vaults (emptied 2026-11-20, nothing left but their locked dead shares) and the
  // 0.5% $liquid vault that was closed unused are not looked after.
  vaults: [
    {
      name: "HYPE-USDC",
      address: "0x05D6A15d864A633DF9efC082aCFf7a2AB1e44911", // self-balancing (LiquidityVaultV2), opened 2026-11-16
      pool: "0xb3032695ffb0a66e6342876dd2386835471466cb2bb70f341947d98a69e265cc",
      dec0: 18,
      dec1: 6,
      reference: { base: ["HYPE", "USDC"], bandPct: 2 },
      swaps: true,
    },
    {
      name: "HYPE-KNTQ",
      address: "0xB7A3cFE218363E158A748aDfcb1A5a5FeD41c686", // self-balancing (LiquidityVaultV2)
      pool: "0xf9b8a9101438145d62c9f03156b203c6c573931167e2d36f9061a32575706c8a",
      dec0: 18,
      dec1: 18,
      reference: { base: ["HYPE", "USDC"], quote: ["KNTQ", "USDC"], bandPct: 3 },
      swaps: true,
    },
    {
      name: "HYPE-$liquid",
      address: "0xF49AAD222D3b9937371701e411c97018285E6691", // LiquidityVaultV3: swaps in Ascend's pool
      pool: "0x688b3a50572b1f0f738f15586acadfd9c3954379f0d6e49d5093d8d4f5382bc9",
      dec0: 18,
      dec1: 18,
      swaps: true,
      refPool: { name: "Ascend's pool", pool: "0xe522ea941342149346fa6641ad358ac49d8bf10abec2bba9106ac6bcc42b210c", invert: true, bandPct: 5 },
    },
    {
      // The first vault on a pair without HYPE: USDC (token0) and wANTx, the wrapped Anthropic xStock as the bridge
      // carries it from HyperEVM. The vault is the only liquidity in its pool, so it cannot swap its surplus there
      // (no `swaps`): after a price run it holds one token beside the price until trades come back into its range.
      // Its price is checked against Hyperliquid's ANTX/USDC market, which quotes dollars per token (hence `invert`).
      name: "wANTx-USDC",
      address: "0xD14C956837b124483707170fa2775160B66FDA2E", // LiquidityVaultV2
      pool: "0x8df1ba0bdc5bcba046cbaa33ee32a17f209c39d008cd204931eff3ab76430851",
      dec0: 6,
      dec1: 18,
      reference: { base: ["ANTX", "USDC"], invert: true, bandPct: 3 },
      gasVia: "HYPE-USDC",
    },
    {
      // wNVDAx (token0), the wrapped NVIDIA xStock as the bridge carries it from HyperEVM, and USDC. wNVDAx trades
      // in other pools on Elysium, but the one against USDC runs through a hook and the vault takes hookless pools
      // only, so the vault has a new pool of its own and is the only liquidity in it (no `swaps`), like wANTx-USDC.
      // Here the pool quotes dollars per token, the way Hyperliquid's NVDAX/USDC market does (no `invert`), and
      // the HYPE-USDC pool prices the network fee in this vault's second token (`gasInto: 1`).
      name: "wNVDAx-USDC",
      address: "0x19c4acb31d505650Fb0D4A96D77fc11C0d38aEd1", // LiquidityVaultV2
      pool: "0x257e5287163c7ed45b022ed1b9a04fcd116bab320b2e538490e85a49388ad7a1",
      dec0: 18,
      dec1: 6,
      reference: { base: ["NVDAX", "USDC"], bandPct: 3 },
      gasVia: "HYPE-USDC",
      gasInto: 1,
    },
  ],
  harvestMinGapSec: 3600,
  harvestGasMultiple: 10, // was 50 until 2026-11-20: with deposits of a few dollars 50 meant fees were collected (and the 20% cut paid out) only every few weeks
  maxGasPriceGwei: 5,
  maxDriftTicks: 20,
  steadySeconds: [180, 360, 600],
  steadyBandTicks: 150,
  rebuildMainBelow: 0.3,
  rebuildNeedsLesser: 0.15,
  rebuildEverySec: 6 * 3600,
  minGasHype: "0.01",
  rpcGapMs: 180, // the public RPC allows about 7 requests a second
};

export interface VaultReport {
  name: string;
  tick?: number;
  range?: [number, number];
  inRange?: boolean;
  /** Is any of the vault's liquidity active at the current price (earning fees)? */
  active?: boolean;
  /** Share of the vault's value sitting in the main range, 0 to 1. */
  mainShare?: number;
  action: "none" | "harvest" | "rebalance" | "skip";
  reason: string;
  tx?: string;
  confirmed?: boolean | null;
}
export interface Report {
  ok: boolean;
  mode: "live" | "watch-only" | "dry-run" | "paused";
  time: string;
  block?: number;
  keeper: string | null;
  gasHype?: string;
  vaults: VaultReport[];
  warnings: string[];
  error?: string;
}

const VAULT_ABI = [
  "function totalSupply() view returns (uint256)",
  "function price() view returns (uint160 sqrtPriceX96, int24 tick)",
  "function main() view returns (int24 lower, int24 upper, uint128 liquidity)",
  "function alt() view returns (int24 lower, int24 upper, uint128 liquidity)",
  "function balances() view returns (uint256 total0, uint256 total1)",
  "function keeper() view returns (address)",
  "function lastRebalance() view returns (uint256)",
  "function REBALANCE_COOLDOWN() view returns (uint256)",
  "function lastHarvest() view returns (uint256)",
  "function pendingFees() view returns (uint256 fee0, uint256 fee1)",
  "function harvest()",
  "function rebalance(int24 expectedTick, int24 maxDrift)",
];
const MULTICALL_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
];
const STATEVIEW_ABI = ["function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)"];
const REVERTS: Record<string, string> = {
  "0xf512b278": "this wallet is not the vault's keeper",
  "0x23d96b80": "the pool price moved before the transaction landed",
  "0xe86f59ea": "the vault's 15-minute cooldown has not passed",
  "0x019af637": "the vault rejected the parameters",
};

export async function runKeeper(deps: Deps, cfg: Config = CONFIG): Promise<Report> {
  const { Wallet, utils } = deps.ethers;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const report: Report = { ok: true, mode: "watch-only", time: new Date().toISOString(), keeper: null, vaults: [], warnings: [] };
  if (deps.env("KEEPER_PAUSED") === "1") {
    report.mode = "paused";
    return report;
  }

  // ---- wallet. The key is never logged, echoed or put in an error message.
  let wallet: any = null;
  const rawKey = (deps.env("KEEPER_PRIVATE_KEY") ?? "").trim();
  if (rawKey) {
    const key = rawKey.startsWith("0x") ? rawKey : "0x" + rawKey;
    if (/^0x[0-9a-fA-F]{64}$/.test(key)) {
      try {
        wallet = new Wallet(key);
      } catch {
        report.warnings.push("KEEPER_PRIVATE_KEY could not be used as a wallet key");
      }
    } else report.warnings.push("KEEPER_PRIVATE_KEY is set but is not a 64-character hex key");
  }
  const dry = deps.env("DRY_RUN") === "1";
  report.mode = !wallet ? "watch-only" : dry ? "dry-run" : "live";
  report.keeper = wallet ? wallet.address : null;
  const rpcUrl = deps.env("ELYSIUM_RPC") || cfg.rpc;

  // ---- JSON-RPC, paced for the public endpoint
  let lastCall = 0;
  async function rpc(method: string, params: unknown[] = [], tries = 0): Promise<any> {
    const wait = lastCall + cfg.rpcGapMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const res = await deps.fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "liquid-reserve-keeper/1" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const j: any = await res.json();
    if (j.error) {
      if (/rate limit|too many/i.test(j.error.message ?? "") && tries < 4) {
        await sleep(1200);
        return rpc(method, params, tries + 1);
      }
      throw Object.assign(new Error(j.error.message ?? "RPC error"), { data: j.error.data, code: j.error.code });
    }
    return j.result;
  }

  const V = new utils.Interface(VAULT_ABI), MC = new utils.Interface(MULTICALL_ABI), SV = new utils.Interface(STATEVIEW_ABI);
  type Call = { to: string; iface: any; fn: string; args?: unknown[] };
  async function multicall(calls: Call[], block: string = "latest"): Promise<any[]> {
    const data = MC.encodeFunctionData("aggregate3", [calls.map((c) => ({ target: c.to, allowFailure: true, callData: c.iface.encodeFunctionData(c.fn, c.args ?? []) }))]);
    const ret = await rpc("eth_call", [{ to: cfg.multicall, data }, block]);
    const [rows] = MC.decodeFunctionResult("aggregate3", ret);
    return rows.map((r: any, i: number) => (r.success && r.returnData !== "0x" ? calls[i].iface.decodeFunctionResult(calls[i].fn, r.returnData) : null));
  }
  const hex = (n: number | bigint) => "0x" + BigInt(n).toString(16);
  const revertReason = (e: any) => {
    const data = String(e?.data?.data ?? e?.data ?? "");
    return REVERTS[data.slice(0, 10)] ?? String(e?.message ?? e).slice(0, 160);
  };

  // ---- everything about every vault, in one request
  const FNS = ["totalSupply", "price", "main", "alt", "balances", "keeper", "lastRebalance", "REBALANCE_COOLDOWN", "lastHarvest", "pendingFees"];
  const calls: Call[] = [];
  for (const v of cfg.vaults) for (const fn of FNS) calls.push({ to: v.address, iface: V, fn });
  // The chain's own latest block. (Not block.number read inside a contract: on
  // Elysium, an Arbitrum Orbit chain, that reports the parent chain's block.)
  const latest = await rpc("eth_getBlockByNumber", ["latest", false]);
  const head = Number(latest.number), now = Number(latest.timestamp);
  const res = await multicall(calls);
  report.block = head;

  if (wallet) {
    const bal = BigInt(await rpc("eth_getBalance", [wallet.address, "latest"]));
    report.gasHype = utils.formatEther(bal.toString());
    if (bal < BigInt(utils.parseEther(cfg.minGasHype).toString())) report.warnings.push(`keeper wallet is low on HYPE for fees (${report.gasHype})`);
  }

  // ---- has the price been steady, on the same side, for the last ~10 minutes?
  // Finds the block that was current at each moment (blocks are not evenly
  // spaced, so it searches by timestamp) and reads the pool price as of then.
  let secPerBlock: number | null = null;
  const stamps = new Map<number, number>();
  async function stampOf(block: number): Promise<number> {
    if (!stamps.has(block)) stamps.set(block, Number((await rpc("eth_getBlockByNumber", [hex(block), false])).timestamp));
    return stamps.get(block)!;
  }
  /** Newest block whose timestamp is at or before `target`. */
  async function blockAt(target: number): Promise<number> {
    if (secPerBlock === null) {
      const back = Math.min(4000, head - 1);
      secPerBlock = Math.max(0.01, (now - (await stampOf(head - back))) / back);
    }
    let hi = head, step = Math.max(1, Math.round((now - target) / secPerBlock));
    let lo = Math.max(1, head - step), loTs = await stampOf(lo);
    for (let i = 0; i < 24 && loTs > target && lo > 1; i++) {
      hi = lo;
      step += Math.max(Math.ceil((loTs - target) / secPerBlock) + 2, Math.ceil(step * 0.25));
      lo = Math.max(1, head - step);
      loTs = await stampOf(lo);
    }
    for (let i = 0; i < 16 && hi - lo > 1 && target - loTs > 20; i++) {
      const mid = lo + Math.floor((hi - lo) / 2), t = await stampOf(mid);
      if (t <= target) { lo = mid; loTs = t; } else hi = mid;
    }
    return lo;
  }
  async function steady(v: VaultConfig, tick: number, lower: number, upper: number, mustBeOutside: boolean): Promise<{ ok: boolean; detail: string }> {
    const below = tick < lower;
    for (const secs of cfg.steadySeconds) {
      const block = await blockAt(now - secs);
      const [slot] = await multicall([{ to: cfg.stateView, iface: SV, fn: "getSlot0", args: [v.pool] }], hex(block));
      if (!slot) return { ok: false, detail: "could not read the pool's recent history" };
      const t = Number(slot.tick), mins = Math.round(secs / 60);
      const side = t < lower ? "below" : t >= upper ? "above" : "inside";
      if (mustBeOutside && side !== (below ? "below" : "above")) return { ok: false, detail: `the price was ${side} the range ${mins} minutes ago` };
      if (Math.abs(t - tick) > cfg.steadyBandTicks) return { ok: false, detail: `the price moved ${(Math.abs(t - tick) / 100).toFixed(1)}% in the last ${mins} minutes` };
    }
    return { ok: true, detail: `steady ${mustBeOutside ? "outside the range " : ""}for ${Math.round(Math.max(...cfg.steadySeconds) / 60)} minutes` };
  }

  // ---- does the pool agree with an independent market?
  let mids: Record<string, string> | null = null, pairs: Record<string, string> | null = null;
  async function reference(v: VaultConfig, tick: number): Promise<{ ok: boolean; detail: string }> {
    if (v.refPool) {
      const [slot] = await multicall([{ to: cfg.stateView, iface: SV, fn: "getSlot0", args: [v.refPool.pool] }]);
      if (!slot || BigInt(slot.sqrtPriceX96.toString()) === 0n) return { ok: false, detail: `${v.refPool.name} could not be read` };
      const theirs = Number(slot.tick) * (v.refPool.invert ? -1 : 1);
      const off = Math.abs(1.0001 ** (tick - theirs) - 1) * 100;
      return off <= v.refPool.bandPct
        ? { ok: true, detail: `pool is within ${off.toFixed(2)}% of ${v.refPool.name}` }
        : { ok: false, detail: `pool price is ${off.toFixed(1)}% away from ${v.refPool.name} (limit ${v.refPool.bandPct}%)` };
    }
    if (!v.reference) return { ok: true, detail: "no outside price configured" };
    try {
      const post = (body: unknown) => deps.fetch(cfg.hyperliquid, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
      if (!pairs) {
        const meta: any = await post({ type: "spotMeta" });
        const names: Record<number, string> = {};
        for (const t of meta.tokens) names[t.index] = t.name;
        pairs = {};
        for (const u of meta.universe) pairs[`${names[u.tokens[0]]}/${names[u.tokens[1]]}`] = u.name;
      }
      mids ??= (await post({ type: "allMids" })) as Record<string, string>;
      const px = (p: [string, string]) => Number(mids![pairs![`${p[0]}/${p[1]}`]]);
      let market = v.reference.quote ? px(v.reference.base) / px(v.reference.quote) : px(v.reference.base);
      if (v.reference.invert) market = 1 / market;
      if (!(market > 0) || !isFinite(market)) return { ok: false, detail: "the outside price is unavailable" };
      const pool = 1.0001 ** tick * 10 ** (v.dec0 - v.dec1);
      const off = Math.abs(pool / market - 1) * 100;
      return off <= v.reference.bandPct
        ? { ok: true, detail: `pool is within ${off.toFixed(2)}% of Hyperliquid` }
        : { ok: false, detail: `pool price is ${off.toFixed(1)}% away from Hyperliquid (limit ${v.reference.bandPct}%)` };
    } catch {
      return { ok: false, detail: "the outside price could not be fetched" };
    }
  }

  // ---- simulate, sign, send, wait
  async function send(to: string, data: string): Promise<{ tx?: string; confirmed?: boolean | null; failed?: string; dry?: boolean }> {
    let gas: bigint;
    try {
      gas = BigInt(await rpc("eth_estimateGas", [{ from: wallet.address, to, data }]));
    } catch (e) {
      return { failed: revertReason(e) };
    }
    if (dry) return { dry: true };
    const nonce = Number(await rpc("eth_getTransactionCount", [wallet.address, "pending"]));
    const gasPrice = (BigInt(await rpc("eth_gasPrice")) * 12n) / 10n;
    const raw = await wallet.signTransaction({ to, data, nonce, gasLimit: hex((gas * 13n) / 10n), gasPrice: hex(gasPrice), chainId: cfg.chainId, value: 0, type: 0 });
    const tx = await rpc("eth_sendRawTransaction", [raw]);
    for (let i = 0; i < 16; i++) {
      await sleep(1500);
      const r = await rpc("eth_getTransactionReceipt", [tx]);
      if (r) return { tx, confirmed: r.status === "0x1" };
    }
    return { tx, confirmed: null };
  }

  // ---- decide and act, vault by vault
  for (let i = 0; i < cfg.vaults.length; i++) {
    const v = cfg.vaults[i], at = i * FNS.length;
    const [supply, price, main, alt, bal, keeper, lastRebalance, cooldown, lastHarvest, fees] = res.slice(at, at + FNS.length);
    const out: VaultReport = { name: v.name, action: "none", reason: "" };
    report.vaults.push(out);
    try {
      if (!supply || !price || !main || !alt || !bal) { out.action = "skip"; out.reason = "vault did not answer"; continue; }
      const tick = Number(price.tick), lower = Number(main.lower), upper = Number(main.upper);
      out.tick = tick; out.range = [lower, upper];
      if (BigInt(supply[0].toString()) === 0n) { out.reason = "no deposits yet"; continue; }
      out.inRange = tick >= lower && tick < upper;

      // Where the vault's value sits, measured in token1 at the pool price.
      const sp = Number(price.sqrtPriceX96.toString()) / 2 ** 96, p = sp * sp;
      const within = (r: any) => BigInt(r.liquidity.toString()) > 0n && tick >= Number(r.lower) && tick < Number(r.upper);
      out.active = within(main) || within(alt);
      const L = Number(main.liquidity.toString()), sa = 1.0001 ** (lower / 2), sb = 1.0001 ** (upper / 2);
      const main0 = sp <= sa ? L * (1 / sa - 1 / sb) : sp < sb ? L * (1 / sp - 1 / sb) : 0;
      const main1 = sp <= sa ? 0 : sp < sb ? L * (sp - sa) : L * (sb - sa);
      const side0 = Number(bal.total0.toString()) * p, side1 = Number(bal.total1.toString()), total = side0 + side1;
      out.mainShare = total > 0 ? Math.round(((main0 * p + main1) / total) * 1000) / 1000 : 0;
      const lesser = total > 0 ? Math.min(side0, side1) / total : 0;

      const sinceMove = now - Number(lastRebalance[0]);
      const rebuild = out.inRange && out.mainShare < cfg.rebuildMainBelow && (lesser >= cfg.rebuildNeedsLesser || !!v.swaps) && sinceMove >= cfg.rebuildEverySec;
      if (!out.inRange || rebuild) {
        const why = out.inRange ? "main range is nearly empty" : "out of range";
        const isKeeper = !!wallet && String(keeper[0]).toLowerCase() === wallet.address.toLowerCase();
        const readyAt = Number(lastRebalance[0]) + Number(cooldown[0]);
        if (!wallet) { out.action = "skip"; out.reason = `${why}; no keeper wallet is configured yet`; continue; }
        if (!isKeeper) { out.action = "skip"; out.reason = `${why}, but this wallet is not the vault's keeper`; continue; }
        if (Number(lastRebalance[0]) !== 0 && now < readyAt) { out.action = "skip"; out.reason = `${why}; cooldown ends in ${Math.ceil((readyAt - now) / 60)} min`; continue; }
        const s = await steady(v, tick, lower, upper, !out.inRange);
        if (!s.ok) { out.action = "skip"; out.reason = `${why}, waiting: ${s.detail}`; continue; }
        const m = await reference(v, tick);
        if (!m.ok) { out.action = "skip"; out.reason = `${why}, not moving: ${m.detail}`; continue; }
        const r = await send(v.address, V.encodeFunctionData("rebalance", [tick, cfg.maxDriftTicks]));
        const did = out.inRange ? "rebuilt the main range" : "moved the range";
        out.action = r.failed ? "skip" : "rebalance";
        out.reason = r.failed ? `would fail: ${r.failed}` : `${r.dry ? "dry run: would have " : ""}${did} (${s.detail}; ${m.detail})`;
        out.tx = r.tx; out.confirmed = r.confirmed;
        continue;
      }
      if (!out.active) {
        out.reason = lesser < cfg.rebuildNeedsLesser && !v.swaps
          ? "holding one token after the last range move; its range sits just beside the price and starts earning when the price trades into it"
          : "no liquidity at the current price; the main range is rebuilt once 6 hours have passed since the last move";
        continue;
      }

      // Compound when it is worth it: depositors' share of the waiting fees must be many
      // times the network fee of collecting them. The network fee is paid in HYPE. Where token0
      // is HYPE it converts to token1 at the pool price; otherwise it first goes through the
      // vault named in `gasVia`, whose pool prices HYPE in this vault's token0 (or, with
      // `gasInto: 1`, in its token1, which needs no second conversion).
      let hypeIn0 = 1; // raw token0 per wei of HYPE
      let hypeIn1 = 0; // raw token1 per wei of HYPE, when the `gasVia` pool gives that directly
      if (v.gasVia) {
        const j = cfg.vaults.findIndex((x) => x.name === v.gasVia), via = j >= 0 ? res[j * FNS.length + 1] : null;
        const s0 = via ? Number(via.sqrtPriceX96.toString()) / 2 ** 96 : 0;
        if (!(s0 > 0)) { out.reason = "in range; the HYPE price needed to weigh the waiting fees against the network fee could not be read"; continue; }
        if (v.gasInto === 1) hypeIn1 = s0 * s0; else hypeIn0 = s0 * s0;
      }
      const f0 = Number(fees.fee0.toString()), f1 = Number(fees.fee1.toString());
      const waiting = (f0 * p + f1) * 0.8;
      if (waiting <= 0) { out.reason = "in range; no fees waiting"; continue; }
      if (now - Number(lastHarvest[0]) < cfg.harvestMinGapSec) { out.reason = "in range; fees were compounded within the last hour"; continue; }
      const harvestData = V.encodeFunctionData("harvest", []);
      const gasPrice = Number(BigInt(await rpc("eth_gasPrice")));
      const gasUnits = Number(BigInt(await rpc("eth_estimateGas", [{ from: wallet ? wallet.address : keeper[0], to: v.address, data: harvestData }])));
      const cost = gasUnits * gasPrice * (hypeIn1 > 0 ? hypeIn1 : hypeIn0 * p); // network fee, in token1
      const times = cost > 0 ? waiting / cost : Infinity;
      if (gasPrice > cfg.maxGasPriceGwei * 1e9) { out.reason = `in range; fees are waiting but the network fee is unusually high (${(gasPrice / 1e9).toFixed(1)} gwei)`; continue; }
      if (times < cfg.harvestGasMultiple) { out.reason = `in range; fees waiting are ${times.toFixed(0)} times the network fee, compounding at ${cfg.harvestGasMultiple} times`; continue; }
      if (!wallet) { out.action = "skip"; out.reason = "fees are ready to compound; no keeper wallet is configured yet"; continue; }
      const r = await send(v.address, harvestData);
      out.action = r.failed ? "skip" : "harvest";
      out.reason = r.failed ? `would fail: ${r.failed}` : `${r.dry ? "dry run: would compound fees" : "compounded fees"} (${times.toFixed(0)} times the network fee)`;
      out.tx = r.tx; out.confirmed = r.confirmed;
    } catch (e: any) {
      out.action = "skip";
      out.reason = `error: ${String(e?.message ?? e).slice(0, 160)}`;
      report.ok = false;
    }
  }
  return report;
}
