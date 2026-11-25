// What happens to a fee and to the reserve's yield, counted and worded from what is in force on-chain.
//
// The reserve's allocator cannot be changed: of everything it receives, 40% buys kHYPE, 40% buys KNTQ and 20% is set
// aside as USDC. Since 25 November 2026 two contracts, set through the 48-hour timelock, change where those parts end:
// - the HYPE-only router (SwapConfig names it as the swapper): the KNTQ part becomes kHYPE, locked in the reserve;
// - the drop feeder (the set-aside contract points at it): half of the USDC becomes locked kHYPE, half buys $liquid
//   for the drop, or is burned once the drop is full.
// The reserve's yield: a fifth to the creator (a splitter that cannot be changed), the rest to the yield director,
// which divides it by shares the owner's wallet sets.
//
// All of it is read in drop.js's one request (S.drop.flow). Until the chain has answered, what deployment.json names
// is taken to be in force. The yield shares are never guessed: until they are read, the pages show the director's
// part undivided.
import { S as SER } from "./ui.js";

const ALLOC = { khype: 0.4, kntq: 0.4, aside: 0.2 }; // InflowAllocator
const DROP_HALF = 0.5; // DropFeeder.DROP_BPS
const CREATOR_YIELD = 0.2; // YieldSplit

/** 0.9 -> "90%", 0.225 -> "22.5%" */
export const share = (x) => `${Math.round(x * 1000) / 10}%`;
/** ["a", "b", "c"] -> "a, b and c" */
export const list = (a) => (a.length < 2 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`);

export function flow(S) {
  const cfg = S?.cfg, el = cfg?.elysium ?? {}, fw = el.flywheel ?? {}, d = S?.drop, live = d?.flow;
  const known = !!d; // the chain has answered
  const hypeOnly = live?.hypeOnly ?? !!(fw.swapConfig && fw.hypeOnlyRouter);
  const drop = known ? !!d.live : !!el.drop?.feeder;
  const yieldOn = live?.yieldOn ?? !!(fw.yieldDirector && el.creatorShare?.yieldRest);

  // ── a fee
  const khype = ALLOC.khype + (hypeOnly ? ALLOC.kntq : 0) + (drop ? ALLOC.aside * (1 - DROP_HALF) : 0);
  const kntq = hypeOnly ? 0 : ALLOC.kntq;
  const toDrop = drop ? ALLOC.aside * DROP_HALF : 0;
  const aside = drop ? 0 : ALLOC.aside;
  const split = [
    { key: "khype", name: "kHYPE (staked HYPE), locked", short: "kHYPE, locked", tag: "staked HYPE", sym: "kHYPE", where: "staked HYPE · locked on Elysium", share: khype, color: SER[0], does: "is swapped to kHYPE, Kinetiq's staked HYPE, and locked in the reserve" },
    { key: "kntq", name: "sKNTQ (staked KNTQ), locked", short: "sKNTQ, locked", tag: "staked KNTQ", sym: "sKNTQ", where: "staked KNTQ · locked on HyperEVM", share: kntq, color: SER[1], does: "buys KNTQ, which is bridged to HyperEVM, staked and locked there" },
    { key: "drop", name: "$liquid for the drop", short: "$liquid for the drop", tag: "the drop", sym: "$liquid", where: "the drop · the bot's wallet, not locked", share: toDrop, color: SER[2], does: "buys $liquid for the drop" },
    { key: "aside", name: "Set aside as USDC", short: "USDC, set aside", tag: "set aside", sym: "USDC", where: "waiting", share: aside, color: SER[3], does: "is set aside as USDC" },
  ].filter((p) => p.share > 0);

  // ── the reserve's yield, as shares of all of it
  const creator = el.creatorShare ? CREATOR_YIELD : 0, rest = 1 - creator;
  const pools = Object.values(el.rewardPools ?? {});
  const poolOf = (a) => pools.find((p) => p.pool?.toLowerCase() === String(a).toLowerCase());
  const shares = yieldOn && live?.shares ? live.shares.filter((x) => x.bps > 0) : null;
  const named = (x) => {
    if (x.kind === 0) return { key: "compound", name: "Compound into the reserve", goes: "compounds into the reserve", does: "stays kHYPE and is locked in the reserve again", color: SER[0] };
    if (x.kind === 1) return { key: "drop", name: "The drop", goes: "goes to the drop", does: "buys $liquid for the drop, or is burned once the drop is full", color: SER[2] };
    const p = x.kind === 2 ? poolOf(x.target) : null;
    if (p) return { key: "pool", name: `${p.symbol} reward pool`, goes: `goes to the ${p.symbol} reward pool`, does: `buys $liquid, paid over 7 days to people who deposited ${p.symbol} in its reward pool`, color: p.symbol === "liquidKNTQ" ? SER[1] : SER[3] };
    return x.kind === 2
      ? { key: "pool", name: "A reward pool", goes: "goes to a reward pool", does: "buys $liquid for a reward pool", color: SER[5] }
      : { key: "send", name: "Another address", goes: "goes to another address", does: "buys $liquid, sent to an address the timelock listed", color: SER[5] };
  };
  const directed = shares ? shares.map((x) => ({ ...named(x), of: x.bps / 10_000, share: (rest * x.bps) / 10_000 })) : null;
  const yieldParts = [
    ...(creator ? [{ key: "creator", name: "Creator's wallet", does: "paid through a splitter that cannot be changed", share: creator, color: SER[4] }] : []),
    ...(directed ?? [{ key: "rest", name: yieldOn ? "Yield director, by the owner's shares" : "Held until the yield split is in force", does: yieldOn ? "divided by the yield director, in shares the owner sets" : "held until the yield split is in force", share: rest, color: SER[0] }]),
  ];
  const sum = (key) => (directed ?? []).filter((p) => p.key === key).reduce((t, p) => t + p.share, 0);

  return {
    known, hypeOnly, drop, yieldOn, since: fw.since ?? "",
    split, khype, kntq, toDrop, aside,
    /** "90·10" */
    mix: split.map((p) => Math.round(p.share * 100)).join("·"),
    /** "90% is swapped to kHYPE, … and locked in the reserve; 10% buys $liquid for the drop" */
    splitText: split.map((p) => `${share(p.share)} ${p.does}`).join("; "),
    /** the usual case today: nine tenths locked as staked HYPE, one tenth for the drop */
    full: hypeOnly && drop,
    yieldParts, directed, creatorYield: creator,
    /** shares of all yield, for the models */
    y: { creator, compound: sum("compound"), drop: sum("drop"), pools: sum("pool"), send: sum("send"), undivided: directed ? 0 : rest },
    /** "25% compounds into the reserve, 25% goes to the drop, …" (shares of the director's part), or "" until read */
    sharesText: directed ? list(directed.map((p) => `${share(p.of)} ${p.goes}`)) : "",
    /** "compounding, the drop and staking rewards": what the director's part pays for today, or "" until read */
    yieldUses: directed ? list([...new Set(directed.map((p) => ({ compound: "compounding", drop: "the drop", pool: "staking rewards", send: "other listed addresses" })[p.key]))]) : "",
    /** the drop's line, as the feeder counts it */
    capShare: d?.capShare ?? 0.05, cap: d?.cap,
  };
}
