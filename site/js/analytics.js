// Analytics, laid out like a protocol stats page: a grid of headline tiles,
// charts, then an activity log with tabs. Everything is read from the chain in
// the visitor's browser. The projection at the bottom is clearly labelled as a model.
import { usd, amount, price, pct, ago } from "./format.js";
import { esc, eyebrow, tile, val, explorer, buyLinks, S as SER } from "./ui.js";
import { columns, area, spark } from "./charts.js";
import { daysFor, perDay, cumulative, dayLabel } from "./history.js";
import { isLaunched, coinLive } from "./data.js";
import { flow } from "./flow.js";
import { hedgedTvl, hedgedLive, hedgedKnown } from "./hedged.js";

/** The coin exists, so buybacks, the reserve and trades can be charted, even before the full flywheel. */
const liveNow = (cfg) => isLaunched(cfg) || coinLive(cfg);

const ui = { range: 30, vol: 60, band: 2, apr: 2.5, tab: null, page: 0 };
const RANGES = [[7, "7D"], [30, "30D"], [90, "90D"], [0, "All"]];

// Ascend's split of the first 1% of the fee, by market-cap band (share of trade size).
export const BANDS = [
  { name: "Under $40K", creator: 0.0035, support: 0, protocol: 0.0065 },
  { name: "$40K – $1M", creator: 0.005, support: 0.0005, protocol: 0.0045 },
  { name: "$1M – $10M", creator: 0.0055, support: 0.0005, protocol: 0.004 },
  { name: "$10M – $50M", creator: 0.006, support: 0.0005, protocol: 0.0035 },
  { name: "$50M+", creator: 0.0075, support: 0.0005, protocol: 0.002 },
];
export const volOf = (v) => {
  const raw = 10 ** (3 + (v / 100) * 4); // $1K .. $10M, log scale
  const mag = 10 ** Math.floor(Math.log10(raw));
  return Math.round(raw / (mag / 10)) * (mag / 10);
};

/**
 * Where one day of trading volume goes (USD). `fl` is flow(S): how a fee that reaches the reserve's fee contract
 * (`reserve` below) is divided right now, read from the chain.
 */
export function flows(vol, bandIdx, fl) {
  const b = BANDS[bandIdx], ca = 0.01 + b.creator;
  const alloc = ca * vol, share = 0.5 * alloc, reserve = 0.8 * share;
  return {
    fees: 0.02 * vol, ascend: b.protocol * vol, support: b.support * vol, alloc,
    holders: 0.25 * alloc, buyback: 0.25 * alloc, share, creator: 0.2 * share, reserve,
    khype: fl.khype * reserve, kntq: fl.kntq * reserve, drop: fl.toDrop * reserve, aside: fl.aside * reserve,
    locked: (fl.khype + fl.kntq) * reserve,
    bought: 0.25 * alloc + fl.toDrop * reserve + b.support * vol,
  };
}

/** Twelve-month projection at constant volume and prices, with the yield divided by today's shares. */
export function project(vol, bandIdx, aprPct, fl) {
  const f = flows(vol, bandIdx, fl), D = 30.4, apr = aprPct / 100, ys = fl.y;
  let kh = 0, kn = 0;
  const m = { x: [], kh: [], kn: [], buyback: [], bucket: [], support: [], yieldBuys: [], creator: [], yield: [] };
  for (let i = 1; i <= 12; i++) {
    const y = (kh * apr) / 12; // only kHYPE's staking yield is assumed
    kh += f.khype * D + ys.compound * y; // the compounding share stays kHYPE and is locked again
    kn += f.kntq * D;
    m.x.push(`M${i}`); m.kh.push(kh); m.kn.push(kn);
    m.buyback.push(f.buyback * D); m.bucket.push(f.drop * D); m.support.push(f.support * D); m.yieldBuys.push((ys.drop + ys.pools + ys.send) * y);
    m.creator.push(f.creator * D + ys.creator * y); m.yield.push(y);
  }
  return { f, m, total: kh + kn, yieldYear: m.yield.reduce((a, b) => a + b, 0), boughtYear: [...m.buyback, ...m.bucket, ...m.support, ...m.yieldBuys].reduce((a, b) => a + b, 0), creatorYear: m.creator.reduce((a, b) => a + b, 0) };
}

const chartCard = (id, title, sub) => `<div class="card chartcard"><div class="label">${title}</div><div class="sub">${sub}</div><div class="chart" data-chart="${id}"></div></div>`;

function modelSection() {
  return `<section>
    <div class="sec-head"><div>${eyebrow("Model")}<h2>Model the <em>flywheel.</em></h2></div></div>
    <div class="notice" style="margin-bottom:14px"><span class="dot"></span><div><b>This is a projection, not data.</b> It assumes constant trading volume and prices for 12 months, counts staking yield on kHYPE only, and divides fees and yield the way they are divided today. The owner can change the yield shares. Real results will differ.</div></div>
    <div class="card" style="margin-bottom:14px"><div class="model">
      <div class="ctrl"><label for="m-vol"><span>Daily trading volume</span><b id="m-vol-v"></b></label><input id="m-vol" type="range" min="0" max="100" step="1" value="${ui.vol}" /></div>
      <div class="ctrl"><label for="m-band"><span>Market cap</span></label><select id="m-band">${BANDS.map((b, i) => `<option value="${i}"${i === ui.band ? " selected" : ""}>${b.name}</option>`).join("")}</select></div>
      <div class="ctrl"><label for="m-apr"><span>kHYPE staking yield</span><b id="m-apr-v"></b></label><input id="m-apr" type="range" min="0" max="10" step="0.5" value="${ui.apr}" /></div>
    </div></div>
    <div id="model-out"></div>
  </section>`;
}

function paintModel(S, root) {
  const fl = flow(S), vol = volOf(ui.vol), p = project(vol, ui.band, ui.apr, fl), f = p.f;
  root.querySelector("#m-vol-v").textContent = usd(vol);
  root.querySelector("#m-apr-v").textContent = `${ui.apr.toFixed(1)}%`;
  root.querySelector("#model-out").innerHTML = `
    <div class="tiles" style="margin-bottom:14px">
      ${tile("Fees per day", usd(f.fees), "2% of volume")}
      ${tile("Locked per day", usd(f.locked), `${pct(f.locked / vol, 2)} of volume`)}
      ${tile("$liquid bought per day", usd(f.bought), fl.drop ? "buyback + the drop + coin support" : "buyback + coin support")}
      ${tile("Reserve after 12 months", usd(p.total), `earning ${usd(p.yieldYear)} in year one`)}
    </div>
    <div class="two">
      ${chartCard("m-reserve", "Projected reserve", "Principal locked, by asset · US dollars")}
      ${chartCard("m-buys", "Projected $liquid buying", "Per month, by source · US dollars")}
    </div>`;
  area(root.querySelector('[data-chart="m-reserve"]'), {
    id: "m-reserve", title: "Projected reserve by asset", x: p.m.x, xTitle: "Month", fmt: usd,
    series: [{ name: "kHYPE", color: SER[0], values: p.m.kh }, ...(fl.kntq > 0 ? [{ name: "sKNTQ", color: SER[1], values: p.m.kn }] : [])],
  });
  columns(root.querySelector('[data-chart="m-buys"]'), {
    id: "m-buys", title: "Projected monthly $liquid buying", x: p.m.x, xTitle: "Month", fmt: usd,
    series: [
      { name: "Buyback and burn (25% of fees)", color: SER[0], values: p.m.buyback },
      { name: "For the drop (a tenth of fees in)", color: SER[1], values: p.m.bucket },
      { name: "Ascend coin support", color: SER[2], values: p.m.support },
      { name: "From reserve yield", color: SER[3], values: p.m.yieldBuys },
    ],
  });
}

// ───────── protocol tiles
function protocol(S) {
  const launched = isLaunched(S.cfg), m = S.market, r = S.reserves, f = S.flywheel?.totals, h = S.history;
  const live = (S.vaults ?? []).filter((v) => v.live), all = S.vaults ?? [];
  // the hedged vault on HyperEVM counts as a vault too (js/hedged.js): its worth is part of what is in the vaults
  const tvl = live.reduce((s, v) => s + (v.tvlUsd || 0), 0) + hedgedTvl(S), earned = live.reduce((s, v) => s + (v.earnedUsd || 0), 0);
  const nLive = live.length + hedgedLive(S), nAll = all.length + hedgedKnown(S);
  const vaultTiles = [
    tile("Vault TVL", S.vaults ? (nLive ? usd(tvl) : "—") : val(undefined), `${nLive} of ${nAll} vaults live${hedgedLive(S) ? `, ${usd(hedgedTvl(S))} of it in the hedged vault` : ""}`),
    tile("Earned in vaults", S.vaults ? (live.length ? usd(earned) : "—") : val(undefined), "for depositors, after fees"),
  ];
  const sum = (rows) => rows.reduce((s, e) => s + e.amount, 0);
  // Everything $liquid has ever traded for, in every pool it trades in (Ascend's and the vaults' own). Each trade is
  // counted once, by the HYPE that changed hands; the dollar figure prices that HYPE at today's price.
  const trades = h?.trades ?? [], volHype = trades.reduce((s, x) => s + x.hype, 0), bought = trades.filter((x) => x.side === "buy").length;
  const volumeTiles = [
    tile("Volume · all time", h ? usd(volHype * (m?.usd.HYPE ?? NaN)) : val(undefined), h ? `${amount(volHype)} HYPE traded, at today's HYPE price` : ""),
    tile("Trades · all time", h ? amount(trades.length) : val(undefined), h ? `${amount(bought)} buys and ${amount(trades.length - bought)} sells, all pools` : ""),
  ];
  if (!launched && coinLive(S.cfg)) {
    const now = S.heads?.elysium?.time ?? Date.now() / 1000, day = (h?.trades ?? []).filter((x) => x.t > now - 86400);
    const vol = day.reduce((s, x) => s + x.hype, 0) * (m?.usd.HYPE ?? NaN), pl = m?.usd["$liquid"], supply = h?.supply || 1e9;
    const tiles2 = [
      tile("$liquid", val(pl, price), "Ascend pool, live"),
      tile("Market cap", isFinite(pl) ? usd(pl * supply) : val(undefined), `${amount(supply)} supply`),
      tile("Volume · 24h", h ? usd(vol) : val(undefined), h ? `${day.length} trade${day.length === 1 ? "" : "s"}, all pools` : ""),
      ...volumeTiles,
      tile("Locked in the reserve", S.inbox?.pre ? usd(S.inbox.pre.lockedUsd) : val(undefined), "kHYPE and sKNTQ, for good"),
      tile("Supply burned", h?.supply ? pct(h.burned / h.supply, 3) : val(undefined), h ? `${amount(h.burned)} $liquid` : ""),
      tile("Bought back", h ? amount(sum(h.buys)) : val(undefined), "$liquid, with fees and yield"),
      ...vaultTiles,
    ];
    return `<section style="margin-bottom:34px"><div class="label sec-label">Protocol</div><div class="tiles">${tiles2.join("")}</div></section>`;
  }
  const tiles = launched
    ? [
        tile("Total locked", val(r?.totalUsd, usd), "both reserves, for good"),
        tile("Supply burned", h?.supply ? pct(h.burned / h.supply, 2) : val(undefined), h ? `${amount(h.burned)} $liquid` : ""),
        tile("Bought back", h ? amount(sum(h.buys)) : val(undefined), "$liquid, all time"),
        ...volumeTiles,
        tile("Fees into the reserve", val(f?.toReserveUsd, usd), "all time"),
        tile("Yield harvested", val(f?.harvestedUsd, usd), "all time"),
        tile("KNTQ burned", h ? amount(sum(h.kntqBurns)) : val(undefined), "ecosystem buyback"),
        tile("HYPE burned", h ? amount(sum(h.hypeBurns)) : val(undefined), "ecosystem buyback"),
        vaultTiles[0],
      ]
    : [
        tile("HYPE", val(m?.usd.HYPE, price), "Elysium spot"),
        tile("KNTQ", val(m?.usd.KNTQ, price), "Elysium spot"),
        tile("kHYPE", val(m?.usd.kHYPE, price), val(m?.hypePerKhype, (x) => `1 kHYPE = ${x.toFixed(4)} HYPE`)),
        tile("sKNTQ", val(m?.usd.sKNTQ, price), val(m?.skntqRate, (x) => `1 sKNTQ = ${x.toFixed(4)} KNTQ`)),
        ...vaultTiles,
        tile("Reserve locked", "—", "starts at token launch"),
        tile("Supply burned", "—", "starts at token launch"),
      ];
  return `<section style="margin-bottom:34px"><div class="label sec-label">Protocol</div><div class="tiles">${tiles.join("")}</div></section>`;
}

// ───────── charts (after launch)
function chartsSection(S) {
  const h = S.history;
  if (!h) return `<section class="card empty">${S.errors.history ? "Couldn't load history: " + esc(S.errors.history) : "Loading on-chain history…"}</section>`;
  return `<section style="margin-bottom:34px">
    <div class="filters"><div class="label" style="margin-right:auto;margin-left:4px">Buybacks and reserve</div>
      <div class="seggroup sm" role="group" aria-label="Time range">${RANGES.map(([d, l]) => `<button type="button" data-range="${d}" class="${ui.range === d ? "active" : ""}">${l}</button>`).join("")}</div></div>
    <div class="stack">
      ${chartCard("buys", "$liquid bought back", "Per day, by where the tokens went · $liquid")}
      <div class="two">
        ${chartCard("burned", "Supply burned", "Running total sent to the burn sink · $liquid")}
        ${chartCard("principal", "Reserve principal", "Locked for good, valued at today's prices · US dollars")}
      </div>
    </div>
  </section>`;
}

function mountCharts(S, root) {
  const h = S.history;
  if (!h || !root.querySelector('[data-chart="buys"]')) return;
  const now = S.heads?.elysium?.time ?? Date.now() / 1000;
  const first = Math.min(...[...h.buys, ...h.principal].map((e) => e.t), now);
  const days = daysFor(ui.range, now, first), x = days.map(dayLabel);
  const kind = (...ks) => perDay(h.buys, days, (e) => ks.includes(e.kind));
  columns(root.querySelector('[data-chart="buys"]'), {
    id: "buys", title: "$liquid bought back per day", x, fmt: amount, height: 280,
    // the first design's contracts were never deployed; its kinds are charted only if they ever are
    series: isLaunched(S.cfg)
      ? [
          { name: "Burned · trading fees", color: SER[0], values: kind("burnFees") },
          { name: "Burned · reserve yield", color: SER[1], values: kind("burnYield") },
          { name: "Locked in the reserve", color: SER[2], values: kind("reserve") },
          { name: "Bought for stakers", color: SER[3], values: kind("stakers") },
        ]
      : [
          { name: "Burned · Ascend's buyback", color: SER[0], values: kind("burnFees") },
          { name: "Burned · the drop is full", color: SER[1], values: kind("burnDrop", "burnDropYield") },
          { name: "Bought for the drop", color: SER[2], values: kind("drop", "dropYield") },
          { name: "Bought for staking rewards", color: SER[3], values: kind("rewards") },
        ],
  });
  area(root.querySelector('[data-chart="burned"]'), {
    id: "burned", title: "Cumulative $liquid burned", x, fmt: amount,
    series: [{ name: "Burned", color: SER[2], values: cumulative(h.buys, days, (e) => e.kind.startsWith("burn")) }],
  });
  const px = S.market?.usd ?? {};
  const cum = (sym, p) => cumulative(h.principal, days, (e) => e.sym === sym).map((v) => v * (p || 0));
  area(root.querySelector('[data-chart="principal"]'), {
    id: "principal", title: "Reserve principal by asset", x, fmt: usd,
    series: [
      { name: "kHYPE", color: SER[0], values: cum("kHYPE", px.HYPE) },
      { name: "sKNTQ (KNTQ sent to HyperEVM)", color: SER[1], values: cum("sKNTQ", px.KNTQ) },
      { name: "$liquid", color: SER[2], values: cum("$liquid", px["$liquid"]) },
    ],
  });
}

// ───────── activity log
const KIND = {
  burnFees: "Bought and burned · trading fees",
  // the drop (history.js labels a burn by the feeder by where it came from)
  drop: "Bought for the drop · fees", dropYield: "Bought for the drop · reserve yield",
  burnDrop: "Bought and burned · the drop is full", burnDropYield: "Bought and burned · the drop's share of yield",
  rewards: "Bought for staking rewards · reserve yield",
  // the first design, never deployed
  burnYield: "Bought and burned · reserve yield", reserve: "Bought and locked in the reserve", stakers: "Bought for stakers",
};
const TABS = [
  ["trades", "Trades", "Every buy and sell of $liquid: in Ascend's pool and in the vaults' own pools."],
  ["buybacks", "Buybacks", "$liquid bought with fees and with the reserve's yield: burned by Ascend's buyback, bought for the drop, burned once the drop is full, and bought for staking rewards."],
  ["reserve", "Reserve", "Assets going into the locked reserve. Nothing ever comes back out except yield."],
  ["yield", "Yield", "The reserve's yield: a fifth to the creator, the rest divided by the yield director's shares. Each payout by the director is listed here."],
  ["vaults", "Vaults", "Deposits, withdrawals, compounded fees and range moves across the vaults."],
];

function activityRows(S, tab) {
  const h = S.history, px = S.market?.usd ?? {};
  if (tab === "vaults") {
    return (S.vaults ?? []).filter((v) => v.live).flatMap((v) => v.hist.events.map((e) => ({ t: e.t, what: `${v.name} · ${e.kind}`, detail: e.detail, value: e.usd !== undefined ? usd(e.usd) : "—", tx: e.tx }))).sort((a, b) => b.t - a.t);
  }
  if (!h) return null;
  if (tab === "trades") return [...(h.trades ?? [])].reverse().map((e) => ({ t: e.t, what: `${e.side === "buy" ? "Buy" : "Sell"} · ${e.venue}`, detail: `${amount(e.liquid)} $liquid for ${e.hype.toFixed(4)} HYPE`, value: isFinite(px.HYPE) ? usd(e.hype * px.HYPE) : "—", tx: e.tx }));
  if (tab === "buybacks") return [...h.buys].reverse().map((e) => ({ t: e.t, what: KIND[e.kind], detail: `${amount(e.amount)} $liquid`, value: isFinite(px["$liquid"]) ? usd(e.amount * px["$liquid"]) : "—", tx: e.tx }));
  if (tab === "reserve") {
    const p = { kHYPE: px.HYPE, sKNTQ: px.KNTQ, "$liquid": px["$liquid"] };
    const locked = h.principal.map((e) => ({ t: e.t, what: e.sym === "sKNTQ" ? "KNTQ sent to stake on HyperEVM" : `${e.sym} locked`, detail: `${amount(e.amount)} ${e.sym === "sKNTQ" ? "KNTQ" : e.sym}`, value: isFinite(p[e.sym]) ? usd(e.amount * p[e.sym]) : "—", tx: e.tx }));
    const q = { HYPE: px.HYPE, WHYPE: px.HYPE, USDC: 1, KNTQ: px.KNTQ };
    const split = (h.splits ?? []).map((e) => ({ t: e.t, what: "Fees in: 80% to the reserve", detail: `${amount(e.toReserve)} ${e.sym ?? ""}`.trim(), value: isFinite(q[e.sym]) ? usd(e.toReserve * q[e.sym]) : "—", tx: e.tx }));
    return [...locked, ...split].sort((a, b) => b.t - a.t);
  }
  // Yield: each payout by the yield director, with what was locked again and what was bought.
  const kpx = { ...px, kHYPE: px.kHYPE ?? px.HYPE };
  const paid = (h.payouts ?? []).map((e) => {
    const parts = [e.khype > 0 && `${amount(e.khype)} kHYPE locked again`, e.liquid > 0 && `${amount(e.liquid)} $liquid bought`].filter(Boolean);
    return { t: e.t, what: "Yield paid out by the director", detail: `${amount(e.amount)} ${e.sym ?? "of a token"}${parts.length ? ": " + parts.join(", ") : ""}`, value: isFinite(kpx[e.sym]) ? usd(e.amount * kpx[e.sym]) : "—", tx: e.tx };
  });
  // (the first design's ecosystem burns: never deployed)
  const eco = [...h.kntqBurns.map((e) => ({ ...e, sym: "KNTQ" })), ...h.hypeBurns.map((e) => ({ ...e, sym: "HYPE" }))]
    .map((e) => ({ t: e.t, what: `${e.sym} bought and burned`, detail: `${amount(e.amount)} ${e.sym}`, value: isFinite(px[e.sym]) ? usd(e.amount * px[e.sym]) : "—", tx: e.tx }));
  return [...paid, ...eco].sort((a, b) => b.t - a.t);
}

function activity(S) {
  const launched = liveNow(S.cfg);
  ui.tab ??= launched ? "trades" : "vaults";
  const [, , blurb] = TABS.find((t) => t[0] === ui.tab);
  const now = S.heads?.elysium?.time ?? Date.now() / 1000;
  const rows = ui.tab !== "vaults" && !launched ? [] : activityRows(S, ui.tab);
  const per = 10, pages = Math.max(1, Math.ceil((rows?.length ?? 0) / per));
  ui.page = Math.min(ui.page, pages - 1);
  const page = rows?.slice(ui.page * per, ui.page * per + per) ?? [];
  const EMPTY = {
    trades: "No trades yet.",
    buybacks: "No buyback yet. Ascend buys and burns $liquid with a quarter of the creator fees, in batches, and each one appears here. So does each purchase for the drop.",
    reserve: "Nothing locked yet. The bot moves fees into the reserve once they are worth many times the network fees.",
    yield: isLaunched(S.cfg) ? "Nothing yet." : flow(S).yieldOn ? "No payout yet. The yield split is in force, and each payout by the yield director will be listed here: the kHYPE locked again and the $liquid bought. The Reserve page shows today's shares and what is waiting." : "Not built yet. The reserve's staking yield collects in its own contract until the part that divides it exists.",
  };
  const emptyText = rows === null ? (S.errors.history ? "Couldn't load on-chain history: " + esc(S.errors.history) : "Loading on-chain history…") : ui.tab !== "vaults" && !launched ? "Starts when $liquid launches." : ui.tab === "vaults" && !(S.vaults ?? []).some((v) => v.live) ? "No vault is live yet." : EMPTY[ui.tab] ?? "Nothing yet.";
  return `<section>
    <div class="label sec-label">Activity</div>
    <div class="filters"><div class="seggroup" role="tablist" aria-label="Activity">${TABS.map(([id, name]) => `<button type="button" role="tab" aria-selected="${ui.tab === id}" data-tab="${id}" class="${ui.tab === id ? "active" : ""}">${name}</button>`).join("")}</div></div>
    <div class="card"><p class="muted" style="margin:0 0 6px;font-size:13.5px">${blurb}</p>
      ${page.length ? `<div class="tablewrap"><table class="data"><tr><th>When</th><th class="l">What</th><th class="l">Amount</th><th>Value</th><th>Transaction</th></tr>
        ${page.map((e) => `<tr><td>${ago(now - e.t)}</td><td class="l">${esc(e.what)}</td><td class="l">${esc(e.detail)}</td><td>${e.value}</td><td>${e.tx ? explorer(S.cfg, "elysium", "tx", e.tx) : "—"}</td></tr>`).join("")}</table></div>
        <div class="pager"><button class="btn sm" data-page="-1" ${ui.page === 0 ? "disabled" : ""}>Previous</button><span>Page ${ui.page + 1} of ${pages}</span><button class="btn sm" data-page="1" ${ui.page >= pages - 1 ? "disabled" : ""}>Next</button></div>` : `<div class="empty">${emptyText}</div>`}
    </div></section>`;
}

export function view(S) {
  const launched = liveNow(S.cfg);
  const head = `<section class="pagehead">${eyebrow("Analytics")}<h1>Everything, <em>on the record.</em></h1>
    <p class="lede">${launched ? "Every trade, buyback, burn and deposit below is read straight from Elysium in your browser. Nothing is reported by us." : "Read straight from Elysium in your browser. Vault figures are live now; buybacks and the reserve start charting when $liquid launches."}</p>
    ${coinLive(S.cfg) ? `<div class="actions" style="margin-top:18px">${buyLinks(S.cfg, "btn chrome")}</div>` : ""}</section>`;
  return `<div class="page">${head}${protocol(S)}${launched ? chartsSection(S) : ""}${activity(S)}${modelSection()}</div>`;
}

export function mount(S, api) {
  const root = document.getElementById("app");
  root.querySelectorAll("[data-range]").forEach((b) => b.addEventListener("click", () => { ui.range = +b.dataset.range; api.render(); }));
  root.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { ui.tab = b.dataset.tab; ui.page = 0; api.render(); }));
  root.querySelectorAll("[data-page]").forEach((b) => b.addEventListener("click", () => { ui.page += +b.dataset.page; api.render(); }));
  if (liveNow(S.cfg)) mountCharts(S, root);
  paintModel(S, root);
  const bind = (id, key, parse) => root.querySelector(id)?.addEventListener("input", (e) => { ui[key] = parse(e.target.value); paintModel(S, root); });
  bind("#m-vol", "vol", Number); bind("#m-band", "band", Number); bind("#m-apr", "apr", Number);
}
