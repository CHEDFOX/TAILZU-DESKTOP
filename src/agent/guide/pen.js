// The pen: circles, arrows, underlines, numbers and labels drawn on the
// screen, stroke by stroke, as a hand would draw them.
"use strict";

// The model marks up the screen while it explains, as a teacher uses a pen:
// a circle round part of a diagram, an arrow from a label to what it names,
// the places to click numbered. Each mark is drawn as a hand draws it, in
// order, in amber over an ink edge, and it looks the same on every frame:
// its wobble is seeded by its id and worked out once, when it arrives.
const KINDS = new Set(["box", "circle", "underline", "highlight", "arrow", "number", "label", "path"]);
const marks = [];
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
// A mark is drawn in this window or not at all: its geometry is held to
// the window, a little over its edges at most. A frame sent a million px
// wide is a line walked every 2 px when the mark is made, and the page
// hung on it; one wholly off the window has nothing here to mark.
const OVER = 16;
const inX = (v) => clamp(v, -OVER, W + OVER), inY = (v) => clamp(v, -OVER, H + OVER);
function asFrame(f) {
  if (!Array.isArray(f) || f.length !== 4) return null;
  const [x, y, w, h] = f.map(Number);
  if (![x, y, w, h].every(isNum) || w < 0 || h < 0) return null;
  if (x > W + OVER || y > H + OVER || x + w < -OVER || y + h < -OVER) return null;
  const x0 = inX(x), y0 = inY(y);
  return [x0, y0, inX(x + w) - x0, inY(y + h) - y0];
}
function asPoint(p) {
  if (!Array.isArray(p) || p.length !== 2) return null;
  const [x, y] = p.map(Number);
  return isNum(x) && isNum(y) ? [inX(x), inY(y)] : null;
}
/** A point or a frame, by its length. */
const asSpot = (s) => asFrame(s) || asPoint(s);
function seedOf(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rand(seed) {
  let a = seed | 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/**
 * A line as a hand draws it. `raw` is the line meant ([x0, y0, x1, y1, …],
 * finely sampled); it is resampled every 6 px, each point nudged across the
 * line by smooth noise (three slow waves, seeded), and its ends carried 2 px
 * past where they were meant to stop (`over`: [start, end]). `drift(s, len)`
 * nudges further, for a shape whose end runs on over its start, so the end
 * does not trace the start exactly. Returns { pts, cum, len }.
 */
function hand(raw, rnd, amp, over, drift) {
  const n = raw.length / 2;
  let total = 0;
  const segs = new Float64Array(Math.max(1, n));
  for (let i = 1; i < n; i++) { total += Math.hypot(raw[2 * i] - raw[2 * i - 2], raw[2 * i + 1] - raw[2 * i - 1]); segs[i] = total; }
  const step = 6, count = Math.max(2, Math.ceil(total / step) + 1);
  const xs = new Float64Array(count), ys = new Float64Array(count);
  let j = 1;
  for (let k = 0; k < count; k++) {
    const s = Math.min(total, k * step);
    while (j < n - 1 && segs[j] < s) j++;
    const s0 = segs[j - 1] || 0, s1 = segs[j] || 0, f = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
    xs[k] = raw[2 * j - 2] + (raw[2 * j] - raw[2 * j - 2]) * f;
    ys[k] = raw[2 * j - 1] + (raw[2 * j + 1] - raw[2 * j - 1]) * f;
    if (n === 1) { xs[k] = raw[0]; ys[k] = raw[1]; }
  }
  // Mostly slow bends, the way a hand drifts off a line and comes back,
  // and only a faint quick tremor: quicker waves made a line look like a
  // caterpillar, not a pen.
  const f1 = TAU / (70 + rnd() * 50), f2 = TAU / (22 + rnd() * 10), f3 = TAU / (180 + rnd() * 120);
  const p1 = rnd() * TAU, p2 = rnd() * TAU, p3 = rnd() * TAU;
  const noise = (s) => (.6 * Math.sin(s * f1 + p1) + .14 * Math.sin(s * f2 + p2) + .5 * Math.sin(s * f3 + p3)) / 1.2;
  const out = [];
  for (let k = 0; k < count; k++) {
    const a = Math.max(0, k - 1), b = Math.min(count - 1, k + 1);
    const dx = xs[b] - xs[a], dy = ys[b] - ys[a], L = Math.hypot(dx, dy) || 1;
    const s = Math.min(total, k * step);
    const off = amp * noise(s) + (drift ? drift(s, total) : 0);
    out.push(xs[k] - dy / L * off, ys[k] + dx / L * off);
  }
  // The ends, carried on a little: a hand does not stop on the dot.
  const m = out.length / 2;
  if (m >= 2) {
    const ext = (i, k, d) => { const dx = out[2 * i] - out[2 * k], dy = out[2 * i + 1] - out[2 * k + 1], L = Math.hypot(dx, dy) || 1; return [out[2 * i] + dx / L * d, out[2 * i + 1] + dy / L * d]; };
    if (over[1]) { const e = ext(m - 1, m - 2, over[1]); out.push(e[0], e[1]); }
    if (over[0]) { const e = ext(0, 1, over[0]); out.unshift(e[0], e[1]); }
  }
  const pts = Float32Array.from(out), cum = new Float32Array(pts.length / 2);
  let len = 0;
  for (let i = 1; i < cum.length; i++) { len += Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]); cum[i] = len; }
  return { pts, cum, len };
}
/** A point `d` along a rounded rectangle, clockwise from the start of its top edge. */
function alongRound(x, y, w, h, r, d) {
  const a = w - 2 * r, b = h - 2 * r, q = Math.PI / 2 * r;
  const arc = (cx, cy, from, dd) => { const th = from + dd / r; return [cx + r * Math.cos(th), cy + r * Math.sin(th)]; };
  if (d < a) return [x + r + d, y]; d -= a;
  if (d < q) return arc(x + w - r, y + r, -Math.PI / 2, d); d -= q;
  if (d < b) return [x + w, y + r + d]; d -= b;
  if (d < q) return arc(x + w - r, y + h - r, 0, d); d -= q;
  if (d < a) return [x + w - r - d, y + h]; d -= a;
  if (d < q) return arc(x + r, y + h - r, Math.PI / 2, d); d -= q;
  if (d < b) return [x, y + h - r - d]; d -= b;
  return arc(x + r, y + r, Math.PI, Math.min(d, q));
}
/** Where a line toward `q` leaves frame `f`, `gap` px off its edge. */
function edgeToward(f, q, gap) {
  const cx = f[0] + f[2] / 2, cy = f[1] + f[3] / 2, hw = f[2] / 2 + gap, hh = f[3] / 2 + gap;
  const dx = q[0] - cx, dy = q[1] - cy;
  if (Math.abs(dx) <= hw && Math.abs(dy) <= hh) return [cx, cy];
  const k = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  return [cx + dx * k, cy + dy * k];
}
const centreOf = (s) => (s.length === 4 ? [s[0] + s[2] / 2, s[1] + s[3] / 2] : s);
/** Label spots: four candidate top-left corners for a label of w × h,
 *  around a rectangle, best first (above its left, below it, to its right,
 *  to its left). */
const around = (x, y, w, h, first) => (lw, lh) => {
  const g = 6, mid = y + h / 2 - lh / 2;
  const above = [x, y - lh - g], below = [x, y + h + g], right = [x + w + g, mid], left = [x - lw - g, mid];
  return first === "below" ? [below, above, right, left] : first === "right" ? [right, left, above, below] : [above, below, right, left];
};

/** A mark, as the guide draws it: its strokes made by the hand, and where
 *  its label wants to be. Null for one that cannot be drawn. */
function makeMark(m) {
  const kind = String(m.kind || "");
  if (!KINDS.has(kind)) return null;
  const id = String(m.id || "") || "m" + marks.length + ":" + Math.round(now());
  const rnd = rand(seedOf(id));
  const amp = K.num("desktop.guide.inkWobble", 1.2);
  // Around a thing: its frame (`at` as a frame is taken as one too).
  const frame = asFrame(m.frame) || asFrame(m.at);
  const out = { id, kind, strokes: [], len: 0, fill: null, sweep: null, disc: null, label: null, spots: null, bounds: null, areas: [], path: null, start: 0, dur: 0, fadeAt: 0 };
  const raw = [];
  switch (kind) {
    case "box": {
      if (!frame) return null;
      // A rounded rectangle 6 px round it, clockwise from the top-left, in
      // one stroke that runs on 10 px past where it began.
      const x = frame[0] - 6, y = frame[1] - 6, w = frame[2] + 12, h = frame[3] + 12, r = Math.min(8, w / 2, h / 2);
      const P = 2 * (w + h - 4 * r) + TAU * r;
      for (let d = 0; d <= P + 10; d += 2) { const q = alongRound(x, y, w, h, r, d % P); raw.push(q[0], q[1]); }
      out.strokes.push(hand(raw, rnd, amp, [2, 2], (s) => (s > P - 14 ? -1.6 * clamp((s - P + 14) / 24) : 0)));
      out.spots = around(x, y, w, h);
      break;
    }
    case "circle": {
      if (!frame) return null;
      // An ellipse round it, tilted a little, from just left of the top,
      // once round and on past the start, a little wider by the end: the
      // way a circle is drawn in one go.
      const cx = frame[0] + frame[2] / 2, cy = frame[1] + frame[3] / 2, rx = frame[2] / 2 + 10, ry = frame[3] / 2 + 8;
      const tilt = -4 * Math.PI / 180, a0 = (-100 + (rnd() - .5) * 8) * Math.PI / 180, sweep = (380 + (rnd() - .5) * 10) * Math.PI / 180;
      const steps = Math.max(24, Math.ceil(sweep * Math.max(rx, ry) / 2));
      const ct = Math.cos(tilt), st = Math.sin(tilt);
      for (let i = 0; i <= steps; i++) {
        const th = a0 + sweep * i / steps, g = 1 + .045 * (th - a0) / TAU;
        const px = rx * g * Math.cos(th), py = ry * g * Math.sin(th);
        raw.push(cx + px * ct - py * st, cy + px * st + py * ct);
      }
      out.strokes.push(hand(raw, rnd, amp, [2, 2]));
      out.spots = around(cx - rx, cy - ry, 2 * rx, 2 * ry);
      break;
    }
    case "underline": {
      if (!frame) return null;
      // Under it, with a slight sag and a small flick up at the end, both
      // in proportion: under one character, a sag and a flick made for a
      // line of words turned it into a tilde.
      const x0 = frame[0] - 2, x1 = frame[0] + frame[2] + 2, by = frame[1] + frame[3] + 3, L = x1 - x0;
      const sag = Math.min(2.5, L * .015), flick = Math.min(3, L * .06), fl = Math.max(2, Math.min(10, L * .35));
      for (let x = x0; x <= x1 + .01; x += 2) {
        const u = (x - x0) / Math.max(1, L), up = clamp((x - (x1 - fl)) / fl);
        raw.push(x, by + sag * Math.sin(Math.PI * u) - flick * up * up);
      }
      out.strokes.push(hand(raw, rnd, amp * .8 * clamp(L / 80, .3, 1), [2, 2]));
      out.spots = (lw, lh) => [[x0, by + 8], [x0, frame[1] - lh - 6], [x1 + 6, by - lh / 2], [x0 - lw - 6, by - lh / 2]];
      break;
    }
    case "highlight": {
      if (!frame) return null;
      // A marker's swipe over it: a band with slanted ends, its edges not
      // quite straight, swept left to right.
      const x0 = frame[0] - 3, x1 = frame[0] + frame[2] + 3, y0 = frame[1] - 2, y1 = frame[1] + frame[3] + 2;
      const sl = Math.min(6, (y1 - y0) * .3), p = new Path2D();
      const wob = (x) => .7 * Math.sin(x * .09 + rnd() * TAU);
      p.moveTo(x0 + sl, y0);
      for (let x = x0 + sl; x <= x1 + sl; x += 8) p.lineTo(x, y0 + wob(x));
      p.lineTo(x1 + sl, y0);
      p.lineTo(x1, y1);
      for (let x = x1; x >= x0; x -= 8) p.lineTo(x, y1 + wob(x));
      p.lineTo(x0, y1);
      p.closePath();
      out.fill = p; out.sweep = [x0, x1 + sl, y0 - 2, y1 + 2];
      out.len = x1 + sl - x0;
      out.spots = around(x0, y0, x1 - x0, y1 - y0);
      break;
    }
    case "arrow": {
      const from = asSpot(m.from), to = asSpot(m.to);
      if (!from || !to) return null;
      // A curve from one to the other, bowed away from the card; a frame's
      // end leaves (or reaches) the edge facing the other end, 6 px off it.
      const a = from.length === 4 ? edgeToward(from, centreOf(to), 6) : from;
      const b = to.length === 4 ? edgeToward(to, centreOf(from), 6) : to;
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
      if (L < 8) return null;
      let nx = -dy / L, ny = dx / L;
      const bx = S.box ? S.box.x + S.box.w / 2 : W / 2, byc = S.box ? S.box.y + S.box.h / 2 : H;
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, bow = .12 * L;
      if (Math.hypot(mx + nx * bow - bx, my + ny * bow - byc) < Math.hypot(mx - nx * bow - bx, my - ny * bow - byc)) { nx = -nx; ny = -ny; }
      const cx = mx + nx * bow, cy = my + ny * bow;
      const steps = Math.max(8, Math.ceil(L / 2));
      for (let i = 0; i <= steps; i++) { const u = i / steps, v = 1 - u; raw.push(v * v * a[0] + 2 * v * u * cx + u * u * b[0], v * v * a[1] + 2 * v * u * cy + u * u * b[1]); }
      out.strokes.push(hand(raw, rnd, amp, [2, 0]));
      // The head: two short strokes back from the tip at ±28°, after the
      // shaft, as one flick of the pen.
      const tx = b[0] - cx, ty = b[1] - cy, tL = Math.hypot(tx, ty) || 1, ux = tx / tL, uy = ty / tL, hl = 11, an = 28 * Math.PI / 180;
      const barb = (s) => [b[0] - hl * (ux * Math.cos(an) - s * uy * Math.sin(an)), b[1] - hl * (uy * Math.cos(an) + s * ux * Math.sin(an))];
      const l = barb(1), r = barb(-1);
      out.strokes.push(hand([l[0], l[1], b[0], b[1], r[0], r[1]], rnd, amp * .3, [0, 1]));
      if (from.length === 4) out.spots = around(from[0], from[1], from[2], from[3]);
      else {
        // At the tail: the arrow comes out of its label.
        const vx = cx - a[0], vy = cy - a[1], vL = Math.hypot(vx, vy) || 1, ex = vx / vL, ey = vy / vL;
        out.spots = (lw, lh) => {
          const k = Math.min(Math.abs(ex) > 1e-3 ? lw / 2 / Math.abs(ex) : Infinity, Math.abs(ey) > 1e-3 ? lh / 2 / Math.abs(ey) : Infinity) + 5;
          const c = [a[0] - ex * k, a[1] - ey * k];
          return [[c[0] - lw / 2, c[1] - lh / 2], [a[0] - lw / 2, a[1] - lh - 8], [a[0] - lw / 2, a[1] + 8], [a[0] + (ex > 0 ? -lw - 8 : 8), a[1] - lh / 2]];
        };
      }
      break;
    }
    case "number": {
      const n = Math.round(Number(m.n));
      if (!(n >= 1 && n <= 9)) return null;
      // On a frame's top-left corner, or on the point; kept on screen.
      const at = frame ? [frame[0] - 8, frame[1] - 8] : asPoint(m.at);
      if (!at) return null;
      const cx = clamp(at[0], 13, W - 13), cy = clamp(at[1], 13, H - 13);
      out.disc = { x: cx, y: cy, n };
      out.spots = around(cx - 11, cy - 11, 22, 22, "right");
      break;
    }
    case "label": {
      const at = asPoint(m.at), f = frame || asFrame(m.at);
      if (!at && !f) return null;
      if (f) out.spots = around(f[0], f[1], f[2], f[3], "right");
      else out.spots = (lw, lh) => [[at[0] - lw / 2, at[1] - lh / 2], [at[0] - lw / 2, at[1] - lh - 8], [at[0] - lw / 2, at[1] + 8], [at[0] + 8, at[1] - lh / 2]];
      break;
    }
    case "path": {
      // At most 64 points (the server sends 32 at most): each costs a
      // line drawn through it when the mark is made.
      const pts = Array.isArray(m.points) ? m.points.slice(0, 64).map(asPoint) : [];
      if (pts.length < 2 || pts.some((p) => !p)) return null;
      const seq = m.closed === true ? pts.concat([pts[0]]) : pts;
      for (let i = 0; i < seq.length; i++) {
        if (!i) { raw.push(seq[0][0], seq[0][1]); continue; }
        const [ax, ay] = seq[i - 1], [bx2, by2] = seq[i], L = Math.hypot(bx2 - ax, by2 - ay), steps = Math.max(1, Math.ceil(L / 2));
        for (let k = 1; k <= steps; k++) raw.push(ax + (bx2 - ax) * k / steps, ay + (by2 - ay) * k / steps);
      }
      out.strokes.push(hand(raw, rnd, amp, [2, 2]));
      const p = pts[0];
      out.spots = (lw, lh) => [[p[0] - lw - 10, p[1] - lh / 2], [p[0] + 10, p[1] - lh / 2], [p[0] - lw / 2, p[1] - lh - 10], [p[0] - lw / 2, p[1] + 10]];
      break;
    }
  }
  for (const st of out.strokes) out.len += st.len;
  // What it covers, for the labels that come after it to keep off: a
  // number's disc; a line's extent, unless it is a long one across the
  // screen (an arrow's box is mostly empty).
  if (out.disc) out.bounds = [out.disc.x - 12, out.disc.y - 12, 24, 24];
  else if (out.strokes.length && kind !== "arrow" && kind !== "path") {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const st of out.strokes) for (let i = 0; i < st.pts.length; i += 2) { x0 = Math.min(x0, st.pts[i]); x1 = Math.max(x1, st.pts[i]); y0 = Math.min(y0, st.pts[i + 1]); y1 = Math.max(y1, st.pts[i + 1]); }
    out.bounds = [x0 - 3, y0 - 3, x1 - x0 + 6, y1 - y0 + 6];
  } else if (out.sweep) out.bounds = [out.sweep[0], out.sweep[2], out.sweep[1] - out.sweep[0], out.sweep[3] - out.sweep[2]];
  // What a card tied to the pill keeps off (docked): drawn under the card,
  // a mark it covers is not seen. All of a box, a circle or a closed path,
  // what is inside it too; but an arrow or an open path only along its
  // line, in short runs of it (eight points, about 48 px): its box is
  // mostly empty, and kept off, a line nowhere near the card sent the card
  // across the screen.
  {
    const runs = kind === "arrow" || (kind === "path" && m.closed !== true);
    let x0, y0, x1, y1;
    const reset = () => { x0 = y0 = Infinity; x1 = y1 = -Infinity; };
    const add = (x, y) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); };
    const flush = () => { if (x1 >= x0) out.areas.push([x0, y0, x1 - x0, y1 - y0]); reset(); };
    reset();
    for (const st of out.strokes) {
      for (let i = 0; i < st.pts.length; i += 2) {
        add(st.pts[i], st.pts[i + 1]);
        // The next run starts where this one ends, so no piece of the line falls between them.
        if (runs && i / 2 % 8 === 7 && i + 2 < st.pts.length) { flush(); add(st.pts[i], st.pts[i + 1]); }
      }
      if (runs) flush();
    }
    if (out.disc) { add(out.disc.x - 12, out.disc.y - 12); add(out.disc.x + 12, out.disc.y + 12); }
    if (out.sweep) { add(out.sweep[0], out.sweep[2]); add(out.sweep[1], out.sweep[3]); }
    flush();
  }
  const text = typeof m.text === "string" ? m.text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim().slice(0, 48) : "";
  if (text) {
    const size = K.num("desktop.guide.labelSize", 19);
    ctx.save(); ctx.font = labelFont(size); const tw = ctx.measureText(text).width; ctx.restore();
    out.label = { text, size, w: Math.ceil(tw) + 16, h: Math.round(size * 1.12) + 4, x: 0, y: 0, rot: (rnd() - .6) * 3.2 * Math.PI / 180, writeMs: Math.min(620, 140 + text.length * 30), at: 0 };
  } else if (kind === "label") return null;
  if (kind === "label") out.len = out.label.w;
  // The pen's pace: longer marks take longer, up to a limit.
  out.dur = Math.min(K.num("desktop.guide.inkMaxMs", 900), K.num("desktop.guide.inkMs", 260) + out.len / K.num("desktop.guide.inkSpeed", 1.6));
  return out;
}
const labelFont = (size) => `600 ${size}px Caveat, "Segoe Print", cursive`;
/** The label where it is clear: off the card (and Blip's head over it),
 *  the ring and its label, the pill, and the other labels; the first of
 *  its spots that is, else of the same spots stepped further out. Where
 *  none is, it may cross the ring or the tether, but never the card, the
 *  ring's label or another label: with nowhere for it, it is not drawn
 *  (placed false) until the card moves (relabel). */
function placeLabel(m) {
  const L = m.label;
  if (!L) return;
  // `loose`: only what a label would hide or be hidden by.
  const free = (x, y, loose) => {
    if (x < 8 || y < 8 || x + L.w > W - 8 || y + L.h > H - 8) return false;
    const hit = (r, g) => r && x < r.x + r.w + g && x + L.w > r.x - g && y < r.y + r.h + g && y + L.h > r.y - g;
    const b = S.box;
    if (b && x < b.x + b.w + 6 && x + L.w > b.x - 6 && y < b.y + b.h + 6 && y + L.h > b.y - 62) return false;
    if (hit(S.chipBox, 6)) return false;
    if (S.P && hit(S.P, 10)) return false;
    for (const o of marks) if (o !== m && o.label && !o.fadeAt && o.label.placed && hit(o.label, 4)) return false;
    if (loose) return true;
    if (S.ring) {
      const [rx, ry, rw, rh] = S.ring.frame;
      // Off what is ringed; and off the line of a ring round a whole
      // picture (the tentative "Looking"), whose dots would run through
      // the words: wholly inside it or wholly out.
      if (!S.ring.tentative) { if (hit({ x: rx, y: ry, w: rw, h: rh }, 10)) return false; }
      else {
        const g = K.num("desktop.guide.ringPad", 6) + 4;
        const inside = x >= rx - g + 6 && y >= ry - g + 6 && x + L.w <= rx + rw + g - 6 && y + L.h <= ry + rh + g - 6;
        if (!inside && hit({ x: rx, y: ry, w: rw, h: rh }, g + 4)) return false;
      }
    }
    // Nor on the tether between the pill and the card.
    if (S.P && b) {
      const px = S.P.x + S.P.w / 2, ax = clamp(px, b.x + 40, b.x + b.w - 40), top = b.y + b.h;
      if (hit({ x: Math.min(px, ax), y: top, w: Math.abs(px - ax), h: Math.max(0, S.P.y - top) }, 8)) return false;
    }
    return true;
  };
  // And, if it can, off the other marks: their numbers, and what their
  // lines cover.
  const clear = (x, y) => {
    for (const o of marks) {
      if (o === m || o.fadeAt || !o.bounds) continue;
      const [bx, by, bw, bh] = o.bounds;
      if (x < bx + bw + 3 && x + L.w > bx - 3 && y < by + bh + 3 && y + L.h > by - 3) return false;
    }
    return true;
  };
  const spots = m.spots ? m.spots(L.w, L.h) : [];
  // Marks inside a picture being looked at keep their labels inside it:
  // each spot that would straddle its edge is tried again moved in.
  if (S.ring && S.ring.tentative) {
    const [rx, ry, rw, rh] = S.ring.frame, g = K.num("desktop.guide.ringPad", 6) - 2;
    const l = rx - g, t = ry - g, r = rx + rw + g - L.w, b = ry + rh + g - L.h;
    if (r > l && b > t) for (const p of spots.slice()) if (p[0] < r + L.w && p[0] + L.w > l && p[1] < b + L.h && p[1] + L.h > t) spots.push([clamp(p[0], l, r), clamp(p[1], t, b)]);
  }
  // Crowded (two labels on one point, a label inside a labelled box by
  // the card), every spot can be taken: the same spots a label's height
  // up and down and half its width aside, then twice and three times
  // that, nearest first. The first on screen, taken anyway, put one
  // label on top of another, and both were unreadable.
  const more = [];
  for (let k = 1; k <= 3; k++) {
    const dy = k * (L.h + 6), dx = k * L.w / 2;
    for (const [x, y] of spots) more.push([x, y - dy], [x, y + dy], [x - dx, y], [x + dx, y]);
  }
  const fits = (p) => free(p[0], p[1]) && clear(p[0], p[1]);
  const s = spots.find(fits) || spots.find((p) => free(p[0], p[1])) || more.find(fits) || more.find((p) => free(p[0], p[1]))
    || spots.concat(more).find((p) => free(p[0], p[1], true));
  L.placed = !!s;
  if (s) { L.x = s[0]; L.y = s[1]; }
}
/** The card moved (a ring sent it aside), or a new ring's label came: a
 *  label either now covers finds another spot, and one that had nowhere
 *  to go looks again. */
function relabel() {
  const b = S.box, c = S.chipBox;
  for (const m of marks) {
    const L = m.label;
    if (!L || m.fadeAt) continue;
    const onCard = b && L.x < b.x + b.w + 6 && L.x + L.w > b.x - 6 && L.y < b.y + b.h + 6 && L.y + L.h > b.y - 62;
    const onChip = c && L.x < c.x + c.w + 6 && L.x + L.w > c.x - 6 && L.y < c.y + c.h + 6 && L.y + L.h > c.y - 6;
    if (!L.placed || onCard || onChip) placeLabel(m);
  }
}
function addMark(m) {
  if (!S.shown) return;
  if (m && m.id && marks.some((x) => x.id === String(m.id) && !x.fadeAt)) return;
  const mk = makeMark(m || {});
  if (!mk) return;
  const ms = now();
  // In the order they came: each starts when the one before is most of
  // the way drawn, so they read as one hand moving on.
  let prev = null;
  for (let i = marks.length - 1; i >= 0; i--) if (!marks[i].fadeAt) { prev = marks[i]; break; }
  mk.start = prev && !reduced ? Math.max(ms, prev.start + .7 * prev.dur) : ms;
  if (mk.label) mk.label.at = mk.start + (mk.kind === "label" ? 0 : mk.kind === "number" ? mk.dur * .6 : mk.dur * .55);
  marks.push(mk);
  // Tied to the pill, the card may be over it: it makes room (docked),
  // and the new label is placed by that (relabel) where the card has
  // gone, not where it was: placed first, every spot of a label by the
  // card was under it, and it went a long way off for room that was
  // about to be there.
  if (S.docked) place(false);
  else if (mk.label) placeLabel(mk);
  // A number that lands on the ring's corner moves the ring's label past
  // it (placeChip), and a label of a mark's that the ring's label now
  // covers moves off it.
  if (mk.disc && S.chipBox) { placeChip(); relabel(); }
  // So many and no more: the oldest go first.
  const max = Math.max(1, K.num("desktop.guide.inkMax", 24));
  let live = marks.filter((x) => !x.fadeAt);
  while (live.length > max) { live[0].fadeAt = ms; live = live.slice(1); }
  wake();
}
function fadeMarks() { const ms = now(); for (const m of marks) if (!m.fadeAt) m.fadeAt = ms; wake(); }
/** One stroke, drawn as far as `upto` px along it. */
function traceStroke(g, st, upto) {
  const p = st.pts, c = st.cum, n = c.length;
  if (upto <= 0 || n < 2) return;
  g.moveTo(p[0], p[1]);
  let i = 1;
  for (; i < n && c[i] <= upto; i++) g.lineTo(p[2 * i], p[2 * i + 1]);
  if (i < n) {
    const f = (upto - c[i - 1]) / Math.max(1e-6, c[i] - c[i - 1]);
    g.lineTo(p[2 * i - 2] + (p[2 * i] - p[2 * i - 2]) * f, p[2 * i - 1] + (p[2 * i + 1] - p[2 * i - 1]) * f);
  }
}
const penEase = (p) => .4 * p + .6 * p * p * (3 - 2 * p);
/** A mark's opacity: fading in (reduced motion only: it appears whole)
 *  and fading out. */
const alphaOf = (m, ms) => (m.fadeAt ? clamp(1 - (ms - m.fadeAt) / 200) : 1) * (reduced ? clamp((ms - m.start) / 120) : 1);
/** The marks' lines, under everything else: an ink edge, then the amber
 *  with a faint glow. Their numbers and labels come later (drawPins). */
function drawMarks(ms) {
  if (!marks.length) return;
  const bots = BOTS();
  const ink = bots ? K.color("desktop.guide.botsInk", "#0a0a0a") : K.color("desktop.guide.inkColor", "#E8A23C"), width = K.num("desktop.guide.inkWidth", 3);
  const glow = bots ? "transparent" : rgba(ink, .55);
  for (let i = marks.length - 1; i >= 0; i--) if (marks[i].fadeAt && ms - marks[i].fadeAt >= 200) marks.splice(i, 1);
  ctx.save();
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  for (const m of marks) {
    const a = alphaOf(m, ms);
    if (a <= 0 || ms < m.start) continue;
    const p = reduced ? 1 : clamp((ms - m.start) / m.dur);
    ctx.globalAlpha = a;
    if (m.fill) {
      // The marker sweeps across.
      const [x0, x1, y0, y1] = m.sweep;
      ctx.save();
      ctx.beginPath(); ctx.rect(x0 - 2, y0, (x1 - x0 + 4) * penEase(p), y1 - y0); ctx.clip();
      // See-through by the alpha, whatever colour the ink is: as an rgba()
      // of a knob it could not read, the band was solid over the words it
      // marked.
      ctx.globalAlpha = a * K.num("desktop.guide.highlightAlpha", 0.26);
      ctx.fillStyle = ink; ctx.fill(m.fill);
      ctx.restore();
      continue;
    }
    if (!m.strokes.length) continue;
    let path = m.path;
    if (!path && p >= 1) {
      // Finished: kept as a path, so it is not walked again every frame.
      path = m.path = new Path2D();
      for (const st of m.strokes) traceStroke(path, st, st.len + 1);
    }
    if (!path) {
      ctx.beginPath();
      let left = m.len * penEase(p);
      for (const st of m.strokes) { if (left <= 0) break; traceStroke(ctx, st, left); left -= st.len; }
    }
    ctx.shadowBlur = 0;
    ctx.strokeStyle = bots ? "rgba(255,255,255,.85)" : "rgba(15,13,11,.38)"; ctx.lineWidth = width + 3;
    if (path) ctx.stroke(path); else ctx.stroke();
    ctx.shadowColor = glow; ctx.shadowBlur = 6;
    ctx.strokeStyle = ink; ctx.lineWidth = width;
    if (path) ctx.stroke(path); else ctx.stroke();
    ctx.shadowBlur = 0;
  }
  ctx.restore();
}
/**
 * The numbers, then the labels on top of them, so a label is never
 * crossed by a line. These are pinned over the ring (still under the
 * thread, Blip and the card): a step being done is ringed and numbered
 * both, and its number sits on the ring's corner. Under the ring, the
 * ring's line and its marching dots ran across the numeral; over it, it
 * reads as a badge on the ring.
 */
function drawPins(ms) {
  if (!marks.length) return;
  const bots = BOTS();
  const ink = bots ? "#ffffff" : K.color("desktop.guide.inkColor", "#E8A23C");
  const glow = bots ? "transparent" : rgba(ink, .55);
  ctx.save();
  for (const m of marks) {
    if (!m.disc) continue;
    const a = alphaOf(m, ms);
    if (a <= 0 || ms < m.start) continue;
    const k = reduced ? 1 : clamp((ms - m.start) / m.dur), s = reduced ? 1 : outBack(k);
    ctx.save();
    ctx.globalAlpha = a * clamp(k * 4);
    ctx.translate(m.disc.x, m.disc.y); ctx.scale(s, s);
    ctx.beginPath(); ctx.arc(0, 0, 12.4, 0, TAU); ctx.fillStyle = "rgba(15,13,11,.38)"; ctx.fill();
    ctx.beginPath(); ctx.arc(0, 0, 11, 0, TAU); ctx.fillStyle = "#0F0D0B"; ctx.fill();
    ctx.shadowColor = glow; ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.arc(0, 0, 10, 0, TAU); ctx.strokeStyle = ink; ctx.lineWidth = 2; ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#F3E2C6"; ctx.font = '600 12px "Instrument Sans", -apple-system, "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(m.disc.n), 0, .5);
    ctx.restore();
  }
  for (const m of marks) {
    const L = m.label;
    if (!L || !L.placed || ms < L.at) continue;
    const a = alphaOf(m, ms) * (reduced ? 1 : clamp((ms - L.at) / 160));
    if (a <= 0) continue;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(L.x + L.w / 2, L.y + L.h / 2); ctx.rotate(L.rot);
    ctx.beginPath(); ctx.roundRect(-L.w / 2, -L.h / 2, L.w, L.h, 8);
    ctx.fillStyle = "rgba(15,13,11,.86)"; ctx.fill();
    ctx.strokeStyle = "rgba(243,226,198,.14)"; ctx.lineWidth = 1; ctx.stroke();
    // The words, written out left to right.
    const wk = reduced ? 1 : outCubic((ms - L.at - 60) / L.writeMs);
    if (wk > 0) {
      ctx.beginPath(); ctx.rect(-L.w / 2, -L.h / 2 - 6, 6 + (L.w - 8) * wk, L.h + 12); ctx.clip();
      ctx.fillStyle = "#F3E2C6"; ctx.font = labelFont(L.size); ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(L.text, -L.w / 2 + 8, 1);
    }
    ctx.restore();
  }
  ctx.restore();
}
