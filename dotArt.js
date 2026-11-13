// GENERATED: do not edit. Dot art that obeys physics: the rules of the DotArt node, shared with the phone.
// Source: TAILZU-FRONTEND/app/src/sdui/bots/dotArtCore.ts; regenerate with `node src/sdui/bots/genDotArt.mjs` there.
// dotArtCore.ts sha256 8dbbe4fc8a8fc4a18fdf022b9eff599fcf8ecbf98d088225f06e8537727c6759
// body sha256 b172b91f4dfe18ceb003bd04fc7b714fe818172f34aee90ef6f271541317dbbe
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.TailzuDotArt = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  /**
   * DOT ART THAT OBEYS PHYSICS: the rules of the DotArt node (DotArt.tsx), with no React, no Skia and no imports, so the window runs
   * the very same file (genDotArt.mjs writes TAILZU-DESKTOP/dotArt.js from it) and the tests step it in plain Node.
   *
   * A picture is dots: each has a home (x, y in points), a radius and a tone (how much ink: 1 is ink, less is grey). The server
   * draws every chart, meter and drawing a bot makes this way (TAILZU-BACKEND src/show/dots.ts), monochrome, so they all share one
   * look; this makes the dots live. Every dot is a point mass, and nothing moves it but forces:
   *
   *   spring    Hooke's law back to its home, a = -k (p - home)
   *   damping   a = -c v, with c = 2 ζ √k: under-damped, so a dot overshoots a little and settles, as a weight on a spring does
   *   gravity   a = g, downward, for a dot that is falling in and has not reached its home yet (the spring takes it from there)
   *   a touch   an impulse, Δv = J e^-(d/R)² away from the finger: a tap scatters the dots near it and the springs bring them back
   *   a hold    while a finger (or the pointer, in the window) is on the picture, a push away from it with the same falloff
   *   heat      a thermal jitter for a picture that should never be quite still: random force with the damping it needs to stay at
   *             a temperature (fluctuation–dissipation: σ² = 2 c T), so the dots tremble about their homes by `heat` points
   *
   * How a picture comes in (`enter`), each a matter of where the dots start and when they are let go, never a timed curve:
   *
   *   fall      from above the picture, let go in order (by `group`), under gravity, caught by their springs at home
   *   grow      from the left edge of their row, let go left to right: a bar or a line drawn out by springs
   *   gather    from scattered places near home, let go by group, pulled together by their springs
   *   none      at home: an older answer, or Reduce Motion
   *
   * It steps on a fixed 1/120 s clock (semi-implicit Euler, a few steps a frame at most) and goes to sleep once every dot is home and
   * still, so a settled picture costs nothing until it is touched again. Same seed, same frames.
   */
  /** The numbers of the physics, in points and seconds. A host may override any of them (the phone's knobs, the window's). */
  const DOT_PHYSICS = {
      /** Spring stiffness, 1/s². */
      k: 180,
      /** Damping ratio: under 1 overshoots and settles. */
      zeta: 0.45,
      /** Gravity for a falling dot, points/s². */
      g: 2600,
      /** A tap: the impulse at its centre (points/s) and its reach (points). */
      tap: 420,
      reach: 46,
      /** A hold: the push at its centre (points/s²). The window's hover pushes a third as hard. */
      hold: 9000,
      /** Heat 1 makes the dots tremble this much about home, points (rms). */
      tremble: 1.2,
      /** The clock: one step, and the most steps one frame may take. */
      step: 1 / 120,
      maxSteps: 8,
      /** Asleep once every dot is this close to home (points) and this slow (points/s). */
      restAt: 0.06,
      restSpeed: 0.6,
      /** How long the release of a whole picture is spread over, seconds. */
      spread: 0.45,
  };
  const DOT_ENTERS = ["fall", "grow", "gather", "none"];
  /** The most dots one picture may have. */
  const MAX_DOTS = 1600;
  const PER_DOT = 5;
  const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  /** A string's own number, for a seed. */
  function hashSeed(s) {
      let h = 2166136261;
      for (let i = 0; i < s.length; i++) {
          h ^= s.charCodeAt(i);
          h = Math.imul(h, 16777619);
      }
      return h >>> 0;
  }
  /** What the server sent, read safely: a picture with no dots, or none that fit, is null (the host draws nothing). */
  function readDotArt(props) {
      const p = (props && typeof props === "object" ? props : {});
      const w = num(p.w, 0), h = num(p.h, 0);
      if (!(w > 0 && h > 0 && w <= 4000 && h <= 4000))
          return null;
      const d = Array.isArray(p.d) ? p.d : [];
      const n = Math.min(MAX_DOTS, Math.floor(d.length / PER_DOT));
      const x = new Float32Array(n), y = new Float32Array(n), r = new Float32Array(n), t = new Float32Array(n), g = new Float32Array(n);
      let m = 0;
      for (let i = 0; i < n; i++) {
          const o = i * PER_DOT;
          const dx = num(d[o], NaN), dy = num(d[o + 1], NaN), dr = num(d[o + 2], NaN);
          if (!Number.isFinite(dx) || !Number.isFinite(dy) || !(dr > 0))
              continue;
          x[m] = dx;
          y[m] = dy;
          r[m] = Math.min(dr, 40);
          t[m] = clamp(num(d[o + 3], 1), 0.05, 1);
          g[m] = Math.max(0, num(d[o + 4], 0));
          m += 1;
      }
      if (!m)
          return null;
      const enter = DOT_ENTERS.includes(p.enter) ? p.enter : "none";
      const ink = typeof p.ink === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(p.ink) ? p.ink : "#0a0a0a";
      const key = typeof p.key === "string" ? p.key.slice(0, 200) : "";
      return {
          w, h, x: x.subarray(0, m), y: y.subarray(0, m), r: r.subarray(0, m), t: t.subarray(0, m), g: g.subarray(0, m), n: m,
          enter, heat: clamp(num(p.heat, 0), 0, 1), ink, seed: typeof p.seed === "number" ? p.seed >>> 0 : hashSeed(key || `${w}x${h}:${m}`), key,
          label: typeof p.label === "string" ? p.label.slice(0, 200) : "",
      };
  }
  /** A small seeded random source (mulberry32), and normal draws from it. */
  class Rand {
      constructor(seed) {
          this.spare = null;
          this.s = seed >>> 0 || 1;
      }
      next() {
          this.s = (this.s + 0x6d2b79f5) >>> 0;
          let z = this.s;
          z = Math.imul(z ^ (z >>> 15), z | 1);
          z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
          return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
      }
      normal() {
          if (this.spare !== null) {
              const v = this.spare;
              this.spare = null;
              return v;
          }
          const u = Math.max(1e-9, this.next()), v = this.next();
          const m = Math.sqrt(-2 * Math.log(u));
          this.spare = m * Math.sin(2 * Math.PI * v);
          return m * Math.cos(2 * Math.PI * v);
      }
  }
  /** The tones a picture is drawn in: four, so a frame is a handful of calls. */
  const TONES = [1, 0.62, 0.36, 0.18];
  const toneOf = (t) => { let b = 0; for (let i = 1; i < TONES.length; i++)
      if (Math.abs(TONES[i] - t) < Math.abs(TONES[b] - t))
          b = i; return b; };
  class DotField {
      /** `motion` false (Reduce Motion, a still turn): every dot at home, and nothing ever moves it. */
      constructor(spec, o = { motion: true }) {
          this.time = 0;
          this.awake = false;
          this.acc = 0;
          this.hold = null;
          this.buckets = [];
          this.order = [];
          this.spec = spec;
          this.phys = { ...DOT_PHYSICS, ...(o.phys ?? {}) };
          this.c = 2 * this.phys.zeta * Math.sqrt(this.phys.k);
          const n = spec.n;
          this.px = Float32Array.from(spec.x);
          this.py = Float32Array.from(spec.y);
          this.vx = new Float32Array(n);
          this.vy = new Float32Array(n);
          this.release = new Float32Array(n);
          this.caught = new Uint8Array(n).fill(1);
          this.rand = new Rand(spec.seed);
          this.motion = o.motion;
          if (o.motion && spec.enter !== "none")
              this.enter(spec.enter);
          this.awake = o.motion && (spec.enter !== "none" || spec.heat > 0);
          this.sortBuckets();
      }
      /** Where the dots start and when each is let go. */
      enter(how) {
          const s = this.spec, P = this.phys, R = this.rand;
          let gMax = 0;
          for (let i = 0; i < s.n; i++)
              gMax = Math.max(gMax, s.g[i]);
          const diag = Math.hypot(s.w, s.h);
          for (let i = 0; i < s.n; i++) {
              const byGroup = gMax > 0 ? (s.g[i] / gMax) * P.spread : 0;
              if (how === "fall") {
                  this.px[i] = s.x[i];
                  this.py[i] = s.y[i] - (s.h * 0.55 + R.next() * s.h * 0.35 + 24);
                  this.caught[i] = 0;
                  this.release[i] = byGroup + R.next() * 0.08;
              }
              else if (how === "grow") {
                  this.px[i] = 0;
                  this.py[i] = s.y[i];
                  this.release[i] = (s.x[i] / s.w) * P.spread + byGroup * 0.5;
              }
              else {
                  const a = R.next() * Math.PI * 2, d = (0.25 + R.next() * 0.35) * diag * 0.5;
                  this.px[i] = clamp(s.x[i] + Math.cos(a) * d, 0, s.w);
                  this.py[i] = clamp(s.y[i] + Math.sin(a) * d, 0, s.h);
                  this.release[i] = byGroup + R.next() * 0.1;
              }
          }
      }
      /** Advances the clock by `dt` seconds. True while anything still moves (the host keeps drawing). */
      frame(dt) {
          if (!this.motion || !this.awake)
              return false;
          const P = this.phys;
          this.acc += Math.min(Math.max(dt, 0), P.step * P.maxSteps);
          let steps = 0;
          while (this.acc >= P.step && steps < P.maxSteps) {
              this.stepOnce(P.step);
              this.acc -= P.step;
              steps += 1;
          }
          if (this.atRest())
              this.sleep();
          return this.awake;
      }
      stepOnce(h) {
          const s = this.spec, P = this.phys, c = this.c, k = P.k;
          this.time += h;
          const heat = s.heat > 0 ? Math.sqrt(2 * c * k * (s.heat * P.tremble) ** 2 / h) : 0;
          const hold = this.hold, inv = 1 / (P.reach * P.reach);
          for (let i = 0; i < s.n; i++) {
              if (this.time < this.release[i])
                  continue;
              let ax = 0, ay = 0;
              const vx = this.vx[i], vy = this.vy[i];
              if (this.caught[i]) {
                  ax = -k * (this.px[i] - s.x[i]) - c * vx;
                  ay = -k * (this.py[i] - s.y[i]) - c * vy;
                  if (heat) {
                      ax += heat * this.rand.normal();
                      ay += heat * this.rand.normal();
                  }
              }
              else {
                  ay = P.g;
              }
              if (hold) {
                  const dx = this.px[i] - hold.x, dy = this.py[i] - hold.y, d2 = dx * dx + dy * dy;
                  const f = hold.power * Math.exp(-d2 * inv) / Math.max(1, Math.sqrt(d2));
                  ax += dx * f;
                  ay += dy * f;
              }
              const nvx = vx + ax * h, nvy = vy + ay * h;
              this.vx[i] = nvx;
              this.vy[i] = nvy;
              this.px[i] = this.px[i] + nvx * h;
              this.py[i] = this.py[i] + nvy * h;
              // A falling dot that reaches its home is caught there, still moving: the spring now holds it and takes the fall.
              if (!this.caught[i] && this.py[i] >= s.y[i])
                  this.caught[i] = 1;
          }
      }
      /** Every dot let go, caught, home and still, with no heat and no finger on it. */
      atRest() {
          const s = this.spec, P = this.phys;
          if (s.heat > 0 || this.hold)
              return false;
          for (let i = 0; i < s.n; i++) {
              if (this.time < this.release[i] || !this.caught[i])
                  return false;
              if (Math.abs(this.px[i] - s.x[i]) > P.restAt || Math.abs(this.py[i] - s.y[i]) > P.restAt)
                  return false;
              if (Math.abs(this.vx[i]) > P.restSpeed || Math.abs(this.vy[i]) > P.restSpeed)
                  return false;
          }
          return true;
      }
      /** At rest: every dot exactly home, and no more frames until something touches it. */
      sleep() {
          this.px.set(this.spec.x);
          this.py.set(this.spec.y);
          this.vx.fill(0);
          this.vy.fill(0);
          this.awake = false;
      }
      /** A tap at (x, y): an impulse away from it on the dots near it. Returns whether the field woke. */
      poke(x, y, power = 1) {
          if (!this.motion)
              return false;
          const s = this.spec, P = this.phys, inv = 1 / (P.reach * P.reach);
          let moved = false;
          for (let i = 0; i < s.n; i++) {
              if (this.time < this.release[i])
                  continue;
              const dx = this.px[i] - x, dy = this.py[i] - y, d2 = dx * dx + dy * dy;
              const j = P.tap * power * Math.exp(-d2 * inv);
              if (j < 1)
                  continue;
              const d = Math.max(1, Math.sqrt(d2));
              this.vx[i] = this.vx[i] + (dx / d) * j;
              this.vy[i] = this.vy[i] + (dy / d) * j;
              moved = true;
          }
          if (moved)
              this.awake = true;
          return moved;
      }
      /** A finger or pointer held at (x, y), pushing (`power` 1 a finger; the window's hover is gentler). Null lets go. */
      press(at) {
          if (!this.motion)
              return;
          this.hold = at ? { x: at.x, y: at.y, power: this.phys.hold * (at.power ?? 1) } : null;
          if (at)
              this.awake = true;
      }
      sortBuckets() {
          const s = this.spec;
          const map = new Map();
          for (let i = 0; i < s.n; i++) {
              const r = Math.round(s.r[i] * 4) / 4, tone = toneOf(s.t[i]);
              const key = `${r}|${tone}`;
              let b = map.get(key);
              if (!b) {
                  b = { r, tone, xy: new Float32Array(0), n: 0, idx: [] };
                  map.set(key, b);
              }
              b.idx.push(i);
          }
          this.order = [];
          // The faintest first, so the ink is drawn over the grey.
          this.buckets = [...map.values()].sort((a, b) => b.tone - a.tone).map((b) => {
              this.order.push(Int32Array.from(b.idx));
              return { r: b.r, tone: b.tone, xy: new Float32Array(b.idx.length * 2), n: 0 };
          });
      }
      /** The picture as it is now: one call per radius and tone where the host can (Skia's points), else a circle each. */
      draw(g) {
          const ink = this.spec.ink;
          const alpha = g.globalAlpha;
          this.buckets.forEach((b, bi) => {
              const idx = this.order[bi];
              let n = 0;
              for (let q = 0; q < idx.length; q++) {
                  const i = idx[q];
                  if (this.time < this.release[i])
                      continue;
                  b.xy[n * 2] = this.px[i];
                  b.xy[n * 2 + 1] = this.py[i];
                  n += 1;
              }
              b.n = n;
              if (!n)
                  return;
              g.globalAlpha = alpha * TONES[b.tone];
              if (g.dots) {
                  g.dots(b.xy, n, b.r, ink);
                  return;
              }
              g.fillStyle = ink;
              g.beginPath();
              for (let q = 0; q < n; q++) {
                  const x = b.xy[q * 2], y = b.xy[q * 2 + 1];
                  // Each circle starts a figure of its own: without the move, a canvas joins one to the next and fills the shape between.
                  g.moveTo(x + b.r, y);
                  g.arc(x, y, b.r, 0, Math.PI * 2);
              }
              g.fill();
          });
          g.globalAlpha = alpha;
      }
  }
  /** Pictures kept by `key` while the app runs, so a screen refreshed under the person does not bring them in again. */
  class Kept {
      constructor(max = 120) {
          this.map = new Map();
          this.max = max;
      }
      get(key) { return key ? this.map.get(key) : undefined; }
      put(key, f) {
          if (!key)
              return;
          this.map.delete(key);
          this.map.set(key, f);
          while (this.map.size > this.max)
              this.map.delete(this.map.keys().next().value);
      }
  }
  /**
   * The field for a node: the one kept under its key when its picture is the same (a repaint, a refresh), else a new one, coming in
   * as the node says only when `entering` (the chat's newest answer) and motion is on.
   */
  function fieldFor(kept, spec, o) {
      const old = kept.get(spec.key);
      if (old && old.motion === o.motion && sameDots(old.spec, spec))
          return old;
      const f = new DotField(o.entering ? spec : { ...spec, enter: "none" }, { motion: o.motion, ...(o.phys ? { phys: o.phys } : {}) });
      kept.put(spec.key, f);
      return f;
  }
  function sameDots(a, b) {
      if (a.n !== b.n || a.w !== b.w || a.h !== b.h || a.heat !== b.heat)
          return false;
      for (let i = 0; i < a.n; i++)
          if (a.x[i] !== b.x[i] || a.y[i] !== b.y[i] || a.r[i] !== b.r[i])
              return false;
      return true;
  }
  return { DOT_PHYSICS, DOT_ENTERS, MAX_DOTS, hashSeed, readDotArt, Rand, DotField, Kept, fieldFor };
});
