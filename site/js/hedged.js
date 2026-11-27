// The hedged vault (src/hedged/): HYPE and USDC in one price range of a pool on HyperEVM, and a short on
// Hyperliquid's HYPE perpetual as large as the HYPE the vault holds, so that its worth is built not to follow
// the price of HYPE. It is a pilot: the owner sets a cap on what it may hold.
//
// Settings: deployment.json -> hyperevm.hedged. Without that entry nothing here shows.
// Reads: ONE Multicall3 request on HyperEVM (the vault's reader, its settings, and this wallet's side).
// The share-price chart reads its past from the history service ("hedged-history": what the keeper bot read on
// its runs), because HyperEVM's public RPC lets a page look back only 1,000 blocks, about a quarter of an hour.
// Writes go to HyperEVM, not Elysium: this page asks the wallet to switch networks itself, and every other page
// switches it back when it next sends something.
//
// Wording rule for this page: "direction-neutral", never "risk-free" or "fees only"; no figure for a return.
import { addr, uint, words, toUint, encodeAggregate3, decodeAggregate3 } from "./abi.js";
import { esc, explorer, tile, sk, icons, segbar, legend, S as SER } from "./ui.js";
import { usd } from "./format.js";
import { wallet } from "./wallet.js";
import { navChart } from "./charts.js";
import { historyGet, priceRangeCard, mountPriceRange, hyperliquidPrices, tickAt } from "./vaultchart.js";
import { vessel, tube } from "./liquid.js";
import { keccak256 } from "./keccak.js";
import { pendingFees, shareStats, positionResult, attribution, niceCeil } from "./hedgedstats.js";

const SEL = {
  state: "0x31e658a5", settings: "0xe06174e4", config: "0x79502c55", totalFees: "0x13114a9d", owed: "0xdf18e047",
  balanceOf: "0x70a08231", allowance: "0xdd62ed3e", approve: "0x095ea7b3",
  deposit: "0x8dbdbe6d", withdraw: "0x0ad58d2f", claim: "0x1e83409a",
};
// What the vault (or USDC) answers when it refuses, by the first four bytes of its answer.
const REFUSALS = {
  "0xf480e285": "The vault is at its cap, so it cannot take this much right now.",
  "0x5a65d188": "Deposits are paused.",
  "0xb59fde0b": "The vault is winding down and takes no deposits.",
  "0x9811e0c7": "That amount is too small to buy a share.",
  "0x7dd37f70": "The price moved while this was on its way, and it would have given you less than shown. Nothing was sent: try again.",
  "0x07c4865e": "The pool's price and Hyperliquid's are too far apart for the vault to price this fairly. Try again in a minute.",
  "0x797dba54": "Nothing is owed to this wallet, or it has not arrived back from Hyperliquid yet.",
  "0x8bd79b28": "The vault reads as worth nothing at the moment, so it cannot price a deposit.",
  "0xfb8f41b2": "The vault has not been allowed to take that much USDC from this wallet.",
  "0xe450d38c": "This wallet does not hold that much.",
};
// The pool's own counters (a Uniswap-v3-style pool), for the fees earned and not collected yet.
const POOL = { positions: "0x514ea4bf", global0: "0xf3058399", global1: "0x46141319", ticks: "0xf30dba93" };
const PERFORMANCE_FEE = 0.2; // FlowLib.PERFORMANCE_FEE_BPS: a fifth of the trading fees leaves the vault
const HYPEREVM = "0x3e7"; // 999
const GAS_CEILING = 1_950_000n; // some wallets refuse a HyperEVM transaction above 2,000,000 gas
const MIN_ORDER = 11_000_000n; // the vault sends no hedge order under 11 dollars (HedgeLib.MIN_ORDER)
const BOT_MIN_DEPLOY = 20_000_000n; // the keeper bot puts idle money to work from 20 USDC (keeper/hosted/hedge.ts)
const E6 = 1_000_000n;
// Hyperliquid's own ledger as HyperEVM shows it: an account's spot balance. It takes plain arguments (account, token)
// with no function selector, and answers (total, on hold, entry value) with 8 decimals. Token 0 is USDC.
const SPOT_BALANCE = "0x0000000000000000000000000000000000000801";

const cfgOf = (S) => S.cfg?.hyperevm?.hedged;
export const hedgedOn = (S) => !!cfgOf(S)?.vault;
/** True when `#/vault/<id>` is this vault's page. */
export const isRoute = (S, id) => hedgedOn(S) && id === cfgOf(S).id;
/** What is in the vault, in dollars, and whether it counts as a live vault: for the pages that add the vaults up. */
export const hedgedTvl = (S) => (S.hedged?.live ? Number(S.hedged.value) / 1e6 : 0);
export const hedgedLive = (S) => (S.hedged?.live ? 1 : 0);
export const hedgedKnown = (S) => (hedgedOn(S) && S.hedged?.live !== false ? 1 : 0);
/** The 20% of trading fees that has left the vault for the reserve and the creator so far, in dollars. */
export const hedgedCut = (S) => (S.hedged?.live ? (S.hedged.feesCollectedUsd ?? 0) * PERFORMANCE_FEE : 0);

const has = (x) => !!x && x.length >= 66;
const int = (w) => BigInt.asIntN(256, w);
const toAddr = (w) => "0x" + w.toString(16).padStart(64, "0").slice(24);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u6 = (v, d = 2) => (Number(v) / 1e6).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const h18 = (v, d = 4) => (Number(v) / 1e18).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const dollars = (n) => (isFinite(n) ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—");
const tickPrice = (t) => 1.0001 ** t * 1e12; // dollars a HYPE: token0 has 18 decimals, USDC 6
function parse6(text) {
  const t = String(text ?? "").trim().replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return 0n;
  const [a, b = ""] = t.split(".");
  return BigInt(a || "0") * E6 + BigInt((b + "000000").slice(0, 6));
}
const plain6 = (v) => { const f = (v % E6).toString().padStart(6, "0").replace(/0+$/, ""); return f ? `${v / E6}.${f}` : `${v / E6}`; };

// ---------------------------------------------------------------- loading
/** Everything the page shows. null without settings; `live: false` until the vault exists on HyperEVM. */
export async function loadHedged(conn, account) {
  const c = conn.cfg?.hyperevm?.hedged;
  if (!c?.vault) return null;
  const calls = [
    { to: c.lens, data: SEL.state + addr(c.vault) }, { to: c.vault, data: SEL.settings },
    { to: c.vault, data: SEL.config }, { to: c.vault, data: SEL.totalFees },
    { to: SPOT_BALANCE, data: "0x" + addr(c.vault) + uint(0) },
  ];
  if (account) calls.push(
    { to: c.vault, data: SEL.balanceOf + addr(account) }, { to: c.vault, data: SEL.owed + addr(account) },
    { to: c.usdc, data: SEL.balanceOf + addr(account) }, { to: c.usdc, data: SEL.allowance + addr(account) + addr(c.vault) },
  );
  const res = decodeAggregate3(await conn.h.call(c.multicall || conn.cfg.elysium.multicall, encodeAggregate3(calls)));
  if (!has(res[1])) return { live: false };
  // The reader asks Hyperliquid's exchange through HyperEVM. If that one call fails, keep what was shown before.
  if (!has(res[0])) throw new Error("the vault's reader did not answer");
  const s = words(res[0]).map(toUint), set = words(res[1]).map(toUint), cfg = has(res[2]) ? words(res[2]).map(toUint) : [];
  const fees = has(res[3]) ? words(res[3]).map(toUint) : [0n, 0n];
  const dec = Number(cfg[4] ?? BigInt(c.szDecimals ?? 2)), SCALE = 10n ** BigInt(18 - dec);
  const v = {
    live: true, szDecimals: dec,
    value: s[0], supply: s[1], px: s[2], tick: Number(int(s[4])), lower: Number(int(s[5])), upper: Number(int(s[6])),
    posHype: s[7], posUsdc: s[8], idleHype: s[9], idleUsdc: s[10], perp: int(s[11]), spot: s[12], target: s[14],
    marginBps: s[15], owed: s[16], inLine: s[17] !== 0n,
    keeper: toAddr(set[0]), bandBps: set[1], marginTarget: set[2], width: Number(int(set[3])), paused: set[4] !== 0n, closing: set[5] !== 0n, cap: set[6],
    poolFee: Number(cfg[2] ?? 500n), entryBps: cfg[5] ?? 7n, exitBps: cfg[6] ?? 5n, fees0: fees[0], fees1: fees[1],
    user: null,
  };
  const szi = int(s[13]);
  v.short = szi < 0n ? -szi : 0n; // in units of 10^-szDecimals HYPE
  v.price = Number(v.px) / 10 ** (6 - dec); // dollars a HYPE, Hyperliquid's oracle
  v.worth = (wei) => (wei * v.px) / SCALE; // HYPE (18 decimals) in USDC (6 decimals) at that price
  v.unitWei = 10n ** BigInt(18 - dec); // one size unit of the short, in HYPE wei
  const sqrtP = s[3];
  v.poolPrice = Number((sqrtP * sqrtP * SCALE) >> 192n) / 10 ** (6 - dec);
  v.hasPosition = v.posHype > 0n || v.posUsdc > 0n;
  v.inRange = v.hasPosition ? v.tick >= v.lower && v.tick < v.upper : null;
  v.held = v.posHype + v.idleHype; // every HYPE the vault holds
  v.shortWei = v.short * v.unitWei;
  v.open = v.held > v.shortWei ? v.held - v.shortWei : v.shortWei - v.held; // HYPE not matched by the other side
  v.overShort = v.shortWei > v.held;
  v.state = v.closing ? "closing" : v.supply === 0n ? "empty" : !v.hasPosition ? "idle" : v.inRange ? "earning" : "out";
  v.room = v.cap === 0n ? null : v.cap > v.value ? v.cap - v.value : 0n;
  v.sharePrice = v.supply > 0n ? Number(v.value) / Number(v.supply) : NaN;
  // The vault keeps 1.05 USDC on its spot side for good once it has first brought money back (Hyperliquid charges an
  // account 1 USDC on its first transfer out). null when that could not be read.
  v.floatSet = has(res[4]) ? toUint(words(res[4])[0]) / 100n >= E6 : null;
  // The short is resized when it is a band (a share of the position's worth) away from the HYPE held, and never by
  // less than 11 dollars. Under about 220 dollars of position the 11 dollars decide, and the hedge is coarse.
  v.small = v.hasPosition && ((v.posUsdc + v.worth(v.posHype)) * v.bandBps) / 10_000n < MIN_ORDER;
  // Fees the position has earned and not collected yet, from the pool's own counters (one more request). The pool
  // keeps a position under a key made from its owner and its range, which is why the page needs a hash here.
  v.pending0 = null; v.pending1 = null; v.liquidity = null;
  if (v.hasPosition && c.pool) {
    try {
      const i24 = (t) => BigInt.asUintN(24, BigInt(t)).toString(16).padStart(6, "0"), tickWord = (t) => uint(BigInt.asUintN(256, BigInt(t)));
      const key = keccak256(c.vault + i24(v.lower) + i24(v.upper)).slice(2);
      const pr = decodeAggregate3(await conn.h.call(c.multicall || conn.cfg.elysium.multicall, encodeAggregate3([
        { to: c.pool, data: POOL.positions + key }, { to: c.pool, data: POOL.global0 }, { to: c.pool, data: POOL.global1 },
        { to: c.pool, data: POOL.ticks + tickWord(v.lower) }, { to: c.pool, data: POOL.ticks + tickWord(v.upper) },
      ])));
      if (pr.every(has)) {
        const pos = words(pr[0]).map(toUint), lo = words(pr[3]).map(toUint), up = words(pr[4]).map(toUint);
        v.liquidity = pos[0];
        [v.pending0, v.pending1] = pendingFees({
          liquidity: pos[0], inside0Last: pos[1], inside1Last: pos[2], owed0: pos[3], owed1: pos[4],
          global0: toUint(words(pr[1])[0]), global1: toUint(words(pr[2])[0]), lower0: lo[2], lower1: lo[3], upper0: up[2], upper1: up[3],
          tick: v.tick, lower: v.lower, upper: v.upper,
        });
      }
    } catch { /* shown as not known */ }
  }
  // trading fees in dollars: collected so far, and earned since the last collection (both before the fee is taken)
  v.feesCollectedUsd = Number(v.fees1 + v.worth(v.fees0)) / 1e6;
  v.feesPendingUsd = v.pending0 === null ? null : Number(v.pending1 + v.worth(v.pending0)) / 1e6;
  if (account && has(res[5])) {
    const shares = toUint(words(res[5])[0]);
    v.user = {
      shares, owed: has(res[6]) ? toUint(words(res[6])[0]) : 0n, usdc: has(res[7]) ? toUint(words(res[7])[0]) : 0n,
      allowance: has(res[8]) ? toUint(words(res[8])[0]) : 0n, value: v.supply > 0n ? (shares * v.value) / v.supply : 0n,
    };
  }
  return v;
}

// ---------------------------------------------------------------- pieces
const ui = { tab: "deposit", text: "", busy: false, msg: null, quote: null, quoting: "", view: "simple" };
const row = (k, val) => `<div class="kv"><span>${k}</span><b class="r">${val}</b></div>`;
const say = (k, val) => `<div class="kv say"><span>${k}</span><b class="r">${val}</b></div>`;
const coin = (s, sm) => `<span class="coin${sm ? " sm" : ""}" title="${s}">${s.slice(0, 2).toUpperCase()}<img src="tokens/${s.toLowerCase()}.svg" alt="" /></span>`;
const pairCoins = (sm) => `<div class="pair">${coin("HYPE", sm)}${coin("USDC", sm)}</div>`;
const link = (S, kind, v, text) => explorer(S.cfg, "hyperevm", kind, v, text);

function badges(v) {
  const pilot = `<span class="badge warn">Pilot</span>`;
  if (!v) return `${pilot}<span class="badge">Loading…</span>`;
  if (!v.live) return `${pilot}<span class="badge">Not launched yet</span>`;
  const state = {
    empty: `<span class="badge">Awaiting first deposit</span>`, idle: `<span class="badge">Waiting to be put to work</span>`,
    earning: `<span class="badge on">● Earning fees</span>`, out: `<span class="badge warn">Out of range</span>`, closing: `<span class="badge warn">Winding down</span>`,
  }[v.state];
  return `${pilot}${state}${v.paused && !v.closing ? `<span class="badge warn">Deposits paused</span>` : ""}`;
}

/** The small range line: the range as a band, the price as a tick. */
function rangeMini(v) {
  if (!v.hasPosition) return "";
  const pad = Math.max((v.upper - v.lower) * 0.12, 30), lo = Math.min(v.lower, v.tick) - pad, hi = Math.max(v.upper, v.tick) + pad;
  const x = (k) => 2 + ((k - lo) / (hi - lo)) * 116;
  const label = v.inRange ? "in range" : "out of range";
  return `<span class="mini-range ${v.inRange ? "earning" : "out"}" title="Price ${label}"><svg viewBox="0 0 120 16" width="120" height="16" aria-hidden="true"><rect class="t" x="2" y="7" width="116" height="2" rx="1"/><rect class="m" x="${x(v.lower).toFixed(1)}" y="5" width="${Math.max(2, x(v.upper) - x(v.lower)).toFixed(1)}" height="6" rx="3"/><rect class="p" x="${(x(v.tick) - 1).toFixed(1)}" y="1" width="2" height="14" rx="1"/></svg><span>${label}</span></span>`;
}

/** How much of the vault's HYPE the short does not match, as a share of the vault's worth. */
const openShare = (v) => (v.value > 0n ? Number(v.worth(v.open)) / Number(v.value) : 0);

const capLine = (v) => (v.cap === 0n ? "" : `Deposits are capped at ${u6(v.cap, 0)} USDC in all while it is tried out. `);
const pilotNotice = (v) => `<div class="notice" style="margin-bottom:22px"><span class="dot"></span><div><b>A pilot, in contracts that have not been audited.</b> This vault is built so that its worth does not follow the price of HYPE. It is not built to be free of risk: it earns trading fees and pays for price swings, for its hedge and for funding, and it can lose money. ${v?.live ? capLine(v) : ""}Only put in what you could afford to lose. Nothing here is advice.</div></div>`;

// ---------------------------------------------------------------- the Vaults page
/** One row under the vaults list: this vault lives on another chain and works differently, so it has its own section. */
export function listSection(S) {
  if (!hedgedOn(S)) return "";
  const c = cfgOf(S), v = S.hedged;
  if (v && !v.live) return ""; // not launched: say nothing yet
  const cells = v
    ? [["Vault value", dollars(Number(v.value) / 1e6)], ["One share", isFinite(v.sharePrice) ? `${v.sharePrice.toFixed(4)} USDC` : "—"],
      v.user?.shares > 0n ? ["Your position", dollars(Number(v.user.value) / 1e6)] : ["Short", `${(Number(v.short) / 10 ** v.szDecimals).toFixed(v.szDecimals)} HYPE`]]
    : [["Vault value", sk("5ch")], ["One share", sk("7ch")], ["Short", sk("6ch")]];
  return `<section style="margin-top:34px"><div class="label sec-label">Hedged · on HyperEVM</div>
    ${!v && S.errors?.hedged ? `<div class="msg err" style="margin:0 0 10px">Couldn't reach HyperEVM just now (${esc(S.errors.hedged)}). Trying again automatically.</div>` : ""}
    <div class="vlist"><a class="card vrow" href="#/vault/${esc(c.id)}">
      <div class="name">${pairCoins(true)}<div style="min-width:0"><b>${esc(c.name)}</b><div class="badges" style="margin-top:6px">${badges(v)}</div>${v ? rangeMini(v) : ""}</div></div>
      ${cells.map(([k, val]) => `<div class="cell"><div class="k">${k}</div><div class="v num">${val}</div></div>`).join("")}
      <span class="go dim">${icons.arrow}</span></a></div>
    <p class="note" style="margin-left:4px">The same kind of HYPE/USDC position, with the HYPE in it sold short on Hyperliquid so that the vault's worth is built not to follow HYPE's price. A pilot, unaudited, and it can lose money.</p>
  </section>`;
}

// ---------------------------------------------------------------- price and range, the chart the other vaults' pages have
const PRICE_NOTE = "The vault earns trading fees only while HYPE's price is inside its range. When the price has been outside for 10 minutes, the keeper moves the range back around it. The line is HYPE's price on Hyperliquid, which the pool follows closely.";
const CHART_OPTS = { priceName: "HYPE price", single: true, note: PRICE_NOTE };
/** The vault in the shape the shared chart draws: one range, HYPE priced in dollars. */
function chartVault(S) {
  const c = cfgOf(S), v = S.hedged;
  return {
    name: c.name, address: c.vault, pool: c.pool, token0: "HYPE", token1: "USDC", d0: 18, d1: 6, tick: v.tick, now: Math.round(Date.now() / 1000), empty: !v.hasPosition,
    main: { lower: v.lower, upper: v.upper, liquidity: v.hasPosition ? (v.liquidity ?? 1n) : 0n }, alt: { lower: 0, upper: 0, liquidity: 0n },
  };
}
/**
 * The chart's history, in the shape the history service gives for the other vaults: the price as ticks (HYPE's
 * price on Hyperliquid) and the vault's range over time (each time the vault filled its range, from the history
 * service; until that record exists, the range it has now, since its first reading).
 */
async function loadPriceRange(S, win) {
  const c = cfgOf(S), v = S.hedged, hv = chartVault(S), now = Math.round(Date.now() / 1000);
  const h = await loadHist(S, "ALL").catch(() => null);
  const first = h?.first?.[0] ?? now - 3600;
  const moves = h?.ranges?.length ? h.ranges : v.hasPosition ? [[first, v.lower, v.upper]] : [];
  const ranges = moves.map(([t, lower, upper]) => [t, lower, upper, 1, 0, 0, 0]);
  const span = { "1D": 86_400, "1W": 604_800, "1M": 2_592_000 }[win];
  const since = span ? now - span : Math.min(first, ranges[0]?.[0] ?? first) - 3600;
  const prices = await hyperliquidPrices(S.cfg.hyperliquid.api, c.coin || "HYPE", since);
  return { now, pool: prices.map(([t, price]) => [Math.round(t), tickAt(hv, price)]), ranges, ref: [] };
}

// ---------------------------------------------------------------- the share price over time
const WINDOWS = ["1D", "1W", "1M", "ALL"];
const hist = { win: "ALL", data: new Map(), err: null };
async function loadHist(S, win) {
  const hit = hist.data.get(win);
  if (hit && Date.now() - hit.at < 300_000) return hit.data;
  const data = await historyGet("hedged-history", { window: win, vault: cfgOf(S).vault });
  if (data.error) throw new Error(data.error);
  hist.data.set(win, { at: Date.now(), data });
  return data;
}
/** The readings of the chosen window, oldest first, with what the page reads right now at the end. */
function chartPoints(S) {
  const v = S.hedged, pts = (hist.data.get(hist.win)?.data?.points ?? []).filter((p) => p[1] > 0).map(([t, share, hype]) => ({ t, v: share, hype }));
  if (v?.live && v.supply > 0n && isFinite(v.sharePrice)) pts.push({ t: Math.max(Math.round(Date.now() / 1000), (pts.at(-1)?.t ?? 0) + 1), v: v.sharePrice, hype: v.price });
  return pts;
}
// a change that rounds to nothing carries no sign
const signed = (x) => { const p = (Math.abs(x) * 100).toFixed(2); return `${Number(p) === 0 ? "" : x >= 0 ? "+" : "−"}${p}%`; };
function chartCard(S) {
  const v = S.hedged, pts = chartPoints(S), first = pts[0], last = pts.at(-1), loaded = hist.data.has(hist.win);
  const chg = pts.length > 1 ? last.v / first.v - 1 : null, hype = chg !== null && first.hype > 0 ? last.hype / first.hype - 1 : null;
  const since = first ? new Date(first.t * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  const line = chg !== null ? `${signed(chg)} since ${esc(since)}${hype !== null ? ` · HYPE ${signed(hype)} in the same time` : ""}`
    : hist.err ? "The history did not load. Trying again shortly." : loaded ? (v.supply === 0n ? "The line starts with the first deposit." : "The line starts with the keeper's next reading.") : "Loading the history…";
  return `<div class="perf-top">
      <div><div class="label">One share in USDC</div>
        <div class="big num">${isFinite(v.sharePrice) ? v.sharePrice.toFixed(4) : "—"}</div>
        <div class="nav">${line}</div></div>
      <div class="side"><span class="pill live"><span class="dot on pulse"></span>Live</span>
        <div class="seggroup sm" role="group" aria-label="Time range">${WINDOWS.map((w) => `<button type="button" data-hwin="${w}" class="${hist.win === w ? "active" : ""}">${w}</button>`).join("")}</div></div>
    </div>
    <div class="navchart" id="hg-chart"></div>
    <p class="note">What one share was worth each time the keeper read the vault, once an hour and whenever it acted, counted at Hyperliquid's price; the last point is this moment. The vault is built so that this line does not follow HYPE's price${v.small ? "; at its present size it follows part of it" : ""}. What it did before is not a promise of what it will do.</p>`;
}
/** Draws the card and its line from what is loaded. Safe to call at any time. */
function paintChart(S) {
  const card = document.getElementById("hg-chartcard");
  if (!card || !S.hedged?.live) return;
  card.innerHTML = chartCard(S);
  const loaded = hist.data.has(hist.win);
  navChart(document.getElementById("hg-chart"), {
    id: "hg", points: chartPoints(S), height: 290, tipName: "One share", title: "What one share of the vault was worth in USDC, over time",
    fmt: (x) => `${x.toFixed(5)} USDC`,
    empty: hist.err ? "The history did not load." : !loaded ? "Loading the history…" : S.hedged.supply === 0n ? "The line starts with the first deposit." : "The line needs a second reading. The keeper takes one every hour.",
  });
}
/** Loads the history the card is waiting for, then repaints. Cached, so a redraw costs nothing. */
function mountChart(S) {
  const card = document.getElementById("hg-chartcard");
  if (!card || !S.hedged?.live) return;
  const fetchAndPaint = () => {
    const want = hist.win;
    loadHist(S, want).then(() => { hist.err = null; }, (e) => { hist.err = String(e?.message || e); }).then(() => { if (hist.win === want) paintChart(S); });
  };
  paintChart(S);
  fetchAndPaint();
  card.addEventListener("click", (ev) => {
    const b = ev.target.closest?.("[data-hwin]");
    if (!b || b.dataset.hwin === hist.win) return;
    hist.win = b.dataset.hwin;
    paintChart(S);
    fetchAndPaint();
  });
}

// ---------------------------------------------------------------- the vault's own page
function tiles(v) {
  const short = (Number(v.short) / 10 ** v.szDecimals).toFixed(v.szDecimals);
  return `${tile("Vault value", dollars(Number(v.value) / 1e6), "counted at Hyperliquid's price")}
    ${tile("One share", isFinite(v.sharePrice) ? `${v.sharePrice.toFixed(4)} USDC` : "—", "rises with fees, falls with costs")}
    ${tile("Short", `${short} HYPE`, `against ${h18(v.held, 4)} HYPE held`)}
    ${tile("Room under the cap", v.room === null ? "No cap" : `${u6(v.room)} USDC`, v.room === null ? "" : `of ${u6(v.cap, 0)} USDC while it is a pilot`)}`;
}

// ---------------------------------------------------------------- more to read: this wallet's past, Hyperliquid's own figures
const more = { acct: null, acctKey: "", acctAt: 0, acctErr: null, hl: null, hlAt: 0, hlErr: null, local: [] };
// The vault's events as they appear in a transaction's receipt (keccak256 of each signature, src/hedged/HedgedTypes.sol).
const EVENT = {
  "0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7": ["deposit", 2, 2], // Deposit(sender, receiver, usdc, shares): the receiver's
  "0x7ff9a08662c21e17b8071f3aef03a9712ea9d3824dfb0139bba272915d59a919": ["withdraw", 1, 4], // Withdraw(owner, receiver, shares, usdcPaid, assetPaid, usdcOwed): the owner's
  "0xd8138f8a3f377c5259ca548e70e4c2de94f129f5a11036a15b69513cba2b426a": ["claimed", 1, 1], // Claimed(receiver, usdc)
};
/** Notes what a transaction made on this page did for this wallet, from the transaction's own receipt. The history
 *  service learns of it within a few minutes; until then the page counts it from here, so that a result is right
 *  the moment a deposit or a withdrawal is done. */
function noteReceipt(S, receipt) {
  const v = S.hedged, me = wallet.account?.toLowerCase(), vault = cfgOf(S).vault.toLowerCase();
  for (const l of receipt?.logs ?? []) {
    const e = EVENT[l.topics?.[0]];
    if (!e || l.address?.toLowerCase() !== vault || "0x" + l.topics[e[1]].slice(26).toLowerCase() !== me) continue;
    const w = [0, 1, 2, 3].map((i) => (i < e[2] ? Number(BigInt("0x" + l.data.slice(2 + 64 * i, 66 + 64 * i))) : 0));
    more.local.push({ account: me, event: [Math.round(Date.now() / 1000), e[0], w[0], w[1], w[2], w[3], v?.price ?? null, receipt.transactionHash] });
  }
}
/** This wallet's deposits and withdrawals, from the history service (the page cannot read that far back on HyperEVM). */
async function loadAccount(S) {
  const a = wallet.account;
  if (!a) return null;
  const key = a.toLowerCase();
  if (more.acctKey === key && more.acct && Date.now() - more.acctAt < 60_000) return more.acct;
  const data = await historyGet("hedged-history", { vault: cfgOf(S).vault, account: a, points: "0" });
  if (data.error) throw new Error(data.error);
  Object.assign(more, { acct: data, acctKey: key, acctAt: Date.now() });
  return data;
}
/** The short as Hyperliquid's own API reports it: the position, the funding it has been paid, what its trades cost. */
async function loadHl(S) {
  if (more.hl && Date.now() - more.hlAt < 60_000) return more.hl;
  const api = S.cfg.hyperliquid?.api, user = cfgOf(S).vault, coin = cfgOf(S).coin || "HYPE";
  if (!api) throw new Error("no Hyperliquid address in the settings");
  const ask = (body) => fetch(api, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => { if (!r.ok) throw new Error(`Hyperliquid ${r.status}`); return r.json(); });
  const [state, funding, fills, rates] = await Promise.all([
    ask({ type: "clearinghouseState", user }), ask({ type: "userFunding", user, startTime: 0 }),
    ask({ type: "userFills", user }), ask({ type: "fundingHistory", coin, startTime: Date.now() - 86_400_000 }),
  ]);
  const pos = (state.assetPositions ?? []).map((x) => x.position).find((x) => x.coin === coin) ?? null;
  const listed = (funding ?? []).filter((f) => f.delta?.coin === coin).reduce((sum, f) => sum + Number(f.delta.usdc), 0);
  const mine = (fills ?? []).filter((f) => f.coin === coin), rs = (rates ?? []).map((r) => Number(r.fundingRate)).filter(isFinite);
  more.hl = {
    pos: pos && { size: Math.abs(Number(pos.szi)), entry: Number(pos.entryPx), value: Number(pos.positionValue), unrealized: Number(pos.unrealizedPnl), liq: pos.liquidationPx == null ? null : Number(pos.liquidationPx) },
    account: Number(state.marginSummary?.accountValue ?? NaN),
    // What the short has been paid in funding, less what it paid. The position carries its own running total
    // (Hyperliquid counts what the account PAID, so the sign is turned); without a position the list is summed,
    // and that list holds the latest 500 payments only.
    funding: pos?.cumFunding ? -Number(pos.cumFunding.allTime) : listed,
    tradeFees: mine.reduce((sum, f) => sum + Number(f.fee), 0), trades: mine.length, closed: mine.reduce((sum, f) => sum + Number(f.closedPnl), 0),
    rateHour: rs.length ? rs.at(-1) : null, rateDay: rs.length ? rs.reduce((x, y) => x + y, 0) / rs.length : null,
  };
  more.hlAt = Date.now();
  return more.hl;
}

// ---------------------------------------------------------------- your position, with its result
const usdS = (x) => `${x < 0 ? "−" : "+"}${usd(Math.abs(x))}`; // dollars with their sign
const dayOf = (t) => new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
/** What this wallet has made or lost, once its deposits and withdrawals are known. */
function myResult(v) {
  const me = wallet.account?.toLowerCase(), known = me && more.acctKey === me ? more.acct?.account?.events : null;
  if (!v.user || !known) return null;
  // with what was done on this page and has not reached the history service yet
  const seen = new Set(known.map((e) => e[7])), fresh = more.local.filter((x) => x.account === me && !seen.has(x.event[7])).map((x) => x.event);
  return positionResult([...known, ...fresh], { shares: v.user.shares, value: v.user.value, owed: v.user.owed });
}
function positionCard(S, v) {
  const u = v.user;
  if (!wallet.account || !u) return "";
  const r = myResult(v);
  if (u.shares === 0n && u.owed === 0n && !(r && r.putIn > 0)) return ""; // nothing here, and nothing ever was
  let line;
  if (r && r.complete && r.putIn > 0) {
    line = `<span class="${r.result >= 0 ? "up" : "down"}"><b>${usdS(r.result)}</b> (${signed(r.pct)})</span> on the ${usd(r.putIn)} you have put in since ${esc(dayOf(r.since))}${r.takenOut > 0 ? `, of which ${usd(r.takenOut)} is out again` : ""}`;
  } else if (r && !r.complete) line = "Some of these shares were sent to this wallet by another one, so what they cost is not known and no result can be worked out.";
  else {
    const loaded = more.acctKey === wallet.account.toLowerCase() && more.acct; // an answer came, but without this wallet's record
    line = more.acctErr || loaded ? "Your result could not be worked out just now: the record of your deposits did not load." : "Working out your result…";
  }
  return `<div class="card chrome position" style="margin-bottom:14px">
    <div><div class="label">Your position</div><div class="fig num">${dollars(Number(u.value) / 1e6)}</div>
      <div class="held num">${u6(u.shares, 4)} shares${u.owed > 0n ? ` · ${u6(u.owed)} USDC owed to you` : ""}</div>
      <div class="held" style="margin-top:8px">${line}</div></div>
  </div>`;
}

// ---------------------------------------------------------------- the vault, live: liquid in glass
function liveCard(v) {
  if (v.supply === 0n) return `<div class="card"><div class="label">The vault, live</div><div class="empty">Nothing is in the vault yet.</div></div>`;
  const dec = v.szDecimals, short = (Number(v.short) / 10 ** dec).toFixed(dec), idle = v.idleUsdc + v.worth(v.idleHype);
  const parts = [
    { name: "HYPE in the pool", value: Number(v.worth(v.posHype)), color: SER[0], note: `${h18(v.posHype)} HYPE` },
    { name: "USDC in the pool", value: Number(v.posUsdc), color: SER[1], note: `${u6(v.posUsdc)} USDC` },
    { name: "Margin on Hyperliquid", value: Math.max(0, Number(v.perp)), color: SER[3], note: `${u6(v.perp)} USDC` },
    { name: "Idle in the vault", value: Number(idle), color: SER[4], note: `${u6(idle)} USDC` },
  ];
  const range = v.hasPosition ? `${dollars(tickPrice(v.lower))} → ${dollars(tickPrice(v.upper))} a HYPE` : "";
  const head = {
    earning: `Earning fees while HYPE is between ${range}`, out: `Outside its range of ${range}: earning nothing until the keeper moves it`,
    idle: "Waiting in the vault to be put to work", closing: "Being wound down to USDC", empty: "",
  }[v.state];
  const light = (c) => `color-mix(in srgb, ${c} 60%, #fff)`;

  // the hedge: the HYPE held is the liquid, the short is the line floating on it. Level with the surface means matched.
  const most = v.held > v.shortWei ? v.held : v.shortWei, scale = Number(most) * 1.3 || 1;
  const matched = most > 0n ? 1 - Number(v.open) / Number(most) : 0;
  const hedge = vessel({
    id: "hedge", layers: [{ level: Number(v.held) / scale, from: light(SER[0]), to: SER[0] }], float: v.short > 0n ? { at: Number(v.shortWei) / scale } : null,
    label: `The vault holds ${h18(v.held)} HYPE and has sold ${short} HYPE short`,
  });
  // the margin: where it stands between the line it is topped up at and the line it is handed back at
  const target = Number(v.marginTarget) / 10_000, brim = target * 2, m = Number(v.marginBps) / 10_000;
  const margin = vessel({
    id: "margin", layers: [{ level: v.short > 0n ? m / brim : 0, from: light(SER[3]), to: SER[3] }],
    marks: [{ at: (target * 5) / 8 / brim }, { at: target / brim, strong: true }, { at: (target * 13) / 8 / brim }],
    label: `The margin is ${(m * 100).toFixed(1)}% of the short`,
  });
  // the fees: what has been collected below, what has been earned since on top, in a glass that holds a round figure
  const got = v.feesCollectedUsd, since = v.feesPendingUsd ?? 0, all = got + since, cup = niceCeil(all * 1.15), FULL = 0.88; // the top mark, as a share of the glass
  const fees = vessel({
    id: "fees", drip: v.state === "earning",
    layers: [{ level: (got / cup) * FULL, from: "var(--mark-c)", to: "color-mix(in srgb, var(--mark-c) 55%, #000)" }, { level: (all / cup) * FULL, from: "var(--mark-a)", to: "var(--mark-b)" }],
    marks: [{ at: FULL / 2 }, { at: FULL, strong: true }], label: `${usd(all)} of trading fees earned so far`,
  });
  const item = (glass, k, val, sub) => `<div class="item">${glass}<div class="t"><div class="k">${k}</div><div class="v">${val}</div><div class="s">${sub}</div></div></div>`;
  const pc = (x) => `${(x * 100).toFixed(0)}%`;
  const tr = (k, val) => `<tr><td style="text-align:left">${k}</td><td>${val}</td></tr>`;
  return `<div class="card">
    <div class="head-row" style="margin-bottom:12px"><div><div class="label">The vault, live</div><div class="rangeline" style="margin-top:8px">${head}</div></div>${v.hasPosition ? rangeMini(v) : ""}</div>
    ${tube(parts)}${legend(parts.filter((p) => p.value > 0))}
    <div class="lq-live">
      ${item(hedge, "The hedge", v.short > 0n ? `${pc(matched)} matched` : "No short yet", `${h18(v.held)} HYPE held · ${short} sold short`)}
      ${item(margin, "Margin behind the short", v.short > 0n ? `${(m * 100).toFixed(1)}%` : "—", `${u6(v.perp)} USDC · aims at ${pc(target)}, topped up under ${pc((target * 5) / 8)}`)}
      ${item(fees, "Fees earned", `<span class="liquid-text">${usd(all)}</span>`, v.feesPendingUsd === null ? "collected so far" : `${usd(since)} of it not collected yet`)}
    </div>
    <p class="note">${v.short > 0n ? "The line across the first glass is the short: level with the liquid means every HYPE the vault holds is sold short as well. " : ""}The marks on the second glass are where the margin is topped up, where it aims, and where the spare is handed back. The third glass holds ${usd(cup)} to its top mark.${v.small ? ` <b>This vault is small, so its short is corrected only in steps of 11 dollars, and for now its worth follows part of HYPE's moves.</b>` : ""}</p>
    <details class="tableview"><summary>View as table</summary><div class="tablewrap"><table class="data">
      ${tr("HYPE's price", `${dollars(v.price)} on Hyperliquid · ${dollars(v.poolPrice)} in the pool`)}
      ${parts.map((p) => tr(p.name, p.note)).join("")}
      ${tr("HYPE the vault holds", `${h18(v.held)} HYPE`)}${tr("Sold short on Hyperliquid", `${short} HYPE`)}
      ${tr(v.overShort ? "Short beyond what it holds" : "Left unmatched", `${h18(v.open)} HYPE · ${dollars(Number(v.worth(v.open)) / 1e6)} · ${(openShare(v) * 100).toFixed(1)}% of the vault`)}
      ${tr("Margin behind the short", v.short > 0n ? `${u6(v.perp)} USDC · ${(m * 100).toFixed(1)}% of its size` : `${u6(v.perp)} USDC`)}
      ${tr("Trading fees collected", `${usd(got)} · before the 20% fee`)}${v.feesPendingUsd === null ? "" : tr("Earned since, not collected yet", usd(since))}
      ${v.owed > 0n ? tr("Owed to people who have left", `${u6(v.owed)} USDC`) : ""}
    </table></div></details></div>`;
}

// ---------------------------------------------------------------- advanced: the figures behind it
const humanDur = (sec) => (sec >= 2 * 86_400 ? `${Math.floor(sec / 86_400)} days` : sec >= 2 * 3600 ? `${Math.floor(sec / 3600)} hours` : `${Math.max(1, Math.round(sec / 60))} minutes`);
const stat = (k, val, sub, wait = false) => `<div class="st${wait ? " wait" : ""}"><div class="k">${k}</div><div class="v num">${val}</div><div class="s">${sub}</div></div>`;
/** Every reading there is, oldest first, with this moment at the end. */
function allPoints(S) {
  const v = S.hedged, pts = (hist.data.get("ALL")?.data?.points ?? []).filter((p) => p[1] > 0).map(([t, share, hype]) => ({ t, v: share, hype }));
  if (v?.live && v.supply > 0n && isFinite(v.sharePrice)) pts.push({ t: Math.max(Math.round(Date.now() / 1000), (pts.at(-1)?.t ?? 0) + 1), v: v.sharePrice, hype: v.price });
  return pts;
}
function statsCard(S) {
  const st = shareStats(allPoints(S)), have = st.seconds > 0 ? `${humanDur(st.seconds)} so far` : "none yet";
  const later = (need) => `shown after ${humanDur(need)} of readings; ${have}`;
  const cell = (k, x, need, fmt, sub) => (x === null ? stat(k, "—", later(need), true) : stat(k, fmt(x), sub));
  const pc = (x, d = 2) => `${(x * 100).toFixed(d)}%`;
  return `<section class="card" style="margin-bottom:14px"><div class="label">How a share has done</div>
    <div class="statgrid">
      ${st.change === null ? stat("Since the first reading", "—", hist.data.has("ALL") ? "needs a second reading" : hist.err ? "the history did not load" : "loading the history…", true)
        : stat("Since the first reading", signed(st.change), `over ${humanDur(st.seconds)}${st.hypeChange === null ? "" : ` · HYPE ${signed(st.hypeChange)}`}`)}
      ${cell("At that pace, a year", st.yearly, st.needs.yearly, signed, "what the change so far comes to over a year; not a forecast")}
      ${cell("Volatility", st.vol, st.needs.vol, (x) => pc(x, 1), "how much a share's worth moves, as a yearly rate")}
      ${cell("Sharpe ratio", st.sharpe, st.needs.sharpe, (x) => x.toFixed(2), "the yearly pace over the volatility, with no risk-free rate taken off")}
      ${st.drawdown === null ? stat("Largest fall", "—", "needs a second reading", true) : stat("Largest fall", st.drawdown < 0 ? `−${pc(-st.drawdown)}` : "0.00%", "from a high to a later low")}
      ${cell("Followed HYPE by", st.beta, st.needs.beta, (x) => pc(x, 0), `of HYPE's moves, reading by reading${st.corr === null ? "" : ` · correlation ${st.corr.toFixed(2)}`}`)}
    </div>
    <p class="note">Worked out from the keeper's readings of one share's worth (${st.readings} of them${st.high === null ? "" : `, between ${st.low.toFixed(4)} and ${st.high.toFixed(4)} USDC`}). A vault that kept clear of HYPE's direction entirely would follow HYPE by 0%. Figures that mean little on a short record are held back until the record is long enough. None of them says what comes next.</p></section>`;
}
function shortCard(S, v) {
  const h = more.hl;
  if (!h) return `<section class="card" style="margin-bottom:14px"><div class="label">The short, as Hyperliquid reports it</div><div class="empty">${more.hlErr ? `Hyperliquid's figures did not load (${esc(more.hlErr)}). Trying again shortly.` : "Loading from Hyperliquid…"}</div></section>`;
  const p = h.pos, yr = (r) => `${(r * 8760 * 100).toFixed(1)}% a year`;
  return `<section class="card" style="margin-bottom:14px"><div class="label">The short, as Hyperliquid reports it</div>
    ${p ? `${row("Sold short", `${p.size} HYPE at ${dollars(p.entry)} on average`)}
      ${row("Its result while open", `<span class="${p.unrealized >= 0 ? "up" : "down"}">${usdS(p.unrealized)}</span> · the HYPE it stands against has moved the other way`)}
      ${row("Size against the margin", isFinite(h.account) && h.account > 0 ? `${(p.value / h.account).toFixed(1)} times · ${usd(p.value)} short on ${usd(h.account)}` : "—")}
      ${p.liq === null ? "" : row("Hyperliquid would close it at", `${dollars(p.liq)} a HYPE, ${((p.liq / v.price - 1) * 100).toFixed(0)}% above today · the vault adds margin long before`)}`
      : row("Sold short", "Nothing right now")}
    ${row("Funding so far", `<span class="${h.funding >= 0 ? "up" : "down"}">${usdS(h.funding)}</span> · ${h.funding >= 0 ? "paid to the vault" : "paid by the vault"}`)}
    ${h.rateHour === null ? "" : row("Funding rate, the last hour", `${(h.rateHour * 100).toFixed(4)}% · ${yr(Math.abs(h.rateHour))} at that rate · shorts ${h.rateHour >= 0 ? "are paid" : "pay"}`)}
    ${h.rateDay === null ? "" : row("Funding rate, the last 24 hours", `${(h.rateDay * 100).toFixed(4)}% an hour on average · ${yr(Math.abs(h.rateDay))} · shorts ${h.rateDay >= 0 ? "are paid" : "pay"}`)}
    ${row("Trades on the short", `${h.trades} · ${usd(h.tradeFees)} paid in fees${h.closed !== 0 ? ` · ${usdS(h.closed)} made final on the parts closed` : ""}`)}
    <p class="note">Read from Hyperliquid's own public figures for the vault's account, a minute old at most. Funding changes sign: in some hours shorts are paid, in others they pay.</p></section>`;
}
function feesCard(S, v) {
  const got = v.feesCollectedUsd, since = v.feesPendingUsd, all = got + (since ?? 0);
  const last = (hist.data.get("ALL")?.data?.fees ?? []).at(-1)?.[0] ?? null, age = last ? Date.now() / 1000 - last : null;
  const pool = Number(v.posUsdc + v.worth(v.posHype)) / 1e6, perDay = since !== null && age && age >= 1800 ? (since / age) * 86_400 : null;
  return `<section class="card" style="margin-bottom:14px"><div class="label">Trading fees</div>
    ${row("Collected so far", `${usd(got)}`)}
    ${since === null ? "" : row("Earned since, not collected yet", usd(since))}
    ${row("Of all of it, to the vault's holders", `${usd(all * (1 - PERFORMANCE_FEE))} · 80%`)}
    ${row("To the locked reserve and the creator", `${usd(all * PERFORMANCE_FEE)} · 20%, of which a fifth to the creator`)}
    ${perDay === null ? "" : row("Pace since the last collection", `${usd(perDay)} a day${pool > 0 ? ` · ${((perDay * 365) / pool * 100).toFixed(0)}% a year of what is in the pool` : ""}`)}
    <p class="note">Fees are what traders pay the pool; the vault collects its part once a day and whenever someone deposits or withdraws.${perDay === null ? "" : " The pace is the fees alone, before the 20% fee and before what price swings and the hedge cost: it is not the vault's return, and it changes with how much is traded."}</p></section>`;
}
function partsCard(S, v) {
  const flows = hist.data.get("ALL")?.data?.flows, h = more.hl;
  if (!flows || !h) return "";
  const a = attribution({
    value: Number(v.value) / 1e6, flows, feesGross: v.feesCollectedUsd, feesPending: v.feesPendingUsd ?? 0, performanceFee: PERFORMANCE_FEE, funding: h.funding, hedgeFees: h.tradeFees,
  });
  const line = (k, x) => row(k, `<span class="${x >= 0 ? "up" : "down"}">${usdS(x)}</span>`);
  return `<section class="card" style="margin-bottom:14px"><div class="label">The vault's result so far, by part</div>
    ${line("Trading fees, after the 20% fee", a.fees)}${line("Funding on the short", a.funding)}${line("Fees for trading the short", a.hedgeFees)}
    ${line("Price swings after the hedge, and trading in the pool", a.rest)}
    <div class="kv"><span><b>Altogether</b></span><b class="r"><span class="${a.total >= 0 ? "up" : "down"}">${usdS(a.total)}</span> on ${usd(flows.deposited)} put in by everyone</b></div>
    <p class="note">The last-but-one line is what is left when the three above are taken from the whole: it is where a hedge that fits shows as a small figure and one that does not as a large one.</p></section>`;
}
function yourCard(S, v) {
  const r = myResult(v), u = v.user;
  if (!r || !r.complete || !(r.putIn > 0)) return "";
  return `<section class="card" style="margin-bottom:14px"><div class="label">Your position, in full</div>
    ${row("Put in", `${usd(r.putIn)} · first on ${esc(dayOf(r.since))}`)}${row("Taken out", usd(r.takenOut))}
    ${u.owed > 0n ? row("Of that, still owed to you", `${u6(u.owed)} USDC`) : ""}${row("Worth now", usd(r.worth))}
    <div class="kv"><span><b>Result</b></span><b class="r"><span class="${r.result >= 0 ? "up" : "down"}">${usdS(r.result)} (${signed(r.pct)})</span></b></div>
    <p class="note">Worth now and taken out, less put in. Money taken out counts in full from the moment it was withdrawn, whether it was paid at once or is still owed.</p></section>`;
}
const advanced = (S, v) => `${yourCard(S, v)}${statsCard(S)}${shortCard(S, v)}${feesCard(S, v)}${partsCard(S, v)}`;
/** Fills the parts of the page that wait for something to load. Safe to call at any time. */
function paintMore(S) {
  const v = S.hedged;
  if (!v?.live) return;
  const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  set("hg-pos", positionCard(S, v));
  if (ui.view === "advanced") set("hg-adv", advanced(S, v));
}
function mountMore(S, api) {
  if (!S.hedged?.live) return;
  document.querySelectorAll("[data-hview]").forEach((b) => b.addEventListener("click", () => { if (ui.view !== b.dataset.hview) { ui.view = b.dataset.hview; api.render(); } }));
  const jobs = [];
  if (wallet.account) jobs.push(loadAccount(S).then(() => { more.acctErr = null; }, (e) => { more.acctErr = String(e?.message || e); }));
  if (ui.view === "advanced") {
    jobs.push(loadHl(S).then(() => { more.hlErr = null; }, (e) => { more.hlErr = String(e?.message || e); }));
    jobs.push(loadHist(S, "ALL").then(() => { hist.err = null; }, () => {}));
  }
  for (const j of jobs) j.then(() => paintMore(S));
}

function panel(S) {
  const v = S.hedged, u = v.user, dep = ui.tab === "deposit";
  const want = parse6(ui.text);
  const bal = !u ? "" : dep ? `Balance ${u6(u.usdc)} USDC on HyperEVM` : `You have ${u6(u.shares, 4)} shares`;
  const blocked = dep && (v.paused || v.closing);
  const full = dep && v.room !== null && v.room === 0n;
  const needApprove = dep && !!u && want > 0n && u.allowance < want;
  const label = !wallet.account ? "Connect wallet" : ui.busy ? "Confirm in your wallet…" : dep ? (needApprove ? "Approve and deposit" : "Deposit") : "Withdraw";
  const note = ui.msg ? `<div class="msg ${ui.msg.kind}">${ui.msg.html ?? esc(ui.msg.text)}</div>` : "";
  const net = want - (want * v.entryBps) / 10_000n;
  const shares = want === 0n ? 0n : v.supply === 0n ? (net > 1_000n ? net - 1_000n : 0n) : v.value > 0n ? (net * v.supply) / v.value : 0n;
  const worth = !dep && v.supply > 0n ? (want * v.value) / v.supply : 0n, back = worth - (worth * v.exitBps) / 10_000n;
  const q = !dep && want > 0n && ui.quote?.key === quoteKey(S, want) ? ui.quote : null; // the vault's own answer for this amount
  const sum = dep
    ? `${row("You receive about", want > 0n ? `${u6(shares, 4)} shares` : "—")}
       ${row("Kept back on the way in", `${(Number(v.entryBps) / 100).toFixed(2)}%, it stays in the vault`)}
       ${row("Room under the cap", v.room === null ? "No cap" : `${u6(v.room)} USDC`)}`
    : `${q ? `${row("Paid to your wallet at once", `${u6(q.paid)} USDC`)}
         ${row("Owed, to come back from Hyperliquid", `${u6(q.owed)} USDC`)}
         ${q.asset > 0n ? row("Sent to you as wrapped HYPE", `${h18(q.asset)} HYPE`) : ""}`
        : row("Worth about", want > 0n ? `${u6(back)} USDC` : "—")}
       ${row("Kept back on the way out", `${(Number(v.exitBps) / 100).toFixed(2)}%, it stays in the vault`)}`;
  const owed = u && u.owed > 0n
    ? `<div class="msg" style="margin-top:12px"><b>${u6(u.owed)} USDC is owed to you</b> from a withdrawal. It comes back from Hyperliquid, usually within a few minutes${v.small ? "; in a vault this small it can take much longer" : ""}. <button class="btn sm" id="hg-claim" type="button" ${ui.busy ? "disabled" : ""} style="margin-left:6px">Claim</button></div>`
    : "";
  return `<div class="card chrome stk-box">
    <div class="seggroup" role="group" aria-label="Deposit or withdraw" style="margin-bottom:14px">
      <button type="button" data-htab="deposit" class="${dep ? "active" : ""}">Deposit</button>
      <button type="button" data-htab="withdraw" class="${dep ? "" : "active"}">Withdraw</button></div>
    ${blocked ? `<div class="msg">${v.closing ? "The vault is winding down and takes no new deposits." : "New deposits are paused."} Withdrawing is always open.</div>` : full ? `<div class="msg">The pilot is at its cap, so it takes no more for now. Withdrawing is always open.</div>` : ""}
    <div class="field"><label><span>${dep ? "You deposit" : "You withdraw"}</span><span>${esc(bal)}</span></label>
      <div class="in"><input id="hg-amt" inputmode="decimal" placeholder="0.0" autocomplete="off" value="${esc(ui.text)}" aria-label="${dep ? "USDC to deposit" : "Shares to withdraw"}" />
        <button class="maxbtn" id="hg-max" type="button">MAX</button><span class="sym">${dep ? "USDC" : "shares"}</span></div></div>
    <div class="sum">${note}${sum}</div>
    <button class="btn primary block" id="hg-go" type="button" ${ui.busy || blocked || full ? "disabled" : ""} style="margin-top:12px">${label}</button>
    ${owed}
    <p class="note">${dep
      ? "This vault is on HyperEVM, so your wallet is asked to switch to it, and the USDC it takes is USDC on HyperEVM, not USDC on Elysium. A deposit waits in the vault until the keeper puts it to work, usually within a minute once at least 20 USDC is waiting."
      : `You are paid in USDC on HyperEVM. Most arrives with the withdrawal. The part that sits on Hyperliquid as margin is owed to you, comes back as the vault makes its short smaller, usually within a few minutes, and is then claimed here.${v.small ? " <b>This vault is small, and its short changes only in steps of 11 dollars. If you take out a large part but not all of your shares, the owed part can stay owed until the short can next be made smaller.</b>" : ""}${v.floatSet === false ? " The vault has not brought money back from Hyperliquid before: the first time it does, 1.05 USDC of the vault's money stays there for good." : ""}`}</p>
  </div>`;
}

function howCard(S, v) {
  const c = cfgOf(S), fee = `${(v.poolFee / 10_000).toFixed(2)}%`;
  return `<section class="card" style="margin-bottom:26px"><div class="label">How it works</div>
    ${say("What it does", `It keeps HYPE and USDC in one price range of Project X's HYPE/USDC pool on HyperEVM (the ${fee} pool), where traders pay a fee on every swap. That position always holds some HYPE, so the vault sells the same amount of HYPE short on Hyperliquid's perpetual. When HYPE's price moves, one side gains about what the other loses.`)}
    ${say("What it earns and pays", "It earns the pool's trading fees, and funding in the hours when shorts are paid. It pays for price swings (the position buys HYPE as it falls and sells it as it rises, which costs more the more HYPE moves), for trading its hedge, and funding in the hours when shorts pay. When the costs are larger than the fees, a share is worth less.")}
    ${say("What you hold", "Shares of the vault, counted in USDC. You put USDC in and take USDC out.")}
    ${say("Getting in", `USDC on HyperEVM. ${(Number(v.entryBps) / 100).toFixed(2)}% of a deposit stays in the vault, for the people already in it: it pays for what putting your money to work costs them.`)}
    ${say("Getting out", `Whenever you like: withdrawals cannot be paused. ${(Number(v.exitBps) / 100).toFixed(2)}% stays in the vault. Most is paid at once; the part held on Hyperliquid as margin comes back within minutes and is then claimed. If the pool cannot take all of your share's HYPE at a fair price, the rest is sent to you as wrapped HYPE instead of being sold badly.`)}
    ${say("Fee", "20% of the trading fees the position earns, never of deposits. A fifth of that goes to the creator and the rest to the locked reserve on Elysium.")}
    ${say("Who runs it", "A keeper bot tops the margin up, resizes the short, moves the range once the price has been outside it for 10 minutes, and collects the fees once a day. The owner can pause deposits, set the cap, the width of the range, how closely the short follows and how much margin stands behind it, and can wind the vault down to USDC. Neither can take anyone's deposit out. A careless keeper could still cost the vault money, within what the contract allows: it only trades while the pool agrees with Hyperliquid's price to within 1%.")}
    ${row("Vault (HyperEVM)", link(S, "address", c.vault))}
    ${row("Pool (Project X)", link(S, "address", c.pool))}
    ${row("Fee forwarder", link(S, "address", c.forwarder))}
    ${c.sourcify ? row("Source code", `<a class="xl" href="${esc(c.sourcify)}/${esc(c.vault)}" target="_blank" rel="noopener">published on Sourcify, exact match</a>`) : ""}
  </section>`;
}

const risksCard = (v) => `<section class="card" style="margin-bottom:26px"><div class="label">What can go wrong</div>
    ${say("The contracts", "They have been tested, including against the real pool and with real money in a small trial, but nobody independent has reviewed them. A fault could lose everything in the vault.")}
    ${say("Costs above fees", "Nothing guarantees that the fees are larger than what price swings, the hedge and funding cost. In quiet weeks with little trading, or in wild ones, the vault can lose steadily.")}
    ${say("The hedge is not exact", "The short is corrected in steps, not all the time, and never by less than 11 dollars. Between corrections the vault's worth follows part of HYPE's moves; in a small vault that is most of the time.")}
    ${say("Hyperliquid", "The short and its margin are on Hyperliquid's exchange. The vault depends on that exchange working, on its price, and on its rules staying as they are. If HYPE rises fast and far before the margin is topped up, the exchange closes the short at a loss.")}
    ${say("The range", "When the price leaves the range the position stops earning until it is moved, and moving it makes that swing's loss final.")}
    ${say("The bot", "If the keeper bot stops, the margin is not topped up and the range is not moved until someone steps in. Anyone can call the vault's upkeep; only the keeper can move the range.")}
    ${say("A cost that comes once", `Hyperliquid charges an account 1 USDC the first time it sends money out. The vault sets 1.05 USDC aside for that, once, out of what it holds at that moment, so it is shared by everyone in the vault then; someone leaving with nearly all of the vault bears most of it.${v.floatSet === true ? " This has already happened." : v.floatSet === false ? " This has not happened yet." : ""}`)}
  </section>`;

export function view(S) {
  const c = cfgOf(S), v = S.hedged;
  const head = `<a href="#/vaults" class="back">‹ All vaults</a>
    <div class="vhead">${pairCoins()}
      <div><h1>${esc(c?.name ?? "Hedged vault")}</h1><div class="label sub">Direction-neutral · HYPE/USDC on Project X · short on Hyperliquid · HyperEVM</div></div>
      <div class="badges">${badges(v)}</div></div>`;
  if (!c) return `<section class="card empty">Vault not found. <a href="#/vaults">Back to vaults</a></section>`;
  if (!v) return `<section>${head}<div class="card empty">${S.errors?.hedged ? `Couldn't reach HyperEVM just now (${esc(S.errors.hedged)}). Trying again automatically.` : "Loading vault…"}</div></section>`;
  if (!v.live) return `<section>${head}<div class="card empty">This vault is not on HyperEVM yet. The page switches on by itself when it is.</div></section>`;
  return `<section>${head}
    ${pilotNotice(v)}
    <div id="hg-pos">${positionCard(S, v)}</div>
    <div style="margin:0 0 14px"><div class="seggroup" role="group" aria-label="Detail level"><button type="button" data-hview="simple" class="${ui.view === "simple" ? "active" : ""}">Simple</button><button type="button" data-hview="advanced" class="${ui.view === "advanced" ? "active" : ""}">Advanced</button></div></div>
    <section style="margin-bottom:26px"><div class="tiles">${tiles(v)}</div></section>
    <section class="stk-grid" style="margin-bottom:${ui.view === "advanced" ? 14 : 44}px">
      <div class="stack">${priceRangeCard(chartVault(S), CHART_OPTS)}<div class="card" id="hg-chartcard">${chartCard(S)}</div>${liveCard(v)}</div>
      ${panel(S)}
    </section>
    <div id="hg-adv" style="margin-bottom:${ui.view === "advanced" ? 30 : 0}px">${ui.view === "advanced" ? advanced(S, v) : ""}</div>
    ${howCard(S, v)}
    ${risksCard(v)}
    <div class="notice"><span class="dot"></span><div><b>These contracts have not been audited</b>, and they work across HyperEVM and Hyperliquid's exchange, which is more that can go wrong than a vault in one place. The vault holds a perpetual, which some countries restrict: whether you may use it where you live is for you to check. Only deposit what you could afford to lose. Nothing here is advice.</div></div>
  </section>`;
}

// ---------------------------------------------------------------- sending to HyperEVM
async function onHyperEvm(S) {
  const eth = window.ethereum;
  if ((await eth.request({ method: "eth_chainId" })) === HYPEREVM) return;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: HYPEREVM }] });
  } catch (e) {
    if (e.code !== 4902) throw e;
    await eth.request({ method: "wallet_addEthereumChain", params: [{ chainId: HYPEREVM, chainName: "HyperEVM", nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 }, rpcUrls: [S.cfg.hyperevm.rpc], blockExplorerUrls: [S.cfg.hyperevm.explorer] }] });
  }
  wallet.chainId = HYPEREVM;
}
/** Why the vault would refuse, in words, from what the network answers to a trial run. */
function refusal(e) {
  const data = e?.rpcError?.data, sel = typeof data === "string" ? data.slice(0, 10) : "";
  if (REFUSALS[sel]) return REFUSALS[sel];
  if (/insufficient funds/i.test(e?.message ?? "")) return "This wallet needs a little HYPE on HyperEVM to pay the network fee.";
  return `The vault would refuse this${sel ? ` (it answers ${sel})` : ""}. Nothing was sent.`;
}
/** One transaction on HyperEVM: a trial run first (so a refusal costs nothing), then the wallet, then wait for it. */
async function send(S, to, data) {
  const h = S.conn.h, from = wallet.account;
  await onHyperEvm(S);
  let need;
  try { need = BigInt(await h.request("eth_estimateGas", [{ from, to, data }])); } catch (e) { throw new Error(refusal(e)); }
  if (need > GAS_CEILING) throw new Error("This would need more gas than a HyperEVM transaction may use here. Nothing was sent.");
  let gas = (need * 13n) / 10n;
  if (gas > 1_990_000n) gas = 1_990_000n;
  const hash = await window.ethereum.request({ method: "eth_sendTransaction", params: [{ from, to, data, value: "0x0", gas: "0x" + gas.toString(16) }] });
  for (let i = 0; i < 120; i++) {
    const r = await h.request("eth_getTransactionReceipt", [hash]);
    if (r) {
      if (r.status !== "0x1") throw new Error(`The transaction failed on HyperEVM, so nothing changed: ${hash}`);
      noteReceipt(S, r);
      return hash;
    }
    await sleep(1000);
  }
  throw new Error(`Still not confirmed after two minutes: ${hash}`);
}

/** A withdrawal's answer is asked for once per amount and per reading of the chain. */
const quoteKey = (S, want) => `${wallet.account}:${want}:${S.updated}`;
/** Asks the vault, with a call that changes nothing, what a withdrawal of `want` shares would pay now. */
async function quoteWithdraw(S, api, want) {
  const c = cfgOf(S), key = quoteKey(S, want);
  if (ui.quoting === key || ui.quote?.key === key) return;
  ui.quoting = key;
  try {
    const r = await S.conn.h.request("eth_call", [{ from: wallet.account, to: c.vault, data: SEL.withdraw + uint(want) + uint(0) + addr(wallet.account) }, "latest"]);
    const w = words(r).map(toUint);
    if (w.length >= 3) ui.quote = { key, paid: w[0], asset: w[1], owed: w[2] };
  } catch { /* the box then shows the plain estimate */ }
  if (ui.quoting === key) { ui.quoting = ""; if (ui.quote?.key === key && ui.tab === "withdraw") api.render(); }
}

// ---------------------------------------------------------------- behaviour
export function mount(S, api) {
  const input = document.getElementById("hg-amt"), c = cfgOf(S);
  if (S.hedged?.live) mountPriceRange(S.cfg, chartVault(S), { ...CHART_OPTS, load: (win) => loadPriceRange(S, win) });
  mountChart(S);
  mountMore(S, api);
  if (!input || !S.hedged?.live) return;
  {
    const u = S.hedged.user, want = parse6(ui.text);
    if (ui.tab === "withdraw" && u && want > 0n && want <= u.shares && !ui.busy) quoteWithdraw(S, api, want);
  }
  const fail = (err) => { ui.msg = { kind: "err", text: err?.code === 4001 ? "Cancelled in your wallet. Nothing was sent." : String(err?.message || err).slice(0, 260) }; };
  input.addEventListener("input", () => { ui.text = input.value; ui.msg = null; });
  input.addEventListener("change", () => api.render());
  document.querySelectorAll("[data-htab]").forEach((b) => b.addEventListener("click", () => { Object.assign(ui, { tab: b.dataset.htab, text: "", msg: null }); api.render(); }));
  document.getElementById("hg-max")?.addEventListener("click", () => {
    const v = S.hedged, u = v.user;
    if (!u) return;
    const most = ui.tab === "deposit" ? (v.room !== null && v.room < u.usdc ? v.room : u.usdc) : u.shares;
    ui.text = plain6(most);
    ui.msg = null;
    api.render();
  });
  document.getElementById("hg-go")?.addEventListener("click", async () => {
    if (ui.busy) return;
    try {
      if (!wallet.account) { await wallet.connect(); return api.refresh(); }
      const dep = ui.tab === "deposit", want = parse6(ui.text), me = wallet.account;
      let v = S.hedged, u = v.user;
      if (!u) { await api.refresh(); v = S.hedged; u = v.user; }
      if (!u) throw new Error("Couldn't read this wallet on HyperEVM just now. Try again in a moment.");
      if (want === 0n) throw new Error("Enter an amount first.");
      if (dep) {
        if (v.closing) throw new Error("The vault is winding down and takes no deposits.");
        if (v.paused) throw new Error("Deposits are paused.");
        if (want > u.usdc) throw new Error(`This wallet has ${u6(u.usdc)} USDC on HyperEVM.`);
        if (v.room !== null && want > v.room) throw new Error(v.room === 0n ? "The pilot is at its cap and takes no more for now." : `The pilot's cap leaves room for ${u6(v.room)} USDC.`);
        if (!v.inLine) throw new Error("The pool's price and Hyperliquid's are too far apart for the vault to price a deposit fairly. Try again in a minute.");
        const net = want - (want * v.entryBps) / 10_000n;
        const expect = v.supply === 0n ? net - 1_000n : (net * v.supply) / v.value;
        if (expect <= 0n) throw new Error("That amount is too small to buy a share.");
        ui.busy = true; ui.msg = null; api.render();
        if (u.allowance < want) await send(S, c.usdc, SEL.approve + addr(c.vault) + uint(want));
        // the least shares to accept: what the vault's own sum gives now, less 1% for whatever moves before it lands
        const hash = await send(S, c.vault, SEL.deposit + uint(want) + uint((expect * 99n) / 100n) + addr(me));
        ui.msg = { kind: "ok", html: `${esc(u6(want))} USDC is in, for about ${esc(u6(expect, 4))} shares. The keeper puts it to work${want < BOT_MIN_DEPLOY ? " once at least 20 USDC is waiting in the vault" : " within a minute or so"}. ${link(S, "tx", hash, "View transaction")}` };
      } else {
        if (want > u.shares) throw new Error(`This wallet has ${u6(u.shares, 4)} shares.`);
        const worth = (want * v.value) / v.supply, usdcBefore = u.usdc, owedBefore = u.owed;
        // the least to accept, paid and owed together: its worth less the allowance and 2% for the sale of its HYPE
        const min = ((worth - (worth * v.exitBps) / 10_000n) * 98n) / 100n;
        ui.busy = true; ui.msg = null; api.render();
        const hash = await send(S, c.vault, SEL.withdraw + uint(want) + uint(min) + addr(me));
        await api.refresh();
        const now = S.hedged?.user, paid = now ? now.usdc - usdcBefore : 0n, owedNow = now ? now.owed - owedBefore : 0n;
        ui.msg = { kind: "ok", html: `${paid > 0n ? `${esc(u6(paid))} USDC was paid to your wallet` : "Withdrawn"}${owedNow > 0n ? `, and ${esc(u6(owedNow))} USDC is owed to you: it is on its way back from Hyperliquid and can be claimed here in a few minutes` : ""}. ${link(S, "tx", hash, "View transaction")}` };
      }
      ui.text = "";
      more.acctAt = 0; // this wallet's record has a new line: ask for it afresh
      await api.refresh();
    } catch (err) { fail(err); }
    ui.busy = false; api.render();
  });
  document.getElementById("hg-claim")?.addEventListener("click", async () => {
    if (ui.busy) return;
    try {
      const v = S.hedged, u = v.user;
      if (!u || u.owed === 0n) return;
      if (v.idleUsdc === 0n) throw new Error("It has not arrived back from Hyperliquid yet. The keeper brings it within a few minutes: try again then.");
      const before = u.usdc;
      ui.busy = true; ui.msg = null; api.render();
      const hash = await send(S, c.vault, SEL.claim + addr(wallet.account));
      await api.refresh();
      const now = S.hedged?.user;
      ui.msg = { kind: "ok", html: `${esc(u6(now ? now.usdc - before : 0n))} USDC was paid to your wallet${now && now.owed > 0n ? `; ${esc(u6(now.owed))} USDC is still on its way` : ""}. ${link(S, "tx", hash, "View transaction")}` };
    } catch (err) { fail(err); }
    ui.busy = false; api.render();
  });
}
