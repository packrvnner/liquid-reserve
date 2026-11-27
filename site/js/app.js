import * as D from "./data.js";
import { usd, amount, price, pct, ago } from "./format.js";
import { esc, mark, icons, NAV, routeOf, explorer, sk, val, eyebrow, tile, segbar, legend, S as SER, X_URL, X_HANDLE, buyLinks } from "./ui.js";
import { mountVessel } from "./hero.js";
import { loadHistory } from "./history.js";
import * as V from "./vaults.js";
import * as A from "./analytics.js";
import * as R from "./reserve.js";
import { vaultFeeText } from "./creator.js";
import { buyCard, mountBuy } from "./buy.js";
import * as Stake from "./stake.js";
import * as Kntq from "./kntq.js";
import * as Hedged from "./hedged.js";
import * as Drop from "./drop.js";
import * as Pools from "./pools.js";
import { flow, share } from "./flow.js";
import * as F from "./flywheel.js";
import * as Docs from "./docs.js";
import { wallet } from "./wallet.js";

const app = document.getElementById("app");
const $ = (q) => document.querySelector(q);
const S = { cfg: null, conn: null, market: null, reserves: null, flywheel: null, transit: null, staking: null, stake: null, kntq: null, hedged: null, oracle: null, heads: null, vaults: null, inbox: null, history: null, updated: 0, errors: {} };
const link = (chain, kind, v, text) => explorer(S.cfg, chain, kind, v, text);
const COLOR = { kHYPE: SER[0], sKNTQ: SER[1], "$liquid": SER[2] };
const TARGET = { kHYPE: 0.4, sKNTQ: 0.4, "$liquid": 0.2 };

// ───────────────────────── loading
async function loadConfig() {
  const which = new URLSearchParams(location.search).get("deployment");
  const file = which && /^[a-z0-9.-]+\.json$/i.test(which) ? which : "deployment.json";
  return (await fetch(file, { cache: "no-store" })).json();
}

async function guard(key, fn) {
  try {
    const v = await fn();
    delete S.errors[key];
    return v;
  } catch (e) {
    S.errors[key] = e.message || String(e);
    console.warn(key, e);
    return undefined;
  }
}

async function refresh() {
  const c = S.conn, firstLoad = !S.updated;
  // Independent things load side by side; the page is drawn as soon as prices are in, then again when the rest arrives.
  const [heads, market] = await Promise.all([guard("heads", () => D.chainHeads(c)), guard("market", () => D.loadMarket(c))]);
  S.heads = heads ?? S.heads;
  S.market = market ?? S.market;
  if (firstLoad && S.market) { paintStatus(); paintTicker(); if (routeOf().name !== "docs") render(true); }
  if (S.market && D.isLaunched(S.cfg)) {
    S.reserves = (await guard("reserves", () => D.loadReserves(c, S.market))) ?? S.reserves;
    S.flywheel = (await guard("flywheel", () => D.loadFlywheel(c, S.market))) ?? S.flywheel;
    if (S.reserves && S.flywheel) S.transit = (await guard("transit", () => D.loadTransit(c, S.reserves, S.flywheel))) ?? S.transit;
    S.staking = (await guard("staking", () => D.loadStaking(c))) ?? S.staking;
    S.oracle = (await guard("oracle", () => D.loadOracle(c))) ?? S.oracle;
    S.history = (await guard("history", () => loadHistory(c, S.market))) ?? S.history;
  }
  if (S.market) {
    // Vaults and the reserve first (their requests go out first); the activity history follows without holding them up.
    const coinOnly = !D.isLaunched(S.cfg) && D.coinLive(S.cfg);
    const vaultsP = guard("vaults", () => V.loadVaults(c, S.market, wallet.account));
    const inboxP = guard("inbox", () => R.loadInbox(c, S.market));
    const stakeP = guard("stake", () => Stake.loadStake(c, S.market, wallet.account)); // HYPE staking (liquidHYPE)
    const kntqP = guard("kntq", () => Kntq.loadKntq(c, S.market, wallet.account)); // KNTQ staking (liquidKNTQ)
    const hedgedP = guard("hedged", () => Hedged.loadHedged(c, wallet.account)); // the hedged vault on HyperEVM (one request there)
    const dropP = guard("drop", () => Drop.loadDrop(c)); // the $liquid drop (shown once it is live)
    const poolsP = guard("pools", () => Pools.loadPools(c, wallet.account)); // the reward pools on the staking pages
    const historyP = coinOnly ? guard("history", () => loadHistory(c, S.market)) : undefined;
    const [vaults, inbox, stake, kntq, drop, pools, hedged] = await Promise.all([vaultsP, inboxP, stakeP, kntqP, dropP, poolsP, hedgedP]);
    S.hedged = hedged ?? S.hedged;
    S.drop = drop ?? S.drop;
    S.pools = pools ?? S.pools;
    S.vaults = vaults ?? S.vaults;
    S.inbox = inbox ?? S.inbox;
    S.stake = stake ?? S.stake;
    S.kntq = kntq ?? S.kntq;
    if (firstLoad && historyP) { paintStatus(); paintTicker(); if (routeOf().name !== "docs") render(true); }
    S.history = (await historyP) ?? S.history;
  }
  const first = !S.updated;
  S.updated = Date.now();
  paintStatus();
  paintTicker();
  // docs are static, but a few of their sentences are worded from the chain, so they are drawn once more when the
  // first reads are in; the flywheel keeps its animation running and updates on the next step
  const name = routeOf().name;
  if (first || (name !== "docs" && name !== "flywheel")) render(true);
}

// ───────────────────────── shell
function shell() {
  const nav = NAV.map((n) => `<a class="item" data-route="${n.route}" href="${n.href}">${icons[n.icon]}<span>${n.label}</span></a>`).join("");
  $("#rail").innerHTML = `<a class="brand" href="#/" aria-label="Liquid Reserve home">${mark(40, "rail")}</a>${nav}<div class="spacer"></div><div class="net" id="railnet" title="Connection to Elysium and HyperEVM"><span class="dot"></span><span>RPC</span></div>`;
  $("#tabbar").innerHTML = nav;
  $("#topbar").innerHTML = `<a class="tb-brand" href="#/" aria-label="Liquid Reserve home">${mark(28, "tb")}<span class="wordmark"><em>Liquid</em> Reserve</span></a>
    <div class="ticker" id="ticker" aria-label="Live market data"><div class="track"></div></div>
    <div class="actions">
      <span class="pill netpill" id="net-status"><span class="dot"></span><span>Connecting</span></span>
      <a class="iconbtn hide-sm" href="${X_URL}" target="_blank" rel="noopener" aria-label="Liquid Reserve on X, @${X_HANDLE}" title="@${X_HANDLE} on X">${icons.x}</a>
      <button class="iconbtn" id="theme" type="button" aria-label="Switch between dark and light"></button>
      <button class="btn chrome connect" id="connect" type="button">Connect wallet</button>
    </div>`;
  $("#foot").innerHTML = `<div style="display:flex;align-items:center;gap:10px">${mark(24, "ft")}<span class="wordmark" style="font-size:19px"><em>Liquid</em> Reserve</span><span class="dim">· $liquid on Elysium</span></div>
    <div class="links"><a href="#/docs">Docs</a><a href="#/analytics">Analytics</a><a href="#/docs/contracts">Contracts</a><a href="#/docs/risks">Risks</a><a href="#/docs/brand">Brand</a><a href="${X_URL}" target="_blank" rel="noopener">X · @${X_HANDLE}</a></div>
    <div class="fine">Reserve principal can never be withdrawn. ${D.isLaunched(S.cfg) ? `See <a href="#/docs/security">Security and status</a> for the audit status.` : "The contracts are unaudited; vault deposits are capped until they are."} Nothing here is financial advice; digital assets are risky.</div>`;
  $("#theme").addEventListener("click", () => {
    const t = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem("lr-theme", t); } catch {}
    paintTheme();
    render();
  });
  paintTheme();
}

function paintTheme() {
  const dark = document.documentElement.dataset.theme !== "light";
  $("#theme").innerHTML = dark ? icons.sun : icons.moon;
  document.querySelector('meta[name="theme-color"]').content = dark ? "#000000" : "#f2f3f3";
}

function paintStatus() {
  const ok = !!(S.heads?.elysium && S.heads?.hyperevm);
  $("#net-status").innerHTML = `<span class="dot ${ok ? "on" : "off"}"></span><span>${ok ? "Elysium · HyperEVM live" : "RPC unreachable"}</span>`;
  $("#railnet .dot").className = `dot ${ok ? "on" : "off"}`;
}

// The moving price bar. Built to behave on phones:
//  - the numbers are refreshed in place; the bar is only rebuilt when the set of items changes, so it never
//    jumps or flickers mid-scroll when new data arrives
//  - it moves by an exact distance in pixels (one copy of the items) at a steady speed, with only as many
//    copies as the screen needs (two on a phone), instead of a percentage of a very wide strip
//  - a touch does not freeze it (only a mouse resting on it pauses it)
//  - with "reduce motion" switched on it stands still and can be swiped sideways
const TICKER_SPEED = 39; // pixels a second
const tk = { key: "", w: 0, anim: null };
function paintTicker() {
  const m = S.market;
  if (!m) return;
  const items = [
    ["HYPE", price(m.usd.HYPE)], ["KNTQ", price(m.usd.KNTQ)],
    ["kHYPE", price(m.usd.kHYPE), `${m.hypePerKhype.toFixed(4)} HYPE`], ["sKNTQ", price(m.usd.sKNTQ), `${m.skntqRate.toFixed(4)} KNTQ`],
  ];
  if (D.isLaunched(S.cfg)) {
    if (S.reserves) items.push(["LOCKED", usd(S.reserves.totalUsd), "forever"]);
    if (S.history?.supply) items.push(["BURNED", pct(S.history.burned / S.history.supply, 2), "of supply"]);
    if (S.staking?.streaming) items.push(["STAKING", pct(S.staking.apr), "APR"]);
  }
  if (isFinite(m.usd["$liquid"])) items.push(["$LIQUID", price(m.usd["$liquid"]), "live on Ascend"]);
  else items.push(["$LIQUID", "Pre-launch", "launching on Ascend"]);
  const track = $("#ticker .track"), key = items.map((i) => i[0]).join(",");
  if (key !== tk.key || !track.firstElementChild) {
    tk.key = key;
    track.innerHTML = `<div class="grp">${items.map(([k, v, s]) => `<span class="t"><b>${k}</b><span>${v}</span>${s ? `<i>${s}</i>` : ""}</span>`).join("")}</div>`;
    tk.w = 0; // rebuilt: start again from the left
  } else {
    for (const g of track.children) items.forEach(([, v, sub], i) => {
      const t = g.children[i], a = t?.querySelector("span"), b = t?.querySelector("i");
      if (a && a.textContent !== v) a.textContent = v;
      if (b && sub && b.textContent !== sub) b.textContent = sub;
    });
  }
  layoutTicker();
}
/** Sizes the bar to the screen and (re)starts its movement. Safe to call at any time. */
function layoutTicker() {
  const box = $("#ticker"), track = box?.querySelector(".track"), first = track?.firstElementChild;
  if (!first) return;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches || typeof track.animate !== "function";
  box.classList.toggle("still", still);
  const w = first.getBoundingClientRect().width; // one copy of the items, including the gap after it
  if (!(w > 0)) return;
  const need = still ? 1 : 1 + Math.ceil(box.clientWidth / w);
  while (track.children.length > need) track.lastElementChild.remove();
  while (track.children.length < need) { const c = first.cloneNode(true); c.setAttribute("aria-hidden", "true"); track.append(c); }
  if (still) { tk.anim?.cancel(); tk.anim = null; tk.w = w; return; }
  if (tk.anim && tk.anim.playState !== "idle" && Math.abs(w - tk.w) < 0.5) return; // nothing changed
  const dur = (w / TICKER_SPEED) * 1000, was = tk.w > 0 ? (tk.w / TICKER_SPEED) * 1000 : 0;
  const at = tk.anim && was ? ((Number(tk.anim.currentTime) || 0) % was) / was : 0; // keep its place when only the width changed
  tk.anim?.cancel();
  tk.anim = track.animate([{ transform: "translate3d(0,0,0)" }, { transform: `translate3d(${-w}px,0,0)` }], { duration: dur, iterations: Infinity, easing: "linear" });
  tk.anim.currentTime = at * dur;
  tk.w = w;
}
function mountTicker() {
  const box = $("#ticker");
  box.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") tk.anim?.pause(); });
  box.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") tk.anim?.play(); });
  let t = 0;
  const again = () => { clearTimeout(t); t = setTimeout(layoutTicker, 150); };
  addEventListener("resize", again);
  addEventListener("orientationchange", again);
  addEventListener("pageshow", again); // coming back to the page on a phone
  document.fonts?.ready?.then(layoutTicker).catch(() => {});
  matchMedia("(prefers-reduced-motion: reduce)").addEventListener?.("change", layoutTicker);
}

// ───────────────────────── home
function hero() {
  const live = D.isLaunched(S.cfg), coin = D.coinLive(S.cfg), r = S.reserves, m = S.market;
  const top = live
    ? `<span class="chip"><b>Live</b> · Elysium + HyperEVM</span><span class="chip">Principal never leaves</span>`
    : coin
    ? `<span class="chip"><b>Live</b> · $liquid on Ascend</span><span class="chip">$liquid <b>${val(m?.usd["$liquid"], price)}</b></span>`
    : `<span class="chip"><b>Pre-launch</b> · launching on Ascend</span><span class="chip">Prices live from Elysium</span>`;
  const bot = live
    ? `<div><div class="label">Locked forever</div><div class="fig">${val(r?.totalUsd, usd)}</div></div><span class="chip">yield waiting <b>${val(r?.pendingUsd, usd)}</b></span>`
    : coin
    ? `<div><div class="label">Locked in the reserve</div><div class="fig">${val(S.inbox?.pre?.lockedUsd, usd)}</div></div><span class="chip">market cap <b>${val(m?.usd["$liquid"] ? m.usd["$liquid"] * 1e9 : undefined, usd)}</b></span>`
    : `<div><div class="label">HYPE on Elysium</div><div class="fig">${val(m?.usd.HYPE, price)}</div></div><span class="chip">KNTQ <b>${val(m?.usd.KNTQ, price)}</b></span>`;
  const fl = flow(S);
  const lede = fl.full
    ? `Every trade of <b>$liquid</b> feeds a reserve of staked HYPE that no one can withdraw. Not holders, not the team. Only its yield flows out. A tenth of every fee buys $liquid for the drop; once the drop is full, that tenth is burned.`
    : `Every trade of <b>$liquid</b> feeds a reserve of staked HYPE and staked KNTQ that no one can withdraw. Not holders, not the team. Only its yield flows out.`;
  return `<section class="hero"><div>
      ${eyebrow(live || coin ? "Live on Elysium" : "Launching on Ascend · Elysium")}
      <h1 class="hero-brand">${mark(96, "hero")}<span><em>Liquid</em><br />Reserve</span></h1>
      <p class="lede">${lede}</p>
      ${coin ? `<div class="actions buy">${buyLinks(S.cfg, "btn primary")}</div>` : ""}
      <div class="actions">
        <a class="btn ${coin ? "chrome" : "primary"}" href="#/flywheel">See the flywheel ${icons.arrow}</a>
        <a class="btn chrome" href="#/vaults">Vaults</a>
        ${Stake.stakingOn(S) ? `<a class="btn chrome" href="#/stake">Stake HYPE</a>` : ""}
        <a class="btn" href="${X_URL}" target="_blank" rel="noopener">${icons.x} @${X_HANDLE}</a>
      </div></div>
    <div class="card chrome vessel"><canvas id="vessel" aria-hidden="true"></canvas><div class="hud top">${top}</div><div class="hud bot">${Drop.dropOn(S) ? Drop.dropHud(S) : bot}</div></div>
  </section>`;
}

function topTiles() {
  const m = S.market, f = S.flywheel?.totals, h = S.history;
  const t = D.isLaunched(S.cfg)
    ? [
        ["Total locked", val(S.reserves?.totalUsd, usd), "across both reserves"],
        ["Supply burned", h?.supply ? pct(h.burned / h.supply, 2) : sk(), h ? `${amount(h.burned)} $liquid` : ""],
        ["Yield harvested", val(f?.harvestedUsd, usd), "to date"],
        ["Paid to stakers", val(f?.stakersLr, amount), "$liquid"],
      ]
    : [
        ["HYPE", val(m?.usd.HYPE, price), "Elysium spot"],
        ["KNTQ", val(m?.usd.KNTQ, price), "Elysium spot"],
        ["kHYPE", val(m?.usd.kHYPE, price), val(m?.hypePerKhype, (x) => `1 kHYPE = ${x.toFixed(4)} HYPE`)],
        ["sKNTQ", val(m?.usd.sKNTQ, price), val(m?.skntqRate, (x) => `1 sKNTQ = ${x.toFixed(4)} KNTQ`)],
      ];
  return `<section class="tiles">${t.map((x) => tile(...x)).join("")}</section>`;
}

// The four steps, worded from what is in force on-chain (flow.js).
function steps() {
  const fl = flow(S);
  return [
    ["01", "2%", "Every trade pays in", "A 2% fee on each $liquid trade on Ascend."],
    ["02", "40%", "Goes to the reserve", "Of $liquid's share of the fee. Another 25% buys and burns, 25% pays holders, 10% goes to the creator."],
    fl.full
      ? ["03", fl.mix, "Locked, and the drop", `Of that, ${share(fl.khype)} becomes staked HYPE, locked for good: no owner, no withdraw function. ${share(fl.toDrop)} buys $liquid for the drop, or is burned once the drop is full.`]
      : ["03", fl.mix, "Locked forever", `Of that, ${fl.splitText}. No owner, no withdraw function.`],
    fl.yieldOn
      ? ["04", "Yield", "Is all that leaves", `A fifth goes to the creator. The rest is divided by shares the owner sets${fl.yieldUses ? `: today between ${esc(fl.yieldUses)}` : ""}.`]
      : ["04", "Yield", "Is all that leaves", "A fifth goes to the creator. The rest is held until its split is in force."],
  ];
}
const how = () => `<section>
    <div class="sec-head"><div>${eyebrow("How it works")}<h2>Fees in. <em>Nothing out</em> but yield.</h2></div><a class="btn chrome" href="#/flywheel">The full flywheel ${icons.arrow}</a></div>
    <div class="steps">${steps().map(([n, big, t, p]) => `<div class="card step"><span class="n">${n}</span><div class="big">${big}</div><h3>${t}</h3><p>${p}</p></div>`).join("")}</div>
  </section>`;

const check = (state, text) => `<div class="check ${state}">${state === "todo" ? icons.dot : icons.check}<span>${text}</span></div>`;

function reservePanel(title, chain, side) {
  if (!side) return `<div class="card"><h3>${title}</h3><div class="empty">${S.errors.reserves ? "Couldn't load: " + esc(S.errors.reserves) : sk("12ch")}</div></div>`;
  const rows = side.assets.map((a) => `<div class="asset-row num"><b>${esc(a.symbol)}</b><span class="r">${amount(a.principal)}</span><span class="r">${amount(a.value)}</span><span class="r hide-sm">${amount(a.pending)}</span></div>`).join("");
  const p = side.proof;
  return `<div class="card chrome">
    <div class="head-row"><div><div class="label">${chain === "elysium" ? "Elysium" : "HyperEVM"}</div><h3 style="margin-top:6px">${title}</h3></div>${link(chain, "address", side.address)}</div>
    <div class="asset-row head label"><span>Asset</span><span class="r">Principal</span><span class="r">Value</span><span class="r hide-sm">Yield</span></div>
    ${rows}
    <div class="checks">
      ${check(p.noOwner ? "" : "no", `No owner <span class="dim">· owner() doesn't exist</span>`)}
      ${check(p.notProxy ? "" : "no", `Not upgradeable <span class="dim">· no proxy implementation</span>`)}
      ${check("", `Only outflow is yield, to ${link(chain, "address", p.onlyOutflow)}`)}
    </div></div>`;
}

function composition() {
  const parts = (S.reserves?.parts ?? []).map((p) => ({ name: p.symbol, value: p.usd, color: COLOR[p.symbol] ?? SER[4] }));
  const total = parts.reduce((s, p) => s + p.value, 0);
  if (!total) return "";
  return `<div class="card" style="margin-top:18px"><div class="head-row"><h3>What's inside</h3><span class="label">Target 40 / 40 / 20</span></div>
    ${segbar(parts, { tall: true })}
    ${legend(parts.map((p) => ({ name: p.name, color: p.color, note: `${pct(p.value / total)} · target ${pct(TARGET[p.name] ?? 0, 0)}` })))}</div>`;
}

function liveSections() {
  const t = S.transit, s = S.staking, f = S.flywheel?.totals, o = S.oracle, h = S.heads, a = S.flywheel?.activity;
  const now = Date.now() / 1000;
  const kv = (k, v) => `<div class="kv num"><span>${k}</span><b class="r">${v}</b></div>`;
  const rows = a
    ? a.length
      ? a.map((x) => `<div class="row"><span class="t">${x.time ? ago((S.heads?.elysium?.time ?? now) - x.time) : ""}</span><span>${esc(x.what)}${x.token ? ` <span class="dim">· ${esc(x.token)}</span>` : ""}</span>${link("elysium", "tx", x.tx)}</div>`).join("")
      : `<div class="empty">No activity yet.</div>`
    : `<div class="empty">${sk("20ch")}</div>`;
  return `<section>
      <div class="sec-head"><div>${eyebrow("Proof, not promises")}<h2>Two reserves. <em>Both locked.</em></h2></div><a class="btn chrome" href="#/analytics">Buyback analytics ${icons.arrow}</a></div>
      <div class="two">${reservePanel("kHYPE and $liquid", "elysium", S.reserves?.elysium)}${reservePanel("Staked KNTQ", "hyperevm", S.reserves?.hyperevm)}</div>
      ${composition()}
    </section>
    <section>
      <div class="sec-head"><div>${eyebrow("In motion")}<h2>Always <em>working.</em></h2></div></div>
      <div class="three">
        <div class="card"><h3>KNTQ to HyperEVM</h3><p class="muted">The KNTQ share is staked as sKNTQ on HyperEVM. The bridge takes a day or more.</p>
          ${kv("Waiting to bridge", val(t?.waitingToBridge, amount))}${kv("Crossing", val(t?.crossing, amount))}${kv("Yield unstaking (7 days)", val(t?.yieldUnstaking, amount))}</div>
        <div class="card"><h3>Staking</h3><p class="muted">Stakers earn 10% of all reserve yield, streamed over 7 days.</p>
          ${kv("Staked", s ? amount(s.total) : sk())}${kv("Current APR", s ? (s.total === 0 ? "no stakers yet" : s.streaming ? pct(s.apr) : "between periods") : sk())}</div>
        <div class="card"><h3>Creator take</h3><p class="muted">Disclosed in full: 10% of $liquid's share of the trading fee and 20% of reserve yield. ${vaultFeeText(S)}</p>
          ${kv("Paid to date", val(f?.creatorUsd, usd))}${kv("Fees into the reserve", val(f?.toReserveUsd, usd))}</div>
      </div>
    </section>
    <section>
      <div class="sec-head"><div>${eyebrow("Fully observable")}<h2>A public <em>control room.</em></h2></div></div>
      <div class="two">
        <div class="card"><div class="head-row"><h3>Recorded flywheel events</h3><span class="label">Elysium</span></div><div class="log">${rows}</div></div>
        <div class="card"><h3>Telemetry</h3>
          ${kv("Oracle price feeds", o ? o.feeds : sk())}${kv("Stalest price", o?.lastPoke ? ago((S.heads?.elysium?.time ?? now) - o.lastPoke) : "—")}
          ${kv("Elysium block", h?.elysium ? h.elysium.number.toLocaleString() : "—")}${kv("HyperEVM block", h?.hyperevm ? h.hyperevm.number.toLocaleString() : "—")}
          ${kv("Page refreshed", S.updated ? ago((Date.now() - S.updated) / 1000) : "—")}</div>
      </div>
    </section>`;
}

const preLaunch = (fl = flow(S)) => `<section>
    <div class="sec-head"><div>${eyebrow("Where things stand")}<h2>${D.coinLive(S.cfg) ? "Live. <em>Still being built.</em>" : "Built. <em>Not yet launched.</em>"}</h2></div><a class="btn chrome" href="#/docs/security">Security and status ${icons.arrow}</a></div>
    <div class="two">
      <div class="card chrome pad-lg"><h3>Two reserves, both locked</h3>
        <p class="muted">${D.coinLive(S.cfg) && S.cfg.elysium.prelaunch
          ? (fl.full
            ? `Since ${esc(fl.since)} every fee is locked as kHYPE, staked HYPE, on Elysium, less the tenth that buys $liquid for the drop. The staked KNTQ locked before then stays locked on HyperEVM, where Kinetiq's vault lives. The drop is a wallet run by the protocol's bot: it is not locked. <a href="#/reserve">See both reserves live</a>. Both reserves:`
            : `kHYPE is locked on Elysium and staked KNTQ on HyperEVM, where Kinetiq's vault lives. The $liquid share waits as USDC until the contract that buys it is built. <a href="#/reserve">See both reserves live</a>. Both reserves:`)
          : `kHYPE is held on Elysium. Staked KNTQ is held on HyperEVM, where Kinetiq's vault lives. After launch this page checks each one live:`}</p>
        <div class="checks">${check("", "No owner, no admin")}${check("", "Not upgradeable")}${check("", "The only outflow is yield, to one fixed contract")}</div>
        <div style="margin-top:18px">${segbar(fl.split.map((q) => ({ name: q.sym, value: q.share, color: q.color })), { tall: true })}
        ${legend(fl.split.map((q) => ({ name: q.sym, color: q.color, note: `${share(q.share)} · ${q.where}` })))}</div>
      </div>
      <div class="card pad-lg"><h3>Progress</h3>
        <div class="checks" style="border-top:0;padding-top:4px;margin-top:8px">
          ${check("", "Mechanism designed and documented")}
          ${check("", "Contracts written: 110 tests pass, with fuzz and invariant tests")}
          ${check("", "Fork-tested against live Elysium and HyperEVM")}
          ${check("", "Keeper bot run end to end on both chains")}
          ${check(S.cfg.elysium.prelaunch ? "" : "todo", `<a href="#/reserve" style="text-decoration:none">Locked reserve live on Elysium and HyperEVM</a>`)}
          ${check(D.coinLive(S.cfg) ? "" : "todo", "$liquid launched on Ascend")}
          ${check((S.vaults ?? []).some((v) => v.live) ? "" : "todo", `<a href="#/vaults" style="text-decoration:none">Auto-compounding vaults live on Elysium</a>`)}
          ${check(fl.full ? "" : "todo", `HYPE-only reserve and the $liquid drop${fl.full && fl.since ? `, live since ${esc(fl.since)}` : ""}`)}
          ${check(fl.yieldOn ? "" : "todo", "The reserve's yield divided by shares the owner sets")}
          ${check("todo", "Independent security audit")}
        </div></div>
    </div></section>`;

const rings = () => `<svg class="rings" viewBox="0 0 420 420" aria-hidden="true">${[40, 75, 110, 145, 180, 205].map((r) => `<circle cx="210" cy="210" r="${r}"/>`).join("")}</svg>`;
const follow = () => `<section class="card chrome pad-lg banner">${rings()}
    <div>${eyebrow("Stay close")}<h2>Follow the <em>reserve.</em></h2><p class="lede">${D.coinLive(S.cfg) ? "New vaults, audit results and every milestone are posted on X first." : "Launch date, audit results and every milestone are posted on X first."}</p></div>
    <div class="actions"><a class="btn primary" href="${X_URL}" target="_blank" rel="noopener">${icons.x} Follow @${X_HANDLE}</a><a class="btn" href="#/docs">Read the docs</a></div>
  </section>`;

const homeView = () => `<div class="page">${hero()}${buyCard(S)}${topTiles()}${how()}${D.isLaunched(S.cfg) ? liveSections() : preLaunch()}${follow()}</div>`;

// ───────────────────────── render
let stopVessel = null;
function render(fromRefresh = false) {
  if (!S.cfg) return;
  const r = routeOf();
  // don't yank the page out from under someone dragging a slider
  if (fromRefresh && app.querySelector('input[type="range"]:active')) return;
  const active = document.activeElement, keep = fromRefresh && active && app.contains(active) && active.id ? { id: active.id, a: active.selectionStart, b: active.selectionEnd } : null;

  document.querySelectorAll(".rail .item, .tabbar .item").forEach((a) => a.classList.toggle("active", a.dataset.route === r.name));
  stopVessel?.(); stopVessel = null;
  const api = { render, refresh };
  const hedged = r.raw === "vault" && Hedged.isRoute(S, r.arg); // the hedged vault has its own page (js/hedged.js)
  if (r.raw === "vaults") app.innerHTML = `<div class="page">${V.listView(S)}${Hedged.listSection(S)}</div>`;
  else if (hedged) app.innerHTML = `<div class="page">${Hedged.view(S)}</div>`;
  else if (r.raw === "vault") app.innerHTML = `<div class="page">${V.detailView(S, r.arg)}</div>`;
  else if (r.raw === "stake") app.innerHTML = r.arg === "kntq" ? Kntq.view(S) : Stake.view(S);
  else if (r.name === "analytics") app.innerHTML = A.view(S);
  else if (r.name === "reserve") app.innerHTML = R.view(S);
  else if (r.name === "flywheel") app.innerHTML = F.view(S);
  else if (r.name === "docs") app.innerHTML = Docs.view(S, r.arg);
  else app.innerHTML = homeView();

  if (hedged) Hedged.mount(S, api);
  else if (r.raw === "vaults" || r.raw === "vault") V.bind(S, render, refresh);
  else if (r.raw === "stake") (r.arg === "kntq" ? Kntq : Stake).mount(S, api);
  else if (r.name === "analytics") A.mount(S, api);
  else if (r.name === "reserve") R.mount(S, api);
  else if (r.name === "flywheel") F.mount(S, api);
  else if (r.name === "docs") Docs.mount(S, api);
  else { const c = document.getElementById("vessel"); if (c) stopVessel = mountVessel(c, () => (Drop.dropOn(S) ? Drop.vesselLevel(S) : 0.56)); mountBuy(S, api); }

  if (keep) {
    const el = document.getElementById(keep.id);
    if (el) { el.focus({ preventScroll: true }); try { if (keep.a != null) el.setSelectionRange(keep.a, keep.b); } catch {} }
  }
}

// Liquid metal: the rim texture of buttons, active tabs and coins slides toward the pointer.
function liquid() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const SEL = ".btn.primary, .btn.chrome, .lq, .coin, .seggroup button.active, .panel-tabs button.active";
  let last = null;
  document.addEventListener("pointermove", (ev) => {
    const el = ev.target.closest?.(SEL);
    if (last && last !== el) { last.style.removeProperty("--lm-x"); last.style.removeProperty("--lm-y"); }
    last = el;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--lm-x", `${Math.round(((ev.clientX - r.left) / r.width) * 100)}%`);
    el.style.setProperty("--lm-y", `${Math.round(((ev.clientY - r.top) / r.height) * 100)}%`);
  }, { passive: true });
}

// ───────────────────────── start
async function start() {
  S.cfg = await loadConfig();
  const local = /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(S.cfg.elysium.rpc);
  if (local && new URLSearchParams(location.search).get("devwallet") === "1") {
    await (await import("./dev-wallet.js")).installDevWallet(S.cfg.elysium.rpc);
  }
  S.conn = D.connect(S.cfg);
  S.cfg.link = link;
  shell();
  mountTicker();
  render();
  addEventListener("hashchange", () => { scrollTo(0, 0); render(); });
  let rz;
  addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { const n = routeOf().name; if (n === "analytics" || n === "flywheel" || n === "reserve" || n === "stake") render(); }, 200); });
  liquid();
  wallet.init(S.cfg, () => refresh());
  await refresh();
  setInterval(refresh, 30_000);
}

start().catch((e) => {
  app.innerHTML = `<div class="page"><div class="card empty">Couldn't start: ${esc(e.message)}</div></div>`;
});
