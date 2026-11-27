// Liquid Reserve: the bot's job for the hedged vault on HyperEVM.
//
// The vault keeps a HYPE/USDC position in a pool and a short on Hyperliquid's HYPE perpetual as large as the
// HYPE it holds. Its own rules decide every size and every price; this job only presses the buttons, in this order:
//
//   1. tend       anyone may: tops the margin up, asks spare or owed USDC back from Hyperliquid, resizes the
//                 short. The job asks the vault whether a call would do anything, and sends it only then.
//   2. rebalance  the keeper only: moves the range back around the price once the price has been outside it for
//                 a while. During a wind-down the same call sells the vault's HYPE.
//   3. deploy     the keeper only: puts idle money (new deposits, collected fees, USDC that came back) to work.
//   4. harvest    anyone may: collects the position's trading fees, once a day.
//   5. forward    anyone may: bridges the vault's fee from its forwarder to the fee splitter on Elysium.
//
// The two keeper calls make the vault swap in its pool, so before either the job requires the pool's price to
// agree closely with Hyperliquid's oracle price, and it tells the vault the tick it saw: the vault refuses if the
// pool has moved by the time the transaction lands.
//
// Hyperliquid carries out the vault's orders and transfers after the block that sent them and reports no
// failure. So the job never assumes anything landed: every run starts from what the vault and Hyperliquid show.
//
// Until the vault exists on-chain the job reports "not-deployed" and does nothing. Without the bot's key it only
// watches and says what it would do. Its key can never take deposits: every call it makes is one of the five above.
//
// No imports: the same code runs in Deno (Supabase Edge Functions) and in Node (tests). ethers v5 is passed in.

export interface Lib { Wallet: any; utils: any }
export interface Deps {
  ethers: Lib;
  fetch: typeof fetch;
  env: (key: string) => string | undefined;
  sleep?: (ms: number) => Promise<void>;
}
export interface HedgeConfig {
  rpc: string; chainId: number; multicall: string; rpcGapMs: number;
  /** Only read when a fee is bridged: Elysium's gas price sets the bid for the bridge ticket. */
  elysiumRpc: string;
  vault: string; lens: string; forwarder: string; usdc: string; whype: string; inbox: string;
  szDecimals: number;
  /** Put idle money to work once this much USDC (or HYPE worth as much) is waiting, above the buffer and what is owed. */
  minDeployUsdc: string;
  /** The vault keeps this share of its value idle for withdrawals (KeepLib.BUFFER_BPS). */
  bufferBps: number;
  /** Before a call that makes the vault swap, the pool must be this close to Hyperliquid's oracle price (basis points). */
  maxGapBps: number;
  /** How many ticks the pool may move between the bot's reading and the transaction landing. */
  maxDrift: number;
  /** Move the range once the price has been outside it, on the same side, for this long. */
  outOfRangeSec: number;
  harvestEverySec: number;
  /** Bridge the fee once the forwarder holds this much of a token, in USDC value. */
  minForwardUsdc: string;
  /** While money is owed to a withdrawer and nothing else needs doing, ask Hyperliquid again at most this often. */
  owedRetrySec: number;
  /** Warn when the margin is under this share of the short (basis points). */
  warnMarginBps: number;
  /** Warn when money has been owed, or the short has been off its target, for longer than this. */
  warnAfterSec: number;
  /** Warn when the bot holds less HYPE than this on HyperEVM. */
  minGasHype: string;
}
export const HEDGE_CONFIG: HedgeConfig = {
  rpc: "https://rpc.hyperliquid.xyz/evm",
  chainId: 999,
  multicall: "0xcA11bde05977b3631167028862bE2a173976CA11",
  rpcGapMs: 700, // the public HyperEVM RPC allows about 100 requests a minute
  elysiumRpc: "https://rpc.elysium.kinetiq.xyz",
  // The addresses script/hedged-vault-data.py works out for the launch. They follow from the vault's code: if a
  // source file changes before the launch, they change, and must be copied here again.
  vault: "0x269ECaEaE9dbC37B9d2cb643Deec89394d9E07DD",
  lens: "0x455F0895eb03a806d9F21638D96b8aBCAd32F5CE",
  forwarder: "0x8cAdAaa251f4c25795212B679cc8A155Cb13B732",
  usdc: "0xb88339CB7199b77E23DB6E890353E22632Ba630f",
  whype: "0x5555555555555555555555555555555555555555",
  inbox: "0xce59f8B65ad41C9DAE4c07A0571a39824bD92cff",
  szDecimals: 2,
  minDeployUsdc: "20",
  bufferBps: 200,
  maxGapBps: 30,
  maxDrift: 10,
  outOfRangeSec: 600,
  harvestEverySec: 86_400,
  minForwardUsdc: "5",
  owedRetrySec: 300,
  warnMarginBps: 2_000,
  warnAfterSec: 300,
  minGasHype: "0.002",
};

/** Kept between runs by the caller. Times are the chain's own. */
export interface HedgeState {
  /** Since when the price has been outside the range, and on which side. */
  outSince?: number;
  outSide?: "above" | "below";
  lastHarvest?: number;
  /** Since when money has been owed to a withdrawer; when the bot last asked Hyperliquid for it. */
  owedSince?: number;
  owedAsked?: number;
  /** Since when the short has been further from its target than the vault's band allows. */
  offSince?: number;
}
export interface HedgeAction { what: string; tx?: string; confirmed?: boolean | null; note?: string }
export interface HedgeReport {
  ok: boolean;
  mode: "live" | "watch-only" | "dry-run" | "paused";
  time: string;
  keeper: string | null;
  gasHype?: string;
  status: "not-deployed" | "idle" | "waiting" | "acted" | "paused";
  reason: string;
  vault?: {
    valueUsdc: string; shares: string; sharePrice: string; hypePrice: string; poolGapPct: string;
    inRange: boolean | null; positionHype: string; positionUsdc: string; idleHype: string; idleUsdc: string;
    perpUsdc: string; marginPct: string; shortHype: string; targetHype: string; owedUsdc: string;
    depositCapUsdc: string; depositsPaused: boolean; closing: boolean; botIsKeeper: boolean;
  };
  actions: HedgeAction[];
  warnings: string[];
  error?: string;
}

const STATE = "tuple(uint256 totalValue, uint256 totalSupply, uint256 oraclePx, uint160 poolSqrtPriceX96, int24 poolTick, int24 lower, int24 upper, uint256 positionAsset, uint256 positionUsdc, uint256 idleAsset, uint256 idleUsdc, int256 perpValue, uint256 spotUsdc, int256 shortSz, uint256 targetSz, uint256 marginBpsNow, uint256 owedTotal, bool priceInLine)";
const LENS_ABI = [`function state(address vault) view returns (${STATE})`];
const VAULT_ABI = [
  "function settings() view returns (address keeper, uint16 bandBps, uint16 marginBps, int24 width, bool depositsPaused, bool closing, uint256 depositCap)",
  "function tend()",
  "function harvest()",
  "function deploy(int24 expectedTick, int24 maxDrift)",
  "function rebalance(int24 expectedTick, int24 maxDrift)",
];
const FORWARDER_ABI = [
  "function minGas() view returns (uint256)",
  "function minGasPrice() view returns (uint256)",
  "function forward(address token, uint256 maxGas, uint256 gasPriceBid, uint256 maxSubmissionCost) payable returns (uint256)",
];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
const INBOX_ABI = ["function calculateRetryableSubmissionFee(uint256 dataLength, uint256 baseFee) view returns (uint256)"];
const MULTICALL_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])",
  "function getEthBalance(address addr) view returns (uint256)",
  "function getCurrentBlockTimestamp() view returns (uint256)",
];
const ZERO = "0x0000000000000000000000000000000000000000";

export async function runHedge(deps: Deps, stateIn: HedgeState | null, cfg: HedgeConfig = HEDGE_CONFIG): Promise<{ report: HedgeReport; state: HedgeState }> {
  const { Wallet, utils } = deps.ethers;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const state: HedgeState = { ...(stateIn ?? {}) };
  const report: HedgeReport = { ok: true, mode: "watch-only", time: new Date().toISOString(), keeper: null, status: "idle", reason: "", actions: [], warnings: [] };
  if (deps.env("KEEPER_PAUSED") === "1" || deps.env("HEDGE_PAUSED") === "1") {
    report.mode = "paused"; report.status = "paused"; report.reason = "paused by its switch";
    return { report, state };
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
  const dry = deps.env("DRY_RUN") === "1" || deps.env("HEDGE_DRY_RUN") === "1";
  report.mode = !wallet ? "watch-only" : dry ? "dry-run" : "live";
  report.keeper = wallet ? wallet.address : null;

  // ---- JSON-RPC, paced for the public endpoint
  function client(url: string, gapMs: number) {
    let last = 0;
    return async function rpc(method: string, params: unknown[] = [], tries = 0): Promise<any> {
      const wait = last + gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      const res = await deps.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "liquid-reserve-keeper/1" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const j: any = await res.json();
      if (j.error) {
        if (/rate limit|too many/i.test(j.error.message ?? "") && tries < 4) { await sleep(1500); return rpc(method, params, tries + 1); }
        throw Object.assign(new Error(j.error.message ?? "RPC error"), { data: j.error.data, code: j.error.code });
      }
      return j.result;
    };
  }
  const H = client(deps.env("HYPEREVM_RPC") || cfg.rpc, cfg.rpcGapMs);
  const I = (abi: string[]) => new utils.Interface(abi);
  const LENS = I(LENS_ABI), VAULT = I(VAULT_ABI), FWD = I(FORWARDER_ABI), ERC20 = I(ERC20_ABI), INBOX = I(INBOX_ABI), MC = I(MULTICALL_ABI);
  const hex = (n: number | bigint) => "0x" + BigInt(n).toString(16);
  const big = (v: any) => BigInt(v.toString());
  const usd = (v: bigint) => utils.formatUnits(v.toString(), 6);
  const hype = (v: bigint) => utils.formatUnits(v.toString(), 18);
  const parse6 = (v: string) => BigInt(utils.parseUnits(v, 6).toString());
  const UNIT = 10n ** BigInt(cfg.szDecimals); // size units per HYPE
  const SCALE = 10n ** BigInt(18 - cfg.szDecimals); // raw price = USDC units per this much HYPE
  const sized = (sz: bigint) => `${sz / UNIT}.${(sz % UNIT).toString().padStart(cfg.szDecimals, "0")}`;
  const pct = (bps: bigint) => (Number(bps) / 100).toFixed(2);

  // ---- everything the job needs to know, in one request
  type Call = { to: string; iface: any; fn: string; args?: unknown[] };
  const calls: Call[] = [
    { to: cfg.lens, iface: LENS, fn: "state", args: [cfg.vault] }, // 0
    { to: cfg.vault, iface: VAULT, fn: "settings" }, // 1
    { to: cfg.usdc, iface: ERC20, fn: "balanceOf", args: [cfg.forwarder] }, // 2
    { to: cfg.whype, iface: ERC20, fn: "balanceOf", args: [cfg.forwarder] }, // 3
    { to: cfg.forwarder, iface: FWD, fn: "minGas" }, // 4
    { to: cfg.forwarder, iface: FWD, fn: "minGasPrice" }, // 5
    { to: cfg.multicall, iface: MC, fn: "getCurrentBlockTimestamp" }, // 6
    { to: cfg.multicall, iface: MC, fn: "getEthBalance", args: [wallet ? wallet.address : ZERO] }, // 7
  ];
  const data = MC.encodeFunctionData("aggregate3", [calls.map((c) => ({ target: c.to, allowFailure: true, callData: c.iface.encodeFunctionData(c.fn, c.args ?? []) }))]);
  const [rows] = MC.decodeFunctionResult("aggregate3", await H("eth_call", [{ to: cfg.multicall, data }, "latest"]));
  const res = rows.map((r: any, i: number) => (r.success && r.returnData !== "0x" ? calls[i].iface.decodeFunctionResult(calls[i].fn, r.returnData) : null));
  if (!res[0] || !res[1]) {
    report.status = "not-deployed"; report.reason = "the hedged vault is not on-chain yet";
    return { report, state: {} };
  }
  const s = res[0][0], set = res[1];
  const now = Number(big(res[6]?.[0] ?? 0)), gasBalance = big(res[7]?.[0] ?? 0);
  if (wallet) report.gasHype = hype(gasBalance);

  const value = big(s.totalValue), supply = big(s.totalSupply), px = big(s.oraclePx);
  const posHype = big(s.positionAsset), posUsdc = big(s.positionUsdc), idleHype = big(s.idleAsset), idleUsdc = big(s.idleUsdc);
  const perp = big(s.perpValue), szi = big(s.shortSz), short = szi < 0n ? -szi : 0n, target = big(s.targetSz), owed = big(s.owedTotal);
  const tick = Number(s.poolTick), lower = Number(s.lower), upper = Number(s.upper);
  const band = BigInt(set.bandBps), margin = BigInt(set.marginBps), closing = Boolean(set.closing);
  const worth = (hypeWei: bigint) => (hypeWei * px) / SCALE; // HYPE in USDC at the oracle price
  const sqrtP = big(s.poolSqrtPriceX96), poolPx = (sqrtP * sqrtP * SCALE) >> 192n;
  const gapBps = px > 0n ? ((poolPx > px ? poolPx - px : px - poolPx) * 10_000n) / px : 10_000n;
  const hasPosition = posHype > 0n || posUsdc > 0n;
  const inRange = hasPosition ? tick >= lower && tick < upper : null;
  const isKeeper = !!wallet && String(set.keeper).toLowerCase() === wallet.address.toLowerCase();
  const mayKeep = !wallet || isKeeper; // with no key the job only says what it would do, as the keeper
  const closeEnough = gapBps <= BigInt(cfg.maxGapBps);
  report.vault = {
    valueUsdc: usd(value), shares: usd(supply), sharePrice: supply > 0n ? (Number(value) / Number(supply)).toFixed(6) : "0",
    hypePrice: (Number(px) / 10 ** (6 - cfg.szDecimals)).toFixed(4), poolGapPct: pct(gapBps), inRange,
    positionHype: hype(posHype), positionUsdc: usd(posUsdc), idleHype: hype(idleHype), idleUsdc: usd(idleUsdc),
    perpUsdc: usd(perp), marginPct: pct(big(s.marginBpsNow)), shortHype: sized(short), targetHype: sized(target), owedUsdc: usd(owed),
    depositCapUsdc: usd(big(set.depositCap)), depositsPaused: Boolean(set.depositsPaused), closing, botIsKeeper: isKeeper,
  };

  // ---- simulate, sign, send, wait
  async function act(what: string, to: string, calldata: string, valueWei: bigint = 0n): Promise<boolean> {
    if (!wallet) { report.actions.push({ what, note: "ready, but no keeper wallet is configured" }); return false; }
    let gas: bigint;
    try {
      gas = big(await H("eth_estimateGas", [{ from: wallet.address, to, data: calldata, value: hex(valueWei) }]));
    } catch (e: any) {
      const low = gasBalance < BigInt(utils.parseEther(cfg.minGasHype).toString());
      report.actions.push({ what, note: low ? "skipped: the bot wallet needs HYPE on HyperEVM" : `skipped: the vault refused (${String(e?.data ?? e?.message ?? e).slice(0, 120)})` });
      return false;
    }
    if (dry) { report.actions.push({ what, note: "dry run: would have been sent" }); return false; }
    let limit = (gas * 13n) / 10n;
    if (limit > 2_900_000n) limit = 2_900_000n; // HyperEVM's fast blocks hold 3,000,000 gas
    const nonce = Number(await H("eth_getTransactionCount", [wallet.address, "pending"]));
    const gasPrice = (big(await H("eth_gasPrice")) * 12n) / 10n;
    const raw = await wallet.signTransaction({ to, data: calldata, nonce, gasLimit: hex(limit), gasPrice: hex(gasPrice), chainId: cfg.chainId, value: hex(valueWei), type: 0 });
    const tx = await H("eth_sendRawTransaction", [raw]);
    for (let i = 0; i < 20; i++) {
      await sleep(1500);
      const r = await H("eth_getTransactionReceipt", [tx]);
      if (r) {
        report.actions.push({ what, tx, confirmed: r.status === "0x1" });
        if (r.status !== "0x1") report.ok = false;
        return r.status === "0x1";
      }
    }
    report.actions.push({ what, tx, confirmed: null });
    return false;
  }

  // ---- what the vault's own rules call for (worked out here only to say why, and to pace the asking)
  const want = ((short > target ? short : target) * px * margin) / 10_000n;
  const thin = want > 0n && perp < (want * 5n) / 8n;
  const fat = perp > (want * 13n) / 8n && perp - want >= 1_000_000n;
  const moneyOwed = owed > idleUsdc;
  const positionValue = posUsdc + worth(posHype);
  const off = (short > target ? short - target : target - short) * px;
  const outsideBand = off >= 11_000_000n && off * 10_000n >= positionValue * band;
  state.owedSince = owed > 0n ? state.owedSince ?? now : undefined;
  state.offSince = outsideBand ? state.offSince ?? now : undefined;

  // ---- 1. tend: only when the vault itself says a call would do something
  let moved = false;
  let wouldTend = false;
  try {
    await H("eth_call", [{ from: wallet ? wallet.address : ZERO, to: cfg.vault, data: VAULT.encodeFunctionData("tend", []) }, "latest"]);
    wouldTend = true;
  } catch (e: any) {
    // "nothing to do" is the usual answer. Anything else the vault says is worth a person's attention.
    const said = typeof e?.data === "string" ? e.data : "";
    if (said.length > 2 && !said.startsWith(utils.id("NothingToDo()").slice(0, 10))) report.warnings.push(`the vault's upkeep call cannot run (it answers ${said.slice(0, 10)})`);
  }
  const onlyOwed = moneyOwed && !thin && !fat && !outsideBand && !(closing && hasPosition);
  if (wouldTend && onlyOwed && state.owedAsked && now - state.owedAsked < cfg.owedRetrySec) wouldTend = false; // asked a moment ago: let it arrive
  if (wouldTend) {
    const why = [
      closing && hasPosition ? "take the position out (wind-down)" : "",
      thin ? `top the margin up (${pct(big(s.marginBpsNow))}% of the short)` : "",
      fat ? "send spare margin back" : "",
      moneyOwed ? `bring back ${usd(owed - idleUsdc)} USDC owed to withdrawers` : "",
      outsideBand ? `resize the short (${sized(short)} HYPE, should be ${sized(target)})` : "",
    ].filter(Boolean).join("; ") || "keep the hedge in place";
    moved = await act(`tend: ${why}`, cfg.vault, VAULT.encodeFunctionData("tend", []));
    if (moved && moneyOwed) state.owedAsked = now;
  }

  // ---- 2. rebalance: the price has left the range (or, in a wind-down, there is HYPE to sell)
  if (inRange === false) {
    const side = tick >= upper ? "above" : "below";
    if (state.outSide !== side) { state.outSide = side; state.outSince = now; }
  } else { state.outSince = undefined; state.outSide = undefined; }
  const outLongEnough = state.outSince !== undefined && now - state.outSince >= cfg.outOfRangeSec;
  const toSell = closing && worth(idleHype) >= 10_000_000n;
  if (!moved && ((outLongEnough && !closing) || toSell)) {
    const what = toSell ? `sell ${hype(idleHype)} HYPE for the wind-down` : `move the range back around the price (outside it, ${state.outSide}, for ${Math.round((now - (state.outSince ?? now)) / 60)} minutes)`;
    if (!mayKeep) report.actions.push({ what, note: "waiting: only the vault's keeper can, and the bot is not it" });
    else if (!closeEnough) report.actions.push({ what, note: `waiting: the pool is ${pct(gapBps)}% from Hyperliquid's price` });
    else moved = await act(what, cfg.vault, VAULT.encodeFunctionData("rebalance", [tick, cfg.maxDrift]));
  }

  // ---- 3. deploy: idle money to work
  const keep = owed + (value * BigInt(cfg.bufferBps)) / 10_000n;
  const budget = idleUsdc > keep ? idleUsdc - keep : 0n;
  const waiting = budget + worth(idleHype);
  if (!moved && !closing && waiting >= parse6(cfg.minDeployUsdc) && inRange !== false) {
    const what = `put ${usd(waiting)} USDC of idle money to work`;
    if (!mayKeep) report.actions.push({ what, note: "waiting: only the vault's keeper can, and the bot is not it" });
    else if (!closeEnough) report.actions.push({ what, note: `waiting: the pool is ${pct(gapBps)}% from Hyperliquid's price` });
    else moved = await act(what, cfg.vault, VAULT.encodeFunctionData("deploy", [tick, cfg.maxDrift]));
  }

  // ---- 4. harvest, once a day
  if (!moved && hasPosition && now - (state.lastHarvest ?? 0) >= cfg.harvestEverySec) {
    if (await act("collect the position's trading fees", cfg.vault, VAULT.encodeFunctionData("harvest", []))) state.lastHarvest = now;
  }

  // ---- 5. the fee: from the forwarder over the bridge to the splitter on Elysium
  const fees: [string, string, bigint, bigint][] = [["USDC", cfg.usdc, big(res[2]?.[0] ?? 0), big(res[2]?.[0] ?? 0)], ["HYPE", cfg.whype, big(res[3]?.[0] ?? 0), worth(big(res[3]?.[0] ?? 0))]];
  for (const [sym, token, amount, valueUsdc] of fees) {
    if (valueUsdc < parse6(cfg.minForwardUsdc) || !res[4] || !res[5]) continue;
    let l2GasPrice = 0n;
    try {
      const r = await deps.fetch(deps.env("ELYSIUM_RPC") || cfg.elysiumRpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] }) });
      l2GasPrice = big((await r.json()).result);
    } catch { /* the forwarder's own floor is used */ }
    const maxGas = big(res[4][0]) > 300_000n ? big(res[4][0]) : 300_000n;
    const gasPriceBid = l2GasPrice * 2n > big(res[5][0]) ? l2GasPrice * 2n : big(res[5][0]);
    // The base fee is read from the block itself: asked for inside a call, a node answers 0, and a ticket paid
    // for at a base fee of 0 is refused when the real transaction lands.
    const latest = await H("eth_getBlockByNumber", ["latest", false]);
    const baseFee = big(latest.baseFeePerGas ?? (await H("eth_gasPrice")));
    const [fee] = INBOX.decodeFunctionResult("calculateRetryableSubmissionFee", await H("eth_call", [{ to: cfg.inbox, data: INBOX.encodeFunctionData("calculateRetryableSubmissionFee", [2000, baseFee.toString()]) }, "latest"]));
    const maxSubmissionCost = big(fee) * 2n;
    const bridgeFee = maxSubmissionCost + maxGas * gasPriceBid;
    await act(`bridge the vault's fee, ${sym === "USDC" ? usd(amount) : hype(amount)} ${sym}, to the fee splitter on Elysium (bridge fee ${hype(bridgeFee)} HYPE)`,
      cfg.forwarder, FWD.encodeFunctionData("forward", [token, maxGas.toString(), gasPriceBid.toString(), maxSubmissionCost.toString()]), bridgeFee);
  }

  // ---- what a person should know about
  if (wallet && !isKeeper) report.warnings.push(`the vault's keeper is ${set.keeper}, not the bot: the bot can tend it but cannot put money to work or move the range`);
  if (short > 0n && big(s.marginBpsNow) < BigInt(cfg.warnMarginBps)) report.warnings.push(`the margin is ${pct(big(s.marginBpsNow))}% of the short`);
  if (!closeEnough && (hasPosition || idleUsdc > 0n)) report.warnings.push(`the pool is ${pct(gapBps)}% from Hyperliquid's price: nothing that swaps is sent until they agree`);
  if (state.owedSince !== undefined && now - state.owedSince > cfg.warnAfterSec) report.warnings.push(`${usd(owed)} USDC has been owed to withdrawers for ${Math.round((now - state.owedSince) / 60)} minutes`);
  if (state.offSince !== undefined && now - state.offSince > cfg.warnAfterSec) report.warnings.push(`the short has been off its target for ${Math.round((now - state.offSince) / 60)} minutes (${sized(short)} HYPE, should be ${sized(target)}): Hyperliquid may be refusing the orders`);
  if (supply > 1_000n && value === 0n) report.warnings.push("the vault reads as worth nothing");
  const blocked = report.actions.some((a) => a.note?.includes("needs HYPE"));
  if (wallet && gasBalance < BigInt(utils.parseEther(cfg.minGasHype).toString()) && (blocked || hasPosition)) report.warnings.push(`the bot wallet has ${report.gasHype} HYPE on HyperEVM and needs some to act there`);

  const sent = report.actions.filter((a) => a.confirmed === true).length;
  report.status = sent > 0 ? "acted" : report.actions.length > 0 ? "waiting" : "idle";
  report.reason = sent > 0 ? `${sent} step${sent === 1 ? "" : "s"} done`
    : blocked ? "work is ready but the bot wallet has no HYPE on HyperEVM"
    : report.actions.length > 0 ? "work is ready but was not sent this run"
    : supply === 0n ? "the vault is empty"
    : closing ? "winding down: nothing left to do this run"
    : inRange === false ? `the price is outside the range (${state.outSide}); the range moves once it has stayed there ${Math.round(cfg.outOfRangeSec / 60)} minutes`
    : `nothing to do: short ${sized(short)} HYPE against ${sized(target)} held, margin ${pct(big(s.marginBpsNow))}%`;
  return { report, state };
}
