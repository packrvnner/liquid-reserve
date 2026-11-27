// Liquid-style figures for live positions: a glass vessel with liquid standing at a level, and a glass tube
// holding several liquids side by side. Drawn as SVG and HTML, styled in styles.css (".lqv", ".lqt").
// The surface moves; it is still for visitors who prefer reduced motion. Time is global, so drawing the same
// vessel again (the page redraws on every refresh) picks the wave up where it was instead of restarting it.
// Every figure a vessel shows is also written out beside it by the caller: the liquid is never the only place
// a number can be read.
import { esc } from "./ui.js";

const clamp = (x) => Math.max(0, Math.min(1, Number(x) || 0));
/** A negative animation delay that puts a loop of `period` seconds at the point the clock says it should be at. */
const phase = (period) => `-${((Date.now() / 1000) % period).toFixed(2)}s`;

// vessel geometry, in the SVG's own units
const W = 120, H = 176, X0 = 12, X1 = 108, TOP = 10, BOT = 166, RX = 24;
const INNER = { x: X0 + 3, y: TOP + 3, w: X1 - X0 - 6, h: BOT - TOP - 6 };
const yAt = (level) => INNER.y + INNER.h * (1 - clamp(level)); // 0 = the bottom, 1 = the brim

/** A wave as wide as two vessels, so that sliding it by one vessel's width loops without a seam. */
function wavePath(y, amp) {
  const p = INNER.w, q = p / 4;
  let d = `M${INNER.x - p},${y.toFixed(1)}`;
  for (let i = 0; i < 6; i++) d += ` q${q},${i % 2 ? amp : -amp} ${2 * q},0`;
  return `${d} V${BOT + 4} H${INNER.x - p} Z`;
}

/**
 * A glass vessel.
 * o.id      a short name, unique on the page (gradients and clips are named after it)
 * o.layers  the liquids from the bottom up: [{ level, from, to }] where `level` is where that liquid's surface
 *           stands (0..1 of the vessel, counted from the bottom, so each is at least the one below it) and
 *           from/to are the colours of its top and bottom
 * o.marks   lines on the glass: [{ at (0..1), strong }]
 * o.float   a line that floats across the vessel at a level, with a bead on it: { at } (used for "the short")
 * o.drip    true to let drops fall into it
 * o.label   what a screen reader is told the vessel shows
 */
export function vessel(o) {
  const id = `lqv-${o.id}`, layers = (o.layers ?? []).filter((l) => l.level > 0);
  const top = layers.length ? Math.max(...layers.map((l) => clamp(l.level))) : 0;
  const defs = layers.map((l, i) => `<linearGradient id="${id}-g${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:${l.from}"/><stop offset="1" style="stop-color:${l.to}"/></linearGradient>`).join("");
  // drawn from the top liquid down, so that each lower one covers the part of the one above that is below its own surface
  const liquids = layers.map((l, i) => ({ l, i })).sort((a, b) => b.l.level - a.l.level).map(({ l, i }) => {
    const y = yAt(l.level), isTop = clamp(l.level) === top;
    return `<g class="wave b" style="animation-delay:${phase(11)}"><path d="${wavePath(y - 1.5, 2.2)}" fill="url(#${id}-g${i})" opacity="${isTop ? 0.4 : 0}"/></g>
      <g class="wave" style="animation-delay:${phase(7)}"><path d="${wavePath(y, 2.8)}" fill="url(#${id}-g${i})" opacity="0.94"/></g>`;
  }).join("");
  const marks = (o.marks ?? []).map((m) => {
    const y = yAt(m.at).toFixed(1), len = m.strong ? 22 : 12;
    return `<line class="mark${m.strong ? " strong" : ""}" x1="${X1 - 3 - len}" x2="${X1 - 3}" y1="${y}" y2="${y}"/>`;
  }).join("");
  const float = o.float ? (() => {
    const y = yAt(o.float.at).toFixed(1);
    return `<g class="float"><line x1="${X0 - 6}" x2="${X1 + 6}" y1="${y}" y2="${y}"/><circle cx="${X0 - 6}" cy="${y}" r="3.2"/><circle cx="${X1 + 6}" cy="${y}" r="3.2"/></g>`;
  })() : "";
  const fall = Math.max(8, yAt(top) - TOP - 6);
  const drip = o.drip ? `<g class="drip" style="--lqv-fall:${fall.toFixed(0)}px;animation-delay:${phase(3.6)}"><path d="M60,${TOP + 2} c2.6,3.8 4.2,5.8 4.2,8 a4.2,4.2 0 0 1 -8.4,0 c0,-2.2 1.6,-4.2 4.2,-8 Z"/></g>` : "";
  return `<span class="lqv" role="img" aria-label="${esc(o.label ?? "")}"><svg viewBox="0 0 ${W} ${H}" aria-hidden="true">
    <defs>${defs}
      <clipPath id="${id}-c"><rect x="${INNER.x}" y="${INNER.y}" width="${INNER.w}" height="${INNER.h}" rx="${RX - 3}"/></clipPath>
      <linearGradient id="${id}-r" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:var(--mark-a)"/><stop offset="0.45" style="stop-color:var(--mark-b)"/><stop offset="1" style="stop-color:var(--mark-c)"/></linearGradient>
    </defs>
    <rect class="glass" x="${X0}" y="${TOP}" width="${X1 - X0}" height="${BOT - TOP}" rx="${RX}"/>
    <g clip-path="url(#${id}-c)">${liquids}${drip}</g>
    ${marks}
    <rect class="rim" x="${X0}" y="${TOP}" width="${X1 - X0}" height="${BOT - TOP}" rx="${RX}" stroke="url(#${id}-r)"/>
    <path class="glint" d="M${X0 + 9},${TOP + 30} V${BOT - 46}"/>
    ${float}
  </svg></span>`;
}

/**
 * A glass tube lying on its side, holding several liquids next to each other.
 * parts: [{ name, value, color }]; a part is labelled inside the tube when it is wide enough to hold the label.
 */
export function tube(parts, label = "") {
  const total = parts.reduce((s, p) => s + (p.value > 0 ? p.value : 0), 0);
  if (!(total > 0)) return "";
  const segs = parts.filter((p) => p.value > 0).map((p) => {
    const share = p.value / total;
    return `<i style="flex:${(share * 1000).toFixed(2)} 1 0;--c:${p.color}" title="${esc(p.name)} · ${(share * 100).toFixed(1)}%">${share >= 0.11 ? `<span>${Math.round(share * 100)}%</span>` : ""}</i>`;
  }).join("");
  const aria = label || parts.filter((p) => p.value > 0).map((p) => `${p.name} ${Math.round((p.value / total) * 100)}%`).join(", ");
  return `<div class="lqt" role="img" aria-label="${esc(aria)}"><div class="in">${segs}</div><b class="sheen" style="animation-delay:${phase(9)}"></b></div>`;
}
