// Reads everything the dashboard shows, straight from Elysium and HyperEVM.
import { Rpc } from "./rpc.js";
import { SEL, TOPIC, IMPL_SLOT, encode, addr, uint, b32, words, toUint, toAddr, topicAddr } from "./abi.js";
import { units } from "./format.js";

const ZERO = /^0x0{40}$/i;
const has = (a) => !!a && !ZERO.test(a);

export function connect(cfg) {
  return { cfg, e: new Rpc(cfg.elysium.rpc, "Elysium", { multicall: cfg.elysium.multicall }), h: new Rpc(cfg.hyperevm.rpc, "HyperEVM") };
}

export const isLaunched = (cfg) => has(cfg.elysium.contracts.reserve);
/** The $liquid coin exists on Ascend (the reserve's later parts may not be built yet). */
export const coinLive = (cfg) => has(cfg.tokens?.["$liquid"]?.address);

// ---------------------------------------------------------------- prices

/** Price of currency1 in currency0 units from a v4 pool's sqrtPriceX96 (getSlot0 return data). */
function slot0Price(ret, dec0, dec1) {
  if (!ret || ret.length < 66) return NaN;
  const sqrt = Number(toUint(words(ret)[0])) / 2 ** 96;
  return sqrt * sqrt * 10 ** (dec0 - dec1); // currency1 per currency0
}

/**
 * Prices from an outside market, for tokens the site prices from a vault's own pool (wANTx, wNVDAx): the middle of
 * Hyperliquid's order book. Used to check a vault's pool against the market; never fatal (an empty object when it cannot be read).
 *
 * The same book is read two ways at once, because a first deposit into the wANTx-USDC vault cannot be made without
 * this price and one blocked address (an extension, a network, a rate limit) must not be enough to stop it:
 *   from Hyperliquid's API, and
 *   from HyperEVM itself, where a precompile reports the best bid and ask of a spot pair (the connection the site
 *   already uses for everything else on HyperEVM).
 */
const HYPERCORE_BBO = "0x000000000000000000000000000000000000080e";
async function outsidePrices(cfg, h) {
  const hl = cfg.hyperliquid, out = {};
  if (!hl?.coins) return out;
  // a book too wide to take a price from is left out
  const mid = (bid, ask) => (bid > 0 && ask >= bid && (ask - bid) / bid < 0.05 ? (bid + ask) / 2 : null);
  const fromApi = async (coin) => {
    if (!hl.api) return null;
    const stop = new AbortController(), timer = setTimeout(() => stop.abort(), 6000);
    try {
      const r = await (await fetch(hl.api, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "l2Book", coin }), signal: stop.signal })).json();
      return mid(Number(r.levels[0][0].px), Number(r.levels[1][0].px));
    } finally { clearTimeout(timer); }
  };
  const fromChain = async (spot) => {
    if (!spot || !h) return null;
    // asset id of a spot pair: 10000 + its index. Prices come back as whole numbers scaled by 10^(8 - szDecimals).
    const w = words(await h.call(HYPERCORE_BBO, encode("0x", uint(BigInt(10000 + spot.index))))), scale = 10 ** (8 - spot.szDecimals);
    return mid(Number(toUint(w[0])) / scale, Number(toUint(w[1])) / scale);
  };
  await Promise.all(Object.entries(hl.coins).map(async ([sym, coin]) => {
    const [api, chain] = await Promise.all([fromApi(coin).catch(() => null), fromChain(hl.spot?.[sym]).catch(() => null)]);
    const px = api ?? chain;
    if (px) out[sym] = px;
  }));
  return out;
}

export async function loadMarket({ cfg, e, h }) {
  const P = cfg.pools;
  const pools = [[P.hypeUsdc, 18, 6], [P.hypeKntq, 18, 18], [P.khypeHype, 18, 18], [P.liquidHype || P.liquidReserveKntq, 18, 18], [P.wantxUsdc, 6, 18], [P.wnvdaxUsdc, 18, 6]];
  const asked = pools.filter(([id]) => id);
  const [rets, skntqRate, ref] = await Promise.all([
    e.multicall(asked.map(([id]) => ({ to: P.stateView, data: encode(SEL.getSlot0, b32(id)) }))), // one request for every pool
    h.call(cfg.hyperevm.skntq, encode(SEL.convertToAssets, uint(10n ** 18n))).then((r) => units(toUint(words(r)[0]))),
    outsidePrices(cfg, h),
  ]);
  const [usdcPerHype, kntqPerHype, hypePerKhype, lrPool, wantxPerUsdc, usdcPerWnvdax] = pools.map(([id, d0, d1]) => (id ? slot0Price(rets[asked.findIndex((x) => x[0] === id)], d0, d1) : NaN));
  const hype = usdcPerHype;
  const kntq = hype / kntqPerHype;
  // the $liquid pool quotes its pair asset per $liquid (or the inverse, by currency order); the pair is HYPE or KNTQ
  const lrInKntq = P.liquidReserveIsCurrency0 ? lrPool : 1 / lrPool;
  const lrPairUsd = P.liquidHype ? hype : kntq;
  return {
    usd: {
      HYPE: hype,
      KNTQ: kntq,
      kHYPE: hype * hypePerKhype,
      USDC: 1,
      "$liquid": isFinite(lrInKntq) ? lrInKntq * lrPairUsd : NaN,
      sKNTQ: kntq * skntqRate,
      // wANTx trades on Elysium only in the vault's own pool (USDC first there); until that pool exists, the outside price
      wANTx: wantxPerUsdc > 0 && isFinite(wantxPerUsdc) ? 1 / wantxPerUsdc : ref.wANTx ?? NaN,
      // wNVDAx is priced from the NVDAx-USDC vault's own pool too (wNVDAx first there, so the pool quotes dollars
      // directly). It has other pools on Elysium, but they are not read here; until the vault's pool exists, the outside price
      wNVDAx: usdcPerWnvdax > 0 && isFinite(usdcPerWnvdax) ? usdcPerWnvdax : ref.wNVDAx ?? NaN,
    },
    ref,
    hypePerKhype,
    skntqRate,
  };
}

// ---------------------------------------------------------------- reserves

async function readReserve(rpc, reserve) {
  const count = Number(toUint(words(await rpc.call(reserve, SEL.assetCount))[0]));
  const assets = [];
  for (let i = 0; i < count; i++) {
    const a = toAddr(words(await rpc.call(reserve, encode(SEL.assetAt, uint(i))))[0]);
    const [p, v, y] = await Promise.all(
      [SEL.principal, SEL.valueOf, SEL.pendingYield].map((s) => rpc.call(reserve, encode(s, addr(a)))),
    );
    const n = (r) => units(toUint(words(r)[0]));
    assets.push({ address: a, principal: n(p), value: n(v), pending: n(y) });
  }
  return assets;
}

/** Live proof that a reserve can't be withdrawn from. */
async function proveLocked(rpc, reserve) {
  const [noOwner, impl, router] = await Promise.all([
    rpc.reverts(reserve, SEL.owner),
    rpc.request("eth_getStorageAt", [reserve, IMPL_SLOT, "latest"]),
    rpc.call(reserve, SEL.yieldRouter),
  ]);
  return { noOwner, notProxy: BigInt(impl) === 0n, onlyOutflow: toAddr(words(router)[0]) };
}

export async function loadReserves({ cfg, e, h }, market) {
  const sym = symbolMap(cfg);
  const out = { elysium: null, hyperevm: null, totalUsd: 0, principalUsd: 0, pendingUsd: 0, parts: [] };
  const underlyingUsd = (symbol) =>
    symbol === "kHYPE" ? market.usd.HYPE : symbol === "sKNTQ" ? market.usd.KNTQ : market.usd[symbol];

  if (has(cfg.elysium.contracts.reserve)) {
    const r = cfg.elysium.contracts.reserve;
    const [assets, proof] = await Promise.all([readReserve(e, r), proveLocked(e, r)]);
    out.elysium = { address: r, proof, assets: assets.map((a) => ({ ...a, symbol: sym[a.address.toLowerCase()] ?? "?" })) };
  }
  if (has(cfg.hyperevm.contracts.reserve)) {
    const r = cfg.hyperevm.contracts.reserve;
    const [assets, proof] = await Promise.all([readReserve(h, r), proveLocked(h, r)]);
    out.hyperevm = { address: r, proof, assets: assets.map((a) => ({ ...a, symbol: "sKNTQ" })) };
  }
  for (const side of [out.elysium, out.hyperevm]) {
    if (!side) continue;
    for (const a of side.assets) {
      const px = underlyingUsd(a.symbol);
      a.usd = a.value * px;
      a.principalUsd = a.principal * px;
      a.pendingUsd = a.pending * px;
      out.totalUsd += a.usd || 0;
      out.principalUsd += a.principalUsd || 0;
      out.pendingUsd += a.pendingUsd || 0;
      out.parts.push({ symbol: a.symbol, usd: a.usd || 0 });
    }
  }
  return out;
}

// ---------------------------------------------------------------- flywheel history (Elysium events)

function symbolMap(cfg) {
  const m = {};
  for (const [s, t] of Object.entries(cfg.tokens)) if (t.address) m[t.address.toLowerCase()] = s;
  return m;
}

async function logs(rpc, address, topic, fromBlock) {
  if (!has(address)) return [];
  return rpc.request("eth_getLogs", [{ address, topics: [topic], fromBlock: "0x" + fromBlock.toString(16), toBlock: "latest" }]);
}

export async function loadFlywheel({ cfg, e }, market) {
  const C = cfg.elysium.contracts;
  const from = cfg.elysium.deployBlock || 0;
  const sym = symbolMap(cfg);
  const dec = (s) => cfg.tokens[s]?.decimals ?? 18;
  const usdOf = (token, raw) => {
    const s = sym[token.toLowerCase()];
    return s ? units(raw, dec(s)) * (market.usd[s] ?? NaN) : 0;
  };
  const [dist, routed, paid, harvested, bridged, allocated] = await Promise.all([
    logs(e, C.feeRouter, TOPIC.Distributed, from),
    logs(e, C.yieldRouter, TOPIC.Routed, from),
    logs(e, C.creatorPayout, TOPIC.PaidOut, from),
    logs(e, C.reserve, TOPIC.Harvested, from),
    logs(e, C.bridgeOut, TOPIC.Bridged, from),
    logs(e, C.allocator, TOPIC.Allocated, from),
  ]);

  const t = { feesUsd: 0, toReserveUsd: 0, creatorUsd: 0, burnedLr: 0, burnedKntq: 0, burnedHype: 0, stakersLr: 0, compoundedUsd: 0, harvestedUsd: 0, bridgedKntq: 0 };
  for (const l of dist) {
    const w = words(l.data), token = topicAddr(l.topics[1]);
    t.feesUsd += usdOf(token, toUint(w[0]) + toUint(w[1]));
    t.toReserveUsd += usdOf(token, toUint(w[1]));
  }
  for (const l of routed) {
    // amountIn, then Split{creator, burnLiquidReserve, compound, ecosystemKntq, ecosystemHype, holders, lpBonus, liquidity}
    const w = words(l.data), token = topicAddr(l.topics[1]);
    t.burnedLr += units(toUint(w[2]));
    t.compoundedUsd += usdOf(token, toUint(w[3]));
    t.burnedKntq += units(toUint(w[4]));
    t.burnedHype += units(toUint(w[5]));
    t.stakersLr += units(toUint(w[6]));
  }
  for (const l of paid) {
    // amountIn, usdcOut, hypeOut, kntqOut, liquidReserveOut
    const w = words(l.data);
    t.creatorUsd += units(toUint(w[1]), 6) + units(toUint(w[2])) * market.usd.HYPE + units(toUint(w[3])) * market.usd.KNTQ + units(toUint(w[4])) * (market.usd["$liquid"] || 0);
  }
  for (const l of harvested) {
    const w = words(l.data), asset = topicAddr(l.topics[1]);
    const s = sym[asset.toLowerCase()];
    const px = s === "kHYPE" ? market.usd.HYPE : market.usd[s] ?? 0;
    t.harvestedUsd += units(toUint(w[1])) * px;
  }
  for (const l of bridged) t.bridgedKntq += units(toUint(words(l.data)[0]));

  const label = { [C.feeRouter?.toLowerCase()]: "Fees split", [C.yieldRouter?.toLowerCase()]: "Yield routed", [C.creatorPayout?.toLowerCase()]: "Creator paid", [C.reserve?.toLowerCase()]: "Yield harvested", [C.bridgeOut?.toLowerCase()]: "KNTQ bridged to HyperEVM", [C.allocator?.toLowerCase()]: "Locked in reserve" };
  const activity = [...dist, ...routed, ...paid, ...harvested, ...bridged, ...allocated]
    .map((l) => ({ what: label[l.address.toLowerCase()] ?? "Event", tx: l.transactionHash, block: parseInt(l.blockNumber, 16), token: sym[topicAddr(l.topics[1] ?? "0x").toLowerCase()] }))
    .sort((a, b) => b.block - a.block)
    .slice(0, 12);
  const blocks = await Promise.all(activity.map((a) => e.request("eth_getBlockByNumber", ["0x" + a.block.toString(16), false])));
  activity.forEach((a, i) => (a.time = parseInt(blocks[i]?.timestamp ?? "0x0", 16)));
  return { totals: t, activity };
}

// ---------------------------------------------------------------- transit, staking, oracle

const bal = async (rpc, token, holder) =>
  has(token) && has(holder) ? units(toUint(words(await rpc.call(token, encode(SEL.balanceOf, addr(holder))))[0])) : 0;

export async function loadTransit({ cfg, e, h }, reserves, flywheel) {
  const C = cfg.elysium.contracts, H = cfg.hyperevm.contracts, K = cfg.tokens.KNTQ.address;
  const [waitingToBridge, arrivedNotStaked, yieldUnstaking, yieldBridging] = await Promise.all([
    bal(e, K, C.bridgeOut),
    bal(h, cfg.hyperevm.kntq, H.stakeAndLock),
    bal(h, cfg.hyperevm.skntq, H.yieldUnstakeBridge),
    bal(h, cfg.hyperevm.kntq, H.yieldUnstakeBridge),
  ]);
  const lockedKntq = reserves.hyperevm?.assets[0]?.principal ?? 0;
  const crossing = Math.max(0, flywheel.totals.bridgedKntq - lockedKntq - arrivedNotStaked);
  return { waitingToBridge, crossing, arrivedNotStaked, yieldUnstaking, yieldBridging };
}

export async function loadStaking({ cfg, e }) {
  const s = cfg.elysium.contracts.staking;
  if (!has(s)) return null;
  const [total, rate, finish] = await Promise.all([SEL.totalStaked, SEL.rewardRate, SEL.periodFinish].map((x) => e.call(s, x).then((r) => toUint(words(r)[0]))));
  const now = Math.floor(Date.now() / 1000);
  const streaming = Number(finish) > now;
  const apr = streaming && total > 0n ? (Number(rate) * 31_536_000) / Number(total) : 0;
  return { total: units(total), apr, streaming };
}

export async function loadOracle({ cfg, e }) {
  const o = cfg.elysium.contracts.oracle;
  if (!has(o)) return null;
  const ls = await logs(e, o, TOPIC.FeedAdded, cfg.elysium.deployBlock || 0);
  if (!ls.length) return { feeds: 0, lastPoke: null };
  const times = await Promise.all(ls.map((l) => e.call(o, encode(SEL.feeds, b32(l.topics[1]))).then((r) => Number(toUint(words(r)[2])))));
  return { feeds: ls.length, lastPoke: Math.min(...times) };
}

// Elysium's latest block, read through Multicall3 so it rides in the same request as the prices (its RPC allows
// only a few requests a second). Elysium is an Arbitrum chain: its own block number comes from the ArbSys contract.
const ARBSYS = "0x0000000000000000000000000000000000000064", ARB_BLOCK_NUMBER = "0xa3b1b31d", MC_TIMESTAMP = "0x0f28c97d";
async function elysiumHead(e, mc) {
  if (mc) {
    const r = await e.multicall([{ to: ARBSYS, data: ARB_BLOCK_NUMBER }, { to: mc, data: MC_TIMESTAMP }]).catch(() => null);
    if (r?.[0]?.length >= 66 && r?.[1]?.length >= 66) return { number: Number(toUint(words(r[0])[0])), time: Number(toUint(words(r[1])[0])) };
  }
  const b = await e.request("eth_getBlockByNumber", ["latest", false]);
  return { number: parseInt(b.number, 16), time: parseInt(b.timestamp, 16) };
}

export async function chainHeads({ cfg, e, h }) {
  const [eb, hb] = await Promise.allSettled([
    elysiumHead(e, cfg?.elysium?.multicall),
    h.request("eth_getBlockByNumber", ["latest", false]),
  ]);
  return {
    elysium: eb.status === "fulfilled" ? eb.value : null,
    hyperevm: hb.status === "fulfilled" ? { number: parseInt(hb.value.number, 16), time: parseInt(hb.value.timestamp, 16) } : null,
  };
}
