// The drop: a wallet the protocol's bot runs, which collects $liquid bought with a tenth of every fee until it
// holds 5% of the $liquid that has not been burned; after that every such purchase is burned instead. The home
// page's vessel shows its level once it is live. Everything here is read from the chain: the token's supply, what
// sits at Ascend's burn address, what the drop's wallet holds, and what the feeder contract says it has sent.
//
// The same request also reads what else of the flywheel is in force (deployment.json -> elysium.flywheel): which
// swapper the reserve's allocator is told to use, where the reserve's yield is pointed, and the yield director's
// shares. flow.js words the pages from that.
import { SEL, encode, addr, words, toUint } from "./abi.js";
import { units, amount, pct } from "./format.js";
import { esc } from "./ui.js";

// totalSupply(), feeder sentToDrop(), burned() and cap(), waiting contract target(), SwapConfig swapper(),
// yield director destinations()
const SIG = { totalSupply: "0x18160ddd", sentToDrop: "0x5dd89ae1", burned: "0x73f42561", cap: "0x355274ea", target: "0xd4b83992", swapper: "0x2b3297f9", destinations: "0x8d17b383" };
/** The drop is full when it holds this share of the unburned supply (the feeder's own figure is used once read). */
export const CAP_SHARE = 0.05;

const sameAddr = (ret, a) => !!ret && ret.length >= 66 && !!a && ("0x" + ret.slice(-40)).toLowerCase() === a.toLowerCase();

/** The yield director's list: [{ kind: 0 compound | 1 the drop | 2 a reward pool | 3 an address, target, bps }], or null. */
function destinations(ret) {
  if (!ret || ret.length < 130) return null;
  const w = words(ret), n = Number(toUint(w[1]));
  if (!(n >= 1 && n <= 16) || w.length < 2 + n * 3) return null;
  return Array.from({ length: n }, (_, i) => ({ kind: Number(toUint(w[2 + i * 3])), target: "0x" + w[3 + i * 3].slice(24), bps: Number(toUint(w[4 + i * 3])) }));
}

/** One request. Null when the site's config names no drop. `live` only once the reserve's set-aside share really points at the feeder. */
export async function loadDrop({ cfg, e }) {
  const d = cfg.elysium.drop, liquid = cfg.tokens["$liquid"]?.address, sink = cfg.elysium.burnSink;
  if (!d?.feeder || !d?.wallet || !liquid || !sink) return null;
  const wait = cfg.elysium.prelaunch?.liquidWait;
  const calls = [
    { to: liquid, data: SIG.totalSupply },
    { to: liquid, data: encode(SEL.balanceOf, addr(sink)) },
    { to: liquid, data: encode(SEL.balanceOf, addr(d.wallet)) },
    { to: d.feeder, data: SIG.sentToDrop },
    { to: d.feeder, data: SIG.burned },
  ];
  const ask = (c) => calls.push(c) - 1; // its place in the answers
  const waitAt = wait ? ask({ to: wait, data: SIG.target }) : -1;
  const capAt = ask({ to: d.feeder, data: SIG.cap });
  // the rest of the flywheel, in the same request
  const fw = cfg.elysium.flywheel ?? {}, rest = cfg.elysium.creatorShare?.yieldRest, khype = cfg.tokens.kHYPE?.address;
  const swapperAt = fw.swapConfig && fw.hypeOnlyRouter ? ask({ to: fw.swapConfig, data: SIG.swapper }) : -1;
  const director = fw.yieldDirector && rest ? fw.yieldDirector : null;
  const restAt = director ? ask({ to: rest, data: SIG.target }) : -1;
  const destAt = director ? ask({ to: director, data: SIG.destinations }) : -1;
  const waitingAt = director && khype ? [ask({ to: khype, data: encode(SEL.balanceOf, addr(rest)) }), ask({ to: khype, data: encode(SEL.balanceOf, addr(director)) })] : [];
  const res = await e.multicall(calls);
  const has = (i) => i >= 0 && !!res[i] && res[i].length >= 66;
  const num = (i) => (has(i) ? units(toUint(words(res[i])[0]), 18) : 0);
  if (!has(0) || !has(1) || !has(2)) throw new Error("could not read the drop");
  const supply = num(0), burnedAll = num(1);
  const exists = has(3); // the feeder is on-chain
  const held = Math.max(num(2), num(3)); // as the feeder counts it: the wallet's balance, never less than what it was sent
  const cap = has(capAt) ? num(capAt) : (supply - burnedAll) * CAP_SHARE;
  const live = exists && sameAddr(res[waitAt], d.feeder);
  // undefined = this deployment names no such part; true / false = what the chain says
  const flow = {
    hypeOnly: swapperAt < 0 ? undefined : sameAddr(res[swapperAt], fw.hypeOnlyRouter),
    yieldOn: restAt < 0 ? undefined : sameAddr(res[restAt], director),
    shares: destAt < 0 ? null : destinations(res[destAt]),
    yieldWaiting: waitingAt.reduce((t, i) => t + num(i), 0), // kHYPE past the creator's split, not yet divided
  };
  return {
    wallet: d.wallet, feeder: d.feeder, exists, live, held, cap, capShare: supply - burnedAll > 0 ? cap / (supply - burnedAll) : CAP_SHARE,
    level: cap > 0 ? Math.min(1, held / cap) : 0, burnedByDrop: num(4), burnedAll, flow,
  };
}

/** True once the drop is really running; until then the home page looks as it did. */
export const dropOn = (S) => !!S.drop?.live;

/** How full the vessel is drawn: the real level, with a sliver left visible so an almost empty drop still reads as one. */
export const vesselLevel = (S) => Math.max(0.035, Math.min(1, S.drop?.level ?? 0));

/** The bottom line of the home page's vessel while the drop is live. */
export function dropHud(S) {
  const d = S.drop, full = d.level >= 1;
  const share = d.level > 0 && d.level < 0.1 ? pct(d.level, 2) : pct(d.level, 1);
  return `<div><div class="label">The drop${full ? " · full, new buys burn" : ""}</div><div class="fig">${esc(share)}<small>full</small></div></div>
    <div class="chips"><span class="chip"><b>${esc(amount(d.held))}</b> of ${esc(amount(d.cap))} $liquid</span><span class="chip">burned <b>${esc(amount(d.burnedAll))}</b></span></div>`;
}
