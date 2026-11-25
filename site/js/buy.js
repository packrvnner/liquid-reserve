// Buy $liquid here.
//
// Asks every pool what a buy of the entered size would get: Ascend's own pool and the vault pools listed in
// deployment.json (elysium.swap.pools; one since 20 November 2026, the 2% pool; two before that). If the
// vault pools give more, the buy is sent through them (split between them when there are several and
// that gets more), using Uniswap's router. If Ascend's pool gives more, the box says so and links there:
// nothing is sent through a worse route.
//
// Settings come from deployment.json -> elysium.swap. One Multicall3 request per quote (the RPC allows
// only a few requests a second).
import { addr, uint, words, toUint } from "./abi.js";
import { esc, explorer } from "./ui.js";
import { amount, usd } from "./format.js";
import { wallet } from "./wallet.js";
import { coinLive } from "./data.js";

const QUOTE = "0xaa9d21cb"; // V4Quoter.quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))
const EXECUTE = "0x3593564c"; // UniversalRouter.execute(bytes,bytes[],uint256)
const V4_SWAP = "10"; // router command
const ACT = { swapExactInSingle: "06", settleAll: "0c", takeAll: "0f" }; // actions inside a v4 swap
const ZERO = "0x0000000000000000000000000000000000000000";
const STEPS = 8; // the order is offered to the vault pools in this many equal pieces
const SLIPPAGE_BPS = 100n; // the buy fails rather than deliver more than 1% less than quoted
const E18 = 10n ** 18n;

// ---------------------------------------------------------------- encoding
const pad32 = (h) => h.padEnd(Math.ceil(h.length / 64) * 64, "0");
const dynBytes = (hex) => { const h = hex.replace(/^0x/, ""); return uint(h.length / 2) + pad32(h); };
/** ABI-encodes a sequence of values: { s: static words } or { d: the encoding of a dynamic value }. */
function seq(items) {
  const headBytes = items.reduce((n, it) => n + (it.s !== undefined ? it.s.length / 2 : 32), 0);
  let head = "", tail = "";
  for (const it of items) {
    if (it.s !== undefined) head += it.s;
    else { head += uint(headBytes + tail.length / 2); tail += it.d; }
  }
  return head + tail;
}
const bytesArray = (list) => uint(list.length) + seq(list.map((b) => ({ d: dynBytes(b) })));
const keyWords = (k) => addr(k.currency0) + addr(k.currency1) + uint(k.fee) + uint(k.tickSpacing) + addr(k.hooks);

/** The quoter call: how much comes out of `amountIn` in this pool. */
export const quoteData = (key, zeroForOne, amountIn) =>
  QUOTE + uint(0x20) + keyWords(key) + uint(zeroForOne ? 1 : 0) + uint(amountIn) + uint(0x100) + uint(0);

/** The router call that buys through one or more native-HYPE pools and fails if fewer than `minOut` tokens arrive. */
export function buyData(legs, token, minOut, deadline) {
  const total = legs.reduce((s, l) => s + l.amountIn, 0n);
  const swap = (l) => seq([{ d: seq([{ s: keyWords(l.key) + uint(1) + uint(l.amountIn) + uint(0) }, { d: dynBytes("") }]) }]);
  const actions = legs.map(() => ACT.swapExactInSingle).join("") + ACT.settleAll + ACT.takeAll;
  const params = [...legs.map(swap), addr(ZERO) + uint(total), addr(token) + uint(minOut)];
  const v4 = seq([{ d: dynBytes(actions) }, { d: bytesArray(params) }]);
  return EXECUTE + seq([{ d: dynBytes(V4_SWAP) }, { d: bytesArray([v4]) }, { s: uint(deadline) }]);
}

// ---------------------------------------------------------------- quoting
const vaultKey = (cfg, p) => ({ currency0: ZERO, currency1: cfg.tokens["$liquid"].address, fee: p.fee, tickSpacing: p.tickSpacing, hooks: ZERO });

/**
 * What a buy of `amountIn` (wei of HYPE) gets: through the vault pools (split greedily, piece by piece, to
 * whichever pool gives more for the next piece) and through Ascend's pool.
 */
export async function quoteBuy({ cfg, e }, amountIn) {
  const sw = cfg.elysium.swap, piece = amountIn / BigInt(STEPS);
  if (piece === 0n) return null;
  const calls = [];
  for (const p of sw.pools) for (let k = 1; k <= STEPS; k++) calls.push({ to: sw.quoter, data: quoteData(vaultKey(cfg, p), true, piece * BigInt(k)) });
  calls.push({ to: sw.quoter, data: quoteData(sw.ascend, !sw.ascend.liquidIs0, amountIn) }); // HYPE in, $liquid out
  const res = await e.multicall(calls);
  const out = (i) => (res[i] && res[i].length >= 66 ? toUint(words(res[i])[0]) : null);
  // q[p][k]: tokens out of k pieces in pool p (q[p][0] = 0); null where the pool cannot fill that much
  const q = sw.pools.map((_, p) => [0n, ...Array.from({ length: STEPS }, (_, k) => out(p * STEPS + k))]);
  const take = sw.pools.map(() => 0);
  let filled = true;
  for (let step = 0; step < STEPS; step++) {
    let best = -1, gain = -1n;
    q.forEach((row, p) => {
      const next = row[take[p] + 1], have = row[take[p]];
      if (next !== null && next !== undefined && have !== null && next - have > gain) { gain = next - have; best = p; }
    });
    if (best < 0) { filled = false; break; }
    take[best]++;
  }
  const legs = sw.pools.map((p, i) => ({ name: p.name, key: vaultKey(cfg, p), amountIn: piece * BigInt(take[i]), out: q[i][take[i]] ?? 0n })).filter((l) => l.amountIn > 0n);
  const here = filled ? legs.reduce((s, l) => s + l.out, 0n) : null;
  return { amountIn: piece * BigInt(STEPS), here, legs, ascend: out(calls.length - 1) };
}

// ---------------------------------------------------------------- the box
const ui = { text: "", q: null, quoting: false, busy: false, msg: null, bal: null, seq: 0 };
const on = (S) => coinLive(S.cfg) && !!S.cfg.elysium.swap?.pools?.length;
function parseHype(text) {
  const s = String(text ?? "").trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return 0n;
  const [i, f = ""] = s.split(".");
  return BigInt(i || "0") * E18 + BigInt((f + "0".repeat(18)).slice(0, 18) || "0");
}
const tokens = (v) => amount(Number(v) / 1e18);
const hype = (v) => { const n = Number(v) / 1e18; return n >= 1 ? n.toFixed(3) : n.toPrecision(3).replace(/\.?0+$/, ""); };
const pctMore = (a, b) => `${(((Number(a) / Number(b)) - 1) * 100).toFixed(1)}%`;
const ascendUrl = (cfg) => (cfg.buy ?? []).find((b) => /ascend/i.test(b.name))?.url ?? "";
/** "the vault's pool" or "the vaults' pools", by how many are configured. */
const ours = (S, own = "") => (S.cfg.elysium.swap.pools.length > 1 ? `the vaults' ${own}pools` : `the vault's ${own}pool`);
const cap = (t) => t[0].toUpperCase() + t.slice(1);

function body(S) {
  const q = ui.q, px = S.market?.usd?.HYPE;
  if (ui.msg?.kind === "ok") return `<div class="msg ok">${ui.msg.html}</div>`;
  const err = ui.msg?.kind === "err" ? `<div class="msg err">${esc(ui.msg.text)}</div>` : "";
  if (parseHype(ui.text) === 0n) return `${err}<p class="note">Enter how much HYPE to spend. The box checks Ascend's pool and ${ours(S)}.</p>`;
  if (!q) return `${err}<p class="note">${ui.quoting ? "Checking the pools…" : "No quote yet."}</p>`;
  const worth = px ? ` (${usd((Number(q.amountIn) / 1e18) * px)})` : "";
  const hereWins = q.here !== null && (q.ascend === null || q.here > q.ascend);
  if (hereWins) {
    const route = q.legs.length === 1 ? `through the vault's ${esc(q.legs[0].name)}` : `split: ${q.legs.map((l) => `${hype(l.amountIn)} HYPE in the ${esc(l.name)}`).join(", ")}`;
    const min = (q.here * (10_000n - SLIPPAGE_BPS)) / 10_000n;
    return `${err}<div class="kv"><span>You get about</span><b class="r">${tokens(q.here)} $liquid</b></div>
      <div class="kv"><span>Compared with Ascend's pool</span><b class="r">${q.ascend ? `${pctMore(q.here, q.ascend)} more` : "Ascend's pool gave no quote"}</b></div>
      <div class="kv"><span>Route</span><b class="r">${route}</b></div>
      <div class="kv"><span>At least</span><b class="r">${tokens(min)} $liquid, or the buy is cancelled</b></div>
      <button class="btn primary" id="buy-go" type="button" ${ui.busy ? "disabled" : ""} style="margin-top:14px;width:100%">${ui.busy ? "Confirm in your wallet…" : wallet.account ? `Buy with ${hype(q.amountIn)} HYPE${worth}` : "Connect wallet to buy"}</button>`;
  }
  const url = ascendUrl(S.cfg);
  return `${err}<div class="kv"><span>Through ${ours(S)}</span><b class="r">${q.here !== null ? `${tokens(q.here)} $liquid` : "not enough liquidity for this size"}</b></div>
    <div class="kv"><span>Through Ascend's pool</span><b class="r">${q.ascend ? `${tokens(q.ascend)} $liquid${q.here ? ` · ${pctMore(q.ascend, q.here)} more` : ""}` : "no quote"}</b></div>
    <p class="note">For this size Ascend's pool gives more, so nothing is sent from here. ${cap(ours(S))} ${S.cfg.elysium.swap.pools.length > 1 ? "are" : "is"} small: smaller buys usually get more here.</p>
    ${url ? `<a class="btn chrome" href="${esc(url)}" target="_blank" rel="noopener" style="margin-top:12px;width:100%;justify-content:center">Buy on Ascend</a>` : ""}`;
}

export function buyCard(S) {
  if (!on(S)) return "";
  const bal = wallet.account && ui.bal !== null ? `Balance ${hype(ui.bal)} HYPE` : "";
  return `<section id="buybox"><div class="card chrome" style="max-width:560px">
    <div class="label">Buy $liquid here</div>
    <p class="muted" style="margin:8px 0 14px">Checks every pool and buys through ${ours(S, "own ")} only when that gets you more $liquid than Ascend's pool. Fees paid there go to vault depositors and the reserve.</p>
    <div class="field"><label><span>You pay</span><span id="buy-bal">${esc(bal)}</span></label>
      <div class="in"><input id="buy-amt" inputmode="decimal" placeholder="0.0" autocomplete="off" value="${esc(ui.text)}" aria-label="HYPE to spend" /><span class="sym">HYPE</span></div></div>
    <div id="buy-body">${body(S)}</div>
    <p class="note">Prices move with every trade. This is a tool, not advice.</p>
  </div></section>`;
}

export function mountBuy(S, api) {
  const input = document.getElementById("buy-amt"), box = document.getElementById("buy-body");
  if (!input || !box) return;
  const paint = () => { const b = document.getElementById("buy-body"); if (b) b.innerHTML = body(S); bindGo(); };
  async function requote() {
    const want = parseHype(ui.text), mine = ++ui.seq;
    ui.q = null; ui.msg = ui.msg?.kind === "ok" ? ui.msg : null;
    if (want === 0n) { ui.quoting = false; return paint(); }
    ui.quoting = true; paint();
    try {
      const [q, bal] = await Promise.all([quoteBuy(S.conn, want), wallet.account ? S.conn.e.request("eth_getBalance", [wallet.account, "latest"]).then(BigInt).catch(() => null) : null]);
      if (mine !== ui.seq) return; // a newer amount was typed meanwhile
      ui.q = q; ui.bal = bal;
      const el = document.getElementById("buy-bal");
      if (el && bal !== null) el.textContent = `Balance ${hype(bal)} HYPE`;
    } catch (e) {
      if (mine !== ui.seq) return;
      ui.msg = { kind: "err", text: `Could not get a quote: ${e.message || e}` };
    }
    ui.quoting = false; paint();
  }
  let timer = 0;
  input.addEventListener("input", () => { ui.text = input.value; ui.msg = null; clearTimeout(timer); timer = setTimeout(requote, 450); });
  function bindGo() {
    document.getElementById("buy-go")?.addEventListener("click", async () => {
      if (ui.busy) return;
      try {
        if (!wallet.account) { await wallet.connect(); return requote(); }
        ui.busy = true; ui.msg = null; paint();
        // a fresh quote right before sending, so the minimum is measured against the price now
        const q = await quoteBuy(S.conn, parseHype(ui.text));
        if (!q || q.here === null || (q.ascend !== null && q.here <= q.ascend)) { ui.q = q; ui.busy = false; return paint(); }
        const bal = await S.conn.e.request("eth_getBalance", [wallet.account, "latest"]).then(BigInt);
        if (bal < q.amountIn) throw new Error(`This wallet has ${hype(bal)} HYPE on Elysium, less than the ${hype(q.amountIn)} you entered (and the network fee comes on top).`);
        const min = (q.here * (10_000n - SLIPPAGE_BPS)) / 10_000n;
        const data = buyData(q.legs, S.cfg.tokens["$liquid"].address, min, Math.floor(Date.now() / 1000) + 600);
        const hash = await wallet.send(S.cfg.elysium.swap.router, data, S.conn.e, q.amountIn);
        ui.msg = { kind: "ok", html: `Bought about ${tokens(q.here)} $liquid with ${hype(q.amountIn)} HYPE. ${explorer(S.cfg, "elysium", "tx", hash, "View transaction")}` };
        ui.text = ""; ui.q = null; input.value = "";
        api?.refresh?.();
      } catch (e) {
        ui.msg = { kind: "err", text: e?.code === 4001 ? "Cancelled in your wallet. Nothing was sent." : String(e?.message || e).slice(0, 220) };
      }
      ui.busy = false; paint();
    });
  }
  bindGo();
  // after a refresh redraw: keep the quote current if an amount is entered
  if (parseHype(ui.text) > 0n && !ui.q && !ui.quoting) requote();
}
