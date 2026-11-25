// HYPE staking: the liquidHYPE vault (src/staking/HypeStakingVault.sol).
//
// The vault holds kHYPE, Kinetiq's staked HYPE, and gives out liquidHYPE for a share of it. People stake HYPE
// (the vault swaps it for kHYPE in one fixed pool) and unstake to HYPE or to kHYPE. The fee is 20% of the
// yield and nothing else. Settings come from deployment.json -> elysium.staking; the page shows "not open
// yet" until the vault exists on-chain.
//
// Reads: one Multicall3 request with the rest of the page's. Previews: one request to Uniswap's quoter.
// The chart and the APY: Kinetiq's own kHYPE rate over time, from the Liquid Reserve history service
// ("stake-history"). Stakers, fees paid and the activity list: the vault's own events, in one request.
import { addr, uint, words, toUint, topicAddr, MULTICALL } from "./abi.js";
import { esc, explorer, tile, sk, segbar, S as SER } from "./ui.js";
import { usd, ago, short } from "./format.js";
import { wallet } from "./wallet.js";
import { quoteData } from "./buy.js";
import { navChart } from "./charts.js";
import { historyGet } from "./vaultchart.js";
import { stamper } from "./history.js";
import { assetSwitch } from "./kntq.js";
import * as Pools from "./pools.js";

const V = {
  totalSupply: "0x18160ddd", totalAssets: "0x01e1d114", currentRate: "0xf9f8bdb7", pendingFees: "0x224438d1",
  depositCap: "0xdbd5edc7", depositsPaused: "0x60da3e83", maxDeposit: "0x402d267d", balanceOf: "0x70a08231",
  depositHype: "0x8234abc6", redeemToHype: "0xd2cd1730", redeem: "0xba087652",
};
const ZERO = "0x0000000000000000000000000000000000000000";
const E18 = 10n ** 18n;
const SLIPPAGE_BPS = 50n; // the transaction fails rather than deliver more than 0.5% less than previewed
const GAS_RESERVE = 10n ** 16n; // HYPE left in the wallet for network fees when staking the maximum
// Gas limit = the network's estimate plus 30%. The kHYPE pool has a hook whose cost shifts a little between blocks,
// and a limit with no margin ran out of gas in testing. Unused gas is not charged.
const GAS_PAD = 30;
const cfgOf = (S) => S.cfg?.elysium?.staking;
export const stakingOn = (S) => !!cfgOf(S)?.vault;

// ---------------------------------------------------------------- numbers
const num = (v, digits = 4) => (Number(v) / 1e18).toLocaleString("en-US", { maximumFractionDigits: digits });
/** "1.25" -> 1250000000000000000n; anything unreadable -> 0n */
function parse18(text) {
  const t = String(text ?? "").trim().replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return 0n;
  const [a, b = ""] = t.split(".");
  return BigInt(a || "0") * E18 + BigInt((b + "0".repeat(18)).slice(0, 18));
}
const has = (x) => !!x && x.length >= 66;

// ---------------------------------------------------------------- loading
/** Everything the page shows, in one request. `live: false` until the vault exists. */
export async function loadStake(conn, market, account) {
  const st = conn.cfg?.elysium?.staking;
  if (!st?.vault) return null;
  const calls = [
    { to: st.vault, data: V.totalSupply }, { to: st.vault, data: V.totalAssets }, { to: st.vault, data: V.currentRate },
    { to: st.vault, data: V.depositCap }, { to: st.vault, data: V.depositsPaused }, { to: st.vault, data: V.maxDeposit + addr(ZERO) },
    { to: st.vault, data: V.pendingFees },
  ];
  if (account) calls.push({ to: st.vault, data: V.balanceOf + addr(account) }, { to: conn.cfg.elysium.multicall, data: MULTICALL.ethBalance + addr(account) }, { to: st.khype, data: V.balanceOf + addr(account) });
  const r = await conn.e.multicall(calls);
  if (!has(r[0]) || !has(r[2])) return { live: false };
  const n = (i) => (has(r[i]) ? BigInt(r[i]) : 0n);
  const supply = n(0), assets = n(1), rate = n(2), hypeUsd = market?.usd?.HYPE;
  const out = {
    live: true, supply, assets, rate, cap: n(3), paused: n(4) !== 0n, room: n(5), fees: n(6),
    /** HYPE that the vault's kHYPE is worth, and that one liquidHYPE is worth */
    tvlHype: (assets * rate) / E18, perShare: supply > 0n ? (((assets * rate) / E18) * E18) / supply : rate,
    user: null,
  };
  // under half a cent reads as $0 (an emptied vault still holds the 1,000 wei behind its first, burned shares)
  const dollars = (wei) => { const v = (Number(wei) / 1e18) * hypeUsd; return !isFinite(hypeUsd) ? NaN : v < 0.005 ? 0 : v; };
  out.tvlUsd = dollars(out.tvlHype);
  if (account && has(r[7])) {
    const shares = n(7), khype = supply > 0n ? (shares * (assets + 1n)) / (supply + 1n) : 0n, hype = (khype * rate) / E18;
    out.user = { shares, khype, hype, usd: dollars(hype), wallet: n(8), walletKhype: n(9) };
  }
  return out;
}

// ---------------------------------------------------------------- previews
const poolKey = (st) => ({ currency0: st.pool.currency0, currency1: st.pool.currency1, fee: st.pool.fee, tickSpacing: st.pool.tickSpacing, hooks: st.pool.hooks });
/** What comes out of the pool for `amountIn`: kHYPE for HYPE when staking, HYPE for kHYPE when unstaking. */
async function quotePool(S, khypeIn, amountIn) {
  const st = cfgOf(S), zeroForOne = khypeIn === !!st.pool.khypeIs0;
  const [res] = await S.conn.e.multicall([{ to: S.cfg.elysium.swap.quoter, data: quoteData(poolKey(st), zeroForOne, amountIn) }]);
  return has(res) ? toUint(words(res)[0]) : null;
}
const less = (v) => (v * (10_000n - SLIPPAGE_BPS)) / 10_000n;
/** Staking `hypeIn`: the kHYPE it buys and the liquidHYPE that mints (the vault's own formula). */
async function previewStake(S, hypeIn) {
  const s = S.stake, khype = await quotePool(S, false, hypeIn);
  if (khype === null) return null;
  return { hypeIn, khype, shares: (khype * (s.supply + 1n)) / (s.assets + 1n) };
}
/** Unstaking `shares`: the kHYPE they stand for, and the HYPE that sells for. */
async function previewUnstake(S, shares, toHype) {
  const s = S.stake, khype = (shares * (s.assets + 1n)) / (s.supply + 1n);
  if (!toHype || khype === 0n) return { shares, khype, hype: null };
  const hype = await quotePool(S, true, khype);
  return hype === null ? null : { shares, khype, hype };
}

// ---------------------------------------------------------------- view
const ui = { tab: "stake", to: "hype", text: "", q: null, quoting: false, busy: false, msg: null, seq: 0 };

function summary(S) {
  const s = S.stake, q = ui.q, want = parse18(ui.text);
  if (ui.msg?.kind === "ok") return `<div class="msg ok">${ui.msg.html}</div>`;
  const err = ui.msg?.kind === "err" ? `<div class="msg err">${esc(ui.msg.text)}</div>` : "";
  if (want === 0n) return err;
  if (!q) return `${err}<p class="note">${ui.quoting ? "Checking the pool…" : ""}</p>`;
  const row = (k, v) => `<div class="kv"><span>${k}</span><b class="r">${v}</b></div>`;
  if (ui.tab === "stake") {
    return `${err}${row("You receive about", `${num(q.shares, 6)} liquidHYPE`)}
      ${row("Held for you as", `${num(q.khype, 6)} kHYPE, worth ${num((q.khype * s.rate) / E18, 6)} HYPE`)}
      ${row("At least", `${num(less(q.shares), 6)} liquidHYPE, or nothing is sent`)}`;
  }
  return ui.to === "hype"
    ? `${err}${row("You receive about", `${num(q.hype, 6)} HYPE`)}${row("At least", `${num(less(q.hype), 6)} HYPE, or nothing is sent`)}`
    : `${err}${row("You receive", `${num(q.khype, 6)} kHYPE`)}`;
}

function panel(S) {
  const s = S.stake, u = s.user, staking = ui.tab === "stake";
  const bal = !u ? "" : staking ? `Balance ${num(u.wallet)} HYPE` : `You have ${num(u.shares, 6)} liquidHYPE`;
  const label = wallet.account ? (staking ? "Stake" : "Unstake") : "Connect wallet";
  const blocked = staking && (s.paused || s.room === 0n);
  return `<div class="card chrome stk-box">
    <div class="seggroup" role="group" aria-label="Stake or unstake" style="margin-bottom:14px">
      <button type="button" data-stab="stake" class="${staking ? "active" : ""}">Stake</button>
      <button type="button" data-stab="unstake" class="${staking ? "" : "active"}">Unstake</button></div>
    ${blocked ? `<div class="msg">${s.paused ? "New deposits are paused." : "The vault is at its cap."} Unstaking is always open.</div>` : ""}
    <div class="field"><label><span>${staking ? "You stake" : "You unstake"}</span><span id="stk-bal">${esc(bal)}</span></label>
      <div class="in"><input id="stk-amt" inputmode="decimal" placeholder="0.0" autocomplete="off" value="${esc(ui.text)}" aria-label="${staking ? "HYPE to stake" : "liquidHYPE to unstake"}" />
        <button class="maxbtn" id="stk-max" type="button">MAX</button><span class="sym">${staking ? "HYPE" : "liquidHYPE"}</span></div></div>
    ${staking ? "" : `<div class="field"><label><span>Receive <span class="seggroup sm" style="margin-left:6px"><button type="button" data-sto="hype" class="${ui.to === "hype" ? "active" : ""}">HYPE</button><button type="button" data-sto="khype" class="${ui.to === "khype" ? "active" : ""}">kHYPE</button></span></span></label></div>`}
    <div class="sum" id="stk-sum">${summary(S)}</div>
    <button class="btn primary block" id="stk-go" type="button" ${ui.busy || blocked ? "disabled" : ""} style="margin-top:12px">${ui.busy ? "Confirm in your wallet…" : label}</button>
    <p class="note">${staking
      ? "Your HYPE is swapped for kHYPE in Uniswap's kHYPE pool on Elysium and held for you. liquidHYPE is your share of it."
      : ui.to === "hype" ? "Your kHYPE is sold for HYPE in the same pool. A large amount gets a worse price than a small one."
      : "You receive the kHYPE itself. This way out needs no pool and is always open."}</p>
  </div>`;
}

// ---------------------------------------------------------------- yield, history, activity
// What a stake earns is read from Kinetiq's own rate for kHYPE on HyperEVM: the HYPE one kHYPE redeems for. It has
// only ever gone up, once a day. liquidHYPE holds kHYPE, so that rate, less the vault's fee, is its yield. (The vault
// itself prices kHYPE at its market price on Elysium, which trades within a few hundredths of a percent of the rate.)
const FEE = 0.2; // 20% of the yield: FEE_BPS in the contract
const WINDOWS = [["1M", "in 30 days"], ["3M", "in 90 days"], ["1Y", "in a year"], ["ALL", ""]];
const EVENT = {
  transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  deposit: "0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7", // Deposit(sender, owner, assets, shares)
  withdraw: "0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db", // Withdraw(sender, receiver, owner, assets, shares)
  fees: "0x860c0aa5520013080c2f65981705fcdea474d9f7c3daf954656ed5e65d692d1f", // FeesCollected(amount)
};
const an = { win: "ALL", hist: new Map(), marks: null, histErr: null, logs: null, logsAt: 0, logsErr: null, est: "100", page: 0 };

/** Yearly rate between two readings [unix, rate] of kHYPE's rate: what kHYPE earned, and what is left after the fee. */
function yearly(a, b) {
  if (!a || !b || !(a[1] > 0) || b[0] - a[0] < 3600) return null;
  const gain = b[1] / a[1] - 1, years = (b[0] - a[0]) / 31_536_000;
  return { days: (b[0] - a[0]) / 86_400, gross: (1 + gain) ** (1 / years) - 1, net: (1 + gain * (1 - FEE)) ** (1 / years) - 1 };
}
/** The yearly rate over the last `days`, if the history really reaches about that far back. */
const over = (key, days) => { const y = yearly(an.marks?.[key], an.marks?.latest); return y && y.days > days * 0.8 && y.days < days * 1.4 ? y : null; };
const apyNow = () => over("d7", 7);
const pct2 = (x) => `${(x * 100).toFixed(2)}%`;

async function loadHist(S, win) {
  const hit = an.hist.get(win);
  if (hit && Date.now() - hit.at < 300_000) return hit.data;
  const data = await historyGet("stake-history", { window: win, vault: cfgOf(S).vault });
  if (data.error) throw new Error(data.error);
  an.hist.set(win, { at: Date.now(), data });
  if (data.marks) an.marks = data.marks;
  return data;
}

/** The vault's own events since it opened: who holds liquidHYPE, fees paid out, and every stake and unstake. */
async function loadLogs(S) {
  if (an.logs && Date.now() - an.logsAt < 60_000) return an.logs;
  const st = cfgOf(S), e = S.conn.e;
  const from = "0x" + (st.fromBlock || S.cfg.elysium.historyFromBlock || 0).toString(16);
  const logs = await e.request("eth_getLogs", [{ address: st.vault, fromBlock: from, toBlock: "latest" }]);
  const ts = await stamper(e, logs.filter((l) => l.topics[0] !== EVENT.transfer));
  const word = (l, i) => BigInt("0x" + l.data.slice(2 + 64 * i, 66 + 64 * i));
  const held = new Map(), events = [];
  let fees = 0n;
  for (const l of logs) {
    const kind = l.topics[0];
    if (kind === EVENT.transfer) {
      const from1 = topicAddr(l.topics[1]).toLowerCase(), to = topicAddr(l.topics[2]).toLowerCase(), v = word(l, 0);
      held.set(from1, (held.get(from1) ?? 0n) - v);
      held.set(to, (held.get(to) ?? 0n) + v);
    } else if (kind === EVENT.deposit) events.push({ t: ts(l), kind: "stake", who: topicAddr(l.topics[2]), khype: word(l, 0), tx: l.transactionHash });
    else if (kind === EVENT.withdraw) events.push({ t: ts(l), kind: "unstake", who: topicAddr(l.topics[3]), khype: word(l, 0), tx: l.transactionHash });
    else if (kind === EVENT.fees) { fees += word(l, 0); events.push({ t: ts(l), kind: "fee", who: null, khype: word(l, 0), tx: l.transactionHash }); }
  }
  // the first, burned shares sit at the dead address and are nobody's stake
  const nobody = new Set([ZERO, "0x000000000000000000000000000000000000dead"]);
  an.logs = { stakers: [...held].filter(([who, v]) => !nobody.has(who) && v > 0n).length, fees, events: events.sort((x, y) => y.t - x.t) };
  an.logsAt = Date.now();
  return an.logs;
}

// ---------------------------------------------------------------- view
const row = (k, v) => `<div class="kv"><span>${k}</span><b class="r">${v}</b></div>`;

function tiles(S) {
  const s = S.stake, u = s.user, y = apyNow();
  return `${tile("Staked", isFinite(s.tvlUsd) ? usd(s.tvlUsd) : `${num(s.tvlHype, 2)} HYPE`, `${num(s.tvlHype, 3)} HYPE, held as ${num(s.assets, 3)} kHYPE`)}
    ${tile("1 liquidHYPE", `${num(s.perShare, 4)} HYPE`, "rises as staking rewards come in")}
    ${tile(u ? "Your stake" : "Fee", u ? (isFinite(u.usd) ? usd(u.usd) : `${num(u.hype)} HYPE`) : "20%", u ? `${num(u.shares, 4)} liquidHYPE, worth ${num(u.hype, 4)} HYPE` : "of the yield, never of deposits")}
    ${tile("Current APY", y ? pct2(y.net) : an.histErr ? "—" : sk("5ch"), y ? "the last 7 days, after the fee" : an.histErr ? "the rate history did not load" : "from kHYPE's rate over 7 days")}`;
}

function chartCard() {
  const pts = an.hist.get(an.win)?.data?.rate ?? [], first = pts[0], last = pts.at(-1);
  const chg = first && last ? last[1] / first[1] - 1 : null;
  const began = an.marks?.first ? new Date(an.marks.first[0] * 1000).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }) : "";
  const span = an.win === "ALL" ? (began ? `since kHYPE began in ${began}` : "since kHYPE began") : WINDOWS.find((w) => w[0] === an.win)[1];
  return `<div class="perf-top">
      <div><div class="label">1 kHYPE in HYPE</div>
        <div class="big num">${last ? last[1].toFixed(4) : "—"}</div>
        <div class="nav">${chg === null ? (an.histErr ? "The rate history did not load. Trying again shortly." : "Loading the rate history…") : `${chg >= 0 ? "+" : "−"}${(Math.abs(chg) * 100).toFixed(2)}% ${span}`}</div></div>
      <div class="side"><span class="pill live"><span class="dot on pulse"></span>Live</span>
        <div class="seggroup sm" role="group" aria-label="Time range">${WINDOWS.map(([w]) => `<button type="button" data-swin="${w}" class="${an.win === w ? "active" : ""}">${w}</button>`).join("")}</div></div>
    </div>
    <div class="navchart" id="stk-chart"></div>
    <p class="note">Kinetiq's own rate for kHYPE, read from HyperEVM: the HYPE that one kHYPE redeems for. liquidHYPE holds kHYPE, so it follows this line, less the fee. What it did before is not a promise of what it will do.</p>`;
}

function yieldTiles() {
  return [["Last 7 days", "d7", 7], ["Last 30 days", "d30", 30], ["Last 90 days", "d90", 90], ["Last year", "d365", 365]].map(([label, key, days]) => {
    const y = over(key, days);
    return tile(label, y ? pct2(y.net) : an.marks || an.histErr ? "—" : sk("5ch"), y ? `kHYPE itself: ${pct2(y.gross)}` : an.marks ? "not enough history yet" : "");
  }).join("");
}

function estimate() {
  const y = apyNow(), amt = Number(String(an.est).replace(/,/g, ""));
  if (!y) return `<p class="note">${an.histErr ? "The rate history did not load." : "Loading the rate…"}</p>`;
  if (!(amt > 0) || !isFinite(amt)) return `<p class="note">Enter an amount of HYPE.</p>`;
  const earn = (days) => amt * ((1 + y.net) ** (days / 365) - 1);
  const f = (x) => `about +${x.toLocaleString("en-US", { maximumFractionDigits: x >= 100 ? 0 : Math.min(8, Math.max(2, 2 - Math.floor(Math.log10(x)))) })} HYPE`;
  return row("In a day", f(earn(1))) + row("In a month", f(earn(30))) + row("In a year", f(earn(365)));
}

function vaultCard(S) {
  const s = S.stake, st = cfgOf(S), L = an.logs, capped = s.cap < 2n ** 200n;
  const bar = capped ? `<div style="margin:14px 0 6px">${segbar([{ name: "Staked", value: Number(s.assets) / 1e18, color: SER[0] }, { name: "Room left", value: Number(s.room) / 1e18, color: "var(--line-2)" }], { label: `${num(s.assets, 2)} of ${num(s.cap, 0)} kHYPE staked` })}</div>` : "";
  return `<div class="label">The vault</div>${bar}
    ${row(capped ? "Staked, of the cap" : "Staked", capped ? `${num(s.assets, 2)} of ${num(s.cap, 0)} kHYPE` : `${num(s.assets, 2)} kHYPE`)}
    ${row("Stakers", L ? L.stakers.toLocaleString("en-US") : an.logsErr ? "—" : sk("3ch"))}
    ${row("liquidHYPE in issue", num(s.supply, 4))}
    ${row("Fee paid out so far", L ? `${num(L.fees, 6)} kHYPE` : an.logsErr ? "—" : sk("6ch"))}
    ${row("Fee waiting in the vault", `${num(s.fees, 6)} kHYPE`)}
    ${row("Contract", explorer(S.cfg, "elysium", "address", st.vault))}`;
}

function activityCard(S) {
  const L = an.logs, s = S.stake, now = S.heads?.elysium?.time ?? Date.now() / 1000;
  const rows = L?.events ?? [], per = 8, pages = Math.max(1, Math.ceil(rows.length / per));
  an.page = Math.max(0, Math.min(an.page, pages - 1));
  const page = rows.slice(an.page * per, an.page * per + per);
  const WHAT = { stake: "Staked", unstake: "Unstaked", fee: "Fee paid out" };
  const head = `<div class="label">Activity</div>`;
  if (!page.length) return `${head}<div class="empty">${L ? "Nothing yet. Every stake and unstake will show here." : an.logsErr ? "The vault's history did not load. Trying again shortly." : "Loading the vault's history…"}</div>`;
  return `${head}<div class="tablewrap"><table class="data"><tr><th>When</th><th class="l">What</th><th class="l">Amount</th><th>Who</th><th>Transaction</th></tr>
      ${page.map((e) => `<tr><td>${ago(now - e.t)}</td><td class="l">${WHAT[e.kind]}</td><td class="l">${num(e.khype, 4)} kHYPE, about ${num((e.khype * s.rate) / E18, 4)} HYPE</td><td>${e.who ? explorer(S.cfg, "elysium", "address", e.who, short(e.who)) : "—"}</td><td>${explorer(S.cfg, "elysium", "tx", e.tx)}</td></tr>`).join("")}</table></div>
    ${pages > 1 ? `<div class="pager"><button class="btn sm" data-spage="-1" ${an.page === 0 ? "disabled" : ""}>Previous</button><span>Page ${an.page + 1} of ${pages}</span><button class="btn sm" data-spage="1" ${an.page >= pages - 1 ? "disabled" : ""}>Next</button></div>` : ""}`;
}

export function view(S) {
  const st = cfgOf(S), s = S.stake;
  const head = `<section class="pagehead"><div class="eyebrow">Staking</div>
      <h1>Stake HYPE. <em>Stay liquid.</em></h1>
      <p class="lede">Stake HYPE on Elysium and receive liquidHYPE. The vault holds kHYPE, Kinetiq's staked HYPE, which gains value against HYPE as staking rewards come in. Unstake whenever you like.</p></section>`;
  if (!st) return `<div class="page">${head}<section class="card empty">Staking is not set up yet.</section></div>`;
  if (!s) return `<div class="page">${head}<section class="card empty">${S.errors?.stake ? `Couldn't reach Elysium just now (${esc(S.errors.stake)}). Trying again automatically.` : "Loading…"}</section></div>`;
  if (!s.live) return `<div class="page">${head}<section class="card empty">HYPE staking is not open yet. This page switches on by itself when the vault is created.</section></div>`;
  const capLeft = s.cap >= 2n ** 200n ? "No cap" : `${num(s.room, 2)} kHYPE of room`;
  return `<div class="page">${head}${assetSwitch(S, "hype")}
    <section style="margin-bottom:26px"><div class="tiles" id="stk-tiles">${tiles(S)}</div></section>
    <section class="stk-grid" style="margin-bottom:44px">
      <div class="card" id="stk-chartcard">${chartCard()}</div>
      ${panel(S)}
    </section>
    ${Pools.card(S, "hype")}
    <section style="margin-bottom:44px"><div class="label sec-label">Yield, as a yearly rate</div>
      <div class="tiles" id="stk-yield">${yieldTiles()}</div>
      <p class="note" style="margin-left:4px">What a stake would have earned over each stretch, as a yearly rate after the 20% fee, worked out from kHYPE's rate at the start and the end of it. The smaller figure is kHYPE's own rate before the fee.</p></section>
    <section class="two stk-two" style="margin-bottom:44px">
      <div class="card"><div class="label">Estimate</div>
        <div class="field" style="margin-top:12px"><label for="stk-est"><span>If you stake</span></label>
          <div class="in"><input id="stk-est" inputmode="decimal" autocomplete="off" value="${esc(an.est)}" aria-label="HYPE staked, for the estimate" /><span class="sym">HYPE</span></div></div>
        <div class="sum" id="stk-est-out">${estimate()}</div>
        <p class="note">At the rate of the last 7 days, after the fee. The rate changes from day to day, so this is an estimate and not a promise. It leaves out the pool's trading fee on the way in and out.</p></div>
      <div class="card" id="stk-vault">${vaultCard(S)}</div>
    </section>
    <section style="margin-bottom:44px"><div class="card" id="stk-act">${activityCard(S)}</div></section>
    <section class="card" style="margin-bottom:26px"><div class="label">How it works</div>
      <div class="kv say"><span>What you hold</span><b class="r">liquidHYPE, a share of the vault's kHYPE. It follows the standard vault interface (ERC-4626), so other apps can use it.</b></div>
      <div class="kv say"><span>Yield</span><b class="r">kHYPE's staking yield, less the fee. It shows as 1 liquidHYPE being worth more HYPE over time.</b></div>
      <div class="kv say"><span>Fee</span><b class="r">20% of the yield, fixed in the contract. It is measured from kHYPE's 30-minute average price on Elysium and only above the highest level reached before. The yield it can count is capped at 5% a year, so the fee can never pass 1% of your stake a year.</b></div>
      <div class="kv say"><span>Leaving</span><b class="r">To HYPE through the pool, or to kHYPE directly. The kHYPE way out cannot be paused.</b></div>
      <div class="kv"><span>Room for deposits</span><b class="r">${esc(capLeft)}</b></div>
      <div class="kv"><span>Vault</span><b class="r">${explorer(S.cfg, "elysium", "address", st.vault)}</b></div>
      <div class="kv"><span>Fee goes to</span><b class="r">${explorer(S.cfg, "elysium", "address", st.feeTo)}</b></div>
    </section>
    <div class="notice"><span class="dot"></span><div><b>This contract has not been audited.</b> It is tested against the real kHYPE pool, but an independent review has not happened yet. The price of kHYPE against HYPE is set by the market and can dip. Only stake what you could afford to lose. Nothing here is advice.</div></div>
  </div>`;
}

/** Draws the chart from what is loaded, and fills in the parts that wait for history. Safe to call at any time. */
function paintAnalytics(S) {
  const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  if (!document.getElementById("stk-chartcard") || !S.stake?.live) return;
  set("stk-tiles", tiles(S));
  set("stk-chartcard", chartCard());
  set("stk-yield", yieldTiles());
  set("stk-est-out", estimate());
  set("stk-vault", vaultCard(S));
  set("stk-act", activityCard(S));
  const box = document.getElementById("stk-chart"), pts = an.hist.get(an.win)?.data?.rate ?? [];
  if (box) navChart(box, {
    id: "stk", points: pts.map(([t, v]) => ({ t, v })), height: 290, tipName: "1 kHYPE", title: "The HYPE one kHYPE redeems for, over time",
    fmt: (v) => `${v.toFixed(5)} HYPE`, empty: an.histErr ? "The rate history did not load." : "Loading the rate history…",
  });
}

/** Loads the history the page is waiting for, then repaints. Cached, so a redraw costs nothing. */
function mountAnalytics(S) {
  const root = document.getElementById("stk-chartcard")?.closest(".page");
  if (!root) return;
  paintAnalytics(S);
  const want = an.win;
  loadHist(S, want).then(() => { an.histErr = null; }, (e) => { an.histErr = String(e?.message || e); }).then(() => { if (an.win === want) paintAnalytics(S); });
  loadLogs(S).then(() => { an.logsErr = null; }, (e) => { an.logsErr = String(e?.message || e); }).then(() => paintAnalytics(S));
  // one listener for everything that is repainted
  root.addEventListener("click", (ev) => {
    const w = ev.target.closest?.("[data-swin]"), pg = ev.target.closest?.("[data-spage]");
    if (w) { an.win = w.dataset.swin; mountWindow(S); }
    if (pg) { an.page += Number(pg.dataset.spage); paintAnalytics(S); }
  });
  document.getElementById("stk-est")?.addEventListener("input", (ev) => {
    an.est = ev.target.value;
    const out = document.getElementById("stk-est-out");
    if (out) out.innerHTML = estimate();
  });
}
function mountWindow(S) {
  paintAnalytics(S);
  const want = an.win;
  loadHist(S, want).then(() => { an.histErr = null; }, (e) => { an.histErr = String(e?.message || e); }).then(() => { if (an.win === want) paintAnalytics(S); });
}

// ---------------------------------------------------------------- behaviour
export function mount(S, api) {
  const input = document.getElementById("stk-amt");
  if (!input || !S.stake?.live) return;
  mountAnalytics(S);
  Pools.mount(S, api, "hype"); // the boost pool's card, when that pool exists
  const st = cfgOf(S);
  const paint = () => { const b = document.getElementById("stk-sum"); if (b) b.innerHTML = summary(S); };
  async function requote() {
    const want = parse18(ui.text), mine = ++ui.seq;
    ui.q = null; if (ui.msg?.kind !== "ok") ui.msg = null;
    if (want === 0n) { ui.quoting = false; return paint(); }
    ui.quoting = true; paint();
    try {
      const q = ui.tab === "stake" ? await previewStake(S, want) : await previewUnstake(S, want, ui.to === "hype");
      if (mine !== ui.seq) return; // a newer amount was typed meanwhile
      if (!q) throw new Error("the pool gave no price for that amount");
      ui.q = q;
    } catch (e) {
      if (mine !== ui.seq) return;
      ui.msg = { kind: "err", text: `Could not preview that: ${e.message || e}` };
    }
    ui.quoting = false; paint();
  }
  let timer = 0;
  input.addEventListener("input", () => { ui.text = input.value; ui.msg = null; clearTimeout(timer); timer = setTimeout(requote, 400); });
  const reset = (patch) => { Object.assign(ui, { text: "", q: null, msg: null }, patch); api.render(); };
  document.querySelectorAll("[data-stab]").forEach((b) => b.addEventListener("click", () => reset({ tab: b.dataset.stab })));
  document.querySelectorAll("[data-sto]").forEach((b) => b.addEventListener("click", () => { ui.to = b.dataset.sto; ui.q = null; ui.msg = null; api.render(); }));
  document.getElementById("stk-max")?.addEventListener("click", () => {
    const u = S.stake.user;
    if (!u) return;
    const v = ui.tab === "stake" ? (u.wallet > GAS_RESERVE ? u.wallet - GAS_RESERVE : 0n) : u.shares;
    // exact, as a decimal with 18 places
    const whole = v / E18, frac = (v % E18).toString().padStart(18, "0").replace(/0+$/, "");
    ui.text = frac ? `${whole}.${frac}` : `${whole}`;
    input.value = ui.text;
    ui.msg = null; // a new amount replaces the last result with its preview
    requote();
  });
  document.getElementById("stk-go")?.addEventListener("click", async () => {
    if (ui.busy) return;
    try {
      if (!wallet.account) { await wallet.connect(); return api.refresh(); }
      const want = parse18(ui.text), me = wallet.account, u = S.stake.user;
      if (want === 0n) throw new Error("Enter an amount first.");
      ui.busy = true; ui.msg = null; api.render();
      let hash, done;
      if (ui.tab === "stake") {
        const bal = await S.conn.e.request("eth_getBalance", [me, "latest"]).then(BigInt);
        if (bal < want) throw new Error(`This wallet has ${num(bal)} HYPE on Elysium, less than the ${num(want)} you entered (and the network fee comes on top).`);
        const q = await previewStake(S, want); // fresh, so the minimum is measured against the price now
        if (!q) throw new Error("The pool gave no price for that amount.");
        if (q.khype > S.stake.room) throw new Error(`That is more than the vault has room for right now (${num(S.stake.room, 2)} kHYPE).`);
        hash = await wallet.send(st.vault, V.depositHype + uint(less(q.shares)) + addr(me), S.conn.e, want, GAS_PAD);
        done = `Staked ${num(want)} HYPE for about ${num(q.shares, 6)} liquidHYPE.`;
      } else {
        if (u && want > u.shares) throw new Error(`You have ${num(u.shares, 6)} liquidHYPE.`);
        const q = await previewUnstake(S, want, ui.to === "hype");
        if (!q) throw new Error("The pool gave no price for that amount. You can still unstake to kHYPE.");
        if (ui.to === "hype") {
          hash = await wallet.send(st.vault, V.redeemToHype + uint(want) + uint(less(q.hype)) + addr(me), S.conn.e, 0n, GAS_PAD);
          done = `Unstaked ${num(want, 6)} liquidHYPE for about ${num(q.hype, 6)} HYPE.`;
        } else {
          hash = await wallet.send(st.vault, V.redeem + uint(want) + addr(me) + addr(me), S.conn.e, 0n, GAS_PAD);
          done = `Unstaked ${num(want, 6)} liquidHYPE to ${num(q.khype, 6)} kHYPE.`;
        }
      }
      ui.msg = { kind: "ok", html: `${esc(done)} ${explorer(S.cfg, "elysium", "tx", hash, "View transaction")}` };
      ui.text = ""; ui.q = null;
      an.logsAt = 0; // the activity list and the staker count are read again, so this transaction shows at once
      await api.refresh();
    } catch (e) {
      ui.msg = { kind: "err", text: e?.code === 4001 ? "Cancelled in your wallet. Nothing was sent." : String(e?.message || e).slice(0, 240) };
    }
    ui.busy = false; api.render();
  });
  // after a redraw: keep the preview current if an amount is entered
  if (parse18(ui.text) > 0n && !ui.q && !ui.quoting) requote();
}
