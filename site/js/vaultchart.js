// Vault charts: the pool price over time with the vault's liquidity ranges behind it,
// a map of where the vault's liquidity sits right now, and a small range strip for
// the vault list. History comes from the Liquid Reserve history service: every pool's
// trades since the day it was created (the low, high and last price of each stretch,
// so short spikes are kept), plus a reading every 5 minutes. The current state always
// comes straight from the chain.
import { esc } from "./ui.js";
import { showTip, hideTip } from "./charts.js";

const HISTORY = {
  url: "https://rtsoqkynobkaslxorpnv.supabase.co/functions/v1/vault-history",
  // Supabase's public (publishable) key: it only lets a browser call the read-only history endpoint.
  key: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ0c29xa3lub2JrYXNseG9ycG52Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ2MjU1NzQsImV4cCI6MjExMDIwMTU3NH0.rEKaUVDgBUG_QfggSLF9vbHk8zLQyg0UoleWYcWIyms",
};
/** Calls one of the history service's read-only endpoints (the Stake page uses "stake-history"). */
export async function historyGet(endpoint, params) {
  const r = await fetch(`${HISTORY.url.replace(/[^/]+$/, endpoint)}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${HISTORY.key}`, apikey: HISTORY.key } });
  if (!r.ok) throw new Error(`history ${r.status}`);
  return r.json();
}
const WINDOWS = [["1D", 86_400], ["1W", 604_800], ["1M", 2_592_000], ["ALL", 0]];
const chart = { win: "1W" };
const cache = new Map();
// one resize handler for whichever chart is on screen
let redraw = null, resizeTimer = 0;
addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => redraw?.(), 120); });

// ---------------------------------------------------------------- prices

const priceAt = (v, tick) => 1.0001 ** tick * 10 ** (v.d0 - v.d1); // token1 per token0

/** A pool whose first token is the dollar (USDC / wANTx) is shown the other way round: dollars per token. */
export const isFlipped = (v) => v.token0 === "USDC" && v.token1 !== "USDC";
/**
 * The same vault with its two tokens swapped, for display only. A Uniswap pool read the other way round is the same
 * pool with every tick's sign changed (tick t becomes -t - 1, so "inside a range" stays exact) and each range's edges
 * swapped. Prices, charts and range pictures are drawn from this view; nothing sent to the chain goes through it.
 */
export function shown(v) {
  if (!v || v.flipped || !isFlipped(v)) return v;
  const range = (r) => (r ? { ...r, lower: -r.upper, upper: -r.lower } : r);
  return {
    ...v, flipped: true, token0: v.token1, token1: v.token0, d0: v.d1, d1: v.d0, token0Usd: v.token1Usd, token1Usd: v.token0Usd,
    tick: Number.isFinite(v.tick) ? -v.tick - 1 : v.tick, main: range(v.main), alt: range(v.alt), poolPrice: 1 / v.poolPrice,
    sqrtP: v.sqrtP ? (1n << 192n) / v.sqrtP : v.sqrtP, total0: v.total1, total1: v.total0, fee0: v.fee1, fee1: v.fee0,
  };
}
const tickOf = (v, p) => Math.log(p / 10 ** (v.d0 - v.d1)) / Math.log(1.0001);
export function fmtPrice(n) {
  if (!isFinite(n)) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : n >= 1e7 ? 1 : 2)}M`;
  if (n >= 1e4) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (n >= 100) return n.toFixed(1);
  if (n >= 1) return n.toFixed(2);
  return n.toPrecision(4);
}
const quote = (v, n) => (v.token1 === "USDC" ? `$${fmtPrice(n)}` : `${fmtPrice(n)} ${v.token1}`);
const unitLabel = (v) => (v.token1 === "USDC" ? `$ per ${v.token0}` : `${v.token1} per ${v.token0}`);
const pctTo = (from, to) => { const p = (to / from - 1) * 100; return `${p >= 0 ? "+" : "−"}${Math.abs(p) < 10 ? Math.abs(p).toFixed(1) : Math.abs(p).toFixed(0)}%`; };
const liqOf = (x) => (x === null || x === undefined ? null : Number(x));
const hasLiq = (x) => x === null || x > 0; // unknown counts as present (older history)
/** nice, round price levels between lo and hi */
function niceLevels(lo, hi, n = 5) {
  const raw = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(raw)), norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const out = [];
  for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) out.push(+p.toPrecision(12));
  return out;
}

// ---------------------------------------------------------------- history

/** The pool Ascend trades $liquid in, shown beside a $liquid vault's own pool. Its tick is the inverse when the coin is listed first there. */
export function refFor(cfg, v) {
  const pool = cfg.pools?.liquidHype;
  if (v.token1 !== "$liquid" || !pool || pool.toLowerCase() === String(v.pool).toLowerCase()) return null;
  return { pool, invert: cfg.pools.liquidReserveIsCurrency0 !== false, name: "Ascend pool" };
}

async function loadHistory(v, win, ref) {
  const k = `${v.address}|${v.pool}|${win}`, hit = cache.get(k);
  if (hit && Date.now() - hit.at < 120_000) return hit.data;
  const q = new URLSearchParams({ vault: v.address, pool: v.pool, window: win });
  if (ref) q.set("ref", ref.pool);
  const r = await fetch(`${HISTORY.url}?${q}`, { headers: { authorization: `Bearer ${HISTORY.key}`, apikey: HISTORY.key } });
  if (!r.ok) throw new Error(`history ${r.status}`);
  const data = await r.json();
  cache.set(k, { at: Date.now(), data });
  return data;
}

/** Turns the raw history plus the live state into series on one time axis. */
function series(v, d, ref) {
  const now = Math.max(d.now, v.now || 0);
  const span = WINDOWS.find((w) => w[0] === chart.win)[1];
  // the history service stores the pool's own ticks; a vault shown the other way round (see `shown`) reads them mirrored
  const pool = d.pool.map(([t, k]) => ({ t, k: v.flipped ? -k - 1 : k }));
  if (isFinite(v.tick)) pool.push({ t: now, k: v.tick });
  const edges = (lo, hi) => (v.flipped ? { lo: -hi, hi: -lo } : { lo, hi });
  // A row recorded while the vault was still empty has no ranges at all (every edge is 0). It is not a range at tick 0:
  // drawn as one it stretched the price axis to nonsense as soon as the vault had its first deposit.
  const ranges = d.ranges.map(([t, ml, mu, mq, al, au, aq]) => ({ t, main: { ...edges(ml, mu), liq: liqOf(mq) }, alt: { ...edges(al, au), liq: liqOf(aq) } }))
    .filter((r) => r.main.lo !== r.main.hi || r.alt.lo !== r.alt.hi);
  const live = { t: now, main: { lo: v.main.lower, hi: v.main.upper, liq: Number(v.main.liquidity) }, alt: { lo: v.alt.lower, hi: v.alt.upper, liq: Number(v.alt.liquidity) } };
  const lastR = ranges.at(-1);
  const same = (a, b) => a && a.main.lo === b.main.lo && a.main.hi === b.main.hi && a.alt.lo === b.alt.lo && a.alt.hi === b.alt.hi && hasLiq(a.main.liq) === hasLiq(b.main.liq) && hasLiq(a.alt.liq) === hasLiq(b.alt.liq);
  if (!v.empty && !same(lastR, live)) ranges.push({ ...live, t: lastR ? now : Math.max(now - 300, pool[0]?.t ?? now) });
  const refPts = (d.ref ?? []).map(([t, k]) => ({ t, k: ref?.invert ? -k : k }));
  // The chart starts at the earliest thing it has: for a $liquid vault that is Ascend's pool, where the coin has
  // traded since launch, so the token's price shows from day one and not only from the day the vault's own pool opened.
  const first = Math.min(...[pool[0]?.t, ranges[0]?.t, refPts[0]?.t].filter((x) => x !== undefined));
  const t0 = span ? Math.max(now - span, Math.min(first, now - 60)) : first;
  return { now, t0, pool, ranges, ref: refPts };
}

/** The range rows in force over time, clipped to [t0, now]. */
function segments(s) {
  const out = [];
  s.ranges.forEach((r, i) => {
    const a = Math.max(r.t, s.t0), b = i + 1 < s.ranges.length ? s.ranges[i + 1].t : s.now;
    if (b > a) out.push({ a, b, r });
  });
  return out;
}
const inRange = (r, k) => (hasLiq(r.main.liq) && k >= r.main.lo && k < r.main.hi) || (hasLiq(r.alt.liq) && k >= r.alt.lo && k < r.alt.hi);
const rangeAt = (s, t) => { let r = null; for (const x of s.ranges) { if (x.t <= t) r = x; else break; } return r; };

/** Share of the time (with a range open) that the price sat inside the vault's liquidity, and the number of range moves. */
export function rangeStats(s) {
  let inside = 0, total = 0;
  const pts = s.pool.filter((p, i) => i + 1 < s.pool.length && s.pool[i + 1].t > s.t0);
  for (let i = 0; i < s.pool.length - 1; i++) {
    const a = Math.max(s.pool[i].t, s.t0), b = s.pool[i + 1].t;
    if (b <= a) continue;
    const r = rangeAt(s, a);
    if (!r) continue;
    total += b - a;
    if (inRange(r, s.pool[i].k)) inside += b - a;
  }
  const moves = s.ranges.filter((r, i) => i > 0 && r.t >= s.t0 && (r.main.lo !== s.ranges[i - 1].main.lo || r.main.hi !== s.ranges[i - 1].main.hi)).length;
  const inWin = s.pool.filter((p) => p.t >= s.t0);
  const before = s.pool.filter((p) => p.t < s.t0).at(-1);
  const startK = (before ?? inWin[0])?.k, endK = s.pool.at(-1)?.k;
  return { timeIn: total > 0 ? inside / total : NaN, moves, startK, endK, points: pts.length };
}

// ---------------------------------------------------------------- price and range chart

export function priceRangeCard(v) {
  v = shown(v);
  return `<div class="card prc">
    <div class="prc-top">
      <div><div class="label">Price and liquidity range</div>
        <div class="prc-now num"><b>${quote(v, priceAt(v, v.tick))}</b><span class="dim">${esc(unitLabel(v))}</span></div></div>
      <div class="seggroup sm" role="group" aria-label="Chart time range">${WINDOWS.map(([w]) => `<button type="button" data-cwin="${w}" class="${chart.win === w ? "active" : ""}">${w}</button>`).join("")}</div>
    </div>
    <div class="prc-chart" id="pricerange"><div class="empty" style="padding:96px 18px">Loading price history…</div></div>
    <div class="prc-legend">
      <span><i class="ln"></i>Pool price</span><span><i class="bx main"></i>Main range</span><span><i class="bx alt"></i>Side range</span>
      <span><i class="ln out"></i>Price outside the ranges</span>${v.token1 === "$liquid" ? `<span><i class="ln ref"></i>Ascend pool price</span>` : ""}
    </div>
    <div class="prc-stats" id="prcstats"></div>
    <p class="note" id="prcnote"></p>
    <p class="note">The vault earns trading fees only while the pool price is inside one of its ranges. When the price leaves for good, the keeper moves the ranges back around it.</p>
  </div>`;
}

/** Loads the history for the chosen window and draws the chart; the window buttons redraw it in place. */
export async function mountPriceRange(cfg, v) {
  v = shown(v);
  drawLiquidityMap(v);
  const el = document.getElementById("pricerange");
  if (!el) return;
  const ref = refFor(cfg, v);
  document.querySelectorAll("[data-cwin]").forEach((b) => b.addEventListener("click", () => {
    chart.win = b.dataset.cwin;
    document.querySelectorAll("[data-cwin]").forEach((x) => x.classList.toggle("active", x === b));
    mountPriceRange(cfg, v);
  }));
  const win = chart.win;
  let d = null, partial = false;
  try { d = await loadHistory(v, win, ref); }
  catch {
    await new Promise((r) => setTimeout(r, 1500));
    try { d = await loadHistory(v, win, ref); }
    catch { d = chainHistory(v); partial = true; } // the history service is out of reach: draw what the chain already gave us
  }
  if (chart.win !== win || !document.body.contains(el)) return;
  const s = series(v, d, ref);
  drawPriceRange(el, v, s, ref);
  stats(v, s, ref);
  const note = document.getElementById("prcnote");
  if (note) note.innerHTML = partial ? `The full price history couldn't load, so this shows the vault's own on-chain events only. <button type="button" class="btn sm" id="prcretry">Try again</button>` : "";
  document.getElementById("prcretry")?.addEventListener("click", () => mountPriceRange(cfg, v));
  redraw = () => { if (document.body.contains(el)) { drawPriceRange(el, v, s, ref); drawLiquidityMap(v); } };
}

/** The same shape as the history service's answer, built from the vault's own events (read from the chain on page load). */
function chainHistory(v) {
  const h = v.hist ?? { snaps: [], rebalances: [] };
  const pool = [...h.rebalances.map((r) => [r.t, r.tick]), ...h.snaps.filter((p) => p.k !== null && p.k !== undefined).map((p) => [p.t, p.k])].sort((a, b) => a[0] - b[0]);
  const ranges = h.rebalances.map((r) => [r.t, r.lower, r.upper, null, r.altLower ?? r.lower, r.altUpper ?? r.lower, null]);
  return { now: v.now, pool, ref: [], ranges, share: [] };
}

function stats(v, s, ref) {
  const box = document.getElementById("prcstats");
  if (!box) return;
  const st = rangeStats(s), p = priceAt(v, v.tick);
  const main = v.main.liquidity > 0n ? v.main : v.alt;
  const cell = (k, val, sub = "") => `<div><div class="k">${k}</div><div class="v num">${val}</div>${sub ? `<div class="s">${sub}</div>` : ""}</div>`;
  const win = chart.win === "ALL" ? "all history" : `past ${{ "1D": "24 hours", "1W": "7 days", "1M": "30 days" }[chart.win]}`;
  const lastRef = s.ref.at(-1);
  box.innerHTML = [
    cell("Time in range", isFinite(st.timeIn) ? `${(st.timeIn * 100).toFixed(0)}%` : "—", win),
    cell("Price change", st.startK !== undefined && st.endK !== undefined ? pctTo(priceAt(v, st.startK), priceAt(v, st.endK)) : "—", win),
    cell("Range moves", String(st.moves), win),
    cell("Range edges", v.empty ? "—" : `${pctTo(p, priceAt(v, main.lower))} / ${pctTo(p, priceAt(v, main.upper))}`, "from the price now"),
    ...(ref && lastRef ? [cell("vs Ascend pool", pctTo(priceAt(v, lastRef.k), p), "this pool's price against Ascend's")] : []),
  ].join("");
}

function drawPriceRange(el, v, s, ref) {
  const W = Math.max(300, el.clientWidth || 640), H = W < 520 ? 250 : 320;
  const m = { l: 8, r: W < 520 ? 66 : 84, t: 14, b: 28 }, pw = W - m.l - m.r, ph = H - m.t - m.b;
  const segs = segments(s);
  if (s.pool.length < 2 && !segs.length) {
    el.innerHTML = `<div class="empty" style="padding:96px 18px">No price history for this window yet.</div>`;
    return;
  }
  const span = Math.max(60, s.now - s.t0);
  // vertical extent, in ticks (a log-price axis): the price, Ascend's price and every range on screen
  const ks = [...s.pool.filter((p, i) => i + 1 >= s.pool.length || s.pool[i + 1].t >= s.t0).map((p) => p.k), ...s.ref.filter((p) => p.t >= s.t0).map((p) => p.k)];
  segs.forEach(({ r }) => { if (!v.empty) ks.push(r.main.lo, r.main.hi); if (hasLiq(r.alt.liq)) ks.push(r.alt.lo, r.alt.hi); });
  let kLo = Math.min(...ks), kHi = Math.max(...ks);
  const padK = Math.max((kHi - kLo) * 0.08, 20); kLo -= padK; kHi += padK;
  const x = (t) => m.l + ((t - s.t0) / span) * pw;
  const y = (k) => m.t + ph - ((k - kLo) / (kHi - kLo)) * ph;
  const X = (t) => x(t).toFixed(1), Y = (k) => y(k).toFixed(1);

  // price labels on the right, at round prices
  const pLo = priceAt(v, kLo), pHi = priceAt(v, kHi);
  let levels = niceLevels(pLo, pHi, H < 300 ? 4 : 5);
  if (levels.length < 3) levels = [pLo + (pHi - pLo) * 0.25, pLo + (pHi - pLo) * 0.5, pLo + (pHi - pLo) * 0.75];
  let svg = levels.map((p) => { const yy = y(tickOf(v, p)); return `<line x1="${m.l}" x2="${m.l + pw}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/><text x="${m.l + pw + 8}" y="${(yy + 4).toFixed(1)}">${esc(fmtPrice(p))}</text>`; }).join("");
  const fmtT = (t) => new Date(t * 1000).toLocaleString("en-US", span <= 2 * 86_400 ? { hour: "numeric", minute: "2-digit" } : span <= 10 * 86_400 ? { weekday: "short", hour: "numeric" } : { month: "short", day: "numeric" });
  const nX = W < 520 ? 3 : 5;
  for (let i = 0; i < nX; i++) { const t = s.t0 + (span * i) / (nX - 1); svg += `<text x="${X(t)}" y="${H - 8}" text-anchor="${i === 0 ? "start" : i === nX - 1 ? "end" : "middle"}">${esc(fmtT(t))}</text>`; }

  // ranges: the side range under the main one; an empty range is drawn as an outline only
  const band = (a, b, lo, hi, cls, empty) => {
    const yy = y(hi), h = Math.max(1.5, y(lo) - y(hi));
    return `<rect class="${cls}${empty ? " empty" : ""}" x="${X(a)}" y="${yy.toFixed(1)}" width="${Math.max(1, x(b) - x(a)).toFixed(1)}" height="${h.toFixed(1)}"/>`
      + `<line class="${cls}-edge" x1="${X(a)}" x2="${X(b)}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}"/><line class="${cls}-edge" x1="${X(a)}" x2="${X(b)}" y1="${(yy + h).toFixed(1)}" y2="${(yy + h).toFixed(1)}"/>`;
  };
  segs.forEach(({ a, b, r }) => {
    if (r.alt.hi > r.alt.lo && (r.alt.lo !== r.main.lo || r.alt.hi !== r.main.hi)) svg += band(a, b, r.alt.lo, r.alt.hi, "alt", !hasLiq(r.alt.liq));
    svg += band(a, b, r.main.lo, r.main.hi, "main", !hasLiq(r.main.liq));
  });
  // range moves
  segs.slice(1).forEach(({ a }) => { svg += `<line class="move" x1="${X(a)}" x2="${X(a)}" y1="${m.t}" y2="${m.t + ph}"/><path class="move-mark" d="M${X(a)},${m.t + 2}l4,5l-4,5l-4,-5z"/>`; });

  // Ascend's price (for $liquid vaults), dashed
  const refIn = s.ref.filter((p, i) => i + 1 >= s.ref.length || s.ref[i + 1].t >= s.t0);
  if (refIn.length) {
    let d = "";
    refIn.forEach((p, i) => { const tx = X(Math.max(p.t, s.t0)); d += i ? `H${tx}V${Y(p.k)}` : `M${tx},${Y(p.k)}`; });
    d += `H${X(s.now)}`;
    svg += `<path class="ref" d="${d}"/>`;
  }

  // the pool price as steps, coloured by whether it sat inside the vault's liquidity
  const pts = s.pool.filter((p, i) => i + 1 >= s.pool.length || s.pool[i + 1].t >= s.t0);
  // each sample holds until the next one; a change of status starts a new path, joined by the vertical step
  let path = "", cur = null, out = "";
  const close = () => { if (path) out += `<path class="${cur ? "px" : "px out"}" d="${path}"/>`; };
  for (let i = 0; i < pts.length; i++) {
    const a = Math.max(pts[i].t, s.t0), b = i + 1 < pts.length ? pts[i + 1].t : s.now;
    if (b < a) continue;
    const r = rangeAt(s, a), st = !r || inRange(r, pts[i].k);
    if (st !== cur) { if (path) path += `V${Y(pts[i].k)}`; close(); path = `M${X(a)},${Y(pts[i].k)}`; cur = st; }
    else path += `V${Y(pts[i].k)}`;
    path += `H${X(b)}`;
  }
  close();
  svg += out;
  // the price now
  const kNow = s.pool.at(-1).k, yNow = y(kNow);
  svg += `<circle class="dot" cx="${X(s.now)}" cy="${yNow.toFixed(1)}" r="4"/>`;
  svg += `<g class="nowtag"><rect x="${(m.l + pw + 4).toFixed(1)}" y="${(yNow - 10).toFixed(1)}" width="${m.r - 6}" height="20" rx="6"/><text x="${(m.l + pw + 10).toFixed(1)}" y="${(yNow + 4).toFixed(1)}">${esc(fmtPrice(priceAt(v, kNow)))}</text></g>`;

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${esc(`${v.name}: pool price and the vault's liquidity ranges over time`)}">${svg}
    <g class="hover"><line y1="${m.t}" y2="${m.t + ph}"/><circle r="4"/></g>
    <rect class="hit" x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" fill="transparent"/></svg>`;

  const svgEl = el.querySelector("svg"), g = el.querySelector(".hover"), hit = el.querySelector(".hit");
  const tipT = (t) => new Date(t * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  hit.addEventListener("pointermove", (ev) => {
    const box = svgEl.getBoundingClientRect(), t = s.t0 + (((ev.clientX - box.left) / box.width) * W - m.l) / pw * span;
    let p = pts[0];
    for (const q of pts) { if (q.t <= t) p = q; else break; }
    const r = rangeAt(s, t), k = p.k, rp = s.ref.filter((q) => q.t <= t).at(-1);
    g.style.opacity = 1;
    const line = g.querySelector("line"), dot = g.querySelector("circle");
    line.setAttribute("x1", X(t)); line.setAttribute("x2", X(t)); dot.setAttribute("cx", X(t)); dot.setAttribute("cy", Y(k));
    const rows = [{ name: "Pool price", color: "var(--ink)", value: quote(v, priceAt(v, k)) }];
    if (r) {
      rows.push({ name: "Main range", color: "var(--accent)", value: hasLiq(r.main.liq) ? `${fmtPrice(priceAt(v, r.main.lo))} – ${fmtPrice(priceAt(v, r.main.hi))}` : "empty" });
      if (r.alt.hi > r.alt.lo && hasLiq(r.alt.liq)) rows.push({ name: "Side range", color: "var(--accent-2)", value: `${fmtPrice(priceAt(v, r.alt.lo))} – ${fmtPrice(priceAt(v, r.alt.hi))}` });
      rows.push({ name: "Earning fees", value: inRange(r, k) ? "Yes" : "No, price outside" });
    } else rows.push({ name: "Vault", value: "not open yet" });
    if (rp) rows.push({ name: ref?.name ?? "Reference", color: "var(--ink-3)", value: `${quote(v, priceAt(v, rp.k))} (${pctTo(priceAt(v, rp.k), priceAt(v, k))})` });
    showTip(ev.clientX, ev.clientY, tipT(t), rows);
  });
  hit.addEventListener("pointerleave", () => { g.style.opacity = 0; hideTip(); });
}

// ---------------------------------------------------------------- liquidity map (now)

/**
 * Where the vault's liquidity sits right now, on a price axis: one block per range, its height
 * the liquidity per price step, the price now as a line. rows: [{ name, part }] for the legend.
 */
export function liquidityMap(v, rows = []) {
  const legend = rows.length ? `<div class="lm-legend">${rows.map((r) => `<span><i class="bx ${r.key}"></i><b>${esc(r.name)}</b> ${r.part}</span>`).join("")}</div>` : "";
  return `<div class="lmap" id="lmap"></div>${legend}`;
}
/** Draws the map at the width it has on screen (so its labels keep their size on a phone). */
export function drawLiquidityMap(v) {
  v = shown(v);
  const el = document.getElementById("lmap");
  if (el) el.innerHTML = lmapSvg(v, Math.max(300, el.clientWidth || 640));
}
function lmapSvg(v, W) {
  const H = 168, m = { l: 10, r: 10, t: 34, b: 30 }, pw = W - m.l - m.r, ph = H - m.t - m.b;
  const rs = [{ key: "main", r: v.main }, { key: "alt", r: v.alt }].filter(({ r }) => r.upper > r.lower);
  const ks = [v.tick, ...rs.flatMap(({ r }) => [r.lower, r.upper])];
  let lo = Math.min(...ks), hi = Math.max(...ks);
  const pad = Math.max((hi - lo) * 0.14, 60); lo -= pad; hi += pad;
  const x = (k) => m.l + ((k - lo) / (hi - lo)) * pw;
  // piecewise: stack main then side wherever they overlap
  const edges = [...new Set(rs.flatMap(({ r }) => [r.lower, r.upper]))].sort((a, b) => a - b);
  const L = (r) => Number(r.liquidity);
  let maxL = 0;
  for (let i = 0; i + 1 < edges.length; i++) { const mid = (edges[i] + edges[i + 1]) / 2; maxL = Math.max(maxL, rs.reduce((s, { r }) => s + (mid >= r.lower && mid < r.upper ? L(r) : 0), 0)); }
  const hOf = (l) => (maxL > 0 ? (l / maxL) * ph : 0);
  let svg = `<line x1="${m.l}" x2="${m.l + pw}" y1="${m.t + ph}" y2="${m.t + ph}" stroke="var(--axis)" stroke-width="1"/>`;
  for (let i = 0; i + 1 < edges.length; i++) {
    const a = edges[i], b = edges[i + 1], mid = (a + b) / 2;
    let base = 0;
    for (const { key, r } of rs) {
      if (!(mid >= r.lower && mid < r.upper) || L(r) <= 0) continue;
      const h = hOf(L(r));
      svg += `<rect class="lm-${key}" x="${x(a).toFixed(1)}" y="${(m.t + ph - base - h).toFixed(1)}" width="${(x(b) - x(a)).toFixed(1)}" height="${h.toFixed(1)}"/>`;
      base += h;
    }
  }
  // empty ranges as outlines
  rs.filter(({ r }) => L(r) <= 0).forEach(({ key, r }) => { svg += `<rect class="lm-${key} empty" x="${x(r.lower).toFixed(1)}" y="${(m.t + ph * 0.55).toFixed(1)}" width="${(x(r.upper) - x(r.lower)).toFixed(1)}" height="${(ph * 0.45).toFixed(1)}"/>`; });
  // edge labels: price and distance from the price now, for the main range (and side range edges that differ)
  const pNow = priceAt(v, v.tick);
  const labelled = new Set();
  const edgeLabel = (k, anchor) => {
    if (labelled.has(k)) return ""; labelled.add(k);
    const xx = x(k), a = xx < m.l + 60 ? "start" : xx > m.l + pw - 60 ? "end" : anchor;
    return `<line x1="${xx.toFixed(1)}" x2="${xx.toFixed(1)}" y1="${m.t + ph}" y2="${m.t + ph + 4}" stroke="var(--line-3)"/><text x="${xx.toFixed(1)}" y="${H - 8}" text-anchor="${a}">${esc(fmtPrice(priceAt(v, k)))} <tspan class="dim">${esc(pctTo(pNow, priceAt(v, k)))}</tspan></text>`;
  };
  const main = rs.find((r) => r.key === "main")?.r;
  if (main) svg += edgeLabel(main.lower, "middle") + edgeLabel(main.upper, "middle");
  const alt = rs.find((r) => r.key === "alt")?.r;
  if (alt && Math.abs(x(alt.lower) - x(main?.lower ?? -1e9)) > 70 && Math.abs(x(alt.lower) - x(main?.upper ?? -1e9)) > 70) svg += edgeLabel(alt.lower, "middle");
  if (alt && Math.abs(x(alt.upper) - x(main?.lower ?? -1e9)) > 70 && Math.abs(x(alt.upper) - x(main?.upper ?? -1e9)) > 70) svg += edgeLabel(alt.upper, "middle");
  // the price now
  const xn = x(v.tick), tag = quote(v, pNow), tw = 14 + tag.length * 7.2;
  const tx = Math.min(Math.max(xn - tw / 2, m.l), m.l + pw - tw);
  svg += `<line class="lm-now" x1="${xn.toFixed(1)}" x2="${xn.toFixed(1)}" y1="${m.t - 6}" y2="${m.t + ph}"/>`
    + `<g class="lm-tag"><rect x="${tx.toFixed(1)}" y="4" width="${tw.toFixed(1)}" height="22" rx="7"/><text x="${(tx + tw / 2).toFixed(1)}" y="19" text-anchor="middle">${esc(tag)}</text></g>`;
  return `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${esc(`Where the vault's liquidity sits: price now ${tag}`)}">${svg}</svg>`;
}

// ---------------------------------------------------------------- strip for the vault list

/** A small strip: the main range, the side range, and where the price is. */
export function miniRange(v) {
  v = shown(v);
  if (!v.live || v.empty) return "";
  const rs = [v.alt, v.main].filter((r) => r.upper > r.lower && r.liquidity > 0n);
  if (!rs.length) return "";
  const ks = [v.tick, ...rs.flatMap((r) => [r.lower, r.upper])];
  let lo = Math.min(...ks), hi = Math.max(...ks); const pad = Math.max((hi - lo) * 0.12, 30); lo -= pad; hi += pad;
  const x = (k) => (2 + ((k - lo) / (hi - lo)) * 116).toFixed(1);
  const bands = rs.map((r) => `<rect class="${r === v.main ? "m" : "a"}" x="${x(r.lower)}" y="5" width="${Math.max(2, x(r.upper) - x(r.lower)).toFixed(1)}" height="6" rx="3"/>`).join("");
  const label = v.state === "earning" ? "in range" : v.state === "waiting" ? "waiting" : "out of range";
  return `<span class="mini-range ${v.state}" title="Price ${label}"><svg viewBox="0 0 120 16" width="120" height="16" aria-hidden="true"><rect class="t" x="2" y="7" width="116" height="2" rx="1"/>${bands}<rect class="p" x="${(x(v.tick) - 1).toFixed(1)}" y="1" width="2" height="14" rx="1"/></svg><span>${label}</span></span>`;
}
