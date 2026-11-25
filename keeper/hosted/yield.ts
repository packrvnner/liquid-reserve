// Liquid Reserve: the bot's yield job (runs inside "reserve-keeper", after the reserve and drop jobs).
//
// The locked reserve lets only its yield out. share.ts already takes it as far as YieldRest (a fifth goes to the
// creator on the way). Once the owner has pointed YieldRest at the YieldDirector (a one-time, permanent timelock
// step), this job moves the kHYPE on and calls the director, which splits it by the owner's shares:
//
//   YieldRest -> director
//     compound       kHYPE, locked in the reserve again (no purchase)
//     everything else buys $liquid: for the drop (or the burn, once the drop is full) and for the reward pools
//
// The director buys at no worse than the reserve's 30-minute average price less 1%, so when any share buys $liquid
// the two feeds on that road (kHYPE/HYPE and Ascend's $liquid pool) need 30 minutes of recent readings that agree
// with their pools. Neither has an outside market to compare with. If everything compounds, no price is needed.
// Nothing is sent until the yield waiting is worth the network fees.
//
// Until the director exists and YieldRest points at it, the job does nothing and says so.
// Anyone may make these calls; the money can only go where the contracts send it.
//
// No imports: the same code runs in Deno (Supabase Edge Functions) and in Node (tests). ethers v5 is passed in.

export interface Lib { Wallet: any; utils: any }
export interface Deps {
  ethers: Lib;
  fetch: typeof fetch;
  env: (key: string) => string | undefined;
  sleep?: (ms: number) => Promise<void>;
}
export interface YieldConfig {
  rpc: string;
  chainId: number;
  multicall: string;
  stateView: string;
  khype: string;
  /** Where the reserve's yield waits, and the director it is to be pointed at. */
  yieldRest: string;
  director: string;
  /** The drop feeder: a share for the drop cannot be paid out before it exists. */
  feeder: string;
  oracle: string;
  /** The price feeds on the road from kHYPE to $liquid, by pool id; hypeUsdc only puts a dollar figure on the yield. */
  feeds: { khypeWhype: string; ascend: string; hypeUsdc: string };
  /** Take a price reading when the last one is older than this. */
  pokeEverySec: number;
  /** Distribute when the yield waiting is worth at least this many times the network fees of doing it... */
  gasMultiple: number;
  /** ...where doing it costs about this much gas (a reading, forwarding, distributing)... */
  cycleGas: number;
  /** ...and never for less than this, in dollars. */
  minUsd: number;
  /** Most a 30-minute average may differ from its pool's price now, in ticks (100 is about 1%). */
  maxTwapGapTicks: number;
  maxGasPriceGwei: number;
  rpcGapMs: number;
}
export const YIELD_CONFIG: YieldConfig = {
  rpc: "https://rpc.elysium.kinetiq.xyz",
  chainId: 99901,
  multicall: "0xcA11bde05977b3631167028862bE2a173976CA11",
  stateView: "0x27eD73aE0652fdCf71d6793412A7525f32bE9dfE",
  khype: "0x248888D396A546A69A188f3Deb476964e581E9d0",
  yieldRest: "0x14938d73fdCF459c07fB749dbA21DE76e4519938",
  director: "0x4dBDb5E2cC1D666cBc159e317f458F34cAEEF928",
  feeder: "0x2089dC3D846e5c0C06Cc6E9B35Abf22AB925600f",
  oracle: "0x51670e163023CC3fa63d857A655A430321Fc1f56",
  feeds: {
    khypeWhype: "0x890fc38d3b7ce4482eaab02250be48f596aec0b60c10f29fa2d1ccf356c3740c",
    ascend: "0xe522ea941342149346fa6641ad358ac49d8bf10abec2bba9106ac6bcc42b210c",
    hypeUsdc: "0xb3032695ffb0a66e6342876dd2386835471466cb2bb70f341947d98a69e265cc",
  },
  pokeEverySec: 540,
  gasMultiple: 10,
  cycleGas: 1_400_000,
  minUsd: 0.5,
  maxTwapGapTicks: 100,
  maxGasPriceGwei: 5,
  rpcGapMs: 180,
};

export interface YieldAction { what: string; tx?: string; confirmed?: boolean | null; note?: string }
export interface YieldReport {
  ok: boolean;
  mode: "live" | "watch-only" | "dry-run" | "paused";
  time: string;
  keeper: string | null;
  /** off: the director is not set up yet. idle: too little waiting. warming: waiting for prices. paid: it distributed. */
  status: "off" | "idle" | "warming" | "paid" | "paused";
  reason: string;
  /** The shares in force, in percent, in the director's order (compound, the drop, then the pools). */
  shares?: number[];
  waitingKhype?: string;
  neededUsd?: number;
  actions: YieldAction[];
  warnings: string[];
  error?: string;
}

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
const INBOX_ABI = ["function target() view returns (address)", "function forward(address token) returns (uint256)"];
const DIRECTOR_ABI = [
  "function manager() view returns (address)", "function successor() view returns (address)",
  "function destinations() view returns ((uint8 kind, address target, uint16 bps)[])",
  "function distribute(address token, uint256 maxAmount) returns (uint256, uint256)",
];
const FEEDER_ABI = ["function drop() view returns (address)"];
const ORACLE_ABI = [
  "function feeds(bytes32) view returns (address currency0, address currency1, uint32 lastTime, int24 lastTick, int56 tickCumulative, uint16 latestIndex, uint16 count)",
  "function meanTick(bytes32 id) view returns (int24)",
  "function poke(bytes32[] ids)",
];
const STATEVIEW_ABI = ["function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)"];
const MULTICALL_ABI = ["function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])"];
const REVERTS: Record<string, string> = {
  "0x2c19b8b8": "the purchase would land more than 1% below the average price",
  "0x82ba0f27": "a pool on the way cannot take the whole amount right now",
  "0x6e11123c": "the price readings are too old",
  "0xdb5860d8": "there are not 30 minutes of price readings yet",
  "0x81fff07f": "there is no route for this purchase",
  "0x637c1772": "nothing to forward",
};

export async function runYield(deps: Deps, cfg: YieldConfig = YIELD_CONFIG): Promise<YieldReport> {
  const { Wallet, utils } = deps.ethers;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const report: YieldReport = { ok: true, mode: "watch-only", time: new Date().toISOString(), keeper: null, status: "idle", reason: "", actions: [], warnings: [] };
  if (deps.env("KEEPER_PAUSED") === "1" || deps.env("RESERVE_PAUSED") === "1" || deps.env("YIELD_PAUSED") === "1") {
    report.mode = "paused"; report.status = "paused"; report.reason = "paused by its switch";
    return report;
  }
  // ---- wallet. The key is never logged, echoed or put in an error message.
  let wallet: any = null;
  const rawKey = (deps.env("KEEPER_PRIVATE_KEY") ?? "").trim();
  if (rawKey) {
    const key = rawKey.startsWith("0x") ? rawKey : "0x" + rawKey;
    if (/^0x[0-9a-fA-F]{64}$/.test(key)) {
      try { wallet = new Wallet(key); } catch { report.warnings.push("KEEPER_PRIVATE_KEY could not be used as a wallet key"); }
    } else report.warnings.push("KEEPER_PRIVATE_KEY is set but is not a 64-character hex key");
  }
  const dry = deps.env("DRY_RUN") === "1" || deps.env("RESERVE_DRY_RUN") === "1";
  report.mode = !wallet ? "watch-only" : dry ? "dry-run" : "live";
  report.keeper = wallet ? wallet.address : null;
  const rpcUrl = deps.env("ELYSIUM_RPC") || cfg.rpc;

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
      if (/rate limit|too many/i.test(j.error.message ?? "") && tries < 4) { await sleep(1200); return rpc(method, params, tries + 1); }
      throw Object.assign(new Error(j.error.message ?? "RPC error"), { data: j.error.data, code: j.error.code });
    }
    return j.result;
  }
  const I = (abi: string[]) => new utils.Interface(abi);
  const ERC20 = I(ERC20_ABI), INBOX = I(INBOX_ABI), DIR = I(DIRECTOR_ABI), FEEDER = I(FEEDER_ABI), OR = I(ORACLE_ABI), SV = I(STATEVIEW_ABI), MC = I(MULTICALL_ABI);
  type Call = { to: string; iface: any; fn: string; args?: unknown[] };
  async function multicall(calls: Call[]): Promise<any[]> {
    const data = MC.encodeFunctionData("aggregate3", [calls.map((c) => ({ target: c.to, allowFailure: true, callData: c.iface.encodeFunctionData(c.fn, c.args ?? []) }))]);
    const [rows] = MC.decodeFunctionResult("aggregate3", await rpc("eth_call", [{ to: cfg.multicall, data }, "latest"]));
    return rows.map((r: any, i: number) => (r.success && r.returnData !== "0x" ? calls[i].iface.decodeFunctionResult(calls[i].fn, r.returnData) : null));
  }
  const hex = (n: number | bigint) => "0x" + BigInt(n).toString(16);
  const lower = (a: unknown) => String(a ?? "").toLowerCase();
  const code = (e: any) => String(e?.data?.data ?? e?.data ?? "").slice(0, 10);

  /** Simulates, signs, sends and waits. `ok` when it went through (or would, in a dry run). */
  async function act(what: string, to: string, data: string): Promise<{ ok: boolean; code?: string }> {
    let gas: bigint;
    try {
      gas = BigInt(await rpc("eth_estimateGas", [{ from: wallet.address, to, data }]));
    } catch (e: any) {
      report.actions.push({ what, note: `skipped: ${REVERTS[code(e)] ?? String(e?.message ?? e).slice(0, 140)}` });
      return { ok: false, code: code(e) };
    }
    if (dry) { report.actions.push({ what, note: "dry run: would have been sent" }); return { ok: true }; }
    const nonce = Number(await rpc("eth_getTransactionCount", [wallet.address, "pending"]));
    const gasPrice = (BigInt(await rpc("eth_gasPrice")) * 12n) / 10n;
    const raw = await wallet.signTransaction({ to, data, nonce, gasLimit: hex((gas * 13n) / 10n), gasPrice: hex(gasPrice), chainId: cfg.chainId, value: 0, type: 0 });
    const tx = await rpc("eth_sendRawTransaction", [raw]);
    let confirmed: boolean | null = null;
    for (let n = 0; n < 16 && confirmed === null; n++) {
      await sleep(1500);
      const r = await rpc("eth_getTransactionReceipt", [tx]);
      if (r) confirmed = r.status === "0x1";
    }
    report.actions.push({ what, tx, confirmed });
    if (confirmed === false) report.ok = false;
    return { ok: confirmed === true };
  }

  // ---- everything, in one request
  const FEEDS = [cfg.feeds.khypeWhype, cfg.feeds.ascend], NAMES = ["kHYPE/HYPE", "$liquid"];
  const latest = await rpc("eth_getBlockByNumber", ["latest", false]);
  const now = Number(latest.timestamp);
  const calls: Call[] = [
    { to: cfg.director, iface: DIR, fn: "manager" }, // 0: does the director exist?
    { to: cfg.yieldRest, iface: INBOX, fn: "target" }, // 1
    { to: cfg.khype, iface: ERC20, fn: "balanceOf", args: [cfg.yieldRest] }, // 2
    { to: cfg.khype, iface: ERC20, fn: "balanceOf", args: [cfg.director] }, // 3
    { to: cfg.director, iface: DIR, fn: "successor" }, // 4
    { to: cfg.director, iface: DIR, fn: "destinations" }, // 5
    { to: cfg.feeder, iface: FEEDER, fn: "drop" }, // 6: does the drop feeder exist?
    ...FEEDS.map((id) => ({ to: cfg.oracle, iface: OR, fn: "feeds", args: [id] })), // 7, 8
    ...FEEDS.map((id) => ({ to: cfg.oracle, iface: OR, fn: "meanTick", args: [id] })), // 9, 10
    ...FEEDS.map((id) => ({ to: cfg.stateView, iface: SV, fn: "getSlot0", args: [id] })), // 11, 12
    { to: cfg.stateView, iface: SV, fn: "getSlot0", args: [cfg.feeds.hypeUsdc] }, // 13
  ];
  const res = await multicall(calls);
  const big = (i: number) => BigInt((res[i]?.[0] ?? 0).toString());

  if (!res[0]) { report.status = "off"; report.reason = "the yield director is not on-chain yet"; return report; }
  const dests: { kind: number; bps: number }[] = (res[5]?.[0] ?? []).map((d: any) => ({ kind: Number(d.kind), bps: Number(d.bps) }));
  report.shares = dests.map((d) => d.bps / 100);
  if (lower(res[1]?.[0]) !== lower(cfg.director)) {
    report.status = "off";
    report.reason = /^0x0{40}$/.test(lower(res[1]?.[0])) ? "the reserve's yield is not pointed at the director yet (the owner's timelock step)" : "the reserve's yield points somewhere else";
    return report;
  }
  const passing = !!res[4] && !/^0x0{40}$/.test(lower(res[4][0])); // a successor is named: the director only passes the yield on
  const atRest = big(2), atDirector = big(3), waiting = atRest + atDirector;
  report.waitingKhype = utils.formatUnits(waiting.toString(), 18);
  // kHYPE in dollars: HYPE per kHYPE in its own pool, times HYPE's price in the HYPE/USDC pool
  const hypeUsd = 1.0001 ** Number(res[13].tick) * 1e12, khypeUsd = hypeUsd * 1.0001 ** Number(res[11].tick);
  const gasPriceWei = Number(BigInt(await rpc("eth_gasPrice")));
  const neededUsd = Math.max(cfg.minUsd, (cfg.gasMultiple * cfg.cycleGas * gasPriceWei * hypeUsd) / 1e18);
  report.neededUsd = neededUsd;
  const waitingUsd = (Number(waiting) / 1e18) * khypeUsd;
  if (waitingUsd < neededUsd) {
    report.status = "idle";
    report.reason = `$${waitingUsd.toFixed(2)} of yield waiting; it is distributed once it reaches $${neededUsd.toFixed(2)}`;
    return report;
  }
  if (gasPriceWei > cfg.maxGasPriceGwei * 1e9) { report.status = "idle"; report.reason = `there is work to do but the network fee is unusually high (${(gasPriceWei / 1e9).toFixed(1)} gwei)`; return report; }
  if (!wallet) { report.status = "idle"; report.reason = `$${waitingUsd.toFixed(2)} of yield is ready; no keeper wallet is configured`; return report; }

  // Which shares buy $liquid? Destination 0 compounds; kind 1 is the drop.
  const buys = !passing && dests.some((d, i) => i > 0 && d.bps > 0);
  const dropShare = dests.filter((d) => d.kind === 1).reduce((a, d) => a + d.bps, 0);
  if (!passing && dropShare > 0 && !res[6]) {
    report.status = "warming";
    report.reason = `$${waitingUsd.toFixed(2)} of yield ready; ${dropShare / 100}% of it is for the drop, whose feeder does not exist yet`;
    return report;
  }
  if (buys) {
    // ---- 1. a price reading, if the last one is getting old
    const lastTimes = [7, 8].map((i) => Number(res[i]?.lastTime ?? 0));
    let poked = false;
    if (lastTimes.some((t) => now - t >= cfg.pokeEverySec)) {
      poked = (await act("price reading for the yield", cfg.oracle, OR.encodeFunctionData("poke", [FEEDS]))).ok;
      if (!poked) { report.status = "warming"; report.reason = "could not take a price reading"; return report; }
    }
    // ---- 2. are the prices trustworthy right now?
    const mean = [9, 10].map((i) => (res[i] ? Number(res[i][0]) : null));
    const spot = [11, 12].map((i) => Number(res[i].tick));
    let wait = "";
    if (mean.some((m) => m === null)) wait = "building 30 minutes of price readings";
    else if (poked && lastTimes.some((t) => now - t > 3600)) wait = "the price readings had gone stale; building 30 minutes of fresh ones";
    else {
      const off = mean.map((m, i) => Math.abs((m as number) - spot[i]));
      const worst = off.indexOf(Math.max(...off));
      if (off[worst] > cfg.maxTwapGapTicks) wait = `the ${NAMES[worst]} price is ${(off[worst] / 100).toFixed(1)}% away from its 30-minute average; waiting for it to settle`;
    }
    if (wait) { report.status = "warming"; report.reason = `$${waitingUsd.toFixed(2)} of yield ready; ${wait}`; return report; }
  }

  // ---- 3. move the yield on and distribute
  let atHand = atDirector;
  if (atRest > 0n) {
    if (!(await act(`pass ${utils.formatUnits(atRest.toString(), 18)} kHYPE of yield to the director`, cfg.yieldRest, INBOX.encodeFunctionData("forward", [cfg.khype]))).ok) {
      if (atDirector === 0n) { report.status = "warming"; report.reason = "could not pass the yield on this run"; return report; }
    } else if (dry) { report.status = "paid"; report.reason = "dry run: would have distributed the yield"; return report; } // the next step cannot be simulated until this one is sent
    else atHand += atRest;
  }
  const split = dests.map((d, i) => (d.bps > 0 ? `${d.bps / 100}% ${i === 0 ? "compound" : d.kind === 1 ? "the drop" : d.kind === 2 ? `pool ${i - 1}` : `address ${i - 1}`}` : "")).filter(Boolean).join(", ");
  const label = (v: bigint, piece: boolean) => passing ? `pass ${utils.formatUnits(v.toString(), 18)} kHYPE on to the director's successor`
    : `distribute ${utils.formatUnits(v.toString(), 18)} kHYPE of yield${piece ? " (a piece; a pool is thin)" : ""}: ${split}`;
  const MAX = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
  let r = await act(label(atHand, false), cfg.director, DIR.encodeFunctionData("distribute", [cfg.khype, MAX]));
  // Thin pools: if the whole amount would move a price more than 1%, do a piece; the rest goes next run.
  for (let div = 2n; !r.ok && (r.code === "0x2c19b8b8" || r.code === "0x82ba0f27") && div <= 16n; div *= 2n) {
    report.actions.pop();
    r = await act(label(atHand / div, true), cfg.director, DIR.encodeFunctionData("distribute", [cfg.khype, (atHand / div).toString()]));
  }
  report.status = r.ok ? "paid" : "warming";
  report.reason = r.ok ? `${dry ? "dry run: would have distributed" : "distributed"} the reserve's yield` : "prices are ready; nothing could be distributed this run";
  return report;
}
