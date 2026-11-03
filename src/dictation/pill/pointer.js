// The pointer: the window lets clicks through everywhere but the pill.
"use strict";

// Parted for a question, the pill is the gap wider (askGapPx; 0 otherwise).
function pillRect() { const bottom = H - K.num("desktop.pill.bottomPad", 14); return { x: W / 2 - P.w / 2 - askGapPx / 2, y: bottom - P.h, w: P.w + askGapPx, h: P.h }; }
function podsNow() { return SP.pods(podSeed(), W, clamp(splitT), INSET()); }
const apart = () => splitT > 0.02;
function inside(x, y, pad = 4) {
  // Hidden (Blip over a text box, or no rest pill), it takes nothing: the app under it keeps its clicks.
  if (P.show < 0.5) return false;
  // Apart, only the two halves take the pointer: the thread and the screen
  // between them stay the app's, clicks and all.
  if (apart()) return !!SP.podAt(podsNow(), x, y, pad);
  const r = pillRect(); return x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;
}
function onCancel(x, y) {
  if (S.name !== "listening") return false;
  if (BLIP()) return false;
  if (BOTS()) { const c = botsCancel(); return Math.hypot(x - c.x, y - c.y) <= c.r + 2; }
  if (apart()) return SP.podAt(podsNow(), x, y, 0) === "cancel";
  const r = pillRect(); return Math.hypot(x - (r.x + r.h / 2), y - (r.y + r.h / 2)) <= r.h / 2;
}
function setHover(v) {
  if (v === hovered) return;
  hovered = v;
  if (bridge && bridge.pillHover) bridge.pillHover(v);
  wake();
}
let pointer = null;   // where the pointer was last seen over this window
function hoverAt(x, y) {
  // Only a visible pill takes the pointer; an invisible rest pill is nothing.
  const live = S.name !== "rest" || restShown;
  setHover(live && inside(x, y));
  const oc = onCancel(x, y); if (oc !== overCancel) { overCancel = oc; wake(); }
}
window.addEventListener("mousemove", (e) => { pointer = { x: e.clientX, y: e.clientY }; hoverAt(pointer.x, pointer.y); });
document.addEventListener("mouseleave", () => { pointer = null; setHover(false); overCancel = false; });
window.addEventListener("mousedown", (e) => {
  if (!inside(e.clientX, e.clientY)) return;
  // Halves on their way home after a stop are not buttons any more.
  if (apart() && S.name !== "listening") return;
  const act = S.name === "rest" ? "start" : S.name === "listening" ? (onCancel(e.clientX, e.clientY) ? "cancel" : "finish")
    // A question up: a press puts it away, as Esc does. Closing, it is
    // already going.
    : S.name === "ask" ? (S.data.phase === "closing" ? null : "askCancel")
    // A route's label: its alternative, when it has one.
    : S.name === "routed" ? (S.data.alt ? "alt" : null)
    // Talk mode: a press ends it.
    : S.name === "talk" ? "talkEnd" : null;
  if (act && bridge && bridge.pillAction) bridge.pillAction(act);
});
