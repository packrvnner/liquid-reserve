// KNTQ staking: liquidKNTQ (src/staking/KntqVault.sol, KntqStakeQueue.sol, KntqStakeBridge.sol).
//
// Kinetiq's staked KNTQ (sKNTQ) only exists on HyperEVM, so staking from Elysium works in batches. People put KNTQ
// into the queue here; a batch crosses the bridge (about a day), is staked in the vault on HyperEVM, and the
// liquidKNTQ comes back and is paid to each member. Leaving runs the other way and adds Kinetiq's own 7 days.
// The keeper bot makes every step after the first, so a person makes one transaction and waits.
//
// Settings: deployment.json -> elysium.kntqStaking. The page shows "not open yet" until the queue exists.
// Reads: one Multicall3 request on Elysium (two when the wallet has batches), one on HyperEVM for the vault.
import { addr, uint, words, toUint, encodeAggregate3, decodeAggregate3 } from "./abi.js";
import { esc, explorer, tile, sk } from "./ui.js";
import { usd, ago, duration } from "./format.js";
import { wallet } from "./wallet.js";
import * as Pools from "./pools.js";

const Q = {
  openBatch: "0x18082de7", batch: "0xeae68257", minDeposits: "0x81a94573", minExits: "0xd4351e6c", depositsPaused: "0x60da3e83",
  amountOf: "0xd07e2174", claimable: "0x9a554e04", claimedReceived: "0xff230e0b",
  deposit: "0x6e553f65", cancelDeposit: "0x72fada5c", requestExit: "0x167468b3", cancelExit: "0x726123b4", claim: "0xb5666678",
};
const T = { balanceOf: "0x70a08231", allowance: "0xdd62ed3e", approve: "0x095ea7b3" };
const V = { totalAssets: "0x01e1d114", totalSupply: "0x18160ddd", currentRate: "0xf9f8bdb7", depositCap: "0xdbd5edc7", depositsPaused: "0x60da3e83" };
const JOINED = "0x15f45c9c2e8e8c7184c723280ef25e309cbe775a194fd72651c1de2754932d15"; // Joined(kind, id, account, amount)
const DEPOSIT = 1, EXIT = 2;
const E18 = 10n ** 18n;
const FEE = 0.2; // the vault's fee: 20% of the yield
const BRIDGE_SEC = 86_400, UNSTAKE_SEC = 7 * 86_400; // about a day on the bridge; Kinetiq's withdrawal delay
const SMALL_BATCH_SEC = 6 * 3600; // the bot sends a batch under the minimum once it has waited this long
const cfgOf = (S) => S.cfg?.elysium?.kntqStaking;
export const kntqOn = (S) => !!cfgOf(S)?.queue;

const num = (v, digits = 4) => (Number(v) / 1e18).toLocaleString("en-US", { maximumFractionDigits: digits });
function parse18(text) {
  const t = String(text ?? "").trim().replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return 0n;
  const [a, b = ""] = t.split(".");
  return BigInt(a || "0") * E18 + BigInt((b + "0".repeat(18)).slice(0, 18));
}
const has = (x) => !!x && x.length >= 66;
const n256 = (x) => (has(x) ? BigInt(x) : 0n);
const k8 = (kind) => uint(kind);

// ---------------------------------------------------------------- loading
/** Everything the page shows. `live: false` until the queue exists. */
export async function loadKntq(conn, market, account) {
  const c = conn.cfg?.elysium?.kntqStaking;
  if (!c?.queue) return null;
  const e = conn.e, q = c.queue;
  const first = await e.multicall([
    { to: q, data: Q.openBatch + k8(DEPOSIT) }, { to: q, data: Q.openBatch + k8(EXIT) },
    { to: q, data: Q.minDeposits }, { to: q, data: Q.minExits }, { to: q, data: Q.depositsPaused },
  ]);
  if (!has(first[0]) || !has(first[2])) return { live: false };
  const open = { [DEPOSIT]: n256(first[0]), [EXIT]: n256(first[1]) };
  const out = { live: true, open, minDeposits: n256(first[2]), minExits: n256(first[3]), paused: n256(first[4]) !== 0n, user: null, mine: [], vault: null };

  // the vault on HyperEVM, in one request (that RPC allows few)
  const vaultP = conn.h.call(conn.cfg.elysium.multicall, encodeAggregate3([V.totalAssets, V.totalSupply, V.currentRate, V.depositCap, V.depositsPaused].map((data) => ({ to: c.hyperevm.vault, data }))))
    .then((r) => decodeAggregate3(r).map(n256)).catch(() => null);

  // the open batches, and this wallet
  const calls = [{ to: q, data: Q.batch + k8(DEPOSIT) + uint(open[DEPOSIT]) }, { to: q, data: Q.batch + k8(EXIT) + uint(open[EXIT]) }];
  if (account) calls.push(
    { to: c.kntq, data: T.balanceOf + addr(account) }, { to: c.kntq, data: T.allowance + addr(account) + addr(q) },
    { to: c.share, data: T.balanceOf + addr(account) }, { to: c.share, data: T.allowance + addr(account) + addr(q) },
  );
  const logsP = account
    ? e.request("eth_getLogs", [{ address: q, topics: [JOINED, null, null, "0x" + addr(account)], fromBlock: "0x" + (c.fromBlock || 0).toString(16), toBlock: "latest" }]).catch(() => [])
    : Promise.resolve([]);
  const [second, logs, vault] = await Promise.all([e.multicall(calls), logsP, vaultP]);
  const total = (r) => (has(r) ? toUint(words(r)[0]) : 0n);
  out.openTotal = { [DEPOSIT]: total(second[0]), [EXIT]: total(second[1]) };
  if (vault && vault[2] > 0n) { // a rate of zero means the vault could not be read
    const [assets, supply, rate, cap, vpaused] = vault;
    const kntqUsd = market?.usd?.KNTQ, held = (assets * rate) / E18;
    out.vault = {
      assets, supply, rate, cap, paused: vpaused !== 0n, kntq: held,
      /** KNTQ that one liquidKNTQ stands for */
      perShare: supply > 0n ? (held * E18) / supply : rate,
      usd: isFinite(kntqUsd) ? (Number(held) / 1e18) * kntqUsd : NaN,
    };
  }
  if (account) {
    out.user = { kntq: n256(second[2]), kntqAllow: n256(second[3]), share: n256(second[4]), shareAllow: n256(second[5]) };
    // every batch this wallet has been in, newest first
    const seen = new Map();
    for (const l of logs) seen.set(`${BigInt(l.topics[1])}:${BigInt(l.topics[2])}`, [Number(BigInt(l.topics[1])), BigInt(l.topics[2])]);
    const list = [...seen.values()].sort((a, b) => (a[1] === b[1] ? 0 : a[1] < b[1] ? 1 : -1)).slice(0, 12);
    if (list.length) {
      const rows = await e.multicall(list.flatMap(([kind, id]) => [
        { to: q, data: Q.batch + k8(kind) + uint(id) }, { to: q, data: Q.amountOf + k8(kind) + uint(id) + addr(account) },
        { to: q, data: Q.claimable + k8(kind) + uint(id) + addr(account) }, { to: q, data: Q.claimedReceived + k8(kind) + uint(id) + addr(account) },
      ]));
      out.mine = list.map(([kind, id], i) => {
        const b = has(rows[i * 4]) ? words(rows[i * 4]).map(toUint) : [0n, 0n, 0n, 0n];
        const cl = has(rows[i * 4 + 2]) ? words(rows[i * 4 + 2]).map(toUint) : [0n, 0n];
        return { kind, id, total: b[0], sentAt: Number(b[1]), amount: n256(rows[i * 4 + 1]), ready: cl[0], readyBack: cl[1], paid: n256(rows[i * 4 + 3]) };
      }).filter((m) => m.amount > 0n);
    }
  }
  return out;
}

/** Yearly rate of sKNTQ since the reference reading in the settings, and what is left of it after the fee. */
function apy(S) {
  const ref = cfgOf(S)?.rateRef, v = S.kntq?.vault;
  if (!ref || !v) return null;
  const now = S.heads?.elysium?.time ?? Date.now() / 1000, years = (now - ref.time) / 31_536_000;
  if (years <= 0) return null;
  const gain = Number(v.rate) / Number(BigInt(ref.rate)) - 1;
  return { gross: (1 + gain) ** (1 / years) - 1, net: (1 + gain * (1 - FEE)) ** (1 / years) - 1, days: (now - ref.time) / 86_400 };
}

// ---------------------------------------------------------------- view
const ui = { tab: "stake", text: "", busy: false, msg: null };
const row = (k, v) => `<div class="kv"><span>${k}</span><b class="r">${v}</b></div>`;

/** The switch between the two things that can be staked (shown once KNTQ staking is set up). */
export function assetSwitch(S, active) {
  if (!S.kntq?.live) return ""; // only once KNTQ staking exists on-chain
  return `<div class="seggroup" role="group" aria-label="What to stake" style="margin-bottom:22px">
    <a class="segl ${active === "hype" ? "active" : ""}" href="#/stake">HYPE</a><a class="segl ${active === "kntq" ? "active" : ""}" href="#/stake/kntq">KNTQ</a></div>`;
}

function tiles(S) {
  const s = S.kntq, v = s.vault, u = s.user, y = apy(S);
  return `${tile("Current APY", y ? `${(y.net * 100).toFixed(2)}%` : sk("5ch"), "Kinetiq pays staked KNTQ nothing at present")}
    ${tile("Staked", v ? (isFinite(v.usd) ? usd(v.usd) : `${num(v.kntq, 0)} KNTQ`) : sk("6ch"), v ? `${num(v.kntq, 2)} KNTQ, held as ${num(v.assets, 2)} sKNTQ` : "on HyperEVM")}
    ${tile("1 liquidKNTQ", v ? `${num(v.perShare, 4)} KNTQ` : sk("8ch"), "rises if staking rewards return")}
    ${tile(u ? "Your liquidKNTQ" : "Fee", u ? num(u.share, 4) : "20%", u ? (v ? `worth ${num((u.share * v.perShare) / E18, 2)} KNTQ` : "on Elysium") : "of the yield, never of deposits")}`;
}

function panel(S) {
  const s = S.kntq, u = s.user, staking = ui.tab === "stake", kind = staking ? DEPOSIT : EXIT;
  const want = parse18(ui.text), unit = staking ? "KNTQ" : "liquidKNTQ";
  const bal = !u ? "" : staking ? `Balance ${num(u.kntq, 2)} KNTQ` : `You have ${num(u.share, 4)} liquidKNTQ`;
  const blocked = staking && (s.paused || s.vault?.paused);
  const openTotal = s.openTotal[kind], minimum = staking ? s.minDeposits : s.minExits;
  const needApprove = !!u && want > 0n && (staking ? u.kntqAllow : u.shareAllow) < want;
  const label = !wallet.account ? "Connect wallet" : ui.busy ? "Confirm in your wallet…" : needApprove ? `Approve and ${staking ? "stake" : "unstake"}` : staking ? "Stake" : "Unstake";
  const note = ui.msg ? `<div class="msg ${ui.msg.kind}">${ui.msg.html ?? esc(ui.msg.text)}</div>` : "";
  return `<div class="card chrome stk-box">
    <div class="seggroup" role="group" aria-label="Stake or unstake" style="margin-bottom:14px">
      <button type="button" data-ktab="stake" class="${staking ? "active" : ""}">Stake</button>
      <button type="button" data-ktab="unstake" class="${staking ? "" : "active"}">Unstake</button></div>
    ${blocked ? `<div class="msg">New deposits are paused. Unstaking is always open.</div>` : ""}
    <div class="field"><label><span>${staking ? "You stake" : "You unstake"}</span><span>${esc(bal)}</span></label>
      <div class="in"><input id="kq-amt" inputmode="decimal" placeholder="0.0" autocomplete="off" value="${esc(ui.text)}" aria-label="${staking ? "KNTQ to stake" : "liquidKNTQ to unstake"}" />
        <button class="maxbtn" id="kq-max" type="button">MAX</button><span class="sym">${unit}</span></div></div>
    <div class="sum">${note}
      ${row(staking ? "Joins batch" : "Joins exit batch", `#${s.open[kind]}, ${num(openTotal, 2)} ${unit} so far`)}
      ${row("The batch leaves", `at ${num(minimum, 0)} ${unit}, or after about ${Math.round(SMALL_BATCH_SEC / 3600)} hours`)}
      ${row(staking ? "liquidKNTQ in your wallet" : "KNTQ in your wallet", staking ? "about a day after it leaves" : "about 8 days after it leaves")}</div>
    <button class="btn primary block" id="kq-go" type="button" ${ui.busy || blocked ? "disabled" : ""} style="margin-top:12px">${label}</button>
    <p class="note">${staking
      ? "Your KNTQ crosses the bridge to HyperEVM with the rest of its batch, is staked there, and the liquidKNTQ is sent to this wallet. You do nothing more. Until the batch leaves you can take your KNTQ back."
      : "Your liquidKNTQ crosses the bridge (about a day), Kinetiq's own unstaking takes 7 days, and the KNTQ is sent to this wallet. You do nothing more. Until the batch leaves you can take your liquidKNTQ back."}</p>
  </div>`;
}

function batches(S) {
  const s = S.kntq, now = S.heads?.elysium?.time ?? Date.now() / 1000;
  if (!wallet.account) return `<div class="label">Your batches</div><div class="empty">Connect a wallet to see your stakes on their way.</div>`;
  if (!s.mine.length) return `<div class="label">Your batches</div><div class="empty">Nothing on its way. A stake or an unstake shows here until it has arrived.</div>`;
  const line = (m) => {
    const staking = m.kind === DEPOSIT, unit = staking ? "KNTQ" : "liquidKNTQ", gets = staking ? "liquidKNTQ" : "KNTQ";
    const what = `${staking ? "Stake" : "Unstake"} · ${num(m.amount, 2)} ${unit}`;
    let state, button = "";
    if (m.sentAt === 0) { state = "Collecting with its batch. You can still take it back."; button = `<button class="btn sm" data-kcancel="${m.kind}">Take back</button>`; }
    else if (m.ready > 0n || m.readyBack > 0n) {
      state = `${m.ready > 0n ? `${num(m.ready, 4)} ${gets}` : `${num(m.readyBack, 2)} ${unit} (sent back unprocessed)`} has arrived for you. It is paid out by itself within minutes.`;
      button = `<button class="btn sm" data-kclaim="${m.kind}:${m.id}">Claim now</button>`;
    } else if (m.paid > 0n) state = `Done: ${num(m.paid, 4)} ${gets} paid to your wallet.`;
    else {
      const eta = m.sentAt + BRIDGE_SEC + (staking ? 0 : UNSTAKE_SEC) - now;
      state = `${staking ? "On the bridge to HyperEVM" : now - m.sentAt < BRIDGE_SEC ? "On the bridge to HyperEVM" : "Unstaking at Kinetiq"}; left ${ago(now - m.sentAt)}. ${eta > 0 ? `About ${duration(eta)} to go.` : "Should arrive shortly."}`;
    }
    return `<div class="kv say"><span>${esc(what)}</span><b class="r">${esc(state)} ${button}</b></div>`;
  };
  return `<div class="label">Your batches</div>${s.mine.map(line).join("")}`;
}

export function view(S) {
  const c = cfgOf(S), s = S.kntq;
  const head = `<section class="pagehead"><div class="eyebrow">Staking</div>
      <h1>Stake KNTQ. <em>Stay liquid.</em></h1>
      <p class="lede">Stake KNTQ from Elysium and receive liquidKNTQ. The vault holds sKNTQ, Kinetiq's staked KNTQ, on HyperEVM, where it lives. Your KNTQ travels there in a batch over the bridge and the liquidKNTQ comes back to your wallet by itself.</p></section>`;
  const sw = assetSwitch(S, "kntq");
  if (!c) return `<div class="page">${head}<section class="card empty">KNTQ staking is not set up yet.</section></div>`;
  if (!s) return `<div class="page">${head}${sw}<section class="card empty">${S.errors?.kntq ? `Couldn't reach Elysium just now (${esc(S.errors.kntq)}). Trying again automatically.` : "Loading…"}</section></div>`;
  if (!s.live) return `<div class="page">${head}${sw}<section class="card empty">KNTQ staking is not open yet. This page switches on by itself when it is.</section></div>`;
  const v = s.vault;
  return `<div class="page">${head}${sw}
    <div class="notice" style="margin-bottom:26px"><span class="dot"></span><div><b>Staked KNTQ pays no yield right now.</b> Kinetiq ended staker rewards in September 2026 (its vote KIP-5): KNTQ bought back with protocol revenue is now removed from supply instead of going to stakers. liquidKNTQ earns only if that changes. sKNTQ's other benefits (governance, tiers) belong to whoever holds it, which here is the vault, not you.</div></div>
    <section style="margin-bottom:26px"><div class="tiles">${tiles(S)}</div></section>
    <section class="stk-grid" style="margin-bottom:44px">
      <div class="card">${batches(S)}</div>
      ${panel(S)}
    </section>
    <section class="card" style="margin-bottom:26px"><div class="label">How it works</div>
      <div class="kv say"><span>What you hold</span><b class="r">liquidKNTQ, a share of the vault's sKNTQ. On HyperEVM it is a standard vault token (ERC-4626); on Elysium it is that token as carried over the canonical bridge.</b></div>
      <div class="kv say"><span>Getting in</span><b class="r">About a day: batches cross the bridge from Elysium to HyperEVM, which takes the bridge about a day to confirm. The way back takes minutes.</b></div>
      <div class="kv say"><span>Getting out</span><b class="r">About 8 days: a day on the bridge, then Kinetiq's own 7-day unstaking. Nobody can pause it. On HyperEVM you can also swap liquidKNTQ for the sKNTQ itself at once.</b></div>
      <div class="kv say"><span>Fee</span><b class="r">20% of the yield, fixed in the contract, taken only above the highest rate reached before. While sKNTQ pays nothing, the fee is nothing.</b></div>
      <div class="kv say"><span>If the vault is full</span><b class="r">A batch the vault cannot take is sent back and your KNTQ is returned to your wallet.</b></div>
      <div class="kv"><span>Room in the vault</span><b class="r">${v ? (v.cap >= 2n ** 200n ? "No cap" : `${num(v.cap > v.assets ? v.cap - v.assets : 0n, 0)} sKNTQ of room`) : "—"}</b></div>
      <div class="kv"><span>Queue (Elysium)</span><b class="r">${explorer(S.cfg, "elysium", "address", c.queue)}</b></div>
      <div class="kv"><span>Vault (HyperEVM)</span><b class="r">${explorer(S.cfg, "hyperevm", "address", c.hyperevm.vault)}</b></div>
    </section>
    ${Pools.card(S, "kntq")}
    <div class="notice"><span class="dot"></span><div><b>These contracts have not been audited</b>, and they work across two chains, which is more that can go wrong than a vault on one. Your tokens spend about a day on the bridge each way, and a keeper bot carries each step (anyone else can too; every step is public). Only stake what you could afford to lose. Nothing here is advice.</div></div>
  </div>`;
}

// ---------------------------------------------------------------- behaviour
export function mount(S, api) {
  const input = document.getElementById("kq-amt"), c = cfgOf(S), s = S.kntq;
  if (!input || !s?.live) return;
  Pools.mount(S, api, "kntq"); // the boost pool's card, when that pool exists
  const e = S.conn.e, q = c.queue;
  const fail = (err) => { ui.msg = { kind: "err", text: err?.code === 4001 ? "Cancelled in your wallet. Nothing was sent." : String(err?.message || err).slice(0, 240) }; };
  input.addEventListener("input", () => { ui.text = input.value; ui.msg = null; });
  input.addEventListener("change", () => api.render());
  document.querySelectorAll("[data-ktab]").forEach((b) => b.addEventListener("click", () => { Object.assign(ui, { tab: b.dataset.ktab, text: "", msg: null }); api.render(); }));
  document.getElementById("kq-max")?.addEventListener("click", () => {
    const u = S.kntq.user;
    if (!u) return;
    const v = ui.tab === "stake" ? u.kntq : u.share, frac = (v % E18).toString().padStart(18, "0").replace(/0+$/, "");
    ui.text = frac ? `${v / E18}.${frac}` : `${v / E18}`;
    ui.msg = null;
    api.render();
  });
  document.getElementById("kq-go")?.addEventListener("click", async () => {
    if (ui.busy) return;
    try {
      if (!wallet.account) { await wallet.connect(); return api.refresh(); }
      const staking = ui.tab === "stake", want = parse18(ui.text), me = wallet.account, u = S.kntq.user;
      if (want === 0n) throw new Error("Enter an amount first.");
      const have = staking ? u?.kntq : u?.share, unit = staking ? "KNTQ" : "liquidKNTQ";
      if (u && want > have) throw new Error(`This wallet has ${num(have, 4)} ${unit} on Elysium.`);
      ui.busy = true; ui.msg = null; api.render();
      const token = staking ? c.kntq : c.share;
      if (u && (staking ? u.kntqAllow : u.shareAllow) < want) await wallet.send(token, T.approve + addr(q) + uint(want), e);
      const hash = await wallet.send(q, (staking ? Q.deposit : Q.requestExit) + uint(want) + addr(me), e);
      ui.msg = { kind: "ok", html: `${staking ? `${esc(num(want, 4))} KNTQ joined the next batch. The liquidKNTQ will arrive in this wallet by itself, about a day after the batch leaves.` : `${esc(num(want, 4))} liquidKNTQ joined the next exit batch. The KNTQ will arrive in this wallet by itself, about 8 days after the batch leaves.`} ${explorer(S.cfg, "elysium", "tx", hash, "View transaction")}` };
      ui.text = "";
      await api.refresh();
    } catch (err) { fail(err); }
    ui.busy = false; api.render();
  });
  // take back what is still collecting, or claim what has arrived
  document.querySelectorAll("[data-kcancel]").forEach((b) => b.addEventListener("click", async () => {
    try {
      const kind = Number(b.dataset.kcancel), m = S.kntq.mine.find((x) => x.kind === kind && x.sentAt === 0);
      if (!m) return;
      b.disabled = true;
      await wallet.send(q, (kind === DEPOSIT ? Q.cancelDeposit : Q.cancelExit) + uint(m.amount), e);
      ui.msg = { kind: "ok", text: `${num(m.amount, 4)} ${kind === DEPOSIT ? "KNTQ" : "liquidKNTQ"} is back in your wallet.` };
      await api.refresh();
    } catch (err) { fail(err); api.render(); }
  }));
  document.querySelectorAll("[data-kclaim]").forEach((b) => b.addEventListener("click", async () => {
    try {
      const [kind, id] = b.dataset.kclaim.split(":");
      b.disabled = true;
      await wallet.send(q, Q.claim + uint(BigInt(kind)) + uint(BigInt(id)) + addr(wallet.account), e);
      await api.refresh();
    } catch (err) { fail(err); api.render(); }
  }));
}
