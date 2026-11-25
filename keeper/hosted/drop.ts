// Liquid Reserve: the bot's drop job (runs inside "reserve-keeper", after the reserve job).
//
// The reserve's allocator sets a fifth of every fee aside as USDC in a waiting contract. Once the owner has
// pointed that contract at the DropFeeder (a one-time, permanent timelock step), this job moves the USDC on and
// calls the feeder:
//
//   waiting contract -> feeder
//     half -> kHYPE, locked in the reserve
//     half -> $liquid, to the drop (the bot's own wallet) until it holds 5% of the unburned supply;
//             after that to Ascend's burn address
//
// The feeder buys at no worse than the reserve's 30-minute average price less 1%, so the averages have to be
// fresh. The reserve job usually leaves them fresh for HYPE; the $liquid feed is read here. Nothing is sent until:
//   1. enough USDC is waiting to be worth the network fees
//   2. the three price feeds it needs have 30 minutes of recent readings
//   3. each average agrees with its pool's price now
//   4. the pool does not price HYPE above an outside market (Hyperliquid), since both halves buy HYPE first
// $liquid has no outside market: for it only the 30-minute average is checked.
//
// Until the feeder exists and the waiting contract points at it, the job does nothing and says so.
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
export interface DropConfig {
  rpc: string;
  chainId: number;
  multicall: string;
  stateView: string;
  hyperliquid: string;
  usdc: string;
  liquid: string;
  /** Where the allocator's USDC share waits, and the feeder it is to be pointed at. */
  liquidWait: string;
  feeder: string;
  oracle: string;
  /** The price feeds the feeder's two purchases need, by pool id. */
  feeds: { hypeUsdc: string; khypeWhype: string; ascend: string };
  /** Take a price reading when the last one is older than this. */
  pokeEverySec: number;
  /** Feed when the USDC waiting is worth at least this many times the network fees of doing it... */
  gasMultiple: number;
  /** ...where doing it costs about this much gas (a reading, forwarding, feeding)... */
  cycleGas: number;
  /** ...and never for less than this, in dollars. */
  minUsd: number;
  /** Most a 30-minute average may differ from its pool's price now, in ticks (100 is about 1%). */
  maxTwapGapTicks: number;
  /** Most the pool may price HYPE above Hyperliquid, in percent. */
  hypeBandPct: number;
  maxGasPriceGwei: number;
  rpcGapMs: number;
}
export const DROP_CONFIG: DropConfig = {
  rpc: "https://rpc.elysium.kinetiq.xyz",
  chainId: 99901,
  multicall: "0xcA11bde05977b3631167028862bE2a173976CA11",
  stateView: "0x27eD73aE0652fdCf71d6793412A7525f32bE9dfE",
  hyperliquid: "https://api.hyperliquid.xyz/info",
  usdc: "0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65",
  liquid: "0x247c91C14b5Aa1cF57f02d638B0287F5cd69E9f6",
  liquidWait: "0x358B0d6eA642689C1C0f5424d36adB8B09DBcecB",
  feeder: "0x2089dC3D846e5c0C06Cc6E9B35Abf22AB925600f",
  oracle: "0x51670e163023CC3fa63d857A655A430321Fc1f56",
  feeds: {
    hypeUsdc: "0xb3032695ffb0a66e6342876dd2386835471466cb2bb70f341947d98a69e265cc",
    khypeWhype: "0x890fc38d3b7ce4482eaab02250be48f596aec0b60c10f29fa2d1ccf356c3740c",
    ascend: "0xe522ea941342149346fa6641ad358ac49d8bf10abec2bba9106ac6bcc42b210c",
  },
  pokeEverySec: 540,
  gasMultiple: 10,
  cycleGas: 1_600_000,
  minUsd: 0.5,
  maxTwapGapTicks: 100,
  hypeBandPct: 2,
  maxGasPriceGwei: 5,
  rpcGapMs: 180,
};

export interface DropAction { what: string; tx?: string; confirmed?: boolean | null; note?: string }
export interface DropReport {
  ok: boolean;
  mode: "live" | "watch-only" | "dry-run" | "paused";
  time: string;
  keeper: string | null;
  /** off: the feeder is not set up yet. idle: too little waiting. warming: waiting for prices. fed: it fed the drop. */
  status: "off" | "idle" | "warming" | "fed" | "paused";
  reason: string;
  /** The drop's level, in whole $liquid as decimal strings, once the feeder exists. */
  drop?: { wallet: string; held: string; cap: string; room: string; sent: string; burned: string; full: boolean };
  waitingUsdc?: string;
  neededUsd?: number;
  actions: DropAction[];
  warnings: string[];
  error?: string;
}

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
const INBOX_ABI = ["function target() view returns (address)", "function forward(address token) returns (uint256)"];
const FEEDER_ABI = [
  "function drop() view returns (address)", "function successor() view returns (address)", "function cap() view returns (uint256)",
  "function held() view returns (uint256)", "function room() view returns (uint256)", "function sentToDrop() view returns (uint256)",
  "function burned() view returns (uint256)", "function feed(uint256 maxUsdc) returns (uint256, uint256, uint256)",
];
const ORACLE_ABI = [
  "function feeds(bytes32) view returns (address currency0, address currency1, uint32 lastTime, int24 lastTick, int56 tickCumulative, uint16 latestIndex, uint16 count)",
  "function meanTick(bytes32 id) view returns (int24)",
  "function getRoute(address tokenIn, address tokenOut) view returns (bytes32[] path, uint24[] feesPips)",
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

export async function runDrop(deps: Deps, cfg: DropConfig = DROP_CONFIG): Promise<DropReport> {
  const { Wallet, utils } = deps.ethers;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const report: DropReport = { ok: true, mode: "watch-only", time: new Date().toISOString(), keeper: null, status: "idle", reason: "", actions: [], warnings: [] };
  if (deps.env("KEEPER_PAUSED") === "1" || deps.env("RESERVE_PAUSED") === "1" || deps.env("DROP_PAUSED") === "1") {
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
  const ERC20 = I(ERC20_ABI), INBOX = I(INBOX_ABI), FEEDER = I(FEEDER_ABI), OR = I(ORACLE_ABI), SV = I(STATEVIEW_ABI), MC = I(MULTICALL_ABI);
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
  const FEEDS = [cfg.feeds.hypeUsdc, cfg.feeds.khypeWhype, cfg.feeds.ascend], NAMES = ["HYPE/USDC", "kHYPE/HYPE", "$liquid"];
  const latest = await rpc("eth_getBlockByNumber", ["latest", false]);
  const now = Number(latest.timestamp);
  const calls: Call[] = [
    { to: cfg.feeder, iface: FEEDER, fn: "drop" }, // 0: does the feeder exist?
    { to: cfg.liquidWait, iface: INBOX, fn: "target" }, // 1
    { to: cfg.usdc, iface: ERC20, fn: "balanceOf", args: [cfg.liquidWait] }, // 2
    { to: cfg.usdc, iface: ERC20, fn: "balanceOf", args: [cfg.feeder] }, // 3
    { to: cfg.feeder, iface: FEEDER, fn: "successor" }, // 4
    { to: cfg.feeder, iface: FEEDER, fn: "cap" }, { to: cfg.feeder, iface: FEEDER, fn: "held" }, { to: cfg.feeder, iface: FEEDER, fn: "room" }, // 5..7
    { to: cfg.feeder, iface: FEEDER, fn: "sentToDrop" }, { to: cfg.feeder, iface: FEEDER, fn: "burned" }, // 8, 9
    { to: cfg.oracle, iface: OR, fn: "getRoute", args: [cfg.usdc, cfg.liquid] }, // 10
    ...FEEDS.map((id) => ({ to: cfg.oracle, iface: OR, fn: "feeds", args: [id] })), // 11..13
    ...FEEDS.map((id) => ({ to: cfg.oracle, iface: OR, fn: "meanTick", args: [id] })), // 14..16
    ...FEEDS.map((id) => ({ to: cfg.stateView, iface: SV, fn: "getSlot0", args: [id] })), // 17..19
  ];
  const res = await multicall(calls);
  const big = (i: number) => BigInt((res[i]?.[0] ?? 0).toString());
  const whole = (v: bigint) => utils.formatUnits(v.toString(), 18);

  if (!res[0]) { report.status = "off"; report.reason = "the drop feeder is not on-chain yet"; return report; }
  report.drop = { wallet: String(res[0][0]), held: whole(big(6)), cap: whole(big(5)), room: whole(big(7)), sent: whole(big(8)), burned: whole(big(9)), full: big(7) === 0n };
  if (lower(res[1]?.[0]) !== lower(cfg.feeder)) {
    report.status = "off";
    report.reason = /^0x0{40}$/.test(lower(res[1]?.[0])) ? "the set-aside USDC is not pointed at the feeder yet (the owner's timelock step)" : "the set-aside USDC points somewhere else";
    return report;
  }
  const passing = !!res[4] && !/^0x0{40}$/.test(lower(res[4][0])); // a successor is named: the feeder only passes USDC on
  const atWait = big(2), atFeeder = big(3), waiting = atWait + atFeeder;
  report.waitingUsdc = utils.formatUnits(waiting.toString(), 6);
  const hypeUsd = 1.0001 ** Number(res[17].tick) * 1e12;
  const gasPriceWei = Number(BigInt(await rpc("eth_gasPrice")));
  const neededUsd = Math.max(cfg.minUsd, (cfg.gasMultiple * cfg.cycleGas * gasPriceWei * hypeUsd) / 1e18);
  report.neededUsd = neededUsd;
  const waitingUsd = Number(waiting) / 1e6;
  if (waitingUsd < neededUsd) {
    report.status = "idle";
    report.reason = `$${waitingUsd.toFixed(2)} of the set-aside share waiting; it is used once it reaches $${neededUsd.toFixed(2)}`;
    return report;
  }
  if (gasPriceWei > cfg.maxGasPriceGwei * 1e9) { report.status = "idle"; report.reason = `there is work to do but the network fee is unusually high (${(gasPriceWei / 1e9).toFixed(1)} gwei)`; return report; }
  if (!wallet) { report.status = "idle"; report.reason = `$${waitingUsd.toFixed(2)} is ready for the drop; no keeper wallet is configured`; return report; }

  if (!passing) {
    if (!res[10] || res[10].path.length === 0) { report.status = "warming"; report.reason = "the reserve has no route from USDC to $liquid yet"; return report; }
    // ---- 1. a price reading, if the last one is getting old
    const lastTimes = [11, 12, 13].map((i) => Number(res[i]?.lastTime ?? 0));
    let poked = false;
    if (lastTimes.some((t) => now - t >= cfg.pokeEverySec)) {
      poked = (await act("price reading for the drop", cfg.oracle, OR.encodeFunctionData("poke", [FEEDS]))).ok;
      if (!poked) { report.status = "warming"; report.reason = "could not take a price reading"; return report; }
    }
    // ---- 2. are the prices trustworthy right now?
    const mean = [14, 15, 16].map((i) => (res[i] ? Number(res[i][0]) : null));
    const spot = [17, 18, 19].map((i) => Number(res[i].tick));
    let wait = "";
    if (mean.some((m) => m === null)) wait = "building 30 minutes of price readings";
    else if (poked && lastTimes.some((t) => now - t > 3600)) wait = "the price readings had gone stale; building 30 minutes of fresh ones";
    else {
      const off = mean.map((m, i) => Math.abs((m as number) - spot[i]));
      const worst = off.indexOf(Math.max(...off));
      if (off[worst] > cfg.maxTwapGapTicks) wait = `the ${NAMES[worst]} price is ${(off[worst] / 100).toFixed(1)}% away from its 30-minute average; waiting for it to settle`;
    }
    if (!wait) {
      try {
        const post = async (body: unknown) => (await deps.fetch(cfg.hyperliquid, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
        const meta: any = await post({ type: "spotMeta" }), mids: any = await post({ type: "allMids" });
        const tn: Record<number, string> = {};
        for (const t of meta.tokens) tn[t.index] = t.name;
        const pair: Record<string, string> = {};
        for (const u of meta.universe) pair[`${tn[u.tokens[0]]}/${tn[u.tokens[1]]}`] = u.name;
        const mh = Number(mids[pair["HYPE/USDC"]]);
        if (!(mh > 0)) wait = "the outside price is unavailable";
        else if ((hypeUsd / mh - 1) * 100 > cfg.hypeBandPct) wait = `the pool prices HYPE ${((hypeUsd / mh - 1) * 100).toFixed(1)}% above Hyperliquid (limit ${cfg.hypeBandPct}%), so buying with USDC here now would overpay`;
      } catch {
        wait = "the outside price could not be fetched";
      }
    }
    if (wait) { report.status = "warming"; report.reason = `$${waitingUsd.toFixed(2)} ready for the drop; ${wait}`; return report; }
  }

  // ---- 3. move the USDC on and feed
  let atHand = atFeeder;
  if (atWait > 0n) {
    if (!(await act(`pass ${utils.formatUnits(atWait.toString(), 6)} USDC of the set-aside share to the feeder`, cfg.liquidWait, INBOX.encodeFunctionData("forward", [cfg.usdc]))).ok) {
      if (atFeeder === 0n) { report.status = "warming"; report.reason = "could not pass the USDC on this run"; return report; }
    } else if (dry) { report.status = "fed"; report.reason = "dry run: would have fed the drop"; return report; } // the next step cannot be simulated until this one is sent
    else atHand += atWait;
  }
  const label = (v: bigint, piece: boolean) => passing ? `pass ${utils.formatUnits(v.toString(), 6)} USDC on to the feeder's successor`
    : `feed with ${utils.formatUnits(v.toString(), 6)} USDC${piece ? " (a piece; a pool is thin)" : ""}: half to kHYPE in the reserve, half to $liquid for ${report.drop!.full ? "the burn (the drop is full)" : "the drop"}`;
  const MAX = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
  let r = await act(label(atHand, false), cfg.feeder, FEEDER.encodeFunctionData("feed", [MAX]));
  // Thin pools: if the whole amount would move a price more than 1%, do a piece; the rest goes next run.
  for (let div = 2n; !r.ok && (r.code === "0x2c19b8b8" || r.code === "0x82ba0f27") && div <= 16n; div *= 2n) {
    report.actions.pop();
    r = await act(label(atHand / div, true), cfg.feeder, FEEDER.encodeFunctionData("feed", [(atHand / div).toString()]));
  }
  report.status = r.ok ? "fed" : "warming";
  report.reason = r.ok ? `${dry ? "dry run: would have fed" : "fed"} the reserve and the drop` : "prices are ready; nothing could be fed this run";
  return report;
}
