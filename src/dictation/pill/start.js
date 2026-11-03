// The start: the canvas fitted to the window (and again on every resize), and
// what the main process says (the pill's state, the voice's level).
"use strict";

function fit() {
  DPR = window.devicePixelRatio || 1; W = window.innerWidth; H = window.innerHeight;
  cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR); cv.style.width = W + "px"; cv.style.height = H + "px";
  wake();
  watchScale();
}
window.addEventListener("resize", fit);

// ---- the main process -----------------------------------------------------------
function onPill(m) {
  if (!m || typeof m !== "object") return;
  // Shown again: the main process has made it click-through, and the
  // pointer it last saw is from before it was hidden.
  if (m.unhover) { pointer = null; hovered = false; overCancel = false; wake(); }
  if (typeof m.hint === "string") hint = m.hint;
  if (typeof m.rest === "boolean") restShown = m.rest;
  // Blip has gone to peek over the text box (ask.js): the pill draws him again once he is back.
  // At rest Blip is at the edge of the screen (dictation/rest/): the pill shows him only once it is in use.
  if (typeof m.restAway === "boolean") { blipRestAway(m.restAway, Number(m.walkMs) || 0); wake(); if (!m.state) return; }
  if (typeof m.blipAway === "boolean") { blipAwayAt = m.blipAway ? clock() : 0; wake(); if (!m.state) return; }
  // Talk mode's voice (voice.js).
  if (m.hush) hushVoice();
  if (m.say && typeof m.say === "object") sayVoice(m.say);
  if ((m.hush || m.say) && !m.state) return;
  // Talk mode without Blip: listening while they speak (their words the caption), writing while he answers.
  if (m.state === "talk" && !BLIP()) {
    const as = m.phase === "listen" ? "listening" : "writing";
    if (S.name !== as) setState(as, m);
    if (as === "listening") caption = String(m.heard || "");
    wake();
    return;
  }
  if (m.state === "flash") { flashAt = clock(); wake(); return; }
  if (m.state === "caption") { caption = String(m.text || ""); wake(); return; }
  if (m.state) setState(m.state, m);
  else wake();
}
function onLevel(p) {
  const b = p && p.bands; if (!b || !b.length) return;
  for (let i = 0; i < bands.length; i++) bands[i] = i < b.length ? clamp(+b[i] || 0) : 0;
  bandsAt = clock(); wake();
}

if (bridge) {
  bridge.onPill && bridge.onPill(onPill);
  bridge.onLevel && bridge.onLevel(onLevel);
  bridge.onKnobs && bridge.onKnobs((k) => { K.setKnobs(k); wake(); });
  bridge.knobs && bridge.knobs().then((k) => { K.setKnobs(k); wake(); }).catch(() => {});
}
fit();
// The Bots look's faces, asked for now: a word measured before its face has loaded is measured in another.
if (document.fonts && document.fonts.load) {
  Promise.all([bFont(15), bFont(13, true)].map((f) => document.fonts.load(f).catch(() => null))).then(() => wake());
}
