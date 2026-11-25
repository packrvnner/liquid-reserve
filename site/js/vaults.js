// Vaults: auto-compounding Uniswap v4 liquidity on Elysium.
// A vault is live as soon as its contract exists on-chain; nothing else is needed.
import { SEL, MULTICALL, encode, addr, uint, b32, words, toUint, topicAddr } from "./abi.js";
import { usd, price, amount, pct, short, ago, duration } from "./format.js";
import { esc, icons, tile } from "./ui.js";
import { navChart } from "./charts.js";
import { priceRangeCard, mountPriceRange, liquidityMap, miniRange, shown as asShown } from "./vaultchart.js";
import { stamper, dayOf, dayLabel } from "./history.js";
import { wallet } from "./wallet.js";
import { creatorShare } from "./creator.js";

const V = {
  totalValue: "0xd4c3eea0", balances: "0x7bb98a68", main: "0xdffeadd0", alt: "0xb6136dca", price: "0xa035b1fe",
  depositsPaused: "0x60da3e83", depositCap: "0xdbd5edc7", lastHarvest: "0xf1a392da", lastRebalance: "0x106b9ca1",
  totalSupply: "0x18160ddd", pendingFees: "0x224438d1", keeper: "0xaced1661", totalFees0: "0x80814ffb", totalFees1: "0xef095f8d",
  mainWidth: "0x185c6714", altWidth: "0xb1852b7a", cooldown: "0x8faee2a8", feeRecipient: "0x46904840", tickSpacing: "0xd0c93a7c",
  zapIn: "0xc7e0e42c", zapPoolManager: "0xdc4c90d3",
  setDepositsPaused: "0x1c481e2d", setDepositCap: "0x86651203", setKeeper: "0x748747e6", setRanges: "0xa59c15df",
  allowance: "0xdd62ed3e", approve: "0x095ea7b3",
  deposit: "0xfad3cc4b", withdraw: "0x1708deda", harvest: "0x4641257d", rebalance: "0x393ed075",
  setPoolPrice: "0xe0f8c0ad", // EmptyPoolPrice.set((address,address,uint24,int24,address),uint160)
};
const T = {
  Deposit: "0x4e2ca0515ed1aef1395f66b5303bb5d6f1bf9d61a353fa53f73f8ac9973fa9f6",
  Withdraw: "0xebff2602b3f468259e1e99f613fed6691f3a6526effe6ef3e768ba7ae7a36c4f",
  FeesCollected: "0xf5d590414d56d256b8c16b850d0b57f2f5d2ed90686166e150b48a96f0dbdd61",
  Rebalanced: "0xbfd8611cc26b4f8a08797b5deadff6bc079767b556a1cbc64e122df60cecedd2",
  Snapshot: "0x5c715eeb0b274654b266269c87e69f2e92202e9d82cc79b8255b893228287fcc",
};
const ERRORS = {
  "0xf480e285": "That would take the vault over its deposit cap. Try a smaller amount.",
  "0x7dd37f70": "The price moved while you were confirming. Try again.",
  "0x5a65d188": "Deposits are paused for this vault. Withdrawals still work.",
  "0x9811e0c7": "That amount is too small to mint any shares.",
  "0xe86f59ea": "The range was moved recently. It can be moved again after the 15-minute cooldown.",
  "0x23d96b80": "The pool price moved before this landed, so the range was not moved. Try again.",
  "0xf512b278": "Only the vault's keeper can move the range.",
  "0x118cdaa7": "Only the owner wallet can change this.",
  "0x2746152a": "The price moved while you were confirming, so the deposit was not made. Try again.",
  "0xaff2e820": "That is too much for this pool in one deposit: the swap would move its price by more than about 3%. Try a smaller amount, or deposit both tokens.",
  "0x1f2a2005": "Enter an amount.",
  "0x019af637": "That value is outside the limits the vault allows.",
  "0xd92e233d": "Enter an address.",
};
const MIN_SHARES = 1000n;
const PERF_KEEP = 8n; // depositors keep 8/10 of fees

const int24 = (w) => { const v = Number(BigInt("0x" + w.slice(-6))); return v >= 0x800000 ? v - 0x1000000 : v; };
const tok = (raw, d) => Number(raw) / 10 ** d;
const has = (a) => !!a && !/^0x0{40}$/i.test(a);

function parseUnits(text, d) {
  const s = String(text ?? "").trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return 0n;
  const [i, f = ""] = s.split(".");
  return BigInt(i || "0") * 10n ** BigInt(d) + BigInt((f + "0".repeat(d)).slice(0, d) || "0");
}
/** Exact, truncated (never rounds up past a balance). */
const formatUnits = (raw, d, dp = 6) => {
  const base = 10n ** BigInt(d), n = BigInt(raw);
  const f = (n % base).toString().padStart(d, "0").slice(0, Math.min(dp, d)).replace(/0+$/, "");
  return (n / base).toString() + (f ? "." + f : "");
};
const ceilDiv = (a, b) => (a + b - 1n) / b;
const sym0 = (v) => v.token0; // HYPE is paid in and out as native HYPE

// ---------------------------------------------------------------- loading

const VIEWS = ["totalValue", "balances", "main", "alt", "price", "depositsPaused", "depositCap", "totalSupply", "lastHarvest", "lastRebalance",
  "pendingFees", "keeper", "owner", "totalFees0", "totalFees1", "mainWidth", "altWidth", "cooldown", "feeRecipient", "tickSpacing"];
const VSEL = { ...V, owner: SEL.owner };

/**
 * Everything for every vault in two requests: one Multicall3 call for all the
 * reads, one eth_getLogs for the history. A vault is live when its address has
 * a contract (its reads return data).
 */
export async function loadVaults({ cfg, e }, market, account) {
  // Two zaps: the second (vaultZap2) is for a vault that is the only liquidity in its pool, once it is deployed.
  const list = cfg.vaults ?? [], mc = cfg.elysium.multicall, zapAddr = cfg.elysium.vaultZap, zap2Addr = cfg.elysium.vaultZap2;
  const calls = [], ask = (to, data) => calls.push({ to, data }) - 1;
  const plan = list.map((v) => {
    const t0 = cfg.tokens[v.token0], t1 = cfg.tokens[v.token1], p = { v, t0, t1 };
    if (v.pool) p.slot0 = ask(cfg.pools.stateView, encode(SEL.getSlot0, b32(v.pool)));
    if (!has(v.address)) return p;
    p.views = Object.fromEntries(VIEWS.map((k) => [k, ask(v.address, VSEL[k])]));
    if (account && t0?.address && t1?.address) {
      p.user = {
        shares: ask(v.address, encode(SEL.balanceOf, addr(account))),
        bal1: ask(t1.address, encode(SEL.balanceOf, addr(account))), allow1: ask(t1.address, encode(V.allowance, addr(account), addr(v.address))),
        erc0: ask(t0.address, encode(SEL.balanceOf, addr(account))), allow0: ask(t0.address, encode(V.allowance, addr(account), addr(v.address))),
        native: mc ? ask(mc, encode(MULTICALL.ethBalance, addr(account))) : -1,
        zallow1: has(zapAddr) ? ask(t1.address, encode(V.allowance, addr(account), addr(zapAddr))) : -1,
        zallow0: has(zapAddr) ? ask(t0.address, encode(V.allowance, addr(account), addr(zapAddr))) : -1,
        z2allow1: v.alone && has(zap2Addr) ? ask(t1.address, encode(V.allowance, addr(account), addr(zap2Addr))) : -1,
        z2allow0: v.alone && has(zap2Addr) ? ask(t0.address, encode(V.allowance, addr(account), addr(zap2Addr))) : -1,
      };
    }
    return p;
  });
  const clock = mc ? ask(mc, MULTICALL.timestamp) : -1;
  const zapProbe = has(zapAddr) ? ask(zapAddr, V.zapPoolManager) : -1; // answers only once the zap is deployed
  const zap2Probe = has(zap2Addr) ? ask(zap2Addr, V.zapPoolManager) : -1;
  // The vaults' event history is asked for at the same time as their current state, not after it.
  const fromBlock = "0x" + (cfg.elysium.vaultsFromBlock || cfg.elysium.deployBlock || 0).toString(16);
  const known = list.map((v) => v.address).filter(has);
  const logsEarly = known.length ? e.request("eth_getLogs", [{ address: known, fromBlock, toBlock: "latest" }]).catch(() => null) : Promise.resolve([]);
  const [res, head, natBal] = await Promise.all([
    e.multicall(calls),
    mc ? null : e.request("eth_getBlockByNumber", ["latest", false]),
    mc || !account ? null : e.request("eth_getBalance", [account, "latest"]),
  ]);
  // Chain time, not the visitor's clock, so ages and cooldowns are exact.
  const now = mc ? Number(toUint(words(res[clock])[0])) : parseInt(head.timestamp, 16);
  const W = (i) => (i === undefined || i < 0 || !res[i] || res[i].length < 66 ? null : words(res[i]));

  const zap = W(zapProbe) ? zapAddr : null, zap2 = W(zap2Probe) ? zap2Addr : null;
  const out = plan.map((p) => {
    const o = build(cfg, market, p, W, now, natBal, account), second = !!(p.v.alone && zap2);
    if (second && o.user) Object.assign(o.user, { zallow0: o.user.z2allow0, zallow1: o.user.z2allow1 }); // approvals go to the zap in use
    return Object.assign(o, { zap: second ? zap2 : zap, zapV2: second });
  });
  const live = out.filter((v) => v.live);
  if (live.length) {
    const logs = (await logsEarly) ?? (await e.request("eth_getLogs", [{ address: live.map((v) => v.address), fromBlock, toBlock: "latest" }]));
    const ts = await stamper(e, logs);
    for (const v of live) {
      v.hist = history(v, logs.filter((l) => l.address.toLowerCase() === v.address.toLowerCase()), ts);
      const firstT = v.hist.deposits[0]?.t;
      v.age = firstT ? now - firstT : 0;
      v.apr = v.age >= 86_400 && v.tvlUsd > 0 ? (v.earnedUsd / v.tvlUsd) * (31_536_000 / v.age) : NaN;
    }
  }
  return out;
}

function build(cfg, market, p, W, now, natBal, account) {
  const { v, t0, t1 } = p;
  const d0 = t0?.decimals ?? 18, d1 = t1?.decimals ?? 18;
  const out = { ...v, d0, d1, now, native: v.token0 === "HYPE", token0Usd: market.usd[v.token0], token1Usd: market.usd[v.token1], poolPrice: NaN, live: false };
  const s0 = W(p.slot0);
  if (s0) { const sqrt = Number(toUint(s0[0])) / 2 ** 96; out.poolPrice = sqrt * sqrt * 10 ** (d0 - d1); }
  // token1 per token0, at market prices. A token the site prices from this vault's own pool (wANTx, wNVDAx) would
  // make the comparison empty; for those an outside market's price is used (market.ref). `refSym` is the token of
  // the pair that has such a price (the second token for ANTx-USDC, the first for NVDAx-USDC), `refUsd` that price
  // in dollars when it could be read.
  out.refSym = [v.token1, v.token0].find((s) => cfg.hyperliquid?.coins?.[s]) ?? null;
  out.refUsd = out.refSym ? market.ref?.[out.refSym] : undefined;
  const ref0 = market.ref?.[v.token0], ref1 = market.ref?.[v.token1];
  const marketPrice = (ref0 > 0 ? ref0 : out.token0Usd) / (ref1 > 0 ? ref1 : out.token1Usd);
  out.marketPrice = marketPrice;
  out.priceOff = isFinite(out.poolPrice) && isFinite(marketPrice) && marketPrice > 0 ? out.poolPrice / marketPrice - 1 : 0;
  const r = p.views && Object.fromEntries(VIEWS.map((k) => [k, W(p.views[k])]));
  if (!r || VIEWS.some((k) => !r[k])) return out; // no contract at this address yet
  out.live = true;
  Object.assign(out, {
    totalValueRaw: toUint(r.totalValue[0]), total0: toUint(r.balances[0]), total1: toUint(r.balances[1]),
    main: { lower: int24(r.main[0]), upper: int24(r.main[1]), liquidity: toUint(r.main[2]) },
    alt: { lower: int24(r.alt[0]), upper: int24(r.alt[1]), liquidity: toUint(r.alt[2]) },
    sqrtP: toUint(r.price[0]), tick: int24(r.price[1]),
    paused: toUint(r.depositsPaused[0]) === 1n, capRaw: toUint(r.depositCap[0]), supply: toUint(r.totalSupply[0]),
    lastHarvest: Number(toUint(r.lastHarvest[0])), lastRebalance: Number(toUint(r.lastRebalance[0])),
    fee0: toUint(r.pendingFees[0]), fee1: toUint(r.pendingFees[1]),
    keeper: "0x" + r.keeper[0].slice(24), owner: "0x" + r.owner[0].slice(24), feeRecipient: "0x" + r.feeRecipient[0].slice(24),
    tf0: toUint(r.totalFees0[0]), tf1: toUint(r.totalFees1[0]), mainWidth: int24(r.mainWidth[0]), altWidth: int24(r.altWidth[0]), cooldown: Number(toUint(r.cooldown[0])), spacing: int24(r.tickSpacing[0]),
  });
  const px0 = out.token0Usd ?? NaN, px1 = out.token1Usd ?? NaN;
  out.empty = out.supply <= MIN_SHARES;
  out.tvlUsd = tok(out.totalValueRaw, d1) * px1;
  const within = (r) => r.liquidity > 0n && out.tick >= r.lower && out.tick < r.upper;
  out.inRange = within(out.main);
  out.active = within(out.main) || within(out.alt); // is any liquidity earning at the current price?
  // After a range move with one token only, the main range is empty and everything sits in the side range.
  out.oneSided = out.main.liquidity === 0n && out.alt.liquidity > 0n;
  out.state = out.empty ? "empty" : out.active ? "earning" : out.oneSided && out.tick >= out.main.lower && out.tick < out.main.upper ? "waiting" : "out";
  out.sharePrice = out.supply > 0n ? Number(out.totalValueRaw) / Number(out.supply) : 1;
  out.pendingUsd = tok(out.fee0, d0) * px0 + tok(out.fee1, d1) * px1;
  out.earnedUsd = 0.8 * (tok(out.tf0, d0) * px0 + tok(out.tf1, d1) * px1 + out.pendingUsd);
  // What a new depositor buys into: holdings plus the fees about to be collected for holders.
  out.T0 = out.total0 + (out.fee0 * PERF_KEEP) / 10n;
  out.T1 = out.total1 + (out.fee1 * PERF_KEEP) / 10n;
  out.hist = { snaps: [], fees: [], deposits: [], withdraws: [], rebalances: [], events: [], netUsd: 0 };
  out.age = 0; out.apr = NaN;

  if (p.user) {
    const g = (k) => { const w = W(p.user[k]); return w ? toUint(w[0]) : 0n; };
    const u = { shares: g("shares"), bal1: g("bal1"), allow1: g("allow1"), erc0: g("erc0"), allow0: g("allow0"), zallow1: g("zallow1"), zallow0: g("zallow0"), z2allow1: g("z2allow1"), z2allow0: g("z2allow0"), native: natBal != null ? BigInt(natBal) : g("native") };
    u.bal0 = out.native ? u.native : u.erc0;
    u.out0 = out.supply > 0n ? (out.total0 * u.shares) / out.supply : 0n;
    u.out1 = out.supply > 0n ? (out.total1 * u.shares) / out.supply : 0n;
    u.valueUsd = tok(u.out0, d0) * px0 + tok(u.out1, d1) * px1;
    u.isKeeper = account.toLowerCase() === out.keeper.toLowerCase();
    u.isOwner = account.toLowerCase() === out.owner.toLowerCase();
    out.user = u;
  }
  return out;
}

function history(v, logs, ts) {
  const h = { snaps: [], fees: [], deposits: [], withdraws: [], rebalances: [], events: [] };
  for (const l of logs) {
    const w = words(l.data), t = ts(l), tx = l.transactionHash, k = l.topics[0];
    if (k === T.Snapshot) {
      const supply = Number(toUint(w[2])), sp = Number(toUint(w[3])) / 2 ** 96;
      const value1 = Number(toUint(w[1])) + Number(toUint(w[0])) * sp * sp;
      if (supply > Number(MIN_SHARES)) h.snaps.push({ t, v: value1 / supply, tvl1: value1 / 10 ** v.d1, k: sp > 0 ? Math.round(Math.log(sp * sp) / Math.log(1.0001)) : null });
    } else if (k === T.FeesCollected) {
      h.fees.push({ t, f0: tok(toUint(w[0]), v.d0), f1: tok(toUint(w[1]), v.d1), tx });
    } else if (k === T.Deposit || k === T.Withdraw) {
      const row = { t, who: topicAddr(l.topics[1]), tx };
      if (k === T.Deposit) Object.assign(row, { a0: tok(toUint(w[0]), v.d0), a1: tok(toUint(w[1]), v.d1) }), h.deposits.push(row);
      else Object.assign(row, { a0: tok(toUint(w[1]), v.d0), a1: tok(toUint(w[2]), v.d1) }), h.withdraws.push(row);
    } else if (k === T.Rebalanced) {
      h.rebalances.push({ t, tick: int24(w[0]), lower: int24(w[1]), upper: int24(w[2]), altLower: w[3] ? int24(w[3]) : undefined, altUpper: w[4] ? int24(w[4]) : undefined, tx });
    }
  }
  const px0 = v.token0Usd ?? 0, px1 = v.token1Usd ?? 0, d = asShown(v);
  const val = (r) => r.a0 * px0 + r.a1 * px1;
  const pair = (r) => `${amount(r.a0)} ${v.token0} + ${amount(r.a1)} ${v.token1}`;
  h.events = [
    ...h.deposits.map((r) => ({ t: r.t, kind: "Deposit", detail: pair(r), usd: val(r), who: r.who, tx: r.tx })),
    ...h.withdraws.map((r) => ({ t: r.t, kind: "Withdraw", detail: pair(r), usd: val(r), who: r.who, tx: r.tx })),
    ...h.fees.map((r) => ({ t: r.t, kind: "Fees compounded", detail: `${amount(r.f0)} ${v.token0} + ${amount(r.f1)} ${v.token1}`, usd: r.f0 * px0 + r.f1 * px1, tx: r.tx })),
    // The vault's first deposit opens the range; only later moves are rebalances.
    ...h.rebalances.slice(1).map((r) => ({ t: r.t, kind: "Range moved", detail: d.flipped ? `to ${tickPrice(d, -r.upper)} – ${tickPrice(d, -r.lower)}` : `to ${tickPrice(v, r.lower)} – ${tickPrice(v, r.upper)}`, tx: r.tx })),
  ].sort((a, b) => b.t - a.t);
  h.netUsd = h.deposits.reduce((s, r) => s + val(r), 0) - h.withdraws.reduce((s, r) => s + val(r), 0);
  return h;
}

// ---------------------------------------------------------------- maths

/** token1 per token0, in whole-token terms, at a tick. */
const tickToPrice = (v, t) => 1.0001 ** t * 10 ** (v.d0 - v.d1);
const fmtP = (n) => (!isFinite(n) ? "—" : n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : n >= 1 ? n.toFixed(2) : n.toPrecision(4));
const tickPrice = (v, t) => fmtP(tickToPrice(v, t));
const unit = (v) => (v.token1 === "USDC" ? "$" : "");
const p1 = (v, n) => (v.token1 === "USDC" ? `$${fmtP(n)}` : `${fmtP(n)} ${v.token1}`);

/** Token amounts held by a range at the current price (floats, whole tokens). */
function rangeAmounts(v, r) {
  if (!r || r.liquidity === 0n) return [0, 0];
  const L = Number(r.liquidity), sp = Number(v.sqrtP) / 2 ** 96, sa = 1.0001 ** (r.lower / 2), sb = 1.0001 ** (r.upper / 2);
  let a0 = 0, a1 = 0;
  if (sp <= sa) a0 = L * (1 / sa - 1 / sb);
  else if (sp < sb) { a0 = L * (1 / sp - 1 / sb); a1 = L * (sp - sa); }
  else a1 = L * (sb - sa);
  return [a0 / 10 ** v.d0, a1 / 10 ** v.d1];
}

/** What the two typed amounts buy. Never asks for more than was typed. */
function quoteDeposit(v, a0, a1) {
  if (v.empty) {
    const sp = Number(v.sqrtP) / 2 ** 96;
    const value = a1 + BigInt(Math.floor(Number(a0) * sp * sp));
    const shares = v.supply === 0n ? (value > MIN_SHARES ? value - MIN_SHARES : 0n) : value;
    return { shares, use0: a0, use1: a1, min: (shares * 995n) / 1000n };
  }
  const s0 = v.T0 === 0n ? null : (a0 * v.supply) / v.T0, s1 = v.T1 === 0n ? null : (a1 * v.supply) / v.T1;
  let shares = s0 === null ? s1 ?? 0n : s1 === null ? s0 : s0 < s1 ? s0 : s1;
  shares = (shares * 995n) / 1000n; // room for the price and fees to drift before the transaction lands
  return { shares, use0: ceilDiv(v.T0 * shares, v.supply), use1: ceilDiv(v.T1 * shares, v.supply), min: shares };
}

// ---------------------------------------------------------------- pieces

const MARKS = { HYPE: "HY", USDC: "US", KNTQ: "KN", kHYPE: "kH", "$liquid": "LQ", wANTx: "AN", wNVDAx: "NV" };
// Token images live in site/tokens/ (the site only loads images from itself). A token without one,
// or whose image fails to load, shows its letters instead.
const TOKEN_IMG = { HYPE: "tokens/hype.svg", USDC: "tokens/usdc.svg", KNTQ: "tokens/kntq.svg", "$liquid": "tokens/liquid.svg", wANTx: "tokens/antx.png", wNVDAx: "tokens/nvdax.png" }; // antx.png, nvdax.png: the issuer's own ANTx and NVDAx logos (xstocks-metadata.backed.fi)
const coin = (s, sm) => `<span class="coin${sm ? " sm" : ""}" title="${esc(s)}">${esc(MARKS[s] ?? s.replace("$", "").slice(0, 2).toUpperCase())}${TOKEN_IMG[s] ? `<img src="${TOKEN_IMG[s]}" alt="" />` : ""}</span>`;
// No inline handlers (the site's security policy forbids them): watch image loads and failures from the document.
document.addEventListener("load", (ev) => { if (ev.target?.matches?.(".coin img")) ev.target.parentElement.classList.add("has-img"); }, true);
document.addEventListener("error", (ev) => { if (ev.target?.matches?.(".coin img")) ev.target.remove(); }, true);
const kv = (k, val) => `<div class="kv num"><span>${k}</span><b class="r">${val}</b></div>`;
const link = (S, kind, val, text) => S.cfg.link("elysium", kind, val, text);

function badges(v) {
  if (v.loading) return `<span class="badge">Loading…</span>`;
  if (!v.live) return `<span class="badge">${v.address ? "Not launched yet" : "Opens at token launch"}</span>`;
  const state = { empty: `<span class="badge">Awaiting first deposit</span>`, earning: `<span class="badge on">● Earning fees</span>`, waiting: `<span class="badge warn">Waiting for the price</span>`, out: `<span class="badge warn">Out of range</span>` }[v.state];
  return `<span class="badge on">Live</span>${state}${v.paused ? `<span class="badge warn">Deposits paused</span>` : ""}`;
}
const subline = (v) => `Auto-compounding · Uniswap v4 · ${esc(v.feeTier)} pool`;
/** A vault that is the only liquidity in its pool (deployment.json "alone") says what that means, on its own page. */
const aloneNote = (v) => (v?.alone && v.note ? `<div class="notice" style="margin-top:14px"><span class="dot"></span><div><b>About this vault.</b> ${esc(v.note)}</div></div>` : "");
const unaudited = (v) => `<div class="notice"><span class="dot"></span><div><b>These contracts have not been audited.</b> They are tested, including against the real Elysium pools, but an independent review has not happened yet. ${v?.capRaw > 0n ? `Deposits are capped at ${amount(tok(v.capRaw, v.d1))} ${esc(v.token1)} of value. ` : ""}Only deposit what you could afford to lose. <a class="xl" href="#/docs/risks">Risks</a></div></div>`;

// ---------------------------------------------------------------- list

export function listView(S) {
  const loading = !S.vaults;
  const every = S.vaults ?? (S.cfg.vaults ?? []).map((v) => ({ ...v, live: false, loading: true, poolPrice: NaN }));
  // A replaced vault ("retired" in deployment.json) leaves the list once nothing is deposited in it. Its page still opens by its link.
  const vs = every.filter((v) => !(v.retired && (v.loading || !v.live || v.empty))), live = vs.filter((v) => v.live);
  const tvl = live.reduce((s, v) => s + (v.tvlUsd || 0), 0), earned = every.reduce((s, v) => s + (v.live ? v.earnedUsd || 0 : 0), 0);
  const mine = live.reduce((s, v) => s + (v.user?.valueUsd || 0), 0);
  const row = (v) => {
    const d = asShown(v); // prices and the pair's order as shown (dollars per token where USDC is the pool's first token)
    const cells = v.live
      ? [["TVL", isFinite(v.tvlUsd) ? usd(v.tvlUsd) : "—"], ["Fee APR", isFinite(v.apr) ? pct(v.apr) : "—"], [v.user?.shares > 0n ? "Your position" : "Earned", v.user?.shares > 0n ? usd(v.user.valueUsd) : usd(v.earnedUsd)]]
      : [["Pool price", isFinite(d.poolPrice) ? p1(d, d.poolPrice) : "—"], ["Fee tier", esc(v.feeTier)], ["Status", v.loading ? "…" : v.address ? "Soon" : "At launch"]];
    return `<a class="card vrow" href="#/vault/${esc(v.id)}">
      <div class="name"><div class="pair">${coin(d.token0, true)}${coin(d.token1, true)}</div><div style="min-width:0"><b>${esc(v.name)}</b><div class="badges" style="margin-top:6px">${badges(v)}</div>${miniRange(v)}</div></div>
      ${cells.map(([k, val]) => `<div class="cell"><div class="k">${k}</div><div class="v num">${val}</div></div>`).join("")}
      <span class="go dim">${icons.arrow}</span></a>`;
  };
  return `<section class="pagehead">
      <div class="eyebrow">Vaults</div>
      <h1>Deposit once. <em>It compounds.</em></h1>
      <p class="lede">Each vault holds concentrated Uniswap v4 liquidity on Elysium and puts the trading fees it earns straight back to work. No lock-up: withdraw whenever you like.</p>
    </section>
    <section style="margin-bottom:34px"><div class="label sec-label">Protocol</div>
      <div class="tiles">
        ${tile("Vault TVL", live.length ? usd(tvl) : "—", `${live.length} of ${vs.length} live`)}
        ${tile("Earned for depositors", live.length ? usd(earned) : "—", "trading fees, after the 20% fee")}
        ${tile(wallet.account ? "Your deposits" : "Performance fee", wallet.account ? usd(mine) : "20%", wallet.account ? "across vaults" : "of fees earned, never of deposits")}
        ${creatorShare(S).vaultFees
          ? tile("Of that fee, to the reserve", "80%", "20% to the creator, for vaults opened since 17 Nov 2026; the rest send all of it")
          : tile("Of that fee, to the reserve", "100%", "none to the creator")}
      </div></section>
    <section><div class="label sec-label">All vaults</div>
      ${loading && S.errors?.vaults ? `<div class="msg err" style="margin:0 0 10px">Couldn't reach Elysium just now (${esc(S.errors.vaults)}). Trying again automatically.</div>` : ""}
      <div class="vlist">${vs.length ? vs.map(row).join("") : `<div class="card empty">No vaults configured.</div>`}</div>
      <div style="margin-top:14px">${unaudited()}</div>
    </section>`;
}

// ---------------------------------------------------------------- detail

const ui = { view: "simple", modal: null, range: "ALL", page: 0, mode: "one", ztoken: 0 };
/** Deposits are refused while a vault's pool price is this far from the market price: adding liquidity at a wrong price loses value. */
const OFF_MARKET = 0.08; // two pools that each charge 2% can sit about 4% apart without anyone being able to profit from closing the gap
/** A vault that is alone in its pool: before its first deposit the empty pool is put at the outside market's price when it is further off than this. */
const FIRST_OFF = 0.01;
// A vault that is the only liquidity in its pool. A one-token deposit trades against the vault itself, so:
// it is refused when the pool's price is this far on the wrong side of the outside market for that trade...
const ALONE_OFF = 0.03;
// ...and when its swap would take more than this share of the other token the vault holds (about a 2% price move
// with the usual range width). A bigger swap could empty that side and leave the pool's price far from the market.
const ZAP_TAKE_MAX = 0.1;
/**
 * What a one-token deposit of `a` does in a vault that is the only liquidity in its pool. The zap swaps a share of it
 * (worked out from the vault's mix before the swap), but here that swap trades against the vault itself, so the
 * vault's mix has moved by the time the deposit is made. This follows both steps. Values are counted in token1.
 *   take         share of the vault's other token that the swap takes away
 *   used         share of the payment that ends up deposited (the rest comes back as change)
 *   changeOther  change that comes back in the other token, in that token's smallest units
 */
function zapPlan(v, a, token0In) {
  const sp = Number(v.sqrtP) / 2 ** 96, p = sp * sp, keep = 1 - (v.fee ?? 3000) / 1e6; // p: token1 per token0, smallest units
  const T0 = Number(v.total0) * p, T1 = Number(v.total1); // the vault's two sides, both counted in token1
  const [Av, Bv] = token0In ? [T0, T1] : [T1, T0], av = token0In ? Number(a) * p : Number(a);
  // What the zap swaps away. The first zap works from the vault's mix before the swap; the second counts the vault
  // as the other side of its own swap, which is what happens here, so with it nearly everything is deposited.
  const x = Bv > 0 ? (av * Bv) / (Bv + (Av + (v.zapV2 ? av : 0)) * keep) : 0;
  const got = x * keep, A2 = Av + x, B2 = Bv - got; // what the swap returns; the vault's two sides after it
  const s = Math.min(A2 > 0 ? (av - x) / A2 : Infinity, B2 > 0 ? got / B2 : Infinity); // the share of the vault the deposit can buy
  const share = isFinite(s) && s > 0 ? s : 0, back = Math.max(0, got - share * B2);
  return { take: Bv > 0 ? got / Bv : 0, used: av > 0 ? (share * (A2 + B2)) / av : 0, changeOther: token0In ? back : back / p };
}
const ZERO = "0x0000000000000000000000000000000000000000";
const isqrt = (n) => { if (n < 2n) return n; let x = n, y = (x + 1n) >> 1n; while (y < x) { x = y; y = (x + n / x) >> 1n; } return x; };
/** A pool's sqrtPriceX96 for a price given as token1 per token0 in the tokens' smallest units. That figure is large
 *  when token1 has the more decimals (wANTx per USDC) and tiny the other way round (USDC per wNVDAx), so it is
 *  scaled up by enough to keep its digits before the whole-number square root. */
const sqrtX96For = (raw) => { const k = raw < 1 ? 24n : 6n; return isqrt(BigInt(Math.round(raw * 10 ** Number(k))) << 192n) / 10n ** (k / 2n); };
const offMarketText = (v) => `This vault's pool price is ${(Math.abs(v.priceOff) * 100).toFixed(1)}% away from the market price right now. A deposit at that price would lose value, so it is not sent. Try again once they line up.`;
// Deep links: ?view=advanced opens the detailed view, ?modal=deposit the deposit sheet.
try {
  const q = new URLSearchParams(location.search);
  if (q.get("view") === "advanced") ui.view = "advanced";
  if (["deposit", "withdraw"].includes(q.get("modal"))) ui.modal = q.get("modal");
} catch {}
const draft = { amt0: "", amt1: "", zamt: "", wshares: "", ocap: null, okeeper: null, omain: null, oalt: null, typed: [false, false] };
let notice = { html: "", kind: "", until: 0 };
const RANGES = [["1D", 86_400], ["1W", 604_800], ["1M", 2_592_000], ["ALL", 0]];

function perfPoints(v) {
  const now = v.now;
  const all = [...v.hist.snaps.map((s) => ({ t: s.t, v: s.v }))];
  if (!v.empty) all.push({ t: Math.max(now, (all.at(-1)?.t ?? 0) + 1), v: v.sharePrice });
  const win = RANGES.find((r) => r[0] === ui.range)[1];
  if (!win) return all;
  const from = now - win, inside = all.filter((p) => p.t >= from), before = all.filter((p) => p.t < from).at(-1);
  return before ? [{ t: from, v: before.v }, ...inside] : inside;
}

function positionCard(v) {
  const u = v.user, hasPos = u && u.shares > 0n;
  const fig = !wallet.account ? "—" : usd(u?.valueUsd ?? 0);
  const held = !wallet.account ? "Connect a wallet to see your position." : hasPos ? `${formatUnits(u.out0, v.d0, 4)} ${esc(sym0(v))} + ${formatUnits(u.out1, v.d1, 4)} ${esc(v.token1)} · ${formatUnits(u.shares, v.d1, 4)} shares` : "You have no deposit in this vault yet.";
  return `<div class="card chrome position">
    <div><div class="label">Your position</div><div class="fig num">${fig}</div><div class="held num">${held}</div></div>
    <div class="acts"><button class="btn primary" data-open="deposit" ${v.paused ? "disabled" : ""}>${v.paused ? "Deposits paused" : "Deposit"}</button>${hasPos ? `<button class="btn" data-open="withdraw">Withdraw</button>` : ""}</div>
  </div>`;
}

function rangeCard(v) {
  v = asShown(v);
  const live = [v.main, v.alt].filter((r) => r.liquidity > 0n);
  if (v.empty || !live.length) return `<div class="card"><div class="label">Liquidity range</div><div class="empty">${v.empty ? "The range opens around the pool price with the first deposit." : "The vault's tokens are not in a range right now. They are still safe and can be withdrawn."}</div></div>`;
  const lo = Math.min(...live.map((r) => r.lower), v.tick), hi = Math.max(...live.map((r) => r.upper), v.tick);
  const pad = (hi - lo) * 0.12 || 100, x = (t) => (100 * (t - lo + pad)) / (hi - lo + 2 * pad);
  const band = (r, cls) => `<span class="band ${cls}" style="left:${x(r.lower)}%;width:${x(r.upper) - x(r.lower)}%"></span>`;
  const now = tickToPrice(v, v.tick), shown = v.main.liquidity > 0n ? v.main : v.alt; // the range the headline describes
  const above = v.alt.lower > v.tick, held = above ? v.token0 : v.token1;
  const note = {
    earning: v.inRange
      ? "The pool price is inside the range, so the vault's liquidity is earning trading fees."
      : "The vault's liquidity is in a one-sided range and the price is inside it, so it is earning trading fees. The keeper rebuilds the main range once the vault holds enough of both tokens.",
    waiting: `The vault holds only ${esc(held)} right now, so its liquidity sits in a one-sided range just ${above ? "above" : "below"} the price. It starts earning when the price trades into that range, or when the keeper moves the range. Your tokens are safe and can be withdrawn.`,
    out: "The price has left the range, so the vault is not earning until the keeper moves it. Your tokens are still safe and can be withdrawn.",
  }[v.state];
  const badge = { earning: ["on", "● Earning fees"], waiting: ["warn", "Waiting for the price"], out: ["warn", "Out of range"] }[v.state];
  return `<div class="card">
    <div class="head-row" style="margin-bottom:4px"><div><div class="label">Liquidity range${v.oneSided ? " · one-sided" : ""}</div><div class="rangeline" style="margin-top:8px">${p1(v, tickToPrice(v, shown.lower))} → ${p1(v, tickToPrice(v, shown.upper))}</div></div>
      <span class="badge ${badge[0]}">${badge[1]}</span></div>
    ${liquidityMap(v, mapLegend(v))}
    <p class="note">${note}</p>
  </div>`;
}

/** Legend rows for the liquidity map: how much of the vault sits in each range, and what it holds there. */
function mapLegend(v) {
  const px0 = v.token0Usd ?? 0, px1 = v.token1Usd ?? 0;
  const [m0, m1] = rangeAmounts(v, v.main), [a0, a1] = rangeAmounts(v, v.alt);
  const t0 = tok(v.total0, v.d0), t1 = tok(v.total1, v.d1), total = t0 * px0 + t1 * px1;
  const i0 = Math.max(0, t0 - m0 - a0), i1 = Math.max(0, t1 - m1 - a1);
  const share = (x0, x1) => (total > 0 ? `${(((x0 * px0 + x1 * px1) / total) * 100).toFixed(0)}%` : "—");
  const holds = (x0, x1) => [x0 > 0 ? `${amount(x0)} ${esc(v.token0)}` : "", x1 > 0 ? `${amount(x1)} ${esc(v.token1)}` : ""].filter(Boolean).join(" + ") || "nothing";
  const rows = [];
  if (v.main.liquidity > 0n) rows.push({ key: "main", name: `Main range · ${share(m0, m1)}`, part: `<span class="dim">${holds(m0, m1)}</span>` });
  if (v.alt.liquidity > 0n) rows.push({ key: "alt", name: `Side range · ${share(a0, a1)}`, part: `<span class="dim">${holds(a0, a1)}</span>` });
  if (total > 0 && (i0 * px0 + i1 * px1) / total >= 0.01) rows.push({ key: "idle", name: `Not in a range · ${share(i0, i1)}`, part: `<span class="dim">${holds(i0, i1)}</span>` });
  return rows;
}

function perfCard(v) {
  const pts = perfPoints(v), ok = pts.length >= 2;
  const chg = ok ? pts.at(-1).v / pts[0].v - 1 : 0;
  const since = ui.range === "ALL" ? "Since the vault went live" : `Past ${{ "1D": "24 hours", "1W": "7 days", "1M": "30 days" }[ui.range]}`;
  return `<div class="card">
    <div class="perf-top">
      <div><div class="label">Performance</div>
        <div class="big num ${ok ? (chg >= 0 ? "up" : "down") : ""}">${ok ? `${chg >= 0 ? "+" : ""}${(chg * 100).toFixed(2)}%` : "—"}</div>
        <div class="nav">Share price ${v.empty ? "—" : `${unit(v)}${v.sharePrice.toFixed(4)}${unit(v) ? "" : " " + esc(v.token1)}`} · ${since}</div></div>
      <div class="side"><span class="pill live"><span class="dot on pulse"></span>Live</span>
        <div class="seggroup sm" role="group" aria-label="Time range">${RANGES.map(([l]) => `<button type="button" data-range="${l}" class="${ui.range === l ? "active" : ""}">${l}</button>`).join("")}</div></div>
    </div>
    <div class="navchart" id="navchart"></div>
    <p class="note">One share's value in ${esc(v.token1)}. It moves with the ${esc(asShown(v).flipped ? v.token1 : v.token0)} price as well as with fees earned, so it can fall.</p>
  </div>`;
}

function advanced(S, v) {
  const d = asShown(v); // the live quote and the range table are drawn from the shown view
  const [m0, m1] = rangeAmounts(d, d.main), [a0, a1] = rangeAmounts(d, d.alt);
  const i0 = Math.max(0, tok(d.total0, d.d0) - m0 - a0), i1 = Math.max(0, tok(d.total1, d.d1) - m1 - a1);
  const px0 = v.token0Usd ?? 0, px1 = v.token1Usd ?? 0, h = v.hist, dx0 = d.token0Usd ?? 0, dx1 = d.token1Usd ?? 0;
  const comp = (label, x0, x1) => `<tr><td>${label}</td><td>${amount(x0)}</td><td>${amount(x1)}</td><td>${usd(x0 * dx0 + x1 * dx1)}</td></tr>`;
  const now = v.now;
  const canMove = v.user?.isKeeper, wait = v.lastRebalance + v.cooldown - now;
  const pace = v.age >= 3600 ? (v.earnedUsd / v.age) * 86_400 : NaN;

  // daily table
  const days = new Map();
  const day = (t) => { const d = dayOf(t); if (!days.has(d)) days.set(d, { dep: 0, wd: 0, fee: 0, px: null }); return days.get(d); };
  h.deposits.forEach((r) => (day(r.t).dep += r.a0 * px0 + r.a1 * px1));
  h.withdraws.forEach((r) => (day(r.t).wd += r.a0 * px0 + r.a1 * px1));
  h.fees.forEach((r) => (day(r.t).fee += r.f0 * px0 + r.f1 * px1));
  h.snaps.forEach((s) => (day(s.t).px = s.v));
  const daily = [...days.entries()].sort((a, b) => b[0] - a[0]).slice(0, 14);

  const per = 8, pages = Math.max(1, Math.ceil(h.events.length / per));
  ui.page = Math.min(ui.page, pages - 1);
  const rows = h.events.slice(ui.page * per, ui.page * per + per);

  return `<div class="two" style="margin-top:14px">
    <div class="card"><div class="label">Pool · live quote</div>
      ${kv(`1 ${esc(d.token0)}`, p1(d, d.flipped ? d.poolPrice : tickToPrice(v, v.tick)))}${kv("Pool fee", esc(v.feeTier))}${kv("Current tick", v.tick.toLocaleString())}${kv("Pool", v.pool ? `<span class="mono" style="font-weight:500;font-size:12px">${esc(short(v.pool))}</span>` : "—")}</div>
    <div class="card"><div class="label">Strategy</div>
      ${kv("Main range width", `±${v.mainWidth} spacings`)}${kv("Range last moved", v.lastRebalance ? ago(now - v.lastRebalance) : h.rebalances[0] ? ago(now - h.rebalances[0].t) : "—")}${kv("Fees last compounded", v.lastHarvest ? ago(now - v.lastHarvest) : "—")}${kv("Keeper", link(S, "address", v.keeper))}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
        <button class="btn sm" id="do-harvest" ${v.fee0 + v.fee1 === 0n ? "disabled" : ""}>Compound fees now</button>
        ${canMove ? `<button class="btn sm" id="do-rebalance" ${wait > 0 && v.lastRebalance ? "disabled" : ""}>${wait > 0 && v.lastRebalance ? `Move range in ${duration(wait)}` : "Move range to the price"}</button>` : ""}
      </div>
      <p class="note">Anyone can compound. Only the keeper can move the range, at most once every ${Math.round(v.cooldown / 60)} minutes.</p></div>
  </div>
  <div class="card" style="margin-top:14px"><div class="label">Vault active range</div>
    <div class="tablewrap"><table class="data"><tr><th>Where</th><th>${esc(d.token0)}</th><th>${esc(d.token1)}</th><th>Value</th></tr>
      ${comp(`Main · ${tickPrice(d, d.main.lower)} – ${tickPrice(d, d.main.upper)}`, m0, m1)}
      ${d.alt.liquidity > 0n ? comp(`Side · ${tickPrice(d, d.alt.lower)} – ${tickPrice(d, d.alt.upper)}`, a0, a1) : ""}
      ${comp("Not in a range", i0, i1)}</table></div></div>
  <div class="two" style="margin-top:14px">
    <div class="card"><div class="label">Fees</div>
      ${kv("Waiting to be compounded", usd(v.pendingUsd))}${kv("Earned for depositors, all time", usd(v.earnedUsd))}${kv("Pace", isFinite(pace) ? `${usd(pace)} a day` : "—")}${kv("Performance fee", "20% of fees")}${kv("Fee goes to", link(S, "address", v.feeRecipient))}</div>
    <div class="card"><div class="label">Vault accounting</div>
      ${kv("Net asset value", `${amount(tok(v.totalValueRaw, v.d1))} ${esc(v.token1)}`)}${kv("Share price", `${v.sharePrice.toFixed(6)} ${esc(v.token1)}`)}${kv("Total shares", amount(tok(v.supply, v.d1)))}${kv("Net deposits", usd(h.netUsd))}${kv("Deposit cap", v.capRaw > 0n ? `${amount(tok(v.capRaw, v.d1))} ${esc(v.token1)}` : "None")}</div>
  </div>
  <div class="card" style="margin-top:14px"><div class="head-row"><div class="label">Flows and revenue</div><span class="dim" style="font-size:12.5px">${h.deposits.length} deposits · ${h.withdraws.length} withdrawals</span></div>
    ${daily.length ? `<div class="tablewrap"><table class="data"><tr><th>Daily</th><th>Deposits</th><th>Withdrawals</th><th>Fees</th><th>Share price</th></tr>
      ${daily.map(([d, r]) => `<tr><td>${dayLabel(d)}</td><td>${r.dep ? usd(r.dep) : "—"}</td><td>${r.wd ? usd(r.wd) : "—"}</td><td>${r.fee ? usd(r.fee) : "—"}</td><td>${r.px ? r.px.toFixed(4) : "—"}</td></tr>`).join("")}</table></div>` : `<div class="empty">Nothing yet.</div>`}
    <p class="note">US dollar figures use today's prices.</p></div>
  <div class="card" style="margin-top:14px"><div class="label">Activity</div>
    ${rows.length ? `<div class="tablewrap"><table class="data"><tr><th>When</th><th class="l">What</th><th class="l">Detail</th><th>Value</th><th>Transaction</th></tr>
      ${rows.map((r) => `<tr><td>${ago(now - r.t)}</td><td class="l">${r.kind}</td><td class="l">${esc(r.detail)}</td><td>${r.usd !== undefined ? usd(r.usd) : "—"}</td><td>${link(S, "tx", r.tx)}</td></tr>`).join("")}</table></div>
      <div class="pager"><button class="btn sm" data-page="-1" ${ui.page === 0 ? "disabled" : ""}>Previous</button><span>Page ${ui.page + 1} of ${pages}</span><button class="btn sm" data-page="1" ${ui.page >= pages - 1 ? "disabled" : ""}>Next</button></div>` : `<div class="empty">No activity yet.</div>`}
  </div>
  <div class="card" style="margin-top:14px"><div class="label">Contract</div>
    ${kv("Vault", link(S, "address", v.address, v.address))}${kv("Owner", link(S, "address", v.owner))}
    ${v.verified ? kv("Source code", `Verified · ${link(S, "address", v.address, "read it on the explorer")}${S.cfg.elysium.sourcify ? ` · <a class="xl" href="${esc(S.cfg.elysium.sourcify)}/${esc(v.address)}" target="_blank" rel="noopener">Sourcify</a>` : ""}`) : ""}
    <p class="note">The owner can change the range width, the keeper, the deposit cap and pause deposits. Neither owner nor keeper can take funds or stop withdrawals.</p>
    <p class="note">${v.user?.isOwner ? "You are connected as the owner: the owner controls are at the bottom of this page." : wallet.account ? `The owner controls only appear for the owner wallet. You are connected as <span class="mono">${esc(short(wallet.account))}</span>, and this vault's owner is <span class="mono">${esc(short(v.owner))}</span>.` : `The owner controls appear on this page when the owner wallet <span class="mono">${esc(short(v.owner))}</span> is connected.`}</p></div>`;
}

/** "−16% / +20%": how far each side of a range of `w` tick spacings reaches. */
const widthPct = (v, w) => { const f = 1.0001 ** (w * v.spacing); return `−${((1 - 1 / f) * 100).toFixed(0)}% / +${((f - 1) * 100).toFixed(0)}%`; };

/** Controls for the vault's owner. Only rendered for the owner wallet; the contract rejects anyone else. */
function ownerCard(v) {
  if (!v.user?.isOwner) return "";
  const cap = draft.ocap ?? formatUnits(v.capRaw, v.d1, 6), keeper = draft.okeeper ?? v.keeper;
  const mw = draft.omain ?? String(v.mainWidth), aw = draft.oalt ?? String(v.altWidth);
  const row = (label, body, help) => `<div class="orow"><div><b>${label}</b><div class="note" style="margin:2px 0 0">${help}</div></div><div class="octl">${body}</div></div>`;
  return `<div class="card chrome" style="margin-top:14px" id="owner">
    <div class="head-row"><div class="label">Owner controls</div><span class="badge">Only your wallet sees this</span></div>
    ${row("New deposits", `<span class="badge ${v.paused ? "warn" : "on"}">${v.paused ? "Paused" : "Open"}</span><button class="btn sm" id="do-pause">${v.paused ? "Resume deposits" : "Pause new deposits"}</button>`, "Pausing stops new money coming in. Withdrawals always keep working.")}
    ${row("Deposit cap", `<div class="in sm"><input id="ocap" inputmode="decimal" autocomplete="off" value="${esc(cap)}" aria-label="Deposit cap" /><span class="sym">${esc(v.token1)}</span></div><button class="btn sm" id="do-cap">Save</button>`, `The most the vault may hold, counted in ${esc(v.token1)}. 0 means no cap.`)}
    ${row("Keeper", `<div class="in sm wide"><input id="okeeper" autocomplete="off" spellcheck="false" value="${esc(keeper)}" aria-label="Keeper address" class="mono" /></div><button class="btn sm" id="do-keeper">Save</button>`, "The one address allowed to move the range. Set it to the keeper bot's wallet once that is running.")}
    ${row("Range width", `<div class="in sm narrow"><input id="omain" inputmode="numeric" autocomplete="off" value="${esc(mw)}" aria-label="Main range width" /><span class="sym">main</span></div><div class="in sm narrow"><input id="oalt" inputmode="numeric" autocomplete="off" value="${esc(aw)}" aria-label="Side range width" /><span class="sym">side</span></div><button class="btn sm" id="do-width">Save</button>`, `In tick spacings, 2 to 2,000. <span id="owidth">Main range is about ${widthPct(v, parseInt(mw, 10) || v.mainWidth)} around the price.</span> Applies the next time the range is moved.`)}
    <p class="note">None of these can move anyone's deposit or stop withdrawals.</p>
  </div>`;
}

function modal(v) {
  if (!ui.modal) return "";
  const u = v.user, dep = ui.modal === "deposit";
  const tabs = `<div class="panel-tabs"><button data-open="deposit" class="${dep ? "active" : ""}">Deposit</button><button data-open="withdraw" class="${dep ? "" : "active"}">Withdraw</button></div>`;
  const field = (id, sym, bal, d, maxAttr) => `<div class="field"><label><span>${esc(sym)}</span><span>Balance ${u ? formatUnits(bal, d, 4) : "—"}</span></label>
      <div class="in"><input id="${id}" inputmode="decimal" placeholder="0.0" autocomplete="off" value="${esc(draft[id])}" /><button class="maxbtn" ${maxAttr}>MAX</button><span class="sym">${esc(sym)}</span></div></div>`;
  // One token: through the zap once the vault has liquidity. A vault alone in its pool has nothing to swap with while
  // it is empty, so there a first deposit with one token goes straight into the vault as it is.
  const direct = v.empty && v.alone, canOne = dep && (direct || (v.zap && !v.empty));
  // The token the price is quoted in (USDC for ANTx-USDC) sits below the price as buy orders; the other one above it as sell orders.
  const flippedView = !!asShown(v).flipped, payingQuote = (ui.ztoken === 0) === flippedView, baseSym = flippedView ? v.token1 : sym0(v);
  const one = canOne && ui.mode === "one";
  const zsym = ui.ztoken === 0 ? sym0(v) : v.token1, zbal = ui.ztoken === 0 ? u?.bal0 ?? 0n : u?.bal1 ?? 0n, zdec = ui.ztoken === 0 ? v.d0 : v.d1;
  const modeBar = canOne ? `<div class="seggroup sm" role="group" aria-label="How to deposit" style="margin-bottom:14px"><button type="button" data-mode="one" class="${ui.mode === "one" ? "active" : ""}">One token</button><button type="button" data-mode="both" class="${ui.mode === "both" ? "active" : ""}">Both tokens</button></div>` : "";
  const oneBody = `<div class="field"><label><span>Pay with <span class="seggroup sm" style="margin-left:6px"><button type="button" data-ztoken="0" class="${ui.ztoken === 0 ? "active" : ""}">${esc(sym0(v))}</button><button type="button" data-ztoken="1" class="${ui.ztoken === 1 ? "active" : ""}">${esc(v.token1)}</button></span></span><span>Balance ${u ? formatUnits(zbal, zdec, 4) : "—"}</span></label>
      <div class="in"><input id="zamt" inputmode="decimal" placeholder="0.0" autocomplete="off" value="${esc(draft.zamt)}" /><button class="maxbtn" data-zmax>MAX</button><span class="sym">${esc(zsym)}</span></div></div>
    <div class="sum" id="zsum"></div>
    <button class="btn primary block" id="do-zap" ${v.paused ? "disabled" : ""}>${u ? "Deposit" : "Connect wallet"}</button>
    <p class="note">${direct
      ? `You are the first depositor, and this vault is the only liquidity in its pool, so there is nothing to swap with yet: your ${esc(zsym)} goes in as it is, with no swap and no fee. It waits just ${payingQuote ? "below" : "above"} the price as ${payingQuote ? "buy" : "sell"} orders for ${esc(baseSym)} and earns fees only once someone trades against it. Depositing both tokens puts the whole deposit to work straight away.`
      : `You pay with one token. The right share of it is swapped for the other in this vault's own pool (the pool's ${esc(v.feeTier)} fee applies to that part), both are deposited, and any change comes straight back. On a thin pool a large amount gets a worse price than a small one.${v.alone ? ` This vault is the only liquidity in its pool, so that swap trades against the vault itself and moves the pool's price: one deposit may swap at most ${ZAP_TAKE_MAX * 100}% of what the vault holds of the other token. Both tokens have no such limit.` : ""}`}</p>`;
  const body = one ? modeBar + oneBody : dep
    ? `${modeBar}${field("amt0", sym0(v), u?.bal0 ?? 0n, v.d0, 'data-max="0"')}${field("amt1", v.token1, u?.bal1 ?? 0n, v.d1, 'data-max="1"')}
       <div class="sum" id="dsum"></div>
       <button class="btn primary block" id="do-deposit" ${v.paused ? "disabled" : ""}>${u ? "Deposit" : "Connect wallet"}</button>
       <p class="note">${v.empty && v.swaps ? `You are the first depositor. Any mix works, including ${esc(sym0(v))} alone: the vault swaps the right share into the other token itself and puts everything to work.` : v.empty ? "You are the first depositor, so you set the mix. Use about equal value of both tokens (the second amount is filled in for you): that puts the whole deposit to work straight away." : "Deposits go in at the vault's current mix, so the two amounts move together. Anything not needed comes straight back in the same transaction."} ${v.native ? "HYPE is sent as native HYPE." : ""}</p>`
    : `<div class="field"><label><span>Shares</span><span>You have ${u ? formatUnits(u.shares, v.d1, 6) : "—"}</span></label>
         <div class="in"><input id="wshares" inputmode="decimal" placeholder="0.0" autocomplete="off" value="${esc(draft.wshares)}" /><span class="sym">shares</span></div></div>
       <div style="display:flex;gap:6px;margin-bottom:12px">${[25, 50, 75, 100].map((p) => `<button class="maxbtn" data-pct="${p}">${p}%</button>`).join("")}</div>
       <div class="sum" id="wsum"></div>
       <button class="btn primary block" id="do-withdraw">${u ? "Withdraw" : "Connect wallet"}</button>
       <p class="note">Withdrawals are always open. You receive your share of both tokens${v.native ? ", with HYPE paid as native HYPE" : ""}.</p>`;
  const n = Date.now() < notice.until ? `<div class="msg ${notice.kind}">${notice.html}</div>` : "";
  return `<div class="modal" id="modal" role="dialog" aria-modal="true" aria-label="${dep ? "Deposit" : "Withdraw"}"><div class="card chrome sheet">
    <button class="iconbtn close" data-close aria-label="Close">✕</button>${tabs}${body}<div id="vmsg">${n}</div></div></div>`;
}

export function detailView(S, id) {
  const v = (S.vaults ?? []).find((x) => x.id === id);
  if (!S.vaults) return `<section class="card empty">${S.errors?.vaults ? `Couldn't reach Elysium just now (${esc(S.errors.vaults)}). Trying again automatically.` : "Loading vault…"}</section>`;
  if (!v) return `<section class="card empty">Vault not found. <a href="#/vaults">Back to vaults</a></section>`;
  const d = v && asShown(v); // prices and the pair's order as shown
  const head = `<a href="#/vaults" class="back">‹ All vaults</a>
    <div class="vhead"><div class="pair">${coin(d.token0)}${coin(d.token1)}</div>
      <div><h1>${esc(v.name)}</h1><div class="label sub">${subline(v)}</div></div>
      <div class="badges">${badges(v)}</div></div>`;
  if (!v.live) {
    return `<section>${head}
      <div class="card chrome pad-lg"><div class="label">Not live yet</div>
        <h3 style="font-size:22px;letter-spacing:-0.02em;margin-top:10px">${v.address ? "This vault's contract has not been deployed yet." : "This vault opens when $liquid launches."}</h3>
        <p class="muted" style="max-width:620px">${esc(v.note ?? "When it is, this page switches on by itself: deposit both tokens, the vault keeps them in a Uniswap v4 range around the price, and trading fees are compounded back in.")}</p>
        <div class="tiles three" style="margin-top:18px">${tile("Pool price", isFinite(d.poolPrice) ? p1(d, d.poolPrice) : "—", `${esc(d.token1)} per ${esc(d.token0)}`)}${tile("Pool fee", esc(v.feeTier), "paid by traders")}${tile("Performance fee", "20%", "of fees earned")}</div>
      </div></section>`;
  }
  const live = [d.main, d.alt].filter((r) => r.liquidity > 0n), edge = d.main.liquidity > 0n ? d.main : d.alt, lo = edge.lower, hi = edge.upper; // the same edges the chart's stats use
  const nowP = d.flipped ? d.poolPrice : tickToPrice(v, v.tick), reach = (k) => `${k >= d.tick ? "+" : "−"}${Math.abs((tickToPrice(d, k) / nowP - 1) * 100).toFixed(0)}%`;
  const tiles = `<div class="tiles">
      ${tile("Pool price", p1(d, nowP), v.empty || !live.length ? `${esc(d.token1)} per ${esc(d.token0)}` : `${{ earning: "inside the vault's range", waiting: "beside the vault's range", out: "outside the vault's range" }[v.state] ?? ""} · ${reach(lo)} / ${reach(hi)}`)}
      ${tile("Vault TVL", isFinite(v.tvlUsd) ? usd(v.tvlUsd) : "—", `${amount(tok(v.total0, v.d0))} ${esc(v.token0)} + ${amount(tok(v.total1, v.d1))} ${esc(v.token1)}`)}
      ${tile("Fee APR", isFinite(v.apr) ? pct(v.apr) : "—", isFinite(v.apr) ? `projected · 1y: ${usd(v.tvlUsd * v.apr)}` : "shown after a day of trading")}
      ${tile("Earned", usd(v.earnedUsd), "for depositors, after the 20% fee")}</div>`;
  return `<section>${head}
    ${positionCard(v)}
    <div class="viewtoggle"><div class="seggroup" role="group" aria-label="Detail level"><button type="button" data-view="simple" class="${ui.view === "simple" ? "active" : ""}">Simple</button><button type="button" data-view="advanced" class="${ui.view === "advanced" ? "active" : ""}">Advanced</button></div></div>
    ${tiles}
    <div class="stack" style="margin-top:14px">${priceRangeCard(v)}${rangeCard(v)}${perfCard(v)}</div>
    ${ui.view === "advanced" ? advanced(S, v) : ""}
    ${ownerCard(v)}
    ${aloneNote(v)}
    <div style="margin-top:14px">${unaudited(v)}</div>
    ${modal(v)}
  </section>`;
}

// ---------------------------------------------------------------- actions

export function bind(S, render, refresh) {
  const id = location.hash.replace(/^#\/?/, "").split("/")[1];
  const v = (S.vaults ?? []).find((x) => x.id === id);
  if (!v || !v.live) return;
  const $ = (q) => document.querySelector(q), $$ = (q) => document.querySelectorAll(q);
  const cfg = S.cfg, e = S.conn.e, u = v.user;
  const t0 = cfg.tokens[v.token0].address, t1 = cfg.tokens[v.token1].address;
  const msg = (text, kind = "") => {
    notice = { html: text, kind, until: Date.now() + (kind ? 60_000 : 600_000) };
    const el = $("#vmsg");
    if (el) el.innerHTML = text ? `<div class="msg ${kind}">${text}</div>` : "";
    else if (kind) toast(text, kind);
  };
  const txLink = (hash) => cfg.link("elysium", "tx", hash, "View transaction");
  /** Dry-runs a call so a failure is explained before the wallet opens. */
  const simulate = async (data, value = 0n, to = v.address) => {
    try {
      return await e.request("eth_call", [{ from: wallet.account, to, data, value: "0x" + value.toString(16) }, "latest"]);
    } catch (err) {
      const code = String(err?.rpcError?.data?.data ?? err?.rpcError?.data ?? "").slice(0, 10);
      throw new Error(ERRORS[code] ?? `This would fail: ${err?.rpcError?.message ?? err.message}`);
    }
  };

  const pts = perfPoints(v), chart = $("#navchart");
  if (chart) navChart(chart, { id: v.id, points: pts, title: `${v.name} share price`, tipName: "Share price", fmt: (n) => `${n.toFixed(4)} ${v.token1}` });
  mountPriceRange(cfg, v);

  $$("[data-view]").forEach((b) => b.addEventListener("click", () => { ui.view = b.dataset.view; render(); }));
  $$("[data-range]").forEach((b) => b.addEventListener("click", () => { ui.range = b.dataset.range; render(); }));
  $$("[data-page]").forEach((b) => b.addEventListener("click", () => { ui.page += +b.dataset.page; render(); }));
  $$("[data-open]").forEach((b) => b.addEventListener("click", () => { ui.modal = b.dataset.open; notice.until = 0; render(); }));
  const close = () => { ui.modal = null; render(); };
  $$("[data-close]").forEach((b) => b.addEventListener("click", close));
  $("#modal")?.addEventListener("pointerdown", (ev) => { if (ev.target.id === "modal") close(); });
  if (ui.modal) document.onkeydown = (ev) => { if (ev.key === "Escape" && ui.modal) close(); };

  // ----- deposit
  const in0 = $("#amt0"), in1 = $("#amt1");
  const paintDeposit = () => {
    const el = $("#dsum");
    if (!el) return;
    const a0 = parseUnits(in0.value, v.d0), a1 = parseUnits(in1.value, v.d1);
    if (a0 + a1 === 0n) return (el.innerHTML = "");
    const q = quoteDeposit(v, a0, a1);
    const value = tok(q.use0, v.d0) * (v.token0Usd ?? NaN) + tok(q.use1, v.d1) * (v.token1Usd ?? NaN);
    const over = (u && (a0 > u.bal0 || a1 > u.bal1)) ? `<div class="msg err" style="margin:0 0 8px">That is more than your balance.</div>` : "";
    let lopsided = "";
    if (v.empty && !v.swaps) {
      const sp = Number(v.sqrtP) / 2 ** 96, v0 = Number(a0) * sp * sp, v1 = Number(a1), share0 = v0 / (v0 + v1);
      if (share0 < 0.35 || share0 > 0.65) lopsided = `<div class="msg" style="margin:0 0 8px;color:var(--warn)">This mix is lopsided: about ${Math.round(share0 * 100)}% ${esc(sym0(v))} by value. Only the balanced part goes into the main range. The rest waits in a one-sided range and earns nothing until the price moves into it.</div>`;
    }
    el.innerHTML = `${over}${lopsided}${kv("You deposit", `${formatUnits(q.use0, v.d0, 5)} ${esc(sym0(v))} + ${formatUnits(q.use1, v.d1, 4)} ${esc(v.token1)}`)}${kv("Worth about", isFinite(value) ? usd(value) : "—")}${kv("You receive", `${formatUnits(q.shares, v.d1, 4)} shares`)}`;
  };
  const link2 = (from) => {
    draft.amt0 = in0.value; draft.amt1 = in1.value;
    const a = parseUnits(from === 0 ? in0.value : in1.value, from === 0 ? v.d0 : v.d1);
    if (!v.empty && v.T0 > 0n && v.T1 > 0n) {
      // the vault's mix decides the other side
      if (from === 0) in1.value = a === 0n ? "" : formatUnits(ceilDiv(a * v.T1, v.T0), v.d1, v.d1);
      else in0.value = a === 0n ? "" : formatUnits(ceilDiv(a * v.T0, v.T1), v.d0, 8);
      draft.amt0 = in0.value; draft.amt1 = in1.value;
    } else if (v.empty && !v.swaps) {
      // First deposit: suggest equal value of both at the pool price, unless the other side was typed by hand.
      draft.typed[from] = (from === 0 ? in0.value : in1.value) !== "";
      const other = 1 - from, sp = Number(v.sqrtP) / 2 ** 96, p = sp * sp;
      if (!draft.typed[other] && p > 0) {
        if (from === 0) in1.value = a === 0n ? "" : formatUnits(BigInt(Math.floor(Number(a) * p)), v.d1, v.d1);
        else in0.value = a === 0n ? "" : formatUnits(BigInt(Math.floor(Number(a) / p)), v.d0, 8);
        draft.amt0 = in0.value; draft.amt1 = in1.value;
      }
    }
    paintDeposit();
  };
  in0?.addEventListener("input", () => link2(0));
  in1?.addEventListener("input", () => link2(1));
  if (in0 && (draft.amt0 || draft.amt1)) paintDeposit();
  $$("[data-max]").forEach((b) => b.addEventListener("click", () => {
    if (!u) return;
    if (b.dataset.max === "0") {
      const gas = v.native ? 2n * 10n ** 16n : 0n; // keep 0.02 HYPE for gas
      in0.value = formatUnits(u.bal0 > gas ? u.bal0 - gas : 0n, v.d0, 8);
      link2(0);
    } else { in1.value = formatUnits(u.bal1, v.d1, v.d1); link2(1); }
  }));
  /** Sends a deposit of these amounts straight to the vault (both tokens, or one alone into an empty vault). */
  const sendDeposit = async (a0, a1) => {
    if (!wallet.account) return wallet.connect();
    const q = quoteDeposit(v, a0, a1);
    if (v.empty && v.priceSetter) {
      // A vault that is alone in its pool: while it is empty the pool's price cannot follow the market by itself, and
      // a first deposit at a stale price would lose value. So the pool is first put at the outside market's price,
      // through a helper anyone may call while the pool is empty. That moves no money.
      if (!(v.refUsd > 0)) return msg(`The market price of ${esc(v.refSym ?? v.token1)} could not be read just now. A first deposit needs it, so nothing was sent. Try again in a moment.`, "err");
      if (Math.abs(v.priceOff ?? 0) > FIRST_OFF) {
        try {
          msg("This empty pool's price has drifted from the market. Lining it up first: confirm in your wallet…");
          const raw = v.marketPrice * 10 ** (v.d1 - v.d0); // token1 per token0 at the outside market's price, in the tokens' smallest units
          const target = sqrtX96For(raw);
          await wallet.send(v.priceSetter, encode(V.setPoolPrice, addr(t0), addr(t1), uint(v.fee), uint(v.spacing), addr(ZERO), uint(target)), e);
          await refresh();
          msg("The pool's price matches the market again. Press Deposit once more.", "ok");
        } catch (err) { msg(esc(friendly(err)), "err"); }
        return;
      }
    }
    if (Math.abs(v.priceOff ?? 0) > OFF_MARKET && v.empty && v.realign) {
      // An empty pool's price cannot follow the market by itself. Anyone may line it up, and it moves no money.
      try {
        msg("This empty pool's price has gone stale. Lining it up with the market first: confirm in your wallet…");
        await wallet.send(v.realign, "0x1e17e5dd", e);
        await refresh();
        msg("The pool's price matches the market again. Press Deposit once more.", "ok");
      } catch (err) { msg(esc(friendly(err)), "err"); }
      return;
    }
    if (Math.abs(v.priceOff ?? 0) > OFF_MARKET) return msg(offMarketText(v), "err");
    if (q.shares === 0n) return msg(v.empty ? "Enter an amount." : "Enter an amount for both tokens.", "err");
    if (a0 > u.bal0 || a1 > u.bal1) return msg("That is more than your balance.", "err");
    try {
      if (a1 > 0n && u.allow1 < a1) { msg(`Approving ${esc(v.token1)} in your wallet…`); await wallet.send(t1, encode(V.approve, addr(v.address), uint(a1)), e); }
      if (!v.native && a0 > 0n && u.allow0 < a0) { msg(`Approving ${esc(v.token0)} in your wallet…`); await wallet.send(t0, encode(V.approve, addr(v.address), uint(a0)), e); }
      const data = encode(V.deposit, uint(q.min), uint(a0), uint(a1), addr(wallet.account)), value = v.native ? a0 : 0n;
      await simulate(data, value);
      msg("Confirm the deposit in your wallet…");
      const hash = await wallet.send(v.address, data, e, value);
      draft.amt0 = draft.amt1 = draft.zamt = "";
      msg(`Deposited. ${txLink(hash)}`, "ok");
      await refresh();
    } catch (err) { msg(esc(friendly(err)), "err"); }
  };
  $("#do-deposit")?.addEventListener("click", () => sendDeposit(parseUnits(in0.value, v.d0), parseUnits(in1.value, v.d1)));

  // ----- one-token deposit through the zap
  $$("[data-mode]").forEach((b) => b.addEventListener("click", () => { ui.mode = b.dataset.mode; notice.until = 0; render(); }));
  $$("[data-ztoken]").forEach((b) => b.addEventListener("click", () => { ui.ztoken = +b.dataset.ztoken; draft.zamt = ""; render(); }));
  const zin = $("#zamt"), zdec = ui.ztoken === 0 ? v.d0 : v.d1, zbal = ui.ztoken === 0 ? u?.bal0 ?? 0n : u?.bal1 ?? 0n;
  /** For a vault alone in its pool: why this one-token deposit cannot be made as asked ("" when it can). */
  const tooMuch = (a) => {
    if (!v.alone || v.empty || a === 0n) return "";
    const plan = zapPlan(v, a, ui.ztoken === 0), paid = ui.ztoken === 0 ? sym0(v) : v.token1, other = ui.ztoken === 0 ? v.token1 : sym0(v);
    if (plan.used < 0.02) return `This vault holds almost no ${esc(paid)} right now, and it is the only liquidity in its pool. A one-token deposit swaps part of your ${esc(paid)} for ${esc(other)}, and here that swap would trade against the vault itself and leave nothing to deposit. Pay with ${esc(other)} instead: it goes in as it is.`;
    if (!(plan.take > ZAP_TAKE_MAX)) return "";
    const most = (BigInt(Math.floor(ZAP_TAKE_MAX / plan.take * 1e6)) * a) / 1_000_000n;
    return `That is too much for one deposit with one token: this vault is the only liquidity in its pool, and the swap would take ${Math.min(999, Math.round(plan.take * 100))}% of the ${esc(other)} it holds and push the pool's price away from the market. Use ${formatUnits(most, zdec, 4)} ${esc(paid)} or less, or deposit both tokens.`;
  };
  const paintZap = () => {
    const el = $("#zsum");
    if (!el) return;
    draft.zamt = zin.value;
    const a = parseUnits(zin.value, zdec);
    if (a === 0n) return (el.innerHTML = "");
    const sp = Number(v.sqrtP) / 2 ** 96, in1 = ui.ztoken === 0 ? Number(a) * sp * sp : Number(a); // value in token1
    // In a vault alone in its pool part of the payment comes back as change in the other token (see zapPlan).
    const plan = v.alone && !v.empty ? zapPlan(v, a, ui.ztoken === 0) : null, odec = ui.ztoken === 0 ? v.d1 : v.d0;
    const change = plan && plan.used >= 0.02 && plan.used < 0.99 ? kv("Comes back as change", `about ${amount(plan.changeOther / 10 ** odec)} ${esc(ui.ztoken === 0 ? v.token1 : sym0(v))}`) : "";
    const value = (in1 / 10 ** v.d1) * (v.token1Usd ?? NaN), shares = (in1 / (v.empty ? 1 : v.sharePrice)) * 0.995 * (plan ? plan.used : 1);
    const over = u && a > zbal ? `<div class="msg err" style="margin:0 0 8px">That is more than your balance.</div>` : tooMuch(a) ? `<div class="msg" style="margin:0 0 8px;color:var(--warn)">${tooMuch(a)}</div>` : "";
    el.innerHTML = `${over}${kv("You pay", `${formatUnits(a, zdec, 5)} ${esc(ui.ztoken === 0 ? sym0(v) : v.token1)}`)}${kv("Worth about", isFinite(value) ? usd(value) : "—")}${change}${kv("You receive about", `${amount(shares / 10 ** v.d1)} shares`)}`;
  };
  zin?.addEventListener("input", paintZap);
  if (zin && draft.zamt) paintZap();
  $("[data-zmax]")?.addEventListener("click", () => {
    if (!u) return;
    const gas = ui.ztoken === 0 && v.native ? 2n * 10n ** 16n : 0n; // keep 0.02 HYPE for gas
    zin.value = formatUnits(zbal > gas ? zbal - gas : 0n, zdec, zdec === 18 ? 8 : zdec);
    paintZap();
  });
  $("#do-zap")?.addEventListener("click", async () => {
    if (!wallet.account) return wallet.connect();
    const a = parseUnits(zin.value, zdec), token0In = ui.ztoken === 0, asValue = token0In && v.native;
    // An empty vault that is alone in its pool: nothing to swap with, so the one token goes straight into the vault.
    if (v.empty && v.alone) return a === 0n ? msg("Enter an amount.", "err") : sendDeposit(token0In ? a : 0n, token0In ? 0n : a);
    if (Math.abs(v.priceOff ?? 0) > OFF_MARKET) return msg(offMarketText(v), "err");
    if (a === 0n) return msg("Enter an amount.", "err");
    if (a > zbal) return msg("That is more than your balance.", "err");
    if (v.alone) {
      // priceOff > 0: the pool gives more token1 for a token0 than the outside market does (token1 is cheap here).
      // Paying token0 buys token1, which is a bad trade when token1 is dear here; paying token1 is the mirror image.
      const off = v.priceOff ?? 0, bad = token0In ? off < -ALONE_OFF : off > ALONE_OFF;
      // said about the token the price is quoted for: the second token where the dollar comes first (ANTx-USDC), the first otherwise
      const flippedView = !!asShown(v).flipped, quoted = flippedView ? v.token1 : sym0(v), side = flippedView === token0In ? "above" : "below";
      if (bad) return msg(`This pool prices ${esc(quoted)} ${(Math.abs(off) * 100).toFixed(1)}% ${side} the outside market right now, so the swap inside a one-token deposit would lose value. Deposit both tokens, pay with ${esc(token0In ? v.token1 : sym0(v))} instead, or try again once the prices line up.`, "err");
      if (tooMuch(a)) return msg(tooMuch(a), "err");
    }
    try {
      if (!asValue && (token0In ? u.zallow0 : u.zallow1) < a) {
        msg(`Approving ${esc(token0In ? v.token0 : v.token1)} in your wallet…`);
        await wallet.send(token0In ? t0 : t1, encode(V.approve, addr(v.zap), uint(a)), e);
      }
      const call = (min) => encode(V.zapIn, addr(v.address), uint(token0In ? 1 : 0), uint(a), uint(min), addr(wallet.account));
      // Dry-run it to learn the exact shares, then accept at most 1% fewer.
      const expected = toUint(words(await simulate(call(0n), asValue ? a : 0n, v.zap))[0]);
      msg("Confirm the deposit in your wallet…");
      const hash = await wallet.send(v.zap, call((expected * 99n) / 100n), e, asValue ? a : 0n);
      draft.zamt = "";
      msg(`Deposited. ${txLink(hash)}`, "ok");
      await refresh();
    } catch (err) { msg(esc(friendly(err)), "err"); }
  });

  // ----- withdraw
  const ws = $("#wshares");
  const paintWithdraw = () => {
    draft.wshares = ws.value;
    const sh = parseUnits(ws.value, v.d1), el = $("#wsum");
    if (!el) return;
    if (sh === 0n || v.supply === 0n) return (el.innerHTML = "");
    const o0 = (v.total0 * sh) / v.supply, o1 = (v.total1 * sh) / v.supply;
    const value = tok(o0, v.d0) * (v.token0Usd ?? NaN) + tok(o1, v.d1) * (v.token1Usd ?? NaN);
    el.innerHTML = `${kv("You receive about", `${formatUnits(o0, v.d0, 5)} ${esc(sym0(v))} + ${formatUnits(o1, v.d1, 4)} ${esc(v.token1)}`)}${kv("Worth about", isFinite(value) ? usd(value) : "—")}`;
  };
  ws?.addEventListener("input", paintWithdraw);
  if (ws && draft.wshares) paintWithdraw();
  $$("[data-pct]").forEach((b) => b.addEventListener("click", () => {
    if (!u) return;
    ws.value = formatUnits((u.shares * BigInt(b.dataset.pct)) / 100n, v.d1, v.d1);
    paintWithdraw();
  }));
  $("#do-withdraw")?.addEventListener("click", async () => {
    if (!wallet.account) return wallet.connect();
    let sh = parseUnits(ws.value, v.d1);
    if (u && sh > u.shares) sh = u.shares;
    if (sh === 0n) return msg("Enter how many shares to withdraw.", "err");
    try {
      const min0 = (((v.total0 * sh) / v.supply) * 99n) / 100n, min1 = (((v.total1 * sh) / v.supply) * 99n) / 100n;
      const data = encode(V.withdraw, uint(sh), uint(min0), uint(min1), addr(wallet.account), uint(v.native ? 1 : 0));
      await simulate(data);
      msg("Confirm the withdrawal in your wallet…");
      const hash = await wallet.send(v.address, data, e);
      draft.wshares = "";
      msg(`Withdrawn. ${txLink(hash)}`, "ok");
      await refresh();
    } catch (err) { msg(esc(friendly(err)), "err"); }
  });

  // ----- upkeep
  const upkeep = (sel, build, done, after) => $(sel)?.addEventListener("click", async () => {
    if (!wallet.account) return wallet.connect();
    try {
      const data = build();
      if (!data) return;
      await simulate(data);
      const hash = await wallet.send(v.address, data, e);
      after?.();
      toast(`${done} ${txLink(hash)}`, "ok");
      await refresh();
    } catch (err) { toast(esc(friendly(err)), "err"); }
  });
  upkeep("#do-harvest", () => V.harvest, "Fees compounded.");
  // The keeper states the price it sees; the vault refuses to move if the pool is more than 0.2% away.
  upkeep("#do-rebalance", () => encode(V.rebalance, uint(BigInt.asUintN(256, BigInt(v.tick))), uint(20)), "Range moved.");

  // ----- owner controls (shown only to the owner wallet; the contract enforces it either way)
  for (const [id, key] of [["ocap", "ocap"], ["okeeper", "okeeper"], ["omain", "omain"], ["oalt", "oalt"]]) {
    $("#" + id)?.addEventListener("input", (ev) => { draft[key] = ev.target.value; if (id === "omain" || id === "oalt") paintWidth(); });
  }
  const paintWidth = () => {
    const el = $("#owidth"), w = parseInt($("#omain")?.value, 10);
    if (el) el.textContent = w >= 2 && w <= 2000 ? `Main range would be about ${widthPct(v, w)} around the price.` : "Each width must be between 2 and 2,000.";
  };
  const bad = (text) => { toast(esc(text), "err"); return null; };
  upkeep("#do-pause", () => encode(V.setDepositsPaused, uint(v.paused ? 0 : 1)), v.paused ? "Deposits are open again." : "New deposits are paused. Withdrawals still work.");
  upkeep("#do-cap", () => {
    const text = $("#ocap").value.trim();
    if (!/^\d*\.?\d*$/.test(text) || text === "") return bad("Enter the cap as a number. Use 0 for no cap.");
    return encode(V.setDepositCap, uint(parseUnits(text, v.d1)));
  }, "Deposit cap updated.", () => (draft.ocap = null));
  upkeep("#do-keeper", () => {
    const a = $("#okeeper").value.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return bad("That is not a valid address.");
    if (/^0x0{40}$/.test(a)) return bad("The keeper cannot be the zero address.");
    return encode(V.setKeeper, addr(a));
  }, "Keeper changed.", () => (draft.okeeper = null));
  upkeep("#do-width", () => {
    const m = parseInt($("#omain").value, 10), a = parseInt($("#oalt").value, 10);
    if (!(m >= 2 && m <= 2000 && a >= 2 && a <= 2000)) return bad("Each width must be between 2 and 2,000.");
    return encode(V.setRanges, uint(m), uint(a));
  }, "Range widths saved. They apply the next time the range is moved.", () => (draft.omain = draft.oalt = null));
}

function toast(html, kind) {
  document.getElementById("toast")?.remove();
  const el = document.createElement("div");
  el.id = "toast"; el.className = `msg ${kind}`;
  el.style.cssText = "position:fixed;right:20px;bottom:84px;max-width:360px;z-index:90;margin:0";
  el.innerHTML = html;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 9000);
}

function friendly(err) {
  const m = err?.message ?? String(err);
  if (/user (rejected|denied)/i.test(m) || err?.code === 4001) return "Cancelled in your wallet.";
  if (/insufficient funds/i.test(m)) return "Not enough HYPE to cover this and the network fee.";
  return m.length > 220 ? m.slice(0, 220) + "…" : m;
}
