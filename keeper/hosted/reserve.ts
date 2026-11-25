// Liquid Reserve: the bot's reserve job (Elysium side).
//
// The protocol's cut of vault fees lands in the vault fee inbox. This job moves
// it into the reserve when that is worth the network fees:
//
//   fee inbox -> fee splitter (20% creator / 80% reserve) -> allocator
//     40% -> kHYPE, locked in the reserve
//     40% -> KNTQ, sent to the bridge (staked and locked on HyperEVM)
//     20% -> USDC, parked until the $liquid token exists
//
// Swaps are priced against the reserve's own 30-minute average price, which the
// bot keeps by taking a price reading every run. Readings cost network fees, so
// the bot only starts taking them once enough fees are waiting, and it moves
// nothing until:
//   1. there are 30 minutes of readings and the latest one is recent
//   2. the average agrees with the pool's current price
//   3. the pool's price is not worse for the reserve than an independent market
//      (Hyperliquid spot): it will not sell a token the pool prices too low, nor buy
//      one the pool prices too high. A price that is off in the reserve's favour is fine.
// The contracts then refuse any swap that lands more than 1% below the average.
//
// Fees paid in $liquid (the HYPE-$liquid vault earns part of its fees in it) take the same road, once the
// reserve's swapper and oracle have a route for $liquid (added through the 48-hour timelock, 2026-11). The
// allocator sells that $liquid in Ascend's pool and buys the same three assets with it. $liquid has its own price
// feed, read only while $liquid is waiting, and its own check: a $liquid price that is off its 30-minute average
// holds back the $liquid alone, never the other tokens.
//
// Fees paid in kHYPE (the HYPE staking vault pays its fee in it) take the same road too: 40% of what reaches the
// allocator is locked as it is, and the rest is sold for HYPE in the kHYPE pool and buys KNTQ and USDC. The oracle
// has had those routes since the reserve was created; the job still checks that they are there before it moves any.
//
// Fees paid in wANTx (the wANTx-USDC vault earns part of its fees in it) take the same road once the swapper and
// oracle have a route for wANTx (also added through the timelock). The allocator sells it for USDC in the vault's
// own pool, the only place wANTx trades on Elysium, and that USDC buys kHYPE and KNTQ like any USDC coming in.
// That pool is thin and the vault is its only liquidity, so wANTx has three checks of its own, and failing one
// holds back the wANTx alone: the pool must have enough liquidity at its price (otherwise nothing can be sold and
// the wANTx is not even counted as waiting), the price must sit close to its 30-minute average, and the pool must not
// price wANTx more than a few percent below Hyperliquid's ANTX market. The contracts cannot see Hyperliquid: on
// their own they only compare with the 30-minute average of this one thin pool. So what is at stake if someone
// pushes that pool around is the wANTx waiting on the fee path at that moment, which is why the job moves it early.
//
// Fees paid in wNVDAx (the wNVDAx-USDC vault) are handled exactly like wANTx, with the same three checks and its
// own timelock step: sold for USDC in that vault's own pool, checked against Hyperliquid's NVDAX market. The one
// difference is the pool's token order (wNVDAx is its first token, USDC its second), which turns the price and
// the "how much can the pool take" sums around (`tokenIs0`). wNVDAx has other pools on Elysium; the reserve's
// route does not use them.
//
// A HYPE-only reserve (2026-11): the owner can re-point the reserve's swap and price contracts, through the
// timelock, at a router that turns the allocator's KNTQ part into kHYPE locked in the reserve (HypeOnlyRouter).
// The job notices by reading which swapper SwapConfig names. From then on KNTQ is no longer bought, so a KNTQ
// price that is too high, or a HYPE/KNTQ average that has not settled, no longer holds anything back unless
// fees paid in KNTQ are themselves waiting to be sold.
//
// Staking yield on the locked kHYPE is collected at least once a day, whether or not
// fees are moving. The reserve values its kHYPE at the oracle's average price, and that
// only moves when a price reading is taken, so on a quiet day the bot takes one reading
// of the kHYPE feed and, once the average has caught up (30 minutes), sends whatever
// yield shows to the yield contract.
//
// No imports: the same code runs in Deno (Supabase Edge Functions) and in Node
// (tests). ethers v5 is passed in.

export interface Lib { Wallet: any; utils: any }
export interface Deps {
  ethers: Lib;
  fetch: typeof fetch;
  env: (key: string) => string | undefined;
  sleep?: (ms: number) => Promise<void>;
}
/** A fee token the reserve sells in a vault's own thin pool against USDC (wANTx, wNVDAx). `tokenIs0`: the token is
 *  the pool's first token and USDC its second (wNVDAx); left out when USDC comes first (wANTx). */
export interface ThinToken { token: string; feed: string; market: [string, string]; bandPct: number; tokenIs0?: boolean }
export interface ReserveConfig {
  chainId: number;
  rpc: string;
  multicall: string;
  stateView: string;
  hyperliquid: string;
  tokens: { WHYPE: string; USDC: string; KNTQ: string; KHYPE: string };
  /** Price feeds the oracle keeps, by pool id. */
  feeds: { hypeUsdc: string; hypeKntq: string; khypeWhype: string };
  feeInbox: string; feeSplitter: string; allocator: string; reserve: string; bridgeOut: string; oracle: string;
  creatorWait: string; liquidWait: string; yieldWait: string;
  /** The $liquid coin and the pool the oracle prices it from (Ascend's $liquid/WHYPE pool). Fees paid in $liquid
   *  are moved only once the oracle has a route for it. `liquidIs0`: $liquid is the pool's first token. */
  liquid?: { token: string; feed: string; liquidIs0: boolean };
  /** wANTx and the pool the oracle prices it from: the wANTx-USDC vault's own pool, USDC first, wANTx second. Fees
   *  paid in wANTx are moved only once the oracle has routes for it. `market`: the Hyperliquid spot pair the pool is
   *  checked against. `bandPct`: most the pool may price wANTx below that market, in percent. */
  antx?: ThinToken;
  /** wNVDAx, the same arrangement in the wNVDAx-USDC vault's own pool, where wNVDAx is the FIRST token. */
  nvda?: ThinToken;
  /** The reserve's SwapConfig and the HYPE-only router. While SwapConfig names the router as its swapper, the
   *  allocator's KNTQ part is locked as kHYPE instead. */
  hypeOnly?: { swapConfig: string; router: string };
  /** Take a price reading when the last one is older than this. */
  pokeEverySec: number;
  /** Start moving fees when they are worth at least this many times the network fees of a full cycle... */
  gasMultiple: number;
  /** ...where a full cycle is about this much gas (price readings, forwarding, splitting, swapping)... */
  cycleGas: number;
  /** ...and never for less than this, in dollars. */
  minCycleUsd: number;
  /** Leave a token alone while less than this much of it is waiting, in dollars. */
  minTokenUsd: number;
  /** Refresh the kHYPE price (so yield can show) when its last reading is older than this; collect whatever yield shows. */
  yieldEverySec: number;
  /** Ignore staking yield smaller than this (dust), in HYPE. */
  minYieldHype: string;
  /** Most the 30-minute average may differ from the current pool price, in ticks (100 is about 1%). */
  maxTwapGapTicks: number;
  /** Most the pool price may be worse for the reserve than Hyperliquid spot, in percent. */
  marketBandPct: { hype: number; kntq: number };
  maxGasPriceGwei: number;
  minGasHype: string;
  rpcGapMs: number;
}

export const RESERVE_CONFIG: ReserveConfig = {
  chainId: 99901,
  rpc: "https://rpc.elysium.kinetiq.xyz",
  multicall: "0xcA11bde05977b3631167028862bE2a173976CA11",
  stateView: "0x27eD73aE0652fdCf71d6793412A7525f32bE9dfE",
  hyperliquid: "https://api.hyperliquid.xyz/info",
  tokens: {
    WHYPE: "0xbA876237B0F021A6c6D852d6c26E107997cC5E81",
    USDC: "0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65",
    KNTQ: "0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0",
    KHYPE: "0x248888D396A546A69A188f3Deb476964e581E9d0",
  },
  feeds: {
    hypeUsdc: "0xb3032695ffb0a66e6342876dd2386835471466cb2bb70f341947d98a69e265cc",
    hypeKntq: "0xf9b8a9101438145d62c9f03156b203c6c573931167e2d36f9061a32575706c8a",
    khypeWhype: "0x890fc38d3b7ce4482eaab02250be48f596aec0b60c10f29fa2d1ccf356c3740c",
  },
  feeInbox: "0x2AfD3850794b84205667CE2826b09FA5bf1c3a5c",
  feeSplitter: "0x635321eE277e3aa3DDd62a2A63681dcB4fFC7E4e",
  allocator: "0xB7c3865FfF8e88276a1D57D31869A2b0a839356f",
  reserve: "0xeAd849357Ba8Dbc5A6F205AA0036Bd3d677b0D61",
  bridgeOut: "0x0423ba7C14b3B0c986b1B6858598439A251Cc7d4",
  oracle: "0x51670e163023CC3fa63d857A655A430321Fc1f56",
  creatorWait: "0x0a3293Ee6D333A6Da9e0e09A9129b490193Bb1B4",
  liquidWait: "0x358B0d6eA642689C1C0f5424d36adB8B09DBcecB",
  yieldWait: "0xb99d0AFf4f65AC80c268a3050f72a107329909eE",
  liquid: { token: "0x247c91C14b5Aa1cF57f02d638B0287F5cd69E9f6", feed: "0xe522ea941342149346fa6641ad358ac49d8bf10abec2bba9106ac6bcc42b210c", liquidIs0: true },
  antx: { token: "0xd7d0288Cef796cCc5752B4352f80b74aD2929334", feed: "0x8df1ba0bdc5bcba046cbaa33ee32a17f209c39d008cd204931eff3ab76430851", market: ["ANTX", "USDC"], bandPct: 3 },
  nvda: { token: "0x11265018bF2d5a99fb71EFaE73aD670203C1dF44", feed: "0x257e5287163c7ed45b022ed1b9a04fcd116bab320b2e538490e85a49388ad7a1", market: ["NVDAX", "USDC"], bandPct: 3, tokenIs0: true },
  hypeOnly: { swapConfig: "0xe885e7D7Fda7e481Fe7466C4adB93b0C3045FF87", router: "0x4A90a0F30fC1a1862D54327FdC15cf348aa978E1" },
  pokeEverySec: 540,
  gasMultiple: 10, // was 50 until 2026-11-18: at the reserve's current size 50 kept small amounts waiting for days
  cycleGas: 1_500_000,
  minCycleUsd: 0.5,
  minTokenUsd: 0.1,
  yieldEverySec: 86_400,
  minYieldHype: "0.000001",
  maxTwapGapTicks: 100,
  marketBandPct: { hype: 2, kntq: 3 },
  maxGasPriceGwei: 5,
  minGasHype: "0.01",
  rpcGapMs: 180, // the public RPC allows about 7 requests a second
};

export interface ReserveAction { what: string; tx?: string; confirmed?: boolean | null; note?: string }
export interface ReserveReport {
  ok: boolean;
  mode: "live" | "watch-only" | "dry-run" | "paused";
  time: string;
  block?: number;
  keeper: string | null;
  gasHype?: string;
  /** not-deployed: the reserve contracts are not on-chain. not-connected: the fee inbox does not point at them yet.
   *  idle: too little waiting to be worth moving. warming: taking price readings. moving: fees moved this run. */
  status: "not-deployed" | "not-connected" | "idle" | "warming" | "moving" | "paused";
  reason: string;
  waitingUsd?: number;
  neededUsd?: number;
  prices?: { hypeUsd: number; kntqUsd: number };
  /** Token amounts as decimal strings. */
  waiting?: Record<string, string>;
  holdings?: { khypeLocked: string; khypePrincipalHype: string; kntqAtBridge: string; usdcParked: string; yieldWaitingKhype: string; creatorWaiting: Record<string, string> };
  actions: ReserveAction[];
  warnings: string[];
  error?: string;
}

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
const INBOX_ABI = ["function target() view returns (address)", "function forward(address token) returns (uint256)"];
const SPLITTER_ABI = ["function distribute(address token) returns (uint256, uint256)"];
const ALLOCATOR_ABI = ["function allocate(address token) returns (uint256[3])", "function allocatePartial(address token, uint256 maxAmount) returns (uint256[3])"];
const RESERVE_ABI = ["function principal(address) view returns (uint256)", "function pendingYield(address) view returns (uint256)", "function harvest(address asset) returns (uint256)"];
const BRIDGE_ABI = ["function minAmount() view returns (uint256)", "function bridge() returns (uint256)"];
const ORACLE_ABI = [
  "function feeds(bytes32) view returns (address currency0, address currency1, uint32 lastTime, int24 lastTick, int56 tickCumulative, uint16 latestIndex, uint16 count)",
  "function meanTick(bytes32 id) view returns (int24)",
  "function isKeeper(address) view returns (bool)",
  "function getRoute(address tokenIn, address tokenOut) view returns (bytes32[] path, uint24[] feesPips)",
  "function poke(bytes32[] ids)",
];
const STATEVIEW_ABI = ["function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)", "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)"];
const SWAPCONFIG_ABI = ["function swapper() view returns (address)"];
const MULTICALL_ABI = ["function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])"];
const REVERTS: Record<string, string> = {
  "0x2c19b8b8": "the swap would land more than 1% below the average price",
  "0x82ba0f27": "a pool on the way cannot take the whole amount right now",
  "0x81fff07f": "there is no route for this token",
  "0x6e11123c": "the price readings are too old",
  "0xdb5860d8": "there are not 30 minutes of price readings yet",
  "0x637c1772": "nothing to forward",
  "0x01663f24": "nothing to split",
  "0xe280e5c9": "nothing to allocate",
  "0x4c8d388c": "the amount is too small to price",
  "0xbd49034f": "below the bridge's minimum batch",
  "0xf512b278": "this wallet may not take price readings",
  "0xdfa03a04": "the fee inbox is not connected",
};
const DEC: Record<string, number> = { WHYPE: 18, USDC: 6, KNTQ: 18, KHYPE: 18, LIQUID: 18, WANTX: 18, WNVDAX: 18 };
/** How a token is written in reports. */
const nm = (s: string) => (s === "LIQUID" ? "$liquid" : s === "KHYPE" ? "kHYPE" : s === "WANTX" ? "wANTx" : s === "WNVDAX" ? "wNVDAx" : s);

export async function runReserve(deps: Deps, cfg: ReserveConfig = RESERVE_CONFIG): Promise<ReserveReport> {
  const { Wallet, utils } = deps.ethers;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const report: ReserveReport = { ok: true, mode: "watch-only", time: new Date().toISOString(), keeper: null, status: "idle", reason: "", actions: [], warnings: [] };
  if (deps.env("KEEPER_PAUSED") === "1" || deps.env("RESERVE_PAUSED") === "1") {
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
      if (/rate limit|too many/i.test(j.error.message ?? "") && tries < 4) { await sleep(1200); return rpc(method, params, tries + 1); }
      throw Object.assign(new Error(j.error.message ?? "RPC error"), { data: j.error.data, code: j.error.code });
    }
    return j.result;
  }
  const I = (abi: string[]) => new utils.Interface(abi);
  const ERC20 = I(ERC20_ABI), INBOX = I(INBOX_ABI), SPLIT = I(SPLITTER_ABI), ALLOC = I(ALLOCATOR_ABI), RES = I(RESERVE_ABI), BR = I(BRIDGE_ABI), OR = I(ORACLE_ABI), SV = I(STATEVIEW_ABI), MC = I(MULTICALL_ABI), SC = I(SWAPCONFIG_ABI);
  type Call = { to: string; iface: any; fn: string; args?: unknown[] };
  async function multicall(calls: Call[]): Promise<any[]> {
    const data = MC.encodeFunctionData("aggregate3", [calls.map((c) => ({ target: c.to, allowFailure: true, callData: c.iface.encodeFunctionData(c.fn, c.args ?? []) }))]);
    const [rows] = MC.decodeFunctionResult("aggregate3", await rpc("eth_call", [{ to: cfg.multicall, data }, "latest"]));
    return rows.map((r: any, i: number) => (r.success && r.returnData !== "0x" ? calls[i].iface.decodeFunctionResult(calls[i].fn, r.returnData) : null));
  }
  const hex = (n: number | bigint) => "0x" + BigInt(n).toString(16);
  const revertReason = (e: any) => {
    const data = String(e?.data?.data ?? e?.data ?? "");
    return REVERTS[data.slice(0, 10)] ?? String(e?.message ?? e).slice(0, 160);
  };
  const revertCode = (e: any) => String(e?.data?.data ?? e?.data ?? "").slice(0, 10);

  // ---- simulate, sign, send, wait
  async function send(to: string, data: string): Promise<{ tx?: string; confirmed?: boolean | null; failed?: string; code?: string; dry?: boolean }> {
    let gas: bigint;
    try {
      gas = BigInt(await rpc("eth_estimateGas", [{ from: wallet.address, to, data }]));
    } catch (e) {
      return { failed: revertReason(e), code: revertCode(e) };
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
  /** Sends and records it. True when it went through (or would, in a dry run). */
  async function act(what: string, to: string, data: string): Promise<{ ok: boolean; code?: string }> {
    const r = await send(to, data);
    if (r.failed) { report.actions.push({ what, note: `skipped: ${r.failed}` }); return { ok: false, code: r.code }; }
    if (r.dry) { report.actions.push({ what, note: "dry run: would have been sent" }); return { ok: true }; }
    report.actions.push({ what, tx: r.tx, confirmed: r.confirmed });
    if (r.confirmed === false) report.ok = false;
    return { ok: r.confirmed === true };
  }

  // ---- everything, in one request
  const T = cfg.tokens, SYMS = ["WHYPE", "USDC", "KNTQ"] as const, FEEDS = [cfg.feeds.hypeUsdc, cfg.feeds.hypeKntq, cfg.feeds.khypeWhype];
  const latest = await rpc("eth_getBlockByNumber", ["latest", false]);
  const now = Number(latest.timestamp);
  report.block = Number(latest.number);
  const calls: Call[] = [{ to: cfg.feeInbox, iface: INBOX, fn: "target" }];
  const bal = (token: string, who: string): Call => ({ to: token, iface: ERC20, fn: "balanceOf", args: [who] });
  for (const who of [cfg.feeInbox, cfg.feeSplitter, cfg.allocator, cfg.creatorWait]) for (const s of SYMS) calls.push(bal(T[s], who)); // 1..12
  calls.push(bal(T.KNTQ, cfg.bridgeOut), { to: cfg.bridgeOut, iface: BR, fn: "minAmount" }); // 13, 14
  calls.push(bal(T.KHYPE, cfg.reserve), { to: cfg.reserve, iface: RES, fn: "principal", args: [T.KHYPE] }, { to: cfg.reserve, iface: RES, fn: "pendingYield", args: [T.KHYPE] }); // 15..17
  calls.push(bal(T.USDC, cfg.liquidWait), bal(T.KHYPE, cfg.yieldWait)); // 18, 19
  for (const id of FEEDS) calls.push({ to: cfg.oracle, iface: OR, fn: "feeds", args: [id] }); // 20..22
  for (const id of FEEDS) calls.push({ to: cfg.oracle, iface: OR, fn: "meanTick", args: [id] }); // 23..25
  for (const id of FEEDS) calls.push({ to: cfg.stateView, iface: SV, fn: "getSlot0", args: [id] }); // 26..28
  // $liquid, at the end so the positions above never move: its balances along the path (lq0..lq0+3), whether the
  // oracle has a route for it yet (lq0+4), and its price feed (lq0+5 last reading, lq0+6 average, lq0+7 price now)
  const LQ = cfg.liquid, lq0 = calls.length;
  if (LQ) {
    for (const who of [cfg.feeInbox, cfg.feeSplitter, cfg.allocator, cfg.creatorWait]) calls.push(bal(LQ.token, who));
    calls.push({ to: cfg.oracle, iface: OR, fn: "getRoute", args: [LQ.token, T.KHYPE] }, { to: cfg.oracle, iface: OR, fn: "feeds", args: [LQ.feed] },
      { to: cfg.oracle, iface: OR, fn: "meanTick", args: [LQ.feed] }, { to: cfg.stateView, iface: SV, fn: "getSlot0", args: [LQ.feed] });
  }
  // kHYPE as a fee token (the staking vault's fee), also at the end: its balances along the path (kh0..kh0+3) and
  // whether the oracle can price it into the two assets it is sold for (kh0+4, kh0+5)
  const kh0 = calls.length;
  for (const who of [cfg.feeInbox, cfg.feeSplitter, cfg.allocator, cfg.creatorWait]) calls.push(bal(T.KHYPE, who));
  calls.push({ to: cfg.oracle, iface: OR, fn: "getRoute", args: [T.KHYPE, T.KNTQ] }, { to: cfg.oracle, iface: OR, fn: "getRoute", args: [T.KHYPE, T.USDC] });
  // wANTx, last of all: its balances along the path (ax0..ax0+3), whether the oracle can price it into each of the
  // three assets (ax0+4..ax0+6), its price feed (ax0+7 last reading, ax0+8 average, ax0+9 price now) and how much
  // liquidity its pool has at that price (ax0+10)
  const thinCalls = (X: ThinToken) => {
    for (const who of [cfg.feeInbox, cfg.feeSplitter, cfg.allocator, cfg.creatorWait]) calls.push(bal(X.token, who));
    for (const out of [T.KHYPE, T.KNTQ, T.USDC]) calls.push({ to: cfg.oracle, iface: OR, fn: "getRoute", args: [X.token, out] });
    calls.push({ to: cfg.oracle, iface: OR, fn: "feeds", args: [X.feed] }, { to: cfg.oracle, iface: OR, fn: "meanTick", args: [X.feed] },
      { to: cfg.stateView, iface: SV, fn: "getSlot0", args: [X.feed] }, { to: cfg.stateView, iface: SV, fn: "getLiquidity", args: [X.feed] });
  };
  const AX = cfg.antx, ax0 = calls.length;
  if (AX) thinCalls(AX);
  // which swapper the reserve asks, after everything else (ho0)
  const HO = cfg.hypeOnly, ho0 = calls.length;
  if (HO) calls.push({ to: HO.swapConfig, iface: SC, fn: "swapper" });
  // wNVDAx, added later and so after everything above (no earlier position moves): the same eleven reads as
  // wANTx (nv0..nv0+10)
  const NV = cfg.nvda, nv0 = calls.length;
  if (NV) thinCalls(NV);
  const res = await multicall(calls);
  const gasPriceWei = Number(BigInt(await rpc("eth_gasPrice")));

  if (wallet) {
    const b = BigInt(await rpc("eth_getBalance", [wallet.address, "latest"]));
    report.gasHype = utils.formatEther(b.toString());
    if (b < BigInt(utils.parseEther(cfg.minGasHype).toString())) report.warnings.push(`keeper wallet is low on HYPE for fees (${report.gasHype})`);
  }

  const lower = (a: unknown) => String(a ?? "").toLowerCase();
  if (!res[14] || !res[20]) { report.status = "not-deployed"; report.reason = "the reserve contracts are not on-chain yet"; return report; }
  const big = (i: number) => BigInt((res[i]?.[0] ?? 0).toString());
  const fmt = (v: bigint, sym: string) => utils.formatUnits(v.toString(), DEC[sym]);
  // true once the timelock has pointed the reserve at the HYPE-only router: the KNTQ part is locked as kHYPE
  const hypeOnly = !!HO && lower(res[ho0]?.[0]) === lower(HO.router);
  const MIX = hypeOnly ? "80% kHYPE, 20% USDC" : "40% kHYPE, 40% KNTQ, 20% USDC";
  const at = (group: number) => Object.fromEntries(SYMS.map((s, k) => [s, big(1 + group * 3 + k)])) as Record<string, bigint>;
  const inbox = at(0), splitter = at(1), allocator = at(2), creator = at(3);
  // $liquid joins the tokens this job moves only once the oracle can price it (the timelock has added its route)
  const liquidOn = !!LQ && !!res[lq0 + 4] && res[lq0 + 4].path.length > 0 && !!res[lq0 + 5] && Number(res[lq0 + 5].lastTime) > 0 && !!res[lq0 + 7];
  const TOK: Record<string, string> = { ...T }, ALL: string[] = [...SYMS];
  if (liquidOn) {
    ALL.push("LIQUID"); TOK.LIQUID = LQ!.token;
    inbox.LIQUID = big(lq0); splitter.LIQUID = big(lq0 + 1); allocator.LIQUID = big(lq0 + 2); creator.LIQUID = big(lq0 + 3);
  }
  // kHYPE fees join once the oracle has both routes they need
  const khypeOn = [kh0 + 4, kh0 + 5].every((i) => !!res[i] && res[i].path.length > 0);
  if (khypeOn) {
    ALL.push("KHYPE");
    inbox.KHYPE = big(kh0); splitter.KHYPE = big(kh0 + 1); allocator.KHYPE = big(kh0 + 2); creator.KHYPE = big(kh0 + 3);
  }
  // wANTx and wNVDAx each join once the oracle has all three of its routes and its feed. `held`: tokens that are
  // set aside before the job even decides whether there is work, because nothing can be done with them right now.
  // `THIN`: the ones that have joined, with the price their own pool gives now (tick, and dollars per token).
  const held: Record<string, string> = {};
  const THIN: { sym: string; c: ThinToken; at: number; tick: number; usd: number; pending: boolean; last: number }[] = [];
  for (const [sym, X, at] of [["WANTX", AX, ax0], ["WNVDAX", NV, nv0]] as [string, ThinToken | undefined, number][]) {
    const on = !!X && [at + 4, at + 5, at + 6].every((i) => !!res[i] && res[i].path.length > 0) && !!res[at + 7] && Number(res[at + 7].lastTime) > 0 && !!res[at + 9];
    if (!on) continue;
    ALL.push(sym); TOK[sym] = X!.token;
    inbox[sym] = big(at); splitter[sym] = big(at + 1); allocator[sym] = big(at + 2); creator[sym] = big(at + 3);
    // How much of the token the pool can take before its price has moved 1% (the contracts' limit): liquidity x
    // price root x 0.5% where the token is the pool's second token, liquidity / price root x 0.5% where it is the
    // first. The job sells in pieces down to a sixteenth, so less room than that means nothing can be sold yet.
    const root = Number(BigInt(res[at + 9].sqrtPriceX96.toString())) / 2 ** 96;
    const room = (X!.tokenIs0 ? Number(big(at + 10)) / root : Number(big(at + 10)) * root) * 0.005;
    const toSell = Number(inbox[sym] + splitter[sym] + allocator[sym]);
    if (big(at + 10) === 0n || room < toSell / 16) held[sym] = "its pool has too little liquidity at its price to take it yet";
    // dollars per token from the pool's own price: the pool quotes its second token per first, 6 decimals against 18
    const tick = Number(res[at + 9].tick);
    THIN.push({ sym, c: X!, at, tick, usd: 1e12 * 1.0001 ** (X!.tokenIs0 ? tick : -tick), pending: false, last: 0 });
  }
  const thinUsd: Record<string, number> = Object.fromEntries(THIN.map((t) => [t.sym, t.usd]));
  report.holdings = {
    khypeLocked: fmt(big(15), "KHYPE"), khypePrincipalHype: fmt(big(16), "KHYPE"), kntqAtBridge: fmt(big(13), "KNTQ"), usdcParked: fmt(big(18), "USDC"),
    yieldWaitingKhype: fmt(big(19), "KHYPE"), creatorWaiting: Object.fromEntries(ALL.map((s) => [s, fmt(creator[s], s)])),
  };

  // ---- prices from the pools themselves (token1 per token0, HYPE is token0 in both)
  const spot = [26, 27, 28].map((i) => Number(res[i].tick));
  const hypeUsd = 1.0001 ** spot[0] * 1e12, kntqPerHype = 1.0001 ** spot[1], kntqUsd = hypeUsd / kntqPerHype;
  report.prices = { hypeUsd, kntqUsd };
  // $liquid in dollars, from the price in Ascend's pool right now (HYPE per $liquid, times HYPE's price)
  const liqTick = liquidOn ? Number(res[lq0 + 7].tick) : 0;
  const liquidUsd = liquidOn ? hypeUsd * 1.0001 ** (LQ!.liquidIs0 ? liqTick : -liqTick) : 0;
  // kHYPE in dollars, from its own pool (HYPE per kHYPE, kHYPE being that pool's first token)
  const khypeUsd = hypeUsd * 1.0001 ** spot[2];
  // wANTx and wNVDAx in dollars come from their own pools (`thinUsd`, worked out above)
  const usdOf = (sym: string, v: bigint) => (Number(v) / 10 ** DEC[sym]) * (sym === "USDC" ? 1 : sym === "KNTQ" ? kntqUsd : sym === "LIQUID" ? liquidUsd : sym === "KHYPE" ? khypeUsd : sym in thinUsd ? thinUsd[sym] : hypeUsd);
  const waiting = Object.fromEntries(ALL.map((s) => [s, inbox[s] + splitter[s] + allocator[s]])) as Record<string, bigint>;
  report.waiting = Object.fromEntries(ALL.map((s) => [s, fmt(waiting[s], s)]));
  // a held token is shown as waiting but does not count towards starting a cycle
  const COUNTED = ALL.filter((s) => !held[s]);
  const heldNote = Object.keys(held).filter((s) => usdOf(s, waiting[s]) >= cfg.minTokenUsd).map((s) => `; ${fmt(waiting[s], s)} ${nm(s)} waits: ${held[s]}`).join("");
  const waitingUsd = COUNTED.reduce((a, s) => a + usdOf(s, waiting[s]), 0);
  const neededUsd = Math.max(cfg.minCycleUsd, (cfg.gasMultiple * cfg.cycleGas * gasPriceWei * hypeUsd) / 1e18);
  report.waitingUsd = waitingUsd; report.neededUsd = neededUsd;

  if (lower(res[0]?.[0]) !== lower(cfg.feeSplitter)) {
    report.status = "not-connected";
    report.reason = /^0x0{40}$/.test(lower(res[0]?.[0])) ? "the vault fee inbox is not connected to the reserve yet" : "the vault fee inbox points somewhere else";
    if (!/^0x0{40}$/.test(lower(res[0]?.[0]))) report.ok = false;
    return report;
  }

  // ---- the bridge and the yield do not depend on the fee cycle
  const kntqAtBridge = big(13), bridgeMin = big(14);
  const bridgeDue = kntqAtBridge >= bridgeMin && bridgeMin > 0n;

  // Staking yield on the locked kHYPE, at least once a day (YIELD_EVERY_HOURS changes how often).
  const everyHours = Number(deps.env("YIELD_EVERY_HOURS"));
  const yieldEverySec = everyHours > 0 ? everyHours * 3600 : cfg.yieldEverySec;
  const yieldKhype = big(17), khypeReadingAge = now - Number(res[22].lastTime);
  const yieldDue = yieldKhype >= BigInt(utils.parseEther(cfg.minYieldHype).toString());
  const readingDue = !yieldDue && big(15) > 0n && khypeReadingAge >= yieldEverySec;

  // ---- is there enough to be worth a cycle?
  const inFlight = COUNTED.some((s) => usdOf(s, splitter[s] + allocator[s]) >= cfg.minTokenUsd);
  const pending = inFlight || waitingUsd >= neededUsd;
  if (!pending && !bridgeDue && !yieldDue && !readingDue) {
    report.status = "idle";
    report.reason = `$${waitingUsd.toFixed(2)} of fees waiting; they move once they reach $${neededUsd.toFixed(2)} (${cfg.gasMultiple} times the network fees of moving them)${heldNote}`;
    return report;
  }
  if (gasPriceWei > cfg.maxGasPriceGwei * 1e9) {
    report.status = "idle";
    report.reason = `there is work to do but the network fee is unusually high (${(gasPriceWei / 1e9).toFixed(1)} gwei)`;
    return report;
  }
  if (!wallet) {
    report.status = "idle";
    report.reason = pending ? `$${waitingUsd.toFixed(2)} of fees are ready to move; no keeper wallet is configured` : "there is work to do; no keeper wallet is configured";
    return report;
  }

  const did: string[] = [];
  if (bridgeDue && (await act(`bridge ${fmt(kntqAtBridge, "KNTQ")} KNTQ to HyperEVM`, cfg.bridgeOut, BR.encodeFunctionData("bridge", []))).ok) did.push("sent the KNTQ batch to the bridge");
  if (yieldDue) {
    if ((await act(`collect ${fmt(yieldKhype, "KHYPE")} HYPE worth of kHYPE staking yield`, cfg.reserve, RES.encodeFunctionData("harvest", [T.KHYPE]))).ok) did.push("collected the kHYPE staking yield");
  } else if (readingDue && !pending) {
    // a fee cycle takes its own readings of every feed, so this is only needed on quiet days
    if ((await act("daily price reading for the kHYPE yield", cfg.oracle, OR.encodeFunctionData("poke", [[cfg.feeds.khypeWhype]]))).ok) did.push("took the daily price reading for the kHYPE yield (any yield is collected about 30 minutes later)");
  }
  if (!pending) {
    report.status = did.length ? "moving" : "idle";
    report.reason = (did.length ? `${dry ? "dry run, nothing sent: " : ""}${did.join("; ")}` : "nothing could be sent this run") + heldNote;
    return report;
  }

  // ---- 1. a price reading, if the last one is getting old
  const lastTimes = [20, 21, 22].map((i) => Number(res[i].lastTime));
  // $liquid's own feed is read only while $liquid is waiting to be converted
  const liqPending = liquidOn && usdOf("LIQUID", waiting.LIQUID) >= cfg.minTokenUsd;
  const liqLast = liqPending ? Number(res[lq0 + 5].lastTime) : 0;
  // and so are wANTx's and wNVDAx's, each only while its pool can take a sale at all
  for (const t of THIN) {
    t.pending = !held[t.sym] && usdOf(t.sym, waiting[t.sym]) >= cfg.minTokenUsd;
    t.last = t.pending ? Number(res[t.at + 7].lastTime) : 0;
  }
  const thinPending = THIN.filter((t) => t.pending);
  let poked = false;
  if ([...lastTimes, ...(liqPending ? [liqLast] : []), ...thinPending.map((t) => t.last)].some((t) => now - t >= cfg.pokeEverySec)) {
    poked = (await act("price reading", cfg.oracle, OR.encodeFunctionData("poke", [[...FEEDS, ...(liqPending ? [LQ!.feed] : []), ...thinPending.map((t) => t.c.feed)]]))).ok;
    if (!poked) { report.status = "warming"; report.reason = "could not take a price reading"; return report; }
  }

  // ---- 2. are the prices trustworthy right now?
  const mean = [23, 24, 25].map((i) => (res[i] ? Number(res[i][0]) : null));
  const names = ["HYPE/USDC", "HYPE/KNTQ", "kHYPE/HYPE"];
  let wait = "";
  // feed 1 is HYPE/KNTQ: with a HYPE-only reserve it is needed only to sell fees that arrive as KNTQ
  const kntqIdle = hypeOnly && usdOf("KNTQ", waiting.KNTQ) < cfg.minTokenUsd;
  const need = (i: number) => !(i === 1 && kntqIdle);
  if (mean.some((m, i) => need(i) && m === null)) wait = "building 30 minutes of price readings";
  else if (poked && lastTimes.some((t, i) => need(i) && now - t > 3600)) wait = "the price readings had gone stale; building 30 minutes of fresh ones";
  else {
    const off = mean.map((m, i) => (need(i) ? Math.abs((m as number) - spot[i]) : 0));
    const worst = off.indexOf(Math.max(...off));
    if (off[worst] > cfg.maxTwapGapTicks) wait = `the ${names[worst]} price is ${(off[worst] / 100).toFixed(1)}% away from its 30-minute average; waiting for it to settle`;
  }
  /** Tokens that should not be moved right now, and why: the pools would give the reserve a bad price. */
  const blocked: Record<string, string> = { ...held };
  for (const t of thinPending) {
    // the 30-minute average of a thin pool: the price now must sit close to it (the outside market is checked below)
    const m = res[t.at + 8] ? Number(res[t.at + 8][0]) : null, name = nm(t.sym);
    if (m === null) blocked[t.sym] = `building 30 minutes of ${name} price readings`;
    else if (poked && now - t.last > 3600) blocked[t.sym] = `the ${name} price readings had gone stale; building 30 minutes of fresh ones`;
    else if (Math.abs(m - t.tick) > cfg.maxTwapGapTicks) blocked[t.sym] = `the ${name} price is ${(Math.abs(m - t.tick) / 100).toFixed(1)}% away from its 30-minute average; waiting for it to settle`;
  }
  if (liqPending) {
    // $liquid has no outside market to compare with: its price now must sit close to its own 30-minute average
    const m = res[lq0 + 6] ? Number(res[lq0 + 6][0]) : null;
    if (m === null) blocked.LIQUID = "building 30 minutes of $liquid price readings";
    else if (poked && now - liqLast > 3600) blocked.LIQUID = "the $liquid price readings had gone stale; building 30 minutes of fresh ones";
    else if (Math.abs(m - liqTick) > cfg.maxTwapGapTicks) blocked.LIQUID = `the $liquid price is ${(Math.abs(m - liqTick) / 100).toFixed(1)}% away from its 30-minute average; waiting for it to settle`;
  }
  if (!wait) {
    try {
      const post = async (body: unknown) => (await deps.fetch(cfg.hyperliquid, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
      const meta: any = await post({ type: "spotMeta" }), mids: any = await post({ type: "allMids" });
      const tn: Record<number, string> = {};
      for (const t of meta.tokens) tn[t.index] = t.name;
      const pair: Record<string, string> = {};
      for (const u of meta.universe) pair[`${tn[u.tokens[0]]}/${tn[u.tokens[1]]}`] = u.name;
      const mh = Number(mids[pair["HYPE/USDC"]]), mk = Number(mids[pair["KNTQ/USDC"]]);
      if (!(mh > 0) || !(mk > 0)) wait = "the outside price is unavailable";
      else {
        // How far each pool price is from the outside market, signed: above (+) or below (-).
        const dh = (hypeUsd / mh - 1) * 100, dk = (kntqUsd / mk - 1) * 100, LH = cfg.marketBandPct.hype, LK = cfg.marketBandPct.kntq;
        // a KNTQ price that is too high only matters while the reserve still buys KNTQ
        const kHigh = !hypeOnly && dk > LK;
        const low = (name: string, d: number, lim: number) => `the pool prices ${name} ${Math.abs(d).toFixed(1)}% below Hyperliquid (limit ${lim}%), so selling ${name} here now would lose value`;
        const high = (name: string, d: number, lim: number) => `the pool prices ${name} ${d.toFixed(1)}% above Hyperliquid (limit ${lim}%), so buying ${name} here now would overpay`;
        // HYPE coming in is sold for KNTQ and USDC. KNTQ coming in is sold for HYPE and USDC. USDC coming in buys both.
        if (dh < -LH) blocked.WHYPE = low("HYPE", dh, LH); else if (kHigh) blocked.WHYPE = high("KNTQ", dk, LK);
        if (dk < -LK) blocked.KNTQ = low("KNTQ", dk, LK); else if (dh > LH) blocked.KNTQ = high("HYPE", dh, LH);
        if (dh > LH) blocked.USDC = high("HYPE", dh, LH); else if (kHigh) blocked.USDC = high("KNTQ", dk, LK);
        // $liquid becomes HYPE first, and that HYPE then buys KNTQ and USDC like any HYPE coming in
        if (liquidOn && !blocked.LIQUID) { if (dh < -LH) blocked.LIQUID = low("HYPE", dh, LH); else if (kHigh) blocked.LIQUID = high("KNTQ", dk, LK); }
        // kHYPE: part is locked as it is; the rest becomes HYPE, which buys KNTQ and USDC like any HYPE coming in
        if (khypeOn) { if (dh < -LH) blocked.KHYPE = low("HYPE", dh, LH); else if (kHigh) blocked.KHYPE = high("KNTQ", dk, LK); }
        // wANTx and wNVDAx are sold for USDC in their vault's own pool, so that pool must not price the token
        // below the outside market; the USDC then buys HYPE and KNTQ like any USDC coming in
        for (const t of THIN) {
          if (blocked[t.sym]) continue;
          const name = nm(t.sym), ma = Number(mids[pair[`${t.c.market[0]}/${t.c.market[1]}`]]), da = (t.usd / ma - 1) * 100, LA = t.c.bandPct;
          if (!(ma > 0)) blocked[t.sym] = `the outside price for ${name} is unavailable`;
          else if (da < -LA) blocked[t.sym] = low(name, da, LA);
          else if (dh > LH) blocked[t.sym] = high("HYPE", dh, LH); else if (kHigh) blocked[t.sym] = high("KNTQ", dk, LK);
        }
        const movable = ALL.filter((x) => usdOf(x, waiting[x]) >= cfg.minTokenUsd);
        if (movable.length && movable.every((x) => blocked[x])) wait = blocked[movable[0]];
      }
    } catch {
      wait = "the outside price could not be fetched";
    }
  }
  if (wait) { report.status = "warming"; report.reason = `$${waitingUsd.toFixed(2)} of fees ready; ${wait}`; return report; }

  // ---- 3. move each token: forward -> split -> swap and lock
  let moved = 0;
  for (const s of ALL) {
    const token = TOK[s];
    if (blocked[s]) {
      if (usdOf(s, waiting[s]) >= cfg.minTokenUsd) report.actions.push({ what: `leave ${fmt(waiting[s], s)} ${nm(s)} where it is for now`, note: blocked[s] });
      continue;
    }
    let inSplitter = splitter[s], inAllocator = allocator[s];
    if (usdOf(s, inbox[s]) >= cfg.minTokenUsd) {
      if (!(await act(`forward ${fmt(inbox[s], s)} ${nm(s)} from the fee inbox`, cfg.feeInbox, INBOX.encodeFunctionData("forward", [token]))).ok) continue;
      if (dry) { moved++; continue; } // the later steps cannot be simulated until this one is really sent
      inSplitter += inbox[s];
    }
    if (usdOf(s, inSplitter) >= cfg.minTokenUsd) {
      if (!(await act(`split ${fmt(inSplitter, s)} ${nm(s)}: 20% creator, 80% reserve`, cfg.feeSplitter, SPLIT.encodeFunctionData("distribute", [token]))).ok) continue;
      if (dry) continue;
      inAllocator += (inSplitter * 8000n) / 10000n;
    }
    if (usdOf(s, inAllocator) < cfg.minTokenUsd) continue;
    // Thin pools: if the whole amount would move the price more than 1%, do it in pieces; the rest goes next run.
    let r = await act(`buy and lock with ${fmt(inAllocator, s)} ${nm(s)}: ${MIX}`, cfg.allocator, ALLOC.encodeFunctionData("allocate", [token]));
    for (let div = 2n; !r.ok && (r.code === "0x2c19b8b8" || r.code === "0x82ba0f27") && div <= 16n; div *= 2n) {
      report.actions.pop();
      r = await act(`buy and lock with ${fmt(inAllocator / div, s)} ${nm(s)} (a piece; the pool is thin): ${MIX}`, cfg.allocator, ALLOC.encodeFunctionData("allocatePartial", [token, (inAllocator / div).toString()]));
    }
    if (r.ok) moved++;
  }

  report.status = moved > 0 ? "moving" : "warming";
  report.reason = moved > 0 ? `${dry ? "dry run: would have moved" : "moved"} fees into the reserve` : "prices are ready; nothing could be moved this run";
  return report;
}
