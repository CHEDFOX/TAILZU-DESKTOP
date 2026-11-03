// Blip strolling along the bottom of the screen (pill/ draws him): where he is and where he is going, no drawing,
// so roam.test.js can hold it to the rules.
//
// The pill's window is as wide as the screen and click-through but for the pill, so the strip it spans is his to
// walk. He walks while nothing is asked of him: at rest with no hint open (wander), and while a task runs (work). A
// command stops him where he stands (stay), and the pill opens there: he answers from where he is, he does not
// walk back to the middle first. Going to rest at the screen's edge, he walks off it (leave), in the time given.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.TailzuRoam = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  /**
   * createRoam({ rnd }) → { step(i, dt), place(x), x }. x is his offset from the middle of the strip, px.
   * step's i: { mode: "stay" | "wander" | "work" | "leave", now (ms), span (px either side), speed (px/s),
   *   pauseMs: [min, max] between walks, free (he is not in the middle of a gesture: a new walk may start),
   *   avoid ([lo, hi] px: keep to his side of it), leaveTo (px, past the strip's end), leaveMs }.
   * Returns { x, dir (-1 left, 1 right), walking, arrived (this step) }.
   */
  function createRoam(o) {
    const rnd = (o && o.rnd) || Math.random;
    const me = { x: 0, to: null, dir: 1, next: 0, speed: 0, mode: null };
    const pause = (i) => { const p = i.pauseMs || [5000, 10000]; return p[0] + rnd() * Math.max(0, p[1] - p[0]); };
    /** Somewhere else in the strip, at least a quarter of it away, so a walk is a walk. With `avoid` ([lo, hi], the
     *  pill while a task's label is on it) only on his own side of it: he never walks across the label. */
    function pick(span, avoid) {
      let lo = -span, hi = span;
      if (avoid) { if (me.x <= (avoid[0] + avoid[1]) / 2) hi = Math.min(hi, avoid[0]); else lo = Math.max(lo, avoid[1]); }
      if (hi - lo < 1) return null;
      for (let k = 0; k < 4; k++) { const t = lo + rnd() * (hi - lo); if (Math.abs(t - me.x) >= (hi - lo) * 0.25) return t; }
      return Math.abs(lo - me.x) > Math.abs(hi - me.x) ? (lo + me.x) / 2 : (hi + me.x) / 2;
    }
    function step(i, dt) {
      const span = Math.max(0, i.span || 0);
      let arrived = false;
      // Each spell of strolling (or of work) starts with its own pause: he does not set off the moment it begins.
      if (i.mode !== me.mode) { me.mode = i.mode; if (i.mode !== "leave") me.next = i.now + pause(i); }
      if (i.mode === "stay") {
        // Stopped where he is.
        me.to = null;
        return { x: me.x, dir: me.dir, walking: false, arrived };
      }
      if (i.mode === "leave") {
        if (me.to !== i.leaveTo) { me.to = i.leaveTo; me.speed = Math.max(i.speed || 0, Math.abs(me.to - me.x) / Math.max(0.2, (i.leaveMs || 0) / 1000)); }
      } else {
        // A strip that shrank (a smaller screen) takes him in with it.
        if (Math.abs(me.x) > span) { me.x = clamp(me.x, -span, span); if (me.to !== null) me.to = clamp(me.to, -span, span); }
        if (me.to === null && i.free && i.now >= me.next && span > 0) { me.to = pick(span, i.avoid); me.speed = i.speed || 60; if (me.to === null) me.next = i.now + pause(i); }
      }
      if (me.to !== null) {
        const d = me.to - me.x, s = me.speed * Math.max(0, dt);
        me.dir = d < 0 ? -1 : 1;
        if (Math.abs(d) <= s) { me.x = me.to; me.to = null; arrived = true; me.next = i.now + pause(i); } else me.x += Math.sign(d) * s;
      }
      return { x: me.x, dir: me.dir, walking: me.to !== null, arrived };
    }
    /** Put him somewhere at once (back in the pill after the screen's edge: the middle). */
    function place(x) { me.x = x; me.to = null; }
    return { step, place, get x() { return me.x; } };
  }

  return { createRoam };
});
