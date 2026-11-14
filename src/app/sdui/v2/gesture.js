// Gestures on any node, into state (SPEC 2.5, B5), from pointer events.
//
// The two kinds of `ui.*` value are the whole design: while the pointer moves, `ui.<into>.x | y | progress` live
// here and only `motion.drive` reads them; when it lifts they are written to the store, once, and `commitIf`,
// `onCommit` and the rules see them. A mouse has no pinch, so `pinch` is not one of the kinds this window has.

const V2_GESTURE_KINDS = ["tap", "doubleTap", "longPress", "drag", "pan", "swipe", "hover"];
const V2_GESTURE_LIMITS = { perScreen: 12, perNode: 6, snaps: 16 };
const V2_GESTURE_DEFAULTS = {
  doubleTapMs: 260, longPressMs: 500, slopPx: 12, swipeDistance: 48, swipeVelocity: 320,
  projectMs: 90, springK: 220, springDamp: 0.85, rubberPx: 120,
};

/** What a gesture's values are called under `ui.`, checked the way every other path is. */
function v2IntoOk(name) {
  const k = v2Kernel();
  return typeof name === "string" && !!name && (!k || k.statePathOk(name));
}

/** Read one of this gesture's numbers back, for `motion.drive` to follow. */
function v2UiRead(path) {
  const parts = String(path || "").replace(/^ui\./, "").split(".");
  let at = V2.ui;
  for (const p of parts) { if (at == null) return 0; at = at[p]; }
  return typeof at === "number" ? at : 0;
}

/** Put a gesture's values where expressions can read them, and (at the end only) in the store. */
function v2UiWrite(into, values, toStore) {
  if (!v2IntoOk(into)) return;
  V2.ui[into] = Object.assign({}, V2.ui[into], values);
  if (!toStore) return;
  for (const key of Object.keys(values)) setStatePath("ui." + into + "." + key, values[key]);
}

/** The knob of a drag, held inside its run, with a little give past each end. */
function v2Rubber(v, min, max, give) {
  if (v < min) return min - Math.min(give, (min - v) * 0.5);
  if (v > max) return max + Math.min(give, (v - max) * 0.5);
  return v;
}

/** Where a drag settles: its own speed carries it, then the nearest snap point wins. */
function v2Settle(v, speed, snaps, min, max, projectMs) {
  const to = v + speed * (projectMs / 1000);
  const held = Math.max(min, Math.min(max, to));
  if (!Array.isArray(snaps) || !snaps.length) return held;
  let best = held, gap = Infinity;
  for (const s of snaps.slice(0, V2_GESTURE_LIMITS.snaps)) {
    const n = Number(s);
    if (!Number.isFinite(n)) continue;
    const d = Math.abs(n - held);
    if (d < gap) { gap = d; best = n; }
  }
  return best;
}

/** Which way a swipe went, or "" when it was neither far enough nor fast enough. */
function v2SwipeWay(dx, dy, ms, g) {
  const far = Number(g.distance) > 0 ? Number(g.distance) : V2_GESTURE_DEFAULTS.swipeDistance;
  const fast = Number(g.velocity) > 0 ? Number(g.velocity) : V2_GESTURE_DEFAULTS.swipeVelocity;
  const seconds = Math.max(0.001, ms / 1000);
  const axis = g.axis === "y" ? "y" : g.axis === "x" ? "x" : Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
  const d = axis === "x" ? dx : dy;
  if (Math.abs(d) < far && Math.abs(d) / seconds < fast) return "";
  if (axis === "x") return d < 0 ? "left" : "right";
  return d < 0 ? "up" : "down";
}

/** Everything a node's `gestures` list says, cleaned up. Unknown kinds are dropped, never drawn as something else. */
function v2Gestures(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const g of list.slice(0, V2_GESTURE_LIMITS.perNode)) {
    if (!g || typeof g !== "object") continue;
    if (V2_GESTURE_KINDS.indexOf(g.kind) === -1) continue;
    out.push(g);
  }
  return out;
}

/** Ask the gesture's own question, then do what it says. */
function v2GestureEnd(g, values) {
  if (g.into) v2UiWrite(g.into, values, true);
  const k = v2Kernel();
  let ok = true;
  if (g.commitIf && k && k.isExprCondition(g.commitIf)) ok = v2Cond(g.commitIf, v2Scope()) === true;
  if (ok && g.onCommit) void run(g.onCommit, values);
  if (!ok && g.onCancel && g.onCancel.kind !== "spring") void run(g.onCancel, values);
  if (g.do) void run(g.do, values);
  if (typeof repaint === "function") repaint();
}

/** Wire one node's gestures to its element. */
function v2GestureWire(el, list, live) {
  for (const g of list) {
    if (live.count >= V2_GESTURE_LIMITS.perScreen) return;
    live.count += 1;
    if (g.kind === "hover") {
      el.addEventListener("pointerenter", () => { if (g.into) v2UiWrite(g.into, { progress: 1 }, true); if (g.do) void run(g.do, true); });
      el.addEventListener("pointerleave", () => { if (g.into) v2UiWrite(g.into, { progress: 0 }, true); });
      continue;
    }
    if (g.kind === "tap" || g.kind === "doubleTap" || g.kind === "longPress") {
      let taps = 0, at = 0, hold = null, from = null;
      el.addEventListener("pointerdown", (e) => {
        from = { x: e.clientX || 0, y: e.clientY || 0 };
        if (g.kind !== "longPress") return;
        const ms = Number(g.hold) > 0 ? Number(g.hold) : V2_GESTURE_DEFAULTS.longPressMs;
        hold = setTimeout(() => { hold = null; from = null; v2GestureEnd(g, { progress: 1 }); }, ms);
      });
      el.addEventListener("pointerup", (e) => {
        if (hold) { clearTimeout(hold); hold = null; }
        if (!from) return;
        const slop = Number(g.slop) > 0 ? Number(g.slop) : V2_GESTURE_DEFAULTS.slopPx;
        const moved = Math.abs((e.clientX || 0) - from.x) > slop || Math.abs((e.clientY || 0) - from.y) > slop;
        from = null;
        if (moved || g.kind === "longPress") return;
        if (g.kind === "tap") { v2GestureEnd(g, { progress: 1 }); return;}
        const want = Math.max(2, Math.min(3, Number(g.taps) || 2));
        const window_ = Number(g.window) > 0 ? Number(g.window) : V2_GESTURE_DEFAULTS.doubleTapMs;
        const now = v2Now();
        taps = now - at <= window_ ? taps + 1 : 1;
        at = now;
        if (taps >= want) { taps = 0; v2GestureEnd(g, { progress: 1 }); }
      });
      el.addEventListener("pointercancel", () => { if (hold) { clearTimeout(hold); hold = null; } from = null; });
      continue;
    }
    // drag, pan and swipe all follow the pointer; only what happens at the end differs.
    const axis = g.axis === "y" ? "y" : g.axis === "both" ? "both" : "x";
    const min = Number.isFinite(Number(g.min)) ? Number(g.min) : 0;
    const max = Number.isFinite(Number(g.max)) ? Number(g.max) : 0;
    const give = g.rubber === true ? V2_GESTURE_DEFAULTS.rubberPx : Number(g.rubber) > 0 ? Number(g.rubber) : 0;
    let start = null;
    el.addEventListener("pointerdown", (e) => {
      start = { x: e.clientX || 0, y: e.clientY || 0, at: v2Now(), ox: (V2.ui[g.into] && V2.ui[g.into].x) || 0, oy: (V2.ui[g.into] && V2.ui[g.into].y) || 0 };
      if (el.setPointerCapture && e.pointerId != null) { try { el.setPointerCapture(e.pointerId); } catch { /* no capture */ } }
    });
    el.addEventListener("pointermove", (e) => {
      if (!start) return;
      const dx = (e.clientX || 0) - start.x, dy = (e.clientY || 0) - start.y;
      // While the pointer is down these stay here: only motion.drive reads them, so nothing repaints per frame.
      const x = axis === "y" ? start.ox : v2Rubber(start.ox + dx, min, max || min, give);
      const y = axis === "x" ? start.oy : v2Rubber(start.oy + dy, min, max || min, give);
      const span = (max || 0) - min;
      if (g.into) v2UiWrite(g.into, { x, y, progress: span > 0 ? Math.max(0, Math.min(1, ((axis === "y" ? y : x) - min) / span)) : 0 }, false);
      if (live.drives) for (const apply of live.drives) apply();
    });
    const up = (e) => {
      if (!start) return;
      const dx = (e.clientX || 0) - start.x, dy = (e.clientY || 0) - start.y;
      const ms = v2Now() - start.at;
      const was = start;
      start = null;
      if (g.kind === "swipe") {
        const way = v2SwipeWay(dx, dy, ms, g);
        if (!way) { if (g.onCancel && g.onCancel.kind !== "spring") void run(g.onCancel, ""); return; }
        const named = { left: g.onLeft, right: g.onRight, up: g.onUp, down: g.onDown }[way];
        if (named) void run(named, way);
        v2GestureEnd(g, { progress: 1, way });
        return;
      }
      const projectMs = Number(g.projectMs) >= 0 ? Number(g.projectMs) : V2_GESTURE_DEFAULTS.projectMs;
      const moved = axis === "y" ? dy : dx;
      const speed = ms > 0 ? (moved / ms) * 1000 : 0;
      const landed = v2Settle((axis === "y" ? was.oy : was.ox) + moved, speed, g.snap, min, max || min, projectMs);
      const span = (max || 0) - min;
      const values = axis === "y" ? { y: landed, x: was.ox } : { x: landed, y: was.oy };
      values.progress = span > 0 ? Math.max(0, Math.min(1, (landed - min) / span)) : 0;
      if (g.into) v2UiWrite(g.into, values, false);
      if (live.drives) for (const apply of live.drives) apply();
      v2GestureEnd(g, values);
    };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }
}
