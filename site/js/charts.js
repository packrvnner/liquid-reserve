// Small SVG charts: stacked columns, stacked area / line, sparkline.
// Thin marks, hairline grid, one axis, a hover readout on every chart, and a
// table view so no value is tooltip-only. Labels reach the DOM via textContent.
import { esc } from "./ui.js";

const openTables = new Set();

function ticks(max, n = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / n, mag = 10 ** Math.floor(Math.log10(raw)), norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const out = [];
  for (let v = 0; v < max + step * 0.999; v += step) out.push(+v.toPrecision(12));
  return out;
}

// ---- tooltip ----
const tipEl = () => document.getElementById("tip");
export function showTip(x, y, title, rows) {
  const el = tipEl();
  el.replaceChildren();
  const tt = document.createElement("div");
  tt.className = "tt"; tt.textContent = title;
  el.append(tt);
  for (const r of rows) {
    const d = document.createElement("div"); d.className = "tr";
    const i = document.createElement("i"); i.style.background = r.color || "transparent";
    const s = document.createElement("span"); s.textContent = r.name;
    const b = document.createElement("b"); b.textContent = r.value;
    d.append(i, s, b); el.append(d);
  }
  el.hidden = false;
  const r = el.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(x + 16, innerWidth - r.width - 8)) + "px";
  el.style.top = Math.max(8, Math.min(y + 16, innerHeight - r.height - 8)) + "px";
}
export const hideTip = () => { const el = tipEl(); if (el) el.hidden = true; };

function frame(el, o, rightPad = 12) {
  const W = Math.max(280, el.clientWidth || 600), H = o.height || 250;
  const m = { l: 48, r: rightPad, t: 12, b: 26 };
  return { W, H, m, pw: W - m.l - m.r, ph: H - m.t - m.b };
}

function axes(f, tk, fmt, xLabels, xPos) {
  const { m, pw, ph } = f, ymax = tk.at(-1);
  const y = (v) => m.t + ph - (v / ymax) * ph;
  let s = "";
  for (const t of tk) {
    s += `<line x1="${m.l}" x2="${m.l + pw}" y1="${y(t)}" y2="${y(t)}" stroke="${t === 0 ? "var(--axis)" : "var(--grid)"}" stroke-width="1"/>`;
    s += `<text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${esc(fmt(t))}</text>`;
  }
  const maxLabels = Math.max(2, Math.floor(pw / 70)), step = Math.ceil(xLabels.length / maxLabels);
  xLabels.forEach((lab, i) => {
    if (i % step === 0 || (i === xLabels.length - 1 && (xLabels.length - 1) % step > step / 2)) s += `<text x="${xPos(i)}" y="${m.t + ph + 18}" text-anchor="middle">${esc(lab)}</text>`;
  });
  return { y, svg: s };
}

function tableView(id, o) {
  const head = `<tr><th>${esc(o.xTitle || "Date")}</th>${o.series.map((s) => `<th>${esc(s.name)}</th>`).join("")}</tr>`;
  const rows = o.x.map((lab, i) => `<tr><td>${esc(lab)}</td>${o.series.map((s) => `<td>${esc(o.fmt(s.values[i] || 0))}</td>`).join("")}</tr>`);
  return `<details class="tableview" data-table="${esc(id)}"${openTables.has(id) ? " open" : ""}><summary>View as table</summary><div class="tablewrap"><table class="data">${head}${rows.reverse().join("")}</table></div></details>`;
}
function bindTable(el, id) {
  const d = el.querySelector("details.tableview");
  d?.addEventListener("toggle", () => (d.open ? openTables.add(id) : openTables.delete(id)));
}
const legendHtml = (series) => (series.length < 2 ? "" : `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")}</div>`);

/** Stacked columns. o: { id, x:[labels], series:[{name,color,values}], fmt, height } */
export function columns(el, o) {
  const f = frame(el, o), { m, pw, ph } = f, n = o.x.length;
  const totals = o.x.map((_, i) => o.series.reduce((s, sr) => s + (sr.values[i] || 0), 0));
  const tk = ticks(Math.max(...totals, 0));
  const slot = pw / n, bw = Math.max(2, Math.min(24, slot * 0.62));
  const cx = (i) => m.l + slot * (i + 0.5);
  const ax = axes(f, tk, o.fmt, o.x, cx);
  let bars = "", hits = "";
  for (let i = 0; i < n; i++) {
    let acc = 0;
    const top = o.series.reduce((t, s, k) => ((s.values[i] || 0) > 0 ? k : t), -1);
    o.series.forEach((s, k) => {
      const v = s.values[i] || 0;
      if (v <= 0) return;
      const y1 = ax.y(acc + v), y0 = ax.y(acc), x = cx(i) - bw / 2;
      const h = Math.max(1, y0 - y1 - (acc > 0 && y0 - y1 > 3 ? 2 : 0)); // 2px surface gap between segments
      const r = Math.min(4, bw / 2, h);
      bars += k === top
        ? `<path class="bar" data-i="${i}" fill="${s.color}" d="M${x},${y1 + h}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + bw - r}Q${x + bw},${y1} ${x + bw},${y1 + r}V${y1 + h}Z"/>`
        : `<rect class="bar" data-i="${i}" fill="${s.color}" x="${x}" y="${y1}" width="${bw}" height="${h}"/>`;
      acc += v;
    });
    hits += `<rect class="hit" data-i="${i}" x="${m.l + slot * i}" y="${m.t}" width="${slot}" height="${ph}" fill="transparent"${n <= 31 ? ' tabindex="0"' : ""}><title>${esc(o.x[i])}</title></rect>`;
  }
  el.innerHTML = `<svg viewBox="0 0 ${f.W} ${f.H}" height="${f.H}" role="img" aria-label="${esc(o.title || "")}">${ax.svg}${bars}${hits}</svg>${legendHtml(o.series)}${tableView(o.id, o)}`;
  bindTable(el, o.id);
  const on = (i, x, y) => {
    el.classList.add("dimmed");
    el.querySelectorAll(".bar").forEach((b) => b.classList.toggle("on", +b.dataset.i === i));
    const rows = o.series.map((s) => ({ name: s.name, color: s.color, value: o.fmt(s.values[i] || 0) }));
    if (o.series.length > 1) rows.push({ name: "Total", value: o.fmt(totals[i]) });
    showTip(x, y, o.x[i], rows);
  };
  const off = () => { el.classList.remove("dimmed"); hideTip(); };
  el.querySelectorAll(".hit").forEach((h) => {
    const i = +h.dataset.i;
    h.addEventListener("pointermove", (ev) => on(i, ev.clientX, ev.clientY));
    h.addEventListener("pointerleave", off);
    h.addEventListener("focus", () => { const r = h.getBoundingClientRect(); on(i, r.left + r.width / 2, r.top + 20); });
    h.addEventListener("blur", off);
  });
}

/** Stacked area (or a single line). o: { id, x, series, fmt, height, endLabel } */
export function area(el, o) {
  const f = frame(el, o, 66), { m, pw, ph } = f, n = o.x.length;
  const stack = o.series.map(() => []);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    o.series.forEach((s, k) => { acc += s.values[i] || 0; stack[k][i] = acc; });
  }
  const totals = stack.at(-1) || [];
  const tk = ticks(Math.max(...totals, 0));
  const x = (i) => m.l + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
  const ax = axes(f, tk, o.fmt, o.x, x);
  const line = (arr) => arr.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${ax.y(v).toFixed(1)}`).join("");
  let marks = "";
  for (let k = o.series.length - 1; k >= 0; k--) {
    const upper = stack[k], lower = k ? stack[k - 1] : upper.map(() => 0);
    const back = lower.map((v, i) => `L${x(i).toFixed(1)},${ax.y(v).toFixed(1)}`).reverse().join("");
    marks += `<path d="${line(upper)}${back}Z" fill="${o.series[k].color}" fill-opacity="0.14"/>`;
    marks += `<path d="${line(upper)}" fill="none" stroke="${o.series[k].color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  const last = n - 1;
  const end = n ? `<circle cx="${x(last)}" cy="${ax.y(totals[last])}" r="4" fill="${o.series.at(-1).color}" stroke="var(--surface)" stroke-width="2"/><text class="endlabel" x="${x(last) + 9}" y="${ax.y(totals[last]) + 4}">${esc((o.endLabel || o.fmt)(totals[last]))}</text>` : "";
  const hover = `<g class="hover"><line y1="${m.t}" y2="${m.t + ph}" stroke="var(--line-3)" stroke-width="1"/>${o.series.map((s) => `<circle r="4" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`).join("")}</g>`;
  el.innerHTML = `<svg viewBox="0 0 ${f.W} ${f.H}" height="${f.H}" role="img" aria-label="${esc(o.title || "")}">${ax.svg}${marks}${end}${hover}<rect class="hit" x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" fill="transparent"/></svg>${legendHtml(o.series)}${tableView(o.id, o)}`;
  bindTable(el, o.id);
  const g = el.querySelector(".hover"), hit = el.querySelector(".hit"), svg = el.querySelector("svg");
  hit.addEventListener("pointermove", (ev) => {
    const box = svg.getBoundingClientRect(), px = ((ev.clientX - box.left) / box.width) * f.W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - m.l) / pw) * (n - 1))));
    g.style.opacity = 1;
    g.querySelector("line").setAttribute("x1", x(i)); g.querySelector("line").setAttribute("x2", x(i));
    g.querySelectorAll("circle").forEach((c, k) => { c.setAttribute("cx", x(i)); c.setAttribute("cy", ax.y(stack[k][i])); });
    const rows = o.series.map((s) => ({ name: s.name, color: s.color, value: o.fmt(s.values[i] || 0) })).reverse();
    if (o.series.length > 1) rows.push({ name: "Total", value: o.fmt(totals[i]) });
    showTip(ev.clientX, ev.clientY, o.x[i], rows);
  });
  hit.addEventListener("pointerleave", () => { g.style.opacity = 0; hideTip(); });
}

/** Tiny trend line for a stat tile. */
export function spark(values, color = "var(--s1)") {
  if (!values || values.length < 2) return "";
  const max = Math.max(...values), min = Math.min(...values), span = max - min || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(2)},${(27 - ((v - min) / span) * 24).toFixed(2)}`);
  return `<svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;
}

/**
 * Performance line on a time axis, slvr-style: one white line over a soft fill,
 * the range's high and low marked on the right, crosshair readout on hover.
 * o: { points:[{t, v}], fmt, title, height, tipName }
 */
export function navChart(el, o) {
  const pts = o.points;
  const W = Math.max(280, el.clientWidth || 600), H = o.height || 260;
  const m = { l: 6, r: 62, t: 16, b: 26 }, pw = W - m.l - m.r, ph = H - m.t - m.b;
  if (pts.length < 2) {
    el.innerHTML = `<div class="empty" style="padding:70px 18px">${esc(o.empty || "The line starts with the first deposit.")}</div>`;
    return;
  }
  const t0 = pts[0].t, t1 = pts.at(-1).t, span = Math.max(1, t1 - t0);
  let lo = Math.min(...pts.map((p) => p.v)), hi = Math.max(...pts.map((p) => p.v));
  if (hi - lo < Math.abs(hi) * 1e-6) { hi *= 1.001; lo *= 0.999; }
  const pad = (hi - lo) * 0.14;
  const x = (t) => m.l + ((t - t0) / span) * pw;
  const y = (v) => m.t + ph - ((v - (lo - pad)) / (hi - lo + 2 * pad)) * ph;
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const base = pts[0].v;
  const rel = (v) => `${v >= base ? "+" : ""}${((v / base - 1) * 100).toFixed(2)}%`;
  // over most of a year or more the year matters: the axis reads "Jul 2025" and the readout "Jul 6, 2025"
  const long = span > 300 * 86400;
  const fmtT = (t, axis = false) => new Date(t * 1000).toLocaleString("en-US", span < 3 * 86400 ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" } : long ? (axis ? { month: "short", year: "numeric" } : { month: "short", day: "numeric", year: "numeric" }) : { month: "short", day: "numeric" });
  const id = "nf-" + (o.id || "x");
  const marks = [[hi, rel(hi)], [lo, rel(lo)]].map(([v, lab]) =>
    `<line x1="${m.l}" x2="${m.l + pw}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)" stroke-width="1" stroke-dasharray="2 5"/><text x="${m.l + pw + 8}" y="${y(v) + 4}">${esc(lab)}</text>`).join("");
  const xl = [0, 0.5, 1].map((f) => `<text x="${m.l + f * pw}" y="${H - 6}" text-anchor="${f === 0 ? "start" : f === 1 ? "end" : "middle"}">${esc(fmtT(t0 + f * span, true))}</text>`).join("");
  const last = pts.at(-1);
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${esc(o.title || "")}">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--ink)" stop-opacity="0.2"/><stop offset="1" stop-color="var(--ink)" stop-opacity="0"/></linearGradient></defs>
    ${marks}${xl}
    <path d="${d}L${x(t1).toFixed(1)},${m.t + ph}L${x(t0).toFixed(1)},${m.t + ph}Z" fill="url(#${id})"/>
    <path d="${d}" fill="none" stroke="var(--ink)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(last.t)}" cy="${y(last.v)}" r="4" fill="var(--ink)" stroke="var(--surface)" stroke-width="2"/>
    <g class="hover"><line y1="${m.t}" y2="${m.t + ph}" stroke="var(--line-3)" stroke-width="1"/><circle r="4" fill="var(--ink)" stroke="var(--surface)" stroke-width="2"/></g>
    <rect class="hit" x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" fill="transparent"/></svg>`;
  const g = el.querySelector(".hover"), hit = el.querySelector(".hit"), svg = el.querySelector("svg");
  hit.addEventListener("pointermove", (ev) => {
    const box = svg.getBoundingClientRect(), px = ((ev.clientX - box.left) / box.width) * W;
    const tt = t0 + ((px - m.l) / pw) * span;
    let k = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i].t - tt) < Math.abs(pts[k].t - tt)) k = i;
    const p = pts[k];
    g.style.opacity = 1;
    g.querySelector("line").setAttribute("x1", x(p.t)); g.querySelector("line").setAttribute("x2", x(p.t));
    g.querySelector("circle").setAttribute("cx", x(p.t)); g.querySelector("circle").setAttribute("cy", y(p.v));
    showTip(ev.clientX, ev.clientY, fmtT(p.t), [{ name: o.tipName || "Value", color: "var(--ink)", value: o.fmt(p.v) }, { name: "Change", value: rel(p.v) }]);
  });
  hit.addEventListener("pointerleave", () => { g.style.opacity = 0; hideTip(); });
}
