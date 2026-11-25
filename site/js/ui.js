// Shared UI pieces: brand mark, icons, navigation model, small HTML helpers.
import { short } from "./format.js";

export const X_HANDLE = "xliquidreserve";
export const X_URL = `https://x.com/${X_HANDLE}`;

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** The Liquid Reserve mark: a droplet, with a small glint where the light catches it. */
export const DROP = "M32 5.85C41.35 19.45 49 29.65 49 39A17 17 0 0 1 15 39C15 29.65 22.65 19.45 32 5.85Z";
export const GLINT = "M21.6 40.2C22.1 44.9 25 48.6 29.2 50";
export const mark = (size = 34, id = "m") => `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true">
  <defs><linearGradient id="g-${id}" x1="12" y1="6" x2="52" y2="58" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="var(--mark-a)"/><stop offset=".5" stop-color="var(--mark-b)"/><stop offset="1" stop-color="var(--mark-c)"/></linearGradient></defs>
  <path fill="url(#g-${id})" d="${DROP}"/><path d="${GLINT}" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="2.6" stroke-linecap="round"/></svg>`;

const I = (d, extra = "") => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
export const icons = {
  home: I('<path d="M4 11.2 12 4.5l8 6.7"/><path d="M6.2 9.8V19.5h11.6V9.8"/><path d="M10 19.5v-5h4v5"/>'),
  reserve: I('<path d="M12 3.2c3.3 4.6 6 8 6 11.2a6 6 0 0 1-12 0c0-3.2 2.7-6.6 6-11.2Z"/><path d="M9.2 15.2c.9.8 1.7 1.1 2.8 1.1s1.9-.3 2.8-1.1"/>'),
  analytics: I('<path d="M4 19.5h16"/><path d="M7 16V11"/><path d="M12 16V6"/><path d="M17 16v-7"/>'),
  flywheel: I('<path d="M19.5 12a7.5 7.5 0 0 1-13 5.1"/><path d="M4.5 12a7.5 7.5 0 0 1 13-5.1"/><path d="M17.8 3.6v3.6h-3.6"/><path d="M6.2 20.4v-3.6h3.6"/>'),
  vaults: I('<path d="m12 3.5 8 4.2-8 4.2-8-4.2 8-4.2Z"/><path d="m4 12 8 4.2 8-4.2"/><path d="m4 16.3 8 4.2 8-4.2"/>'),
  stake: I('<ellipse cx="12" cy="6.8" rx="6.6" ry="2.7"/><path d="M5.4 6.8v5.1c0 1.5 3 2.7 6.6 2.7s6.6-1.2 6.6-2.7V6.8"/><path d="M5.4 11.9V17c0 1.5 3 2.7 6.6 2.7s6.6-1.2 6.6-2.7v-5.1"/>'),
  docs: I('<path d="M5 4.5h9.5a2 2 0 0 1 2 2v13H7a2 2 0 0 1-2-2v-13Z"/><path d="M16.5 8H19v11.5"/><path d="M8.5 9h4.5M8.5 12.5h4.5"/>'),
  x: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.2L2 3h6.33l4.37 5.78L17.75 3Zm-1.08 16.17h1.7L7.4 4.74H5.58l11.09 14.43Z"/></svg>`,
  sun: I('<circle cx="12" cy="12" r="3.6"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/>'),
  moon: I('<path d="M19.5 14.2A7.8 7.8 0 0 1 9.8 4.5a7.8 7.8 0 1 0 9.7 9.7Z"/>'),
  arrow: I('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  ext: I('<path d="M9 5h10v10"/><path d="M19 5 6 18"/>'),
  lock: I('<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>'),
  flame: I('<path d="M12 3.5c.6 3 3.9 4.6 3.9 8.6A4.6 4.6 0 0 1 12 20a4.6 4.6 0 0 1-3.9-7.3c.6 1 1.3 1.5 2 1.6-.4-3.2.6-7.2 1.9-10.8Z"/>'),
  check: I('<path d="m5 12.5 4.5 4.5L19 7.5"/>', 'stroke-width="2"'),
  dot: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor"/></svg>`,
};

export const NAV = [
  { route: "home", href: "#/", label: "Home", icon: "home" },
  { route: "reserve", href: "#/reserve", label: "Reserve", icon: "reserve" },
  { route: "analytics", href: "#/analytics", label: "Analytics", icon: "analytics" },
  { route: "flywheel", href: "#/flywheel", label: "Flywheel", icon: "flywheel" },
  { route: "vaults", href: "#/vaults", label: "Vaults", icon: "vaults" },
  { route: "stake", href: "#/stake", label: "Staking", icon: "stake" },
  { route: "docs", href: "#/docs", label: "Docs", icon: "docs" },
];

export function routeOf(hash = location.hash) {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const r = parts[0] || "home";
  return { name: r === "vault" ? "vaults" : r, raw: r, arg: parts[1] };
}

/** Explorer link. `cfg` is the deployment config. */
export const explorer = (cfg, chain, kind, v, text) =>
  `<a class="xl" href="${esc(cfg[chain].explorer)}/${kind}/${esc(v)}" target="_blank" rel="noopener">${esc(text ?? short(v))}</a>`;

export const sk = (w = "6ch") => `<span class="skeleton" style="width:${w}">.</span>`;
export const val = (x, f) => (x === undefined || x === null || (typeof x === "number" && isNaN(x)) ? sk() : f(x));

export const eyebrow = (t) => `<div class="eyebrow">${t}</div>`;

/** Stat tile: label · value · sub (optional sparkline html). */
/** Buy $liquid on the apps that list it (deployment.json "buy"). */
// Each place to buy shows its own logo (a file in site/logos/, because the site only loads images from itself).
// If a logo is missing or fails to load, the button simply shows its text.
export const buyLinks = (cfg, cls = "btn") => (cfg.buy ?? []).map((b) => `<a class="${cls}" href="${esc(b.url)}" target="_blank" rel="noopener">${b.logo ? `<img class="blogo" src="${esc(b.logo)}" alt="" />` : ""}${esc(b.label ?? `Buy on ${b.name}`)}</a>`).join("");
if (typeof document !== "undefined") document.addEventListener("error", (ev) => { if (ev.target?.matches?.("img.blogo")) ev.target.remove(); }, true);

export const tile = (label, value, sub = "", extra = "") =>
  `<div class="card tile"><div class="k">${label}</div><div class="v">${value}</div>${sub ? `<div class="s">${sub}</div>` : ""}${extra}</div>`;

/** Thin or tall segmented bar. parts: [{name, value, color}] */
export function segbar(parts, { tall = false, label = "" } = {}) {
  const total = parts.reduce((s, p) => s + (p.value || 0), 0);
  if (!total) return "";
  const segs = parts
    .filter((p) => p.value > 0)
    .map((p) => {
      const share = p.value / total;
      const text = tall && share >= 0.11 ? `<span>${Math.round(share * 100)}%</span>` : "";
      return `<i style="flex:${(share * 1000).toFixed(2)} 1 0;background:${p.color}" title="${esc(p.name)} · ${Math.round(share * 1000) / 10}%">${text}</i>`;
    })
    .join("");
  const aria = label || parts.map((p) => `${p.name} ${Math.round((p.value / total) * 100)}%`).join(", ");
  return `<div class="seg${tall ? " tall" : ""}" role="img" aria-label="${esc(aria)}">${segs}</div>`;
}

export const legend = (items) =>
  `<div class="legend">${items.map((i) => `<span><i style="background:${i.color}"></i>${esc(i.name)}${i.note ? ` <em>${esc(i.note)}</em>` : ""}</span>`).join("")}</div>`;

export const S = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)", "var(--s6)"];
