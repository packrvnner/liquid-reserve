// The hero "vessel": a droplet-shaped reserve with liquid inside and ripple rings
// around it. Canvas, theme-aware, pauses when off-screen, static if the visitor
// prefers reduced motion. Time is global, so re-mounting never makes it jump.

const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function dropPath(cx, cy, R) {
  const p = new Path2D();
  p.moveTo(cx, cy - 1.95 * R);
  p.bezierCurveTo(cx + 0.55 * R, cy - 1.15 * R, cx + R, cy - 0.55 * R, cx + R, cy);
  p.arc(cx, cy, R, 0, Math.PI, false);
  p.bezierCurveTo(cx - R, cy - 0.55 * R, cx - 0.55 * R, cy - 1.15 * R, cx, cy - 1.95 * R);
  p.closePath();
  return p;
}

function palette() {
  const s = getComputedStyle(document.documentElement);
  const v = (n) => s.getPropertyValue(n).trim();
  return { a: v("--mark-b"), b: v("--mark-c"), pale: v("--mark-a"), ring: v("--line-2"), ring2: v("--line-3"), bg: v("--surface"), light: document.documentElement.dataset.theme === "light" };
}

/** Mounts the animation on `canvas`. `level` is the fill fraction (0..1), or a function that returns it: then the
 *  surface follows it, easing, so a live figure can move the liquid without re-mounting. */
export function mountVessel(canvas, level = 0.56) {
  const target = typeof level === "function" ? level : () => level;
  let shown = Math.max(0, Math.min(1, Number(target()) || 0));
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let w = 0, h = 0, raf = 0, visible = true, pal = palette(), palAt = 0;

  const size = () => {
    const r = canvas.getBoundingClientRect();
    w = r.width; h = r.height;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
  };
  size();
  const ro = new ResizeObserver(() => { size(); if (reduce()) draw(0); });
  ro.observe(canvas);
  const io = new IntersectionObserver((es) => { visible = es[0].isIntersecting; });
  io.observe(canvas);

  function draw(ms) {
    const t = ms / 1000;
    if (ms - palAt > 800) { pal = palette(); palAt = ms; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const R = Math.min(w * 0.235, h * 0.215);
    const cx = w * 0.5, cy = h * 0.6;

    // ripple rings, expanding slowly
    const span = Math.max(w, h) * 0.62, gap = span / 6;
    ctx.lineWidth = 1;
    for (let i = 0; i < 6; i++) {
      const r = R * 1.25 + ((t * 9 + i * gap) % span);
      ctx.globalAlpha = Math.max(0, 1 - (r - R * 1.25) / span);
      ctx.strokeStyle = i % 2 ? pal.ring : pal.ring2;
      ctx.beginPath();
      ctx.ellipse(cx, cy + R * 0.25, r, r * 0.42, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    const drop = dropPath(cx, cy, R);
    // glass body
    ctx.save();
    ctx.clip(drop);
    ctx.fillStyle = pal.bg;
    ctx.fillRect(cx - R - 2, cy - 2 * R - 2, 2 * R + 4, 3 * R + 4);
    const want = Math.max(0, Math.min(1, Number(target()) || 0));
    shown += (want - shown) * (reduce() ? 1 : 0.04);
    const top = cy + R - (2.95 * R) * shown; // liquid surface
    const layers = [
      { amp: R * 0.07, k: 2.1, sp: 0.9, ph: 0, alpha: pal.light ? 0.35 : 0.3, dy: -R * 0.05 },
      { amp: R * 0.05, k: 3.1, sp: -1.3, ph: 1.7, alpha: pal.light ? 0.55 : 0.5, dy: 0 },
      { amp: R * 0.035, k: 4.2, sp: 1.7, ph: 3.9, alpha: 0.92, dy: R * 0.06 },
    ];
    for (const L of layers) {
      const g = ctx.createLinearGradient(cx - R, top, cx + R, cy + R);
      g.addColorStop(0, pal.a); g.addColorStop(1, pal.b);
      ctx.globalAlpha = L.alpha;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(cx - R - 4, cy + R + 4);
      for (let x = -R - 4; x <= R + 4; x += 3) {
        const y = top + L.dy + L.amp * Math.sin((x / R) * L.k + t * L.sp + L.ph) + L.amp * 0.5 * Math.sin((x / R) * L.k * 2.3 - t * L.sp * 0.7);
        ctx.lineTo(cx + x, y);
      }
      ctx.lineTo(cx + R + 4, cy + R + 4);
      ctx.closePath();
      ctx.fill();
    }
    // rising bubbles
    ctx.globalAlpha = pal.light ? 0.5 : 0.65;
    ctx.fillStyle = pal.pale;
    for (let i = 0; i < 7; i++) {
      const life = ((t * (0.08 + i * 0.013) + i * 0.37) % 1);
      const bx = cx + Math.sin(i * 12.9898) * R * 0.62 + Math.sin(t * 0.8 + i) * 3;
      const by = cy + R - life * (cy + R - top - 6);
      if (by > top + 6) { ctx.beginPath(); ctx.arc(bx, by, 1.2 + (i % 3) * 0.7, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.restore();
    ctx.globalAlpha = 1;

    // chrome rim + glint
    const rim = ctx.createLinearGradient(cx - R, cy - 2 * R, cx + R, cy + R);
    rim.addColorStop(0, pal.pale); rim.addColorStop(0.45, pal.a); rim.addColorStop(1, pal.b);
    ctx.strokeStyle = rim; ctx.lineWidth = 1.6;
    ctx.stroke(drop);
    ctx.globalAlpha = pal.light ? 0.5 : 0.75; ctx.strokeStyle = pal.pale; ctx.lineWidth = 2; ctx.lineCap = "round";
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.8, Math.PI * 0.62, Math.PI * 0.86); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function loop(ms) {
    if (!canvas.isConnected) return stop();
    if (visible) draw(ms);
    raf = requestAnimationFrame(loop);
  }
  function stop() { cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); }

  if (reduce()) draw(4200);
  else raf = requestAnimationFrame(loop);
  return stop;
}
