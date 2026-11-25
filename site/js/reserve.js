// The Reserve tab: what the reserve holds, what is waiting to go in, where every
// dollar flows, and a yearly projection. Live numbers are read from the chain;
// the projection is a model and is labelled as one.
import { MULTICALL, SEL, encode, addr, words, toUint } from "./abi.js";
import { usd, amount, pct, units } from "./format.js";
import { esc, eyebrow, tile, val, segbar, legend, explorer, icons, S as SER } from "./ui.js";
import { area } from "./charts.js";
import { isLaunched } from "./data.js";
import { creatorShare } from "./creator.js";
import { BANDS, flows, volOf } from "./analytics.js";
import { flow, share } from "./flow.js";

const ui = { vol: 55, tvl: 40, band: 2, apr: 2.5, vapr: 15 };
const tvlOf = (v) => { const raw = 10 ** (3 + (v / 100) * 4); const mag = 10 ** Math.floor(Math.log10(raw)); return Math.round(raw / (mag / 10)) * (mag / 10); }; // $1K .. $10M
const WAIT = [["HYPE", "HYPE"], ["USDC", "USDC"], ["KNTQ", "KNTQ"]]; // tokens the vaults pay their fee in
// Fee tokens that came later: the staking vault pays in kHYPE, the HYPE-$liquid vault partly in $liquid, the ANTx-USDC
// vault partly in wANTx, the NVDAx-USDC vault partly in wNVDAx. They are read after everything else, so the
// positions above never move, and each is listed only while some of it is waiting (and only once the token is in
// deployment.json).
const WAIT_MORE = ["kHYPE", "$liquid", "wANTx", "wNVDAx"];

const PRE = { target: "0xd4b83992", principal: "0x2ce0f9d6", valueOf: "0xa48028aa" };

/** What is waiting in the vault fee inbox and, once it is launched, what the pre-launch reserve holds. One request (two with HyperEVM). */
export async function loadInbox({ cfg, e }, market) {
  const inbox = cfg.elysium.vaultFeeInbox;
  if (!inbox) return { rows: [], usd: 0 };
  const p = cfg.elysium.prelaunch, T = cfg.tokens;
  const balOf = (sym, who) => ({ to: T[sym].address, data: encode(SEL.balanceOf, addr(who)) });
  const calls = WAIT.map(([sym]) => balOf(sym, inbox));
  if (p) calls.push({ to: inbox, data: PRE.target }, balOf("kHYPE", p.reserve), { to: p.reserve, data: encode(PRE.principal, addr(T.kHYPE.address)) },
    balOf("KNTQ", p.bridgeOut), balOf("USDC", p.liquidWait), balOf("kHYPE", p.yieldWait), ...WAIT.map(([sym]) => balOf(sym, p.creatorWait)));
  // The HyperEVM half is asked for alongside the Elysium read, not after it.
  const hp = cfg.hyperevm?.prelaunch;
  const skntqAsked = p && hp?.reserve && cfg.hyperevm.rpc
    ? fetch(cfg.hyperevm.rpc, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: hp.reserve, data: encode(PRE.valueOf, addr(cfg.hyperevm.skntq)) }, "latest"] }) })
        .then((r) => r.json()).catch(() => null) // HyperEVM unreachable: shown as unknown, not as zero
    : null;
  const yieldTargetAt = p ? calls.push({ to: p.yieldWait, data: PRE.target }) - 1 : -1; // where the reserve's yield points
  const more = WAIT_MORE.filter((sym) => T[sym]?.address), moreAt = calls.length, per = p ? 2 : 1;
  for (const sym of more) { calls.push(balOf(sym, inbox)); if (p) calls.push(balOf(sym, p.creatorWait)); }
  const res = await e.multicall(calls);
  const has = (i) => !!res[i] && res[i].length >= 66;
  const num = (i, sym) => (has(i) ? units(toUint(words(res[i])[0]), T[sym].decimals) : 0);
  const px = (sym) => market.usd[sym] ?? (sym === "kHYPE" ? market.usd.HYPE : 0) ?? 0;
  // the later fee tokens: k = 0 in the holding contract, k = 1 in the creator-cut contract; a price that cannot be read counts as 0
  const later = (k) => more.map((sym, i) => ({ sym, amount: num(moreAt + i * per + k, sym) })).filter((x) => x.amount > 0)
    .map((x) => ({ ...x, usd: isFinite(px(x.sym)) ? x.amount * px(x.sym) : 0 }));
  const rows = [...WAIT.map(([sym, label], i) => ({ sym: label, amount: num(i, sym), usd: num(i, sym) * px(sym) })), ...later(0)];
  const out = { rows, usd: rows.reduce((t, x) => t + x.usd, 0), address: inbox };
  if (!p) return out;

  const deployed = has(5); // the reserve answers
  const live = deployed && has(3) && ("0x" + res[3].slice(-40)).toLowerCase() === p.feeSplitter.toLowerCase();
  const pre = {
    deployed, live,
    khype: num(4, "kHYPE"), kntqBridge: num(6, "KNTQ"), usdcParked: num(7, "USDC"), yieldKhype: num(8, "kHYPE"),
    creator: [...WAIT.map(([sym, label], i) => ({ sym: label, amount: num(9 + i, sym), usd: num(9 + i, sym) * px(sym) })), ...later(1)],
    skntq: null, // staked KNTQ locked on HyperEVM, counted in KNTQ
    // true once the reserve's yield contract points at the splitter that pays the creator 20%
    yieldShare: !!cfg.elysium.creatorShare && has(yieldTargetAt) && ("0x" + res[yieldTargetAt].slice(-40)).toLowerCase() === cfg.elysium.creatorShare.yieldSplit.toLowerCase(),
  };
  if (deployed && skntqAsked) {
    const j = await skntqAsked;
    if (j?.result && j.result.length >= 66) pre.skntq = units(toUint(words(j.result)[0]), 18);
  }
  pre.khypeUsd = pre.khype * px("kHYPE");
  pre.skntqUsd = (pre.skntq ?? 0) * px("KNTQ");
  pre.kntqBridgeUsd = pre.kntqBridge * px("KNTQ");
  pre.yieldUsd = pre.yieldKhype * px("kHYPE");
  pre.lockedUsd = pre.khypeUsd + pre.skntqUsd;
  out.pre = pre;
  return out;
}

// ───────── live numbers from the vaults
function live(S) {
  const vs = (S.vaults ?? []).filter((v) => v.live);
  const tvl = vs.reduce((s, v) => s + (v.tvlUsd || 0), 0);
  // depositors keep 80% of fees; the protocol's cut is the other 20%, a quarter of what depositors earned
  const cut = vs.reduce((s, v) => s + (v.earnedUsd || 0) / 4, 0);
  const dayOf = (v) => (v.age >= 3600 ? ((v.earnedUsd || 0) / 4 / v.age) * 86_400 : 0);
  const perDay = vs.reduce((s, v) => s + dayOf(v), 0);
  // vaults opened since 17 November 2026 pay a fifth of their cut to the creator; the older ones pay all of it to the reserve
  const share = creatorShare(S);
  const creatorPerDay = vs.reduce((s, v) => s + (share.pays(v) ? dayOf(v) * 0.2 : 0), 0);
  const aprs = vs.filter((v) => isFinite(v.apr) && v.tvlUsd > 0);
  const apr = aprs.length ? aprs.reduce((s, v) => s + v.apr * v.tvlUsd, 0) / aprs.reduce((s, v) => s + v.tvlUsd, 0) : NaN;
  return { vs, tvl, cut, perDay, creatorPerDay, share, apr, ready: !!S.vaults };
}

/** One year, at constant volume, vault size and prices. Everything in US dollars. */
function model(S) {
  const fl = flow(S), ys = fl.y;
  const vol = volOf(ui.vol), tvl = tvlOf(ui.tvl), f = flows(vol, ui.band, fl);
  const vaultApr = ui.vapr / 100; // depositors' fee APR, set by hand: the live figure is too noisy while vaults are tiny
  const vaultCut = tvl * vaultApr * 0.25;
  const token = { holders: f.holders * 365, buyback: f.buyback * 365, reserve: f.reserve * 365, creator: f.creator * 365, alloc: f.alloc * 365 };
  // Vaults opened since 17 November 2026 pay a fifth of their cut to the creator (the model assumes new deposits go
  // there); before that the whole vault cut went into the reserve.
  const vaultToCreator = creatorShare(S).vaultFees ? vaultCut * 0.2 : 0;
  const toReserve = token.reserve + vaultCut - vaultToCreator; // what reaches the reserve's fee contract
  // Over the year the reserve holds, on average, half of what flows in; only kHYPE's staking yield is assumed.
  const yieldYear = toReserve * fl.khype * 0.5 * (ui.apr / 100);
  // the yield, divided as the chain has it today: a fifth to the creator, the rest by the yield director's shares
  const y = { creator: ys.creator * yieldYear, compound: ys.compound * yieldYear, drop: ys.drop * yieldYear, pools: ys.pools * yieldYear };
  const khype = toReserve * fl.khype + y.compound, kntq = toReserve * fl.kntq;
  return {
    fl, vol, tvl, vaultApr, vaultCut, vaultToCreator, token, toReserve, yieldYear, y, khype, kntq,
    locked: khype + kntq,
    drop: toReserve * fl.toDrop + y.drop,
    buybacks: token.buyback,
    holders: token.holders + y.pools,
    creator: token.creator + y.creator + vaultToCreator,
    revenue: token.alloc + vaultCut,
  };
}

// ───────── sections
function header(S) {
  const pre = S.inbox?.pre, launched = isLaunched(S.cfg) || !!pre?.live, fl = flow(S);
  const lede = isLaunched(S.cfg) ? "The reserve's holdings, what flows into it and what its yield pays for, read straight from the chain."
    : pre?.live && fl.full ? "The reserve is live. The protocol's cut of vault and staking fees and $liquid's share of its own trading fee arrive here. Nine tenths buy kHYPE, staked HYPE, and lock it for good. One tenth buys $liquid for the drop, or is burned once the drop is full."
    : pre?.live ? "The reserve is live. The protocol's cut of vault fees and the $liquid coin's creator fees buy kHYPE and KNTQ, stake them and lock them for good. The $liquid share waits as USDC: the contract that buys and locks $liquid is not built yet."
    : pre?.deployed ? "The reserve contracts are deployed but the vaults' fee contract is not connected to them yet. Until it is, the protocol's cut collects in a holding contract, shown live below."
    : "The reserve contracts are not deployed yet. Until they are, the protocol's cut of vault fees collects in a holding contract, shown live below, and goes in on day one.";
  const pill = isLaunched(S.cfg) ? "Reserve live" : pre?.live ? (fl.drop ? "Reserve live" : "Reserve live · $liquid share waiting") : pre?.deployed ? "Deployed · not connected yet" : "Collecting · reserve not deployed yet";
  return `<section class="pagehead">${eyebrow("Reserve")}<h1>Everything in it. <em>Every dollar's path.</em></h1>
    <p class="lede">${lede}</p>
    <div style="margin-top:16px"><span class="pill ${launched ? "live" : ""}"><span class="dot ${launched ? "on pulse" : ""}" ${launched ? "" : 'style="background:var(--warn)"'}></span>${pill}</span></div></section>`;
}

function stats(S) {
  const L = live(S), launched = isLaunched(S.cfg), r = S.reserves, pre = S.inbox?.pre;
  const year = L.perDay * 365;
  const t = [
    pre?.live && !launched
      ? tile("Locked in the reserve", usd(pre.lockedUsd), pre.skntq == null ? "kHYPE on Elysium · HyperEVM unreachable" : "kHYPE on Elysium, sKNTQ on HyperEVM, for good")
      : tile("Locked in the reserve", launched ? val(r?.totalUsd, usd) : "$0", launched ? "both reserves, for good" : "starts when the reserve is deployed"),
    tile("Waiting to go in", S.inbox ? usd(S.inbox.usd) : val(undefined), pre?.live ? "moves when it outweighs the network fees 10 to 1" : "the protocol's cut, in the holding contract"),
    tile("Protocol's cut so far", L.ready ? usd(L.cut) : val(undefined), "20% of vault trading fees"),
    tile("Vault TVL feeding it", L.ready ? usd(L.tvl) : val(undefined), `${L.vs.length} vault${L.vs.length === 1 ? "" : "s"} live`),
    tile("Cut per day", L.ready ? (L.perDay > 0 ? usd(L.perDay) : "—") : val(undefined), "at the pace so far"),
    tile("Protocol revenue · 1y", L.ready ? (year > 0 ? usd(year) : "—") : val(undefined), "at today's pace, vaults only"),
    tile(flow(S).drop ? "To the reserve and the drop · 1y" : "To the reserve · 1y", L.ready ? (year > 0 ? usd(year - L.creatorPerDay * 365) : "—") : val(undefined), L.share.vaultFees ? "the cut, less the creator's fifth of the newer vaults'" : "all of the cut"),
    tile("To the creator · 1y", L.ready ? usd(L.creatorPerDay * 365) : val(undefined), L.share.vaultFees ? "20% of the cut of vaults opened since 17 Nov" : "none of the vault cut"),
  ];
  return `<section style="margin-bottom:34px"><div class="label sec-label">Live</div><div class="tiles">${t.join("")}</div>
    <p class="note" style="margin-left:4px">Read from Elysium just now. The yearly figures simply extend the pace since the vaults opened; they are tiny while the vaults are small.</p></section>`;
}

function inside(S) {
  const launched = isLaunched(S.cfg), r = S.reserves, inbox = S.inbox, fl = flow(S), d = S.drop;
  const kpx = S.market?.usd?.kHYPE ?? S.market?.usd?.HYPE ?? 0, lpx = S.market?.usd?.["$liquid"];
  const yieldMore = d?.flow?.yieldWaiting ?? 0; // kHYPE past the creator's split, waiting to be divided
  const row = (where, asset, amt, value, status) => `<tr><td>${where}</td><td class="l">${asset}</td><td>${amt}</td><td>${value}</td><td class="l">${status}</td></tr>`;
  const waiting = (inbox?.rows ?? []).map((x) => row("Holding contract", esc(x.sym), amount(x.amount), usd(x.usd), "Waiting")).join("");
  const target = [["kHYPE", "Staked HYPE · Elysium", 0.4, SER[0]], ["sKNTQ", "Staked KNTQ · HyperEVM", 0.4, SER[1]], ["$liquid", "$liquid · Elysium", 0.2, SER[2]]];
  const pre = inbox?.pre;
  const held = pre?.deployed && !launched
    ? [
        row("Reserve · Elysium", "kHYPE", amount(pre.khype), usd(pre.khypeUsd), "Locked"),
        row("Reserve · HyperEVM", "sKNTQ", pre.skntq == null ? "—" : `${amount(pre.skntq)} KNTQ`, pre.skntq == null ? "—" : usd(pre.skntqUsd), pre.skntq == null ? "Unreachable" : "Locked"),
        row("Bridge", "KNTQ", amount(pre.kntqBridge), usd(pre.kntqBridgeUsd), "To HyperEVM"),
        row(fl.drop ? "Set aside · half reserve, half drop" : "$liquid share", "USDC", amount(pre.usdcParked), usd(pre.usdcParked), "Waiting"),
        row("Staking yield", "kHYPE", amount(pre.yieldKhype + yieldMore), usd(pre.yieldUsd + yieldMore * kpx), "Waiting"),
        ...(fl.drop && d ? [row("The drop · bot's wallet", "$liquid", amount(d.held), isFinite(lpx) ? usd(d.held * lpx) : "—", "Held, not locked")] : []),
        ...pre.creator.filter((x) => x.amount > 0).map((x) => row("Creator cut, going to the reserve", esc(x.sym), amount(x.amount), usd(x.usd), "Waiting")),
      ].join("")
    : target.map(([sym, where]) => {
        const p = r?.parts?.find((x) => x.symbol === sym);
        return row(`Reserve · ${where.split(" · ")[1]}`, esc(sym), launched && p ? amount(p.amount ?? p.value ?? 0) : "0", launched && p ? usd(p.usd) : "$0", launched ? "Locked" : "Not live yet");
      }).join("");
  const pc = S.cfg.elysium.prelaunch, hc = S.cfg.hyperevm?.prelaunch;
  const where = pre?.deployed && pc
    ? `<p class="note">Locked reserve on Elysium: ${explorer(S.cfg, "elysium", "address", pc.reserve)}. Locked reserve on HyperEVM: ${hc ? explorer(S.cfg, "hyperevm", "address", hc.reserve) : "—"}. Neither has an owner or a withdraw function. KNTQ crosses the bridge in batches of 25 or more, after the bridge's waiting period.${fl.drop && d ? ` The drop: ${explorer(S.cfg, "elysium", "address", d.wallet)}, a wallet run by the protocol's bot. It is not a contract and it is not locked.` : ""} These contracts are unaudited.</p>`
    : "";
  return `<section>
    <div class="sec-head"><div>${eyebrow("What's inside")}<h2>Held, and <em>waiting.</em></h2></div></div>
    <div class="stack">
      <div class="card"><div class="label">Holdings</div>
        <div class="tablewrap"><table class="data"><tr><th>Where</th><th class="l">Asset</th><th>Amount</th><th>Value</th><th class="l">Status</th></tr>${held}${waiting || row("Holding contract", "—", "—", "—", "Loading…")}</table></div>
        ${inbox?.address ? `<p class="note">Holding contract: ${explorer(S.cfg, "elysium", "address", inbox.address)}. ${pre?.live ? "It is connected to the reserve's fee splitter, permanently." : "It can only ever be pointed at the fee router, once."}</p>` : ""}${where}</div>
      <div class="card"><div class="label">Where a fee goes</div>
        <div style="margin-top:14px">${segbar(fl.split.map((q) => ({ name: q.sym, value: q.share, color: q.color })), { tall: true })}
        ${legend(fl.split.map((q) => ({ name: q.sym, color: q.color, note: `${share(q.share)} · ${q.where}` })))}</div>
        <p class="note">${fl.full
          ? `Of every dollar that arrives, ${Math.round(fl.khype * 100)} cents buy kHYPE and are locked: nobody can withdraw them, and only their staking yield comes back out. ${Math.round(fl.toDrop * 100)} cents buy $liquid for the drop, a wallet run by the protocol's bot, until it holds ${share(fl.capShare)} of the $liquid that has not been burned; after that they are burned instead. Until ${esc(fl.since)} the split was 40 / 40 / 20: the staked KNTQ locked then stays locked on HyperEVM, and a fee paid in KNTQ still sends 40% of itself there. The split is set by contracts the 48-hour timelock controls, so the owner can change it, two days ahead and in public. What is already locked cannot be taken out.`
          : `Of every dollar that arrives, ${fl.splitText}. Nobody can withdraw what is locked; only its staking yield comes back out.`}</p></div>
    </div></section>`;
}

/** One row of the money-flow cascade: a source, its yearly amount, and how it splits. */
function flowRow(title, sub, total, parts) {
  const shown = parts.filter((p) => p.value > 0);
  return `<div class="cas"><div class="what"><b>${title}</b><span>${sub}</span><span class="amt num">${usd(total)}<span class="dim" style="font:500 12px var(--sans)"> a year</span></span></div>
    <div>${segbar(shown.length ? shown : parts.map((p) => ({ ...p, value: p.share })), { tall: true })}
      <div class="parts">${parts.map((p) => `<div><i style="background:${p.color}"></i><span>${esc(p.name)}</span><b>${usd(p.value)}</b></div>`).join("")}</div></div></div>`;
}

function paintModel(S, root) {
  const m = model(S);
  root.querySelector("#r-vol-v").textContent = `${usd(m.vol)} a day`;
  root.querySelector("#r-tvl-v").textContent = usd(m.tvl);
  root.querySelector("#r-apr-v").textContent = `${ui.apr.toFixed(1)}%`;
  root.querySelector("#r-vapr-v").textContent = `${ui.vapr}% a year`;
  const t = m.token, fl = m.fl, toReserve = fl.drop ? "Reserve and the drop" : "Locked reserve";
  root.querySelector("#r-out").innerHTML = `
    <div class="tiles" style="margin-bottom:14px">
      ${tile("Protocol revenue", usd(m.revenue), "token fee share + vault cut")}
      ${tile("Locked into the reserve", usd(m.locked), "fees locked, plus compounded yield")}
      ${fl.drop ? tile("Bought for the drop", usd(m.drop), "a tenth of fees in, plus its share of yield") : tile("Set aside", usd(m.toReserve * fl.aside), "held as USDC")}
      ${tile("Buybacks and burns", usd(m.buybacks), "$liquid bought and burned by Ascend")}
      ${tile("Holder and staker rewards", usd(m.holders), "Ascend's holder share + reward pools")}
      ${tile("Reserve yield", usd(m.yieldYear), `on staked HYPE, at ${ui.apr.toFixed(1)}%`)}
      ${tile("To the creator", usd(m.creator), m.vaultToCreator > 0 ? "fee share, reserve yield, a fifth of the vault cut" : "fee share + reserve yield, no vault fees")}
      ${tile("Vault fee cut", usd(m.vaultCut), `vaults earning ${pct(m.vaultApr)} a year`)}
    </div>
    <div class="card" style="margin-bottom:14px"><div class="label">Where the money flows</div>
      <div class="cascade" style="margin-top:6px">
        ${flowRow("$liquid trading fee", "$liquid's share of the 2% fee (Ascend's \"creator allocation\")", t.alloc, [
          { name: "Holders (Ascend)", value: t.holders, share: 25, color: SER[3] }, { name: "Buyback and burn", value: t.buyback, share: 25, color: SER[2] },
          { name: toReserve, value: t.reserve, share: 40, color: SER[0] }, { name: "Creator's wallet", value: t.creator, share: 10, color: SER[4] }])}
        ${m.vaultToCreator > 0
          ? flowRow("Vault fees", "the protocol's 20% cut, from vaults opened since 17 November 2026", m.vaultCut, [
            { name: toReserve, value: m.vaultCut - m.vaultToCreator, share: 80, color: SER[0] }, { name: "Creator's wallet", value: m.vaultToCreator, share: 20, color: SER[4] }])
          : flowRow("Vault fees", "the protocol's 20% cut, none of it to the creator", m.vaultCut, [
            { name: toReserve, value: m.vaultCut, share: 100, color: SER[0] }])}
        ${flowRow(toReserve, fl.full ? "nine tenths locked as staked HYPE, one tenth buys $liquid for the drop" : "divided as the chain has it today", m.toReserve,
          fl.split.map((q) => ({ name: q.name, value: m.toReserve * q.share, share: q.share * 100, color: q.color })))}
        ${flowRow("Reserve yield", "the only thing that ever leaves the reserve, divided by today's shares", m.yieldYear,
          fl.yieldParts.map((q) => ({ name: q.name, value: m.yieldYear * q.share, share: q.share * 100, color: q.color })))}
      </div></div>
    <div class="card chartcard"><div class="label">Reserve over the year</div><div class="sub">Principal locked, by asset · US dollars</div><div class="chart" data-chart="r-reserve"></div></div>`;
  const months = Array.from({ length: 12 }, (_, i) => `M${i + 1}`);
  area(root.querySelector('[data-chart="r-reserve"]'), {
    id: "r-reserve", title: "Projected reserve by asset", x: months, xTitle: "Month", fmt: usd,
    series: [{ name: "kHYPE", color: SER[0], values: months.map((_, i) => (m.khype / 12) * (i + 1)) }, ...(m.kntq > 0 ? [{ name: "sKNTQ", color: SER[1], values: months.map((_, i) => (m.kntq / 12) * (i + 1)) }] : [])],
  });
}

function projection() {
  return `<section>
    <div class="sec-head"><div>${eyebrow("One year, modelled")}<h2>Revenue, buybacks, <em>rewards.</em></h2></div></div>
    <div class="notice" style="margin-bottom:14px"><span class="dot"></span><div><b>This is a projection, not data.</b> It assumes the trading volume, vault size, vault earnings and prices you set stay constant for a year, counts staking yield on kHYPE only, and divides fees and yield the way they are divided today. The owner can change the yield shares. Real results will differ.</div></div>
    <div class="card" style="margin-bottom:14px"><div class="model" style="grid-template-columns:repeat(auto-fit,minmax(210px,1fr))">
      <div class="ctrl"><label for="r-vol"><span>$liquid trading volume</span><b id="r-vol-v"></b></label><input id="r-vol" type="range" min="0" max="100" step="1" value="${ui.vol}" /></div>
      <div class="ctrl"><label for="r-tvl"><span>Money in the vaults</span><b id="r-tvl-v"></b></label><input id="r-tvl" type="range" min="0" max="100" step="1" value="${ui.tvl}" /></div>
      <div class="ctrl"><label for="r-vapr"><span>Vault fee earnings</span><b id="r-vapr-v"></b></label><input id="r-vapr" type="range" min="0" max="60" step="1" value="${ui.vapr}" /></div>
      <div class="ctrl"><label for="r-band"><span>$liquid market cap</span></label><select id="r-band">${BANDS.map((b, i) => `<option value="${i}"${i === ui.band ? " selected" : ""}>${b.name}</option>`).join("")}</select></div>
      <div class="ctrl"><label for="r-apr"><span>kHYPE staking yield</span><b id="r-apr-v"></b></label><input id="r-apr" type="range" min="0" max="10" step="0.5" value="${ui.apr}" /></div>
    </div></div>
    <div id="r-out"></div></section>`;
}

function liveFlows(S) {
  const launched = isLaunched(S.cfg), f = S.flywheel?.totals, h = S.history, s = S.staking;
  const soon = "not built yet";
  const sum = (rows) => rows.reduce((a, e) => a + e.amount, 0);
  const t = [
    tile("Bought back and burned", launched && h ? amount(sum(h.buys.filter((e) => e.kind.startsWith("burn")))) : "—", launched ? "$liquid, all time" : soon),
    tile("Paid to stakers", launched ? val(f?.stakersLr, amount) : "—", launched ? "$liquid, all time" : soon),
    tile("Staking APR", launched && s ? (s.total === 0 ? "no stakers yet" : s.streaming ? pct(s.apr) : "between periods") : "—", launched ? "paid from reserve yield" : soon),
    tile("Yield harvested", launched ? val(f?.harvestedUsd, usd) : "—", launched ? "all time" : "starts when the reserve is deployed"),
  ];
  const head = (title) => `<section><div class="sec-head"><div>${eyebrow("Buybacks and holder rewards")}<h2>${title}</h2></div><a class="btn chrome" href="#/analytics">Full activity log ${icons.arrow}</a></div>`;
  if (!launched && S.cfg.elysium.ascend?.seat) return head("What the fees <em>pay for.</em>") + feeFlows(S, sum) + "</section>";
  return `${head("What the yield <em>pays for.</em>")}
    <div class="tiles">${t.join("")}</div></section>`;
}

// Buybacks and holder rewards are paid from $liquid's trading fees by Ascend's own fee contract. These are read
// from the chain: what it has set aside so far, what has been burned, the reserve's yield that is waiting, and,
// once they are in force, the drop and the shares the yield is divided by.
function feeFlows(S, sum) {
  const h = S.history, a = h?.ascend, pre = S.inbox?.pre, px = S.market?.usd ?? {}, fl = flow(S), d = S.drop;
  const kpx = px.kHYPE ?? px.HYPE ?? 0, yieldKhype = (pre?.yieldKhype ?? 0) + (d?.flow?.yieldWaiting ?? 0);
  const pair = a?.pair ?? S.cfg.elysium.ascend.pair ?? "HYPE";
  const inPair = (x) => `${amount(x)} ${esc(pair)}`;
  const worth = (x) => (px[pair] ? `${usd(x * px[pair])} · ` : "");
  const burned = h ? sum(h.buys.filter((e) => e.kind.startsWith("burn"))) : undefined;
  const yieldUsd = fl.yieldOn ? yieldKhype * kpx : pre?.yieldUsd ?? 0;
  const t = [
    tile("Bought back and burned", val(burned, amount), burned > 0 ? "$liquid, all time" : "$liquid · Ascend's buyback has not run yet"),
    tile("Set aside for buybacks", a ? inPair(a.buyback) : val(undefined), `${a ? worth(a.buyback) : ""}25% of Ascend's fees, all time`),
    tile("Earned for holders", a ? inPair(a.holders) : val(undefined), `${a ? worth(a.holders) : ""}25% of Ascend's fees, paid out by Ascend`),
    fl.yieldOn
      ? tile("Reserve yield waiting", pre ? `${amount(yieldKhype)} kHYPE` : val(undefined), `${pre && yieldUsd > 0 ? usd(yieldUsd) + " · " : ""}divided once it is worth sending`)
      : tile("Reserve yield collected", pre ? `${amount(pre.yieldKhype)} kHYPE` : val(undefined), `${pre && yieldUsd > 0 ? usd(yieldUsd) + " · " : ""}waits until its payout step is built`),
  ];
  const kv = (k, v) => `<div class="kv num"><span>${k}</span><b class="r">${v}</b></div>`;
  // a reward pool whose staking token is not on Elysium yet cannot take deposits: its share waits in the pool
  const noToken = Object.entries(S.pools ?? {}).filter(([, x]) => x?.exists && !x.tokenExists).map(([k]) => S.cfg.elysium.rewardPools?.[k]?.symbol).filter(Boolean);
  const dropCard = fl.drop && d ? `<div class="card"><div class="label">The drop</div>
      <div style="margin-top:8px">${kv("Holds", `${amount(d.held)} $liquid`)}${kv("Full at", `${amount(d.cap)} $liquid`)}${kv("Level", pct(d.level, d.level > 0 && d.level < 0.1 ? 2 : 1))}${kv("Burned by the drop", `${amount(d.burnedByDrop)} $liquid`)}</div>
      <p class="note">A wallet run by the protocol's bot: ${explorer(S.cfg, "elysium", "address", d.wallet)}. It is not locked. A tenth of every fee buys $liquid for it until it holds ${share(fl.capShare)} of the $liquid that has not been burned. From then on that tenth is burned instead.</p></div>` : "";
  const yieldCard = fl.yieldOn ? `<div class="card"><div class="label">Where the reserve's yield goes</div>
      <div style="margin-top:14px">${segbar(fl.yieldParts.map((q) => ({ name: q.name, value: q.share, color: q.color })), { tall: true })}
      ${legend(fl.yieldParts.map((q) => ({ name: q.name, color: q.color, note: share(q.share) })))}</div>
      <p class="note">A fifth goes to the creator's wallet, through a splitter that cannot be changed. The rest is divided by the yield director${fl.sharesText ? `: today ${esc(fl.sharesText)}` : ""}. The owner can change these shares at any time, including to zero; a new destination takes the 48-hour timelock.${noToken.length ? ` ${esc(noToken.join(" and "))} does not exist on Elysium yet, so its pool's share waits in the pool.` : ""} While the reserve is small, so is its yield: it is passed on only once it is worth at least $0.50 and ten times the network fee.</p></div>` : "";
  return `<div class="tiles">${t.join("")}</div>
    <p class="note" style="margin-left:4px">Read from Elysium just now. Buybacks and holder rewards are paid from $liquid's trading fees by Ascend: a quarter buys back and burns $liquid, a quarter goes to holders.${fl.yieldOn ? "" : " The reserve's own yield is collected and waits; the step that divides it is not in force yet."}</p>
    ${dropCard || yieldCard ? `<div class="two" style="margin-top:14px">${dropCard}${yieldCard}</div>` : ""}`;
}

export function view(S) {
  return `<div class="page">${header(S)}${stats(S)}${inside(S)}${liveFlows(S)}${projection()}</div>`;
}

export function mount(S) {
  const root = document.getElementById("app");
  if (!root.querySelector("#r-out")) return;
  paintModel(S, root);
  const bind = (id, key) => root.querySelector(id)?.addEventListener("input", (e) => { ui[key] = Number(e.target.value); paintModel(S, root); });
  bind("#r-vol", "vol"); bind("#r-tvl", "tvl"); bind("#r-band", "band"); bind("#r-apr", "apr"); bind("#r-vapr", "vapr");
}
