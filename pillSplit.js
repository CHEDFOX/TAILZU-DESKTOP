// The split pill (pill.js draws it): while it listens the pill comes apart,
// ✕ to one edge of the screen and ✓ to the other, and the body between them
// stretches into a thread the voice plucks. On stop the halves glide back and
// the pill is whole again where it started. Geometry and motion only, no
// drawing, so pillSplit.test.js can hold it to the design.
//
// Why a thread. The owner, of the bars and the waves before it: "the
// listening wave part is not good … think something out of the box". A meter
// says how loud. A string held between the two things you can do next (throw
// it away, keep it) says the pill is open and waiting, and your voice is what
// moves it: slack and barely trembling when you are quiet, ringing when you
// talk, plucked when a pause writes a chunk.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.TailzuPillSplit = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const frac = (v) => v - Math.floor(v);

  /** Slow out of place, slow into place: the halves glide, they do not snap. */
  function easeInOut(t) {
    t = clamp(t);
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  /**
   * THE PULL. The separation is not paced on a clock — it is a DAMPED SPRING,
   * so the thread between the halves reads as a physical thing. Coming apart
   * (target 1) it eases out taut, well damped, barely past the edge. Going
   * home (target 0) it is pulled: a stiff, lightly-damped yank that
   * accelerates the halves inward and overshoots the join a touch — the
   * capsule's click-shut (pill.js snapAt) absorbs the overshoot, so it looks
   * like the thread's tension snapped them back into one pill.
   *
   * `s` is { x, v }, mutated in place and returned. `target` is 0 (home) or 1
   * (apart). Params are read per call (a server knob lands next frame); the
   * two directions carry their own stiffness and damping. Integrated with
   * sub-stepped semi-implicit Euler, so a long frame cannot blow it up, and
   * the overshoot is bounded both ways.
   */
  const SPRING = { outStiff: 120, outDamp: 24, inStiff: 240, inDamp: 16 };
  function spring(s, target, opts, dt) {
    const o = Object.assign({}, SPRING, opts);
    const out = target > 0.5;                       // coming apart vs going home
    const stiff = out ? o.outStiff : o.inStiff;
    const damp = out ? o.outDamp : o.inDamp;
    const d = Math.min(0.05, Math.max(0, +dt || 0));
    let n = Math.max(1, Math.ceil(d / 0.008));
    const h = d / n;
    while (n--) {
      const a = stiff * (target - s.x) - damp * s.v;
      s.v += a * h;
      s.x += s.v * h;
    }
    // The pull may ride a little past the join; the stretch a little past the
    // edge. Bounded, and the velocity into a wall is spent there.
    if (s.x < -0.12) { s.x = -0.12; if (s.v < 0) s.v = 0; }
    else if (s.x > 1.12) { s.x = 1.12; if (s.v > 0) s.v = 0; }
    return s;
  }

  /** True while the spring is still carrying the halves to `target`. */
  function springMoving(s, target) {
    return Math.abs(s.v) > 0.03 || Math.abs(target - s.x) > 0.003;
  }

  /** 0 below a, 1 above b, smooth between. */
  function smooth(a, b, x) {
    const t = clamp((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  }

  /**
   * Where the two halves are. `pill` is the joined pill's box ({x, y, w, h}),
   * `W` the width the window spans (the screen's work area, edge to edge),
   * `e` how far apart they are (0 joined, 1 at the edges, already eased) and
   * `inset` the room kept from each edge. Each half is a disc the pill's own
   * height, centred where the ✕ and the ✓ sit in the joined pill.
   */
  function pods(pill, W, e, inset) {
    const r = pill.h / 2, cy = pill.y + r;
    const lx0 = pill.x + r, rx0 = pill.x + pill.w - r;
    // A window narrower than the pill (a setting, an old server) leaves
    // them where they are rather than pulling them inward.
    const lx1 = Math.min(lx0, inset + r), rx1 = Math.max(rx0, W - inset - r);
    const k = clamp(e);
    return { r, cy, lx: lx0 + (lx1 - lx0) * k, rx: rx0 + (rx1 - rx0) * k };
  }

  /** Which half a point is on: "cancel" (✕), "finish" (✓), or null. */
  function podAt(p, x, y, pad = 0) {
    const reach = p.r + pad;
    if (Math.hypot(x - p.lx, y - p.cy) <= reach) return "cancel";
    if (Math.hypot(x - p.rx, y - p.cy) <= reach) return "finish";
    return null;
  }

  /**
   * How much of each piece shows at a separation `e`: the joined body fades
   * as the halves leave it, the thread arrives as the gap opens, and each
   * half gains a disc of its own as soon as it is out of the body.
   */
  function fades(e) {
    return { body: 1 - smooth(0.05, 0.4, e), thread: smooth(0.1, 0.45, e), disc: smooth(0, 0.2, e) };
  }

  /**
   * THE THREAD. A string held at both halves, its first four modes of
   * vibration driven by the voice: the low bands swing the whole string, the
   * middle and high ones ring its harmonics, each a little faster than a
   * perfect harmonic, as a real string is. A mode rises quickly with the
   * voice and dies away slowly after it. Quiet, the string hangs a little
   * slack and sways.
   *
   *   step(dt, bands, talking, o)    move the modes on by dt seconds
   *   pluck(strength, o)             a pause wrote a chunk
   *   points(x1, x2, cy, t, n, tremor, o)   its shape this frame, n+1 points
   *
   * `o`: { amp, hz, sag, attack, release } — read per call, so a knob changed
   * from the server lands on the next frame.
   */
  const THREAD = { amp: 16, hz: 5.5, sag: 3, attack: 18, release: 5 };
  function createThread() {
    const modes = [1, 2, 3, 4].map((k) => ({ k, a: 0, ph: k * 1.7 }));

    function step(dt, bands, talking, opts) {
      const o = Object.assign({}, THREAD, opts);
      const b = bands || [];
      const avg = (i, j) => {
        let s = 0, n = 0;
        for (let x = i; x < j && x < b.length; x++) { s += +b[x] || 0; n++; }
        return n ? s / n : 0;
      };
      const lo = avg(0, 3), mid = avg(3, 7), hi = avg(7, 12);
      const want = talking
        ? [clamp(lo * 1.35), 0.55 * clamp(mid * 1.5), 0.35 * clamp(hi * 1.8), 0.2 * clamp((lo + mid + hi) / 1.5)]
        : [0, 0, 0, 0];
      for (let i = 0; i < modes.length; i++) {
        const m = modes[i], target = want[i] * o.amp;
        const k = target > m.a ? o.attack : o.release;
        m.a += (target - m.a) * (1 - Math.exp(-k * dt));
        m.ph += 2 * Math.PI * o.hz * m.k * (1 + 0.04 * (m.k - 1)) * dt;
      }
    }

    function pluck(strength, opts) {
      const o = Object.assign({}, THREAD, opts);
      modes[0].a = Math.min(o.amp * 1.4, modes[0].a + o.amp * strength);
    }

    function points(x1, x2, cy, t, n, tremor, opts) {
      const o = Object.assign({}, THREAD, opts);
      const len = Math.max(0, x2 - x1);
      // A short gap (the halves just leaving) does not take a tall swing.
      const reach = clamp(len / 360);
      const sway = 1.6 * Math.sin(t * 1.3);
      const out = [];
      const steps = Math.max(2, n | 0);
      for (let i = 0; i <= steps; i++) {
        const u = i / steps, env = Math.sin(Math.PI * u);
        let y = (o.sag + sway) * env;
        for (const m of modes) y += m.a * Math.sin(m.k * Math.PI * u) * Math.sin(m.ph);
        y *= reach;
        if (tremor && i > 0 && i < steps) y += tremor(i) * env;
        out.push([x1 + len * u, cy + y]);
      }
      return out;
    }

    /** How much it is still moving: the loop keeps drawing until it settles. */
    function energy() {
      let s = 0;
      for (const m of modes) s += Math.abs(m.a);
      return s;
    }

    return { step, pluck, points, energy, modes };
  }

  /**
   * A hand's tremor: one offset per point, the same for a whole frame of the
   * boil and new at the next, so the line shivers the way a drawing does at
   * a dozen frames a second while the string itself moves smoothly.
   */
  function tremor(frame, amount) {
    return (i) => amount * (2 * frac(Math.sin(i * 12.9898 + frame * 78.233) * 43758.5453) - 1);
  }

  return { easeInOut, spring, springMoving, smooth, pods, podAt, fades, createThread, tremor, THREAD, SPRING };
});
