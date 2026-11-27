// Sums for the hedged vault's page, kept apart from the page so that they can be checked on their own.
// Nothing here reads the chain or touches the page.

const YEAR = 31_536_000;
const U256 = (x) => BigInt.asUintN(256, x);

/**
 * Trading fees a Uniswap-v3-style position has earned and not collected yet, from the pool's own counters.
 * All counters are 256-bit and are meant to wrap, which is why every subtraction is taken modulo 2^256.
 * p: { liquidity, inside0Last, inside1Last, owed0, owed1, global0, global1, lower0, lower1, upper0, upper1, tick, lower, upper }
 * (lower0/1 and upper0/1 are the "fee growth outside" of the range's two ticks). Returns [token0, token1].
 */
export function pendingFees(p) {
  const side = (global, lowerOut, upperOut, last, owed) => {
    const below = p.tick >= p.lower ? lowerOut : U256(global - lowerOut);
    const above = p.tick < p.upper ? upperOut : U256(global - upperOut);
    const inside = U256(global - below - above);
    return owed + ((U256(inside - last) * p.liquidity) >> 128n);
  };
  return [side(p.global0, p.lower0, p.upper0, p.inside0Last, p.owed0), side(p.global1, p.lower1, p.upper1, p.inside1Last, p.owed1)];
}

/**
 * What the share price has done, from readings that need not be evenly spaced.
 * points: [{ t (unix seconds), v (one share in USDC), hype (HYPE in dollars) }], oldest first.
 * Every figure that would mean little on a short record is null until the record is long enough; `needs` says
 * how long that is. Rates are per year; the Sharpe ratio takes no risk-free rate off.
 */
export function shareStats(points) {
  const pts = points.filter((p) => p.v > 0 && isFinite(p.v));
  const out = { readings: pts.length, seconds: 0, change: null, hypeChange: null, yearly: null, vol: null, sharpe: null, drawdown: null, high: null, low: null, beta: null, corr: null,
    needs: { vol: 2 * 86_400, yearly: 7 * 86_400, sharpe: 7 * 86_400, beta: 86_400 } };
  if (pts.length < 2) return out;
  const first = pts[0], last = pts.at(-1), T = last.t - first.t;
  out.seconds = T;
  out.change = last.v / first.v - 1;
  if (first.hype > 0 && last.hype > 0) out.hypeChange = last.hype / first.hype - 1;
  // highest, lowest, and the largest fall from a high
  let peak = first.v, dd = 0, hi = first.v, lo = first.v;
  for (const p of pts) { if (p.v > peak) peak = p.v; dd = Math.min(dd, p.v / peak - 1); hi = Math.max(hi, p.v); lo = Math.min(lo, p.v); }
  out.drawdown = dd; out.high = hi; out.low = lo;
  if (T <= 0) return out;
  // log changes between neighbours; the variance is counted per second of time that passed, so uneven spacing
  // (an hourly reading here, two readings a minute apart there) does not distort it
  const steps = [];
  for (let i = 1; i < pts.length; i++) {
    const dt = pts[i].t - pts[i - 1].t;
    if (dt <= 0) continue;
    steps.push({ dt, r: Math.log(pts[i].v / pts[i - 1].v), h: pts[i].hype > 0 && pts[i - 1].hype > 0 ? Math.log(pts[i].hype / pts[i - 1].hype) : null });
  }
  const mu = Math.log(last.v / first.v) / T; // per second
  const varRate = steps.reduce((s, x) => s + (x.r - mu * x.dt) ** 2, 0) / T; // per second
  const vol = Math.sqrt(varRate * YEAR);
  if (T >= out.needs.vol && steps.length >= 24) out.vol = vol;
  if (T >= out.needs.yearly) out.yearly = Math.exp(mu * YEAR) - 1;
  if (T >= out.needs.sharpe && steps.length >= 100 && vol > 0) out.sharpe = (mu * YEAR) / vol;
  // how much of HYPE's move a share followed: the slope of its changes against HYPE's, and how tightly they go together
  const both = steps.filter((x) => x.h !== null);
  if (T >= out.needs.beta && both.length >= 24) {
    const Tb = both.reduce((s, x) => s + x.dt, 0);
    const mr = both.reduce((s, x) => s + x.r, 0) / Tb, mh = both.reduce((s, x) => s + x.h, 0) / Tb;
    let shh = 0, srh = 0, srr = 0;
    for (const x of both) { const a = x.r - mr * x.dt, b = x.h - mh * x.dt; shh += b * b; srh += a * b; srr += a * a; }
    if (shh > 0) { out.beta = srh / shh; out.corr = srr > 0 ? srh / Math.sqrt(srr * shh) : 0; }
  }
  return out;
}

/**
 * One wallet's result, from the vault's own events for it.
 * events: [[unix, kind, a, b, c, d, px]] as the history service gives them (amounts as numbers of smallest units):
 *   "deposit"  a = USDC in, b = shares received
 *   "withdraw" a = shares given up, b = USDC paid at once, c = wrapped HYPE sent (wei), d = USDC owed
 *   "claimed"  a = USDC paid from what was owed (already counted when it became owed)
 * px is Hyperliquid's HYPE price in the same transaction, in dollars (to value any HYPE that was sent).
 * now: { shares, value, owed } of the wallet at this moment, in smallest units (BigInt or number).
 * Returns dollars: { putIn, takenOut, worth, result, pct, since, sharesByEvents, complete }.
 * `complete` is false when the wallet holds shares the events do not account for (they were sent to it by
 * someone else): then what they cost is not known, and the result says nothing reliable.
 */
export function positionResult(events, now) {
  let putIn = 0, takenOut = 0, shares = 0, since = null;
  for (const [t, kind, a, b, c, d, px] of events) {
    if (kind === "deposit") { putIn += a / 1e6; shares += b; since = since ?? t; }
    else if (kind === "withdraw") { takenOut += (b + d) / 1e6 + (c / 1e18) * (px || 0); shares -= a; }
  }
  const worth = Number(now.value) / 1e6; // what is owed is already inside takenOut
  const result = worth + takenOut - putIn;
  const held = Number(now.shares);
  return {
    putIn, takenOut, worth, result, pct: putIn > 0 ? result / putIn : null, since,
    sharesByEvents: shares, complete: Math.abs(held - shares) <= 2 && (held === 0 || putIn > 0),
  };
}

/**
 * Where the vault's result so far came from, in dollars. Everything the vault itself reports is taken as it is;
 * the last line is what is left over, which is the price swings after the hedge, and the cost of trading.
 * flows: { deposited, paid, owed, assetUsd } totals in dollars; value: the vault's worth now in dollars.
 */
export function attribution({ value, flows, feesGross, feesPending, performanceFee, funding, hedgeFees }) {
  const total = value + flows.paid + flows.owed + flows.assetUsd - flows.deposited;
  const fees = (feesGross + feesPending) * (1 - performanceFee);
  const rest = total - fees - funding + hedgeFees;
  return { total, fees, funding, hedgeFees: -hedgeFees, rest };
}

/** A round figure at or above x for the top mark of a measuring scale: 1, 2 or 5 times a power of ten. */
export function niceCeil(x) {
  if (!(x > 0)) return 1;
  const mag = 10 ** Math.floor(Math.log10(x)), n = x / mag;
  return Number(((n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag).toPrecision(1)); // toPrecision: 2 * 0.0001 is not quite 0.0002 in floating point
}
