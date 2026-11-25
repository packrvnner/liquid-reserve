// Time series for the analytics page, read from Elysium events.
// $liquid burns are read as token transfers into Ascend's BurnSink, so
// Ascend's 25% buyback and what the drop burns once it is full are all counted,
// whoever sent them.
import { TOPIC, SEL, encode, addr, words, toUint, topicAddr } from "./abi.js";
import { units } from "./format.js";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TOTAL_SUPPLY = "0x18160ddd";
const has = (a) => !!a && !/^0x0{40}$/i.test(a);
const t32 = (a) => "0x" + addr(a);

/** Returns a function log -> unix seconds (uses blockTimestamp when the RPC provides it). */
export async function stamper(rpc, logs) {
  const need = [...new Set(logs.filter((l) => !l.blockTimestamp).map((l) => l.blockNumber))];
  const map = new Map();
  await Promise.all(need.map(async (b) => map.set(b, parseInt((await rpc.request("eth_getBlockByNumber", [b, false])).timestamp, 16))));
  return (l) => (l.blockTimestamp ? parseInt(l.blockTimestamp, 16) : map.get(l.blockNumber));
}

const SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f"; // PoolManager Swap
const int128 = (w) => { const v = BigInt("0x" + w.slice(-32)); return v >= 1n << 127n ? v - (1n << 128n) : v; };

// Ascend seat: emitted by harvest(); the first value is what the seat received, in the coin's pair asset.
const SEAT_HARVEST = "0x8d9b7aba95c052dfd3204b50c01acfb39981b1e3af2180d3883b9bc6a9e5badd";
// How $liquid's seat splits what it receives, fixed when the coin was launched: a quarter buys back and burns
// $liquid, a quarter goes to holders, and the other half goes to the reserve (80%) and the creator (20%).
const SEAT_SHARE = { buyback: 0.25, holders: 0.25 };

// The drop feeder and the yield director. Topics are `cast keccak` of the signatures in src/DropFeeder.sol and
// src/YieldDirector.sol.
// Fed(uint256 usdcIn, uint256 khypeToReserve, uint256 liquidToDrop, uint256 liquidBurned): nothing indexed
const FED = "0x000cb2d9be8c81fea2148aedbe249d365ec8682f80a9cfef62bb4c15b4220d73";
// LiquidAdded(address indexed from, uint256 liquidToDrop, uint256 liquidBurned)
const LIQUID_ADDED = "0x9832ef78d92c6df98e014c0c90b9df6aae54ee1f295da7a07586242f3c93b7d2";
// Distributed(address indexed token, uint256 amount, uint256 khypeToReserve, uint256 liquidBought). Four values, so
// its topic is not the fee splitter's Distributed (three values, TOPIC.Distributed).
const YIELD_PAID = "0xf334dc3327c53a5f7fd39f983cbad4306ff127f0ecdadf23c6f361eca5358c32";

export async function loadHistory({ cfg, e }, market) {
  // The full design's contracts when they exist, otherwise the reserve that is live now.
  const P = cfg.elysium.prelaunch ?? {}, F = cfg.elysium.contracts;
  const C = { ...F, reserve: F.reserve || P.reserve, bridgeOut: F.bridgeOut || P.bridgeOut, feeRouter: F.feeRouter || P.feeSplitter };
  const T = cfg.tokens;
  const lr = T["$liquid"]?.address, sink = cfg.elysium.burnSink;
  const from = "0x" + (cfg.elysium.deployBlock || cfg.elysium.historyFromBlock || 0).toString(16);
  // Every pool $liquid trades in: Ascend's, and the vaults' own pools.
  const pools = [];
  if (cfg.pools.liquidHype) pools.push({ id: cfg.pools.liquidHype.toLowerCase(), liquid0: !!cfg.pools.liquidReserveIsCurrency0, venue: "Ascend" });
  for (const v of cfg.vaults ?? []) if (v.token1 === "$liquid" && v.pool) pools.push({ id: v.pool.toLowerCase(), liquid0: false, venue: `${v.name} ${v.feeTier} pool` });
  const q = (address, topics) => (has(address) ? e.request("eth_getLogs", [{ address, topics, fromBlock: from, toBlock: "latest" }]) : Promise.resolve([]));

  // Fewer, fuller requests (the RPC allows only a handful a second): the reserve's own events come in one
  // request and are split by contract below, and the two token reads share one multicall.
  const own = [C.reserve, C.bridgeOut, C.feeRouter].filter(has);
  // Ascend's fee contract for $liquid (its "seat") rides in the same request: each harvest records what it received.
  // So do the drop feeder and the yield director: what was bought for the drop, and each payout of the reserve's yield.
  const seat = cfg.elysium.ascend?.seat, feeder = cfg.elysium.drop?.feeder, director = cfg.elysium.flywheel?.yieldDirector;
  const watched = [...own, seat, feeder, director].filter(has);
  const [burns, events, routed, reads, swaps] = await Promise.all([
    has(lr) && has(sink) ? q(lr, [TRANSFER, null, t32(sink)]) : [],
    watched.length ? e.request("eth_getLogs", [{ address: watched, topics: [[TOPIC.Deposited, TOPIC.Bridged, TOPIC.Distributed, SEAT_HARVEST, FED, LIQUID_ADDED, YIELD_PAID]], fromBlock: from, toBlock: "latest" }]) : [],
    q(C.yieldRouter, [TOPIC.Routed]),
    has(lr) ? e.multicall([{ to: lr, data: TOTAL_SUPPLY }, ...(has(sink) ? [{ to: lr, data: encode(SEL.balanceOf, addr(sink)) }] : [])]) : [],
    pools.length && cfg.elysium.poolManager ? q(cfg.elysium.poolManager, [SWAP, pools.map((x) => x.id)]) : [],
  ]);
  const from1 = (address, topic) => (has(address) ? events.filter((l) => l.address.toLowerCase() === address.toLowerCase() && l.topics[0] === topic) : []);
  const deposits = from1(C.reserve, TOPIC.Deposited), bridged = from1(C.bridgeOut, TOPIC.Bridged), dist = from1(C.feeRouter, TOPIC.Distributed);
  const fed = from1(feeder, FED), added = from1(feeder, LIQUID_ADDED), paid = from1(director, YIELD_PAID);
  const supplyHex = reads[0] ?? "0x0", sinkHex = reads[1] ?? "0x0";
  const ts = await stamper(e, [...burns, ...deposits, ...bridged, ...routed, ...dist, ...swaps, ...fed, ...added, ...paid]);
  const sym = {};
  for (const [s, t] of Object.entries(T)) if (t.address) sym[t.address.toLowerCase()] = s;
  const amt = (l, i = 0) => units(toUint(words(l.data)[i]));

  // What Ascend's seat has received from $liquid's trading fees so far, and the shares it sets aside.
  let ascend = null;
  if (has(seat)) {
    const pair = cfg.elysium.ascend.pair ?? "HYPE", dec = T[pair]?.decimals ?? 18;
    const harvests = from1(seat, SEAT_HARVEST);
    const received = harvests.reduce((a, l) => a + units(toUint(words(l.data)[0]), dec), 0);
    ascend = { pair, received, buyback: received * SEAT_SHARE.buyback, holders: received * SEAT_SHARE.holders, harvests: harvests.length };
  }

  // every purchase of $liquid, by where the tokens ended up.
  // A burn made inside a yield-waterfall transaction came from reserve yield;
  // any other burn came from trading fees (Ascend's buyback).
  const yieldTxs = new Set(routed.map((l) => l.transactionHash));
  // A burn by the drop feeder (the drop was full) is one of those same transfers to the burn address: it is
  // labelled here and never counted a second time. The feeder burns in two cases. For the yield director, whose
  // LiquidAdded event names the director as the sender and gives the amount burned: that came from the drop's
  // share of the reserve's yield. Otherwise from a fee.
  const sentBy = (a) => (l) => has(a) && topicAddr(l.topics[1]).toLowerCase() === a.toLowerCase();
  const byFeeder = sentBy(feeder), byDirector = sentBy(director);
  const yieldBurns = new Set(added.filter(byDirector).map((l) => `${l.transactionHash}:${toUint(words(l.data)[1])}`));
  const burnKind = (l) => {
    if (byFeeder(l)) return yieldBurns.has(`${l.transactionHash}:${toUint(words(l.data)[0])}`) ? "burnDropYield" : "burnDrop";
    return yieldTxs.has(l.transactionHash) ? "burnYield" : "burnFees";
  };
  const buys = [];
  for (const l of burns) buys.push({ t: ts(l), kind: burnKind(l), amount: amt(l), tx: l.transactionHash });
  // Bought for the drop: with a fee (Fed), or with the drop's share of the yield (LiquidAdded from the director).
  // $liquid that anyone else hands to the feeder was not bought, so it is not listed.
  for (const l of fed) if (amt(l, 2) > 0) buys.push({ t: ts(l), kind: "drop", amount: amt(l, 2), tx: l.transactionHash });
  for (const l of added) if (byDirector(l) && amt(l, 0) > 0) buys.push({ t: ts(l), kind: "dropYield", amount: amt(l, 0), tx: l.transactionHash });
  // Each payout by the yield director. What it bought and did not hand to the feeder went to the reward pools
  // (or to an address the timelock listed).
  const payouts = [], rest = new Map();
  for (const l of paid) {
    const w = words(l.data), s = sym[topicAddr(l.topics[1]).toLowerCase()], tx = l.transactionHash;
    payouts.push({ t: ts(l), sym: s, amount: units(toUint(w[0]), T[s]?.decimals ?? 18), khype: units(toUint(w[1])), liquid: units(toUint(w[2])), tx });
    const x = rest.get(tx) ?? { t: ts(l), left: 0n };
    x.left += toUint(w[2]);
    rest.set(tx, x);
  }
  for (const l of added) if (byDirector(l) && rest.has(l.transactionHash)) rest.get(l.transactionHash).left -= toUint(words(l.data)[0]) + toUint(words(l.data)[1]);
  for (const [tx, x] of rest) if (x.left > 0n) buys.push({ t: x.t, kind: "rewards", amount: units(x.left), tx });
  const principal = [];
  for (const l of deposits) {
    const s = sym[topicAddr(l.topics[1]).toLowerCase()];
    if (s === "$liquid") buys.push({ t: ts(l), kind: "reserve", amount: amt(l, 0), tx: l.transactionHash });
    if (s) principal.push({ t: ts(l), sym: s, amount: amt(l, 1), tx: l.transactionHash });
  }
  for (const l of routed) {
    const holders = amt(l, 6);
    if (holders > 0) buys.push({ t: ts(l), kind: "stakers", amount: holders, tx: l.transactionHash });
  }
  for (const l of bridged) principal.push({ t: ts(l), sym: "sKNTQ", amount: amt(l, 0), tx: l.transactionHash });
  buys.sort((a, b) => a.t - b.t);
  principal.sort((a, b) => a.t - b.t);

  const fees = dist.map((l) => {
    const w = words(l.data), s = sym[topicAddr(l.topics[1]).toLowerCase()];
    const px = market.usd[s] ?? 0, d = T[s]?.decimals ?? 18;
    return { t: ts(l), creatorUsd: units(toUint(w[0]), d) * px, reserveUsd: units(toUint(w[1]), d) * px };
  });
  // Every buy and sell: the pool's amounts are from the trader's side (positive = received).
  const trades = swaps.map((l) => {
    const pool = pools.find((x) => x.id === l.topics[1].toLowerCase()), w = l.data.slice(2).match(/.{64}/g);
    const a0 = int128(w[0]), a1 = int128(w[1]), liq = pool.liquid0 ? a0 : a1, hype = pool.liquid0 ? a1 : a0;
    const abs = (v) => (v < 0n ? -v : v);
    return { t: ts(l), side: liq > 0n ? "buy" : "sell", liquid: Number(abs(liq)) / 1e18, hype: Number(abs(hype)) / 1e18, venue: pool.venue, tx: l.transactionHash };
  }).sort((a, b) => a.t - b.t);
  const splits = dist.map((l) => {
    const w = words(l.data), s = sym[topicAddr(l.topics[1]).toLowerCase()], dd = T[s]?.decimals ?? 18;
    return { t: ts(l), sym: s === "HYPE" ? "HYPE" : s, toCreator: units(toUint(w[0]), dd), toReserve: units(toUint(w[1]), dd), tx: l.transactionHash };
  });
  return {
    buys,
    principal,
    fees,
    trades,
    splits,
    payouts: payouts.sort((a, b) => a.t - b.t),
    // Routed data: amountIn, then creator, burn, compound, ecosystemKntq, ecosystemHype, holders, lpBonus, liquidity
    kntqBurns: routed.map((l) => ({ t: ts(l), amount: amt(l, 4), tx: l.transactionHash })).filter((x) => x.amount > 0),
    hypeBurns: routed.map((l) => ({ t: ts(l), amount: amt(l, 5), tx: l.transactionHash })).filter((x) => x.amount > 0),
    supply: units(toUint(words(supplyHex)[0])),
    burned: units(toUint(words(sinkHex)[0])),
    ascend,
  };
}

// ---- bucketing ----
const DAY = 86400;
export const dayOf = (t) => Math.floor(t / DAY);
export const dayLabel = (d) => new Date(d * DAY * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** Days covered by a range ending "now". range: number of days, or 0 for everything since `first`. */
export function daysFor(range, now, first) {
  const end = dayOf(now);
  const start = range ? end - range + 1 : Math.min(end - 6, dayOf(first ?? now));
  const out = [];
  for (let d = start; d <= end; d++) out.push(d);
  return out;
}

/** Sums `amount` per day for the rows matching `pick`. */
export function perDay(rows, days, pick = () => true) {
  const idx = new Map(days.map((d, i) => [d, i]));
  const out = days.map(() => 0);
  for (const r of rows) {
    const i = idx.get(dayOf(r.t));
    if (i !== undefined && pick(r)) out[i] += r.amount;
  }
  return out;
}

/** Running total per day, including everything before the first day shown. */
export function cumulative(rows, days, pick = () => true) {
  let acc = rows.filter((r) => pick(r) && dayOf(r.t) < days[0]).reduce((s, r) => s + r.amount, 0);
  const daily = perDay(rows, days, pick);
  return daily.map((v) => (acc += v));
}
