// pill.html's scripts: the pill, drawn on its canvas (see pill.html for the
// states). This file holds what the rest share (the clock, colours, knobs, the
// split, the state); frame.js, capsule.js, bots.js, pointer.js and start.js
// follow it, and demo.js (the review page) comes last. They are classic
// scripts sharing the page's global scope, loaded in that order.
"use strict";
const K = window.TailzuKnobs;
const q = new URLSearchParams(location.search), DEMO = q.has("demo"), CAPTURE = q.has("capture");
const bridge = DEMO ? null : window.tailzu;

// ---- time -----------------------------------------------------------------------
let virtual = 0;
const clock = () => (CAPTURE ? virtual : performance.now());
const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const ease = (cur, tgt, k, dt) => cur + (tgt - cur) * (1 - Math.exp(-k * dt));
const outCubic = (t) => 1 - Math.pow(1 - clamp(t), 3);

// ---- colour ----------------------------------------------------------------------
function rgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [n >> 16 & 255, n >> 8 & 255, n & 255];
}
/** A knob colour at an alpha. A knob that is not a hex is used as it is. */
function rgba(hex, a) { const c = rgb(hex); return c ? `rgba(${c[0]},${c[1]},${c[2]},${clamp(a)})` : hex; }
function mixHex(a, b, t) {
  const x = rgb(a), y = rgb(b); if (!x || !y) return t < .5 ? a : b;
  const c = x.map((v, i) => Math.round(v + (y[i] - v) * clamp(t)));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// ---- knobs, read as they are used, so a change from the server lands on the next frame
const C = {
  ink: () => K.color("desktop.pill.ink", "#0F0D0B"),
  pale: () => K.color("desktop.pill.pale", "#F3E2C6"),
  amber: () => K.color("desktop.pill.live", "#E8A23C"),
  rose: () => K.color("desktop.pill.error", "#E4587B"),
};
const FONT = () => `${K.num("desktop.pill.fontWeight", 500)} ${K.num("desktop.pill.fontSize", 12)}px ${K.str("desktop.pill.font", '-apple-system, "Segoe UI", system-ui, sans-serif')}`;
const BARS = () => Math.max(5, Math.min(31, Math.round(K.num("desktop.pill.bars", 15))));

// ---- the split (pillSplit.js) -------------------------------------------------------
// Listening, the pill comes apart: ✕ to the left edge of the screen, ✓ to the
// right, a thread between them that the voice plucks. Stopped, the halves
// glide back and it is whole again where it started. The window spans the
// screen for it (main.js, desktop.pill.split).
const SP = window.TailzuPillSplit;
// THE BOTS LOOK (pill.html, DeskPill): the Bots app's switch, as the bootstrap's flags carry it. On, the pill is one
// white pill (no split, no capsule) drawn by drawBots; every state, press and hit is the same. ?demo&bots shows it.
const BOTS = () => K.bool("bots.app", false) || (DEMO && q.has("bots"));
const SPLIT = () => !BOTS() && K.bool("desktop.pill.split", true);
const INSET = () => K.num("desktop.pill.splitInset", 22);
const threadOpts = () => ({
  amp: K.num("desktop.pill.threadAmp", 16),
  hz: K.num("desktop.pill.threadHz", 5.5),
  sag: K.num("desktop.pill.threadSag", 3),
});
// THE PULL, as a damped spring (pillSplit.js spring). Coming apart eases out
// taut (out*); going home is a stiffer, lighter-damped yank that overshoots
// the join — the click-shut swallows the overshoot, so the thread looks like
// it snapped the halves back together. Server-tunable, read per frame.
const splitOpts = () => ({
  outStiff: K.num("desktop.pill.splitOutStiff", 120),
  outDamp: K.num("desktop.pill.splitOutDamp", 24),
  inStiff: K.num("desktop.pill.splitInStiff", 240),
  inDamp: K.num("desktop.pill.splitInDamp", 16),
});
// THE CAPSULE. The pill is a pill: two halves, ink and cream, that are the ✕
// and the ✓. At rest it is shut; hover opens it a little for the way in;
// listening, it opens all the way and the halves go to the edges with the
// thread between them; stopped, they click shut again where they were.
// It replaced the three dots it was.
const CAPSULE = () => SPLIT() && K.bool("desktop.pill.capsule", true);
let splitT = 0;                 // 0 joined … 1 apart (= splitState.x, a spring now)
const splitState = { x: 0, v: 0 }; // the separation's spring: position and velocity
const thread = SP.createThread();
let pluckedAt = -1e9;
let snapAt = -1e9;              // the halves met: the capsule clicks shut

// ---- ask (ask.js, guide.html) -------------------------------------------------------
// A question's card grows out of the pill. Dictation pulls the halves to the
// edges of the screen; Ask is the same gesture turned upward: the halves part
// a little at the seam, and the guide's thread rises out of the gap to the
// card above. A bead sits in the gap, amber while the microphone is open,
// cream while it thinks and while it shows. When the card folds back into the
// thread and the thread comes home, the bead goes into the seam and the halves
// click shut, the same click as after a dictation (snapAt).
//
// The gap rides the split's own springs (splitOpts): out to open, the yank in
// to shut. Prefers-reduced-motion opens and shuts it with no overshoot, and
// no click.
const askGap = { x: 0, v: 0 };  // the gap at the seam: 0 shut … 1 open
let askGapPx = 0;               // and in pixels, this frame
let bead = 0;                   // how much of the bead there is, 0 … 1
let beadHot = 0;                // amber (listening) … cream
let beadSlow = 0;               // the slow pulse while it thinks
const motionQuery = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
const REDUCED = () => !!(motionQuery && motionQuery.matches);
// Under it a question's bead is still and the frames stop; turned off with a
// question up, the bead starts to breathe again now, not at the next phase.
if (motionQuery && motionQuery.addEventListener) motionQuery.addEventListener("change", () => wake());

// ---- state ------------------------------------------------------------------------
let S = { name: "rest", at: 0, data: {} };
let hint = "";               // the way in, as main words it for the keys it bound
let caption = "";            // live captions, when that mode is on
let flashAt = -1e9;          // a chunk written mid-session
let hovered = false, overCancel = false;
let restShown = true;
const bands = new Float32Array(32);
let bandsAt = -1e9;

function setState(name, data) {
  const asked = name, from = S && S.name;
  // NO "✓ 12 words", and no joined listening pill: neither is needed.
  // Written, the pill goes straight back to rest; the words are in the
  // field to be seen.
  if (name === "done" && !K.bool("desktop.pill.showDone", false)) name = "rest";
  // Ask's phase comes again as the guide moves on (and with every card it
  // puts up). The same phase again is not a new one: its clock, and the
  // closing hold above all, runs from when it began.
  if (name === "ask" && S.name === "ask" && data && data.phase === S.data.phase) { wake(); return; }
  S = { name, at: clock(), data: data || {} };
  if (name !== "listening") caption = "";
  if (BLIP()) blipFor(asked, data || {}, from);
  wake();
}

/** Where the halves start from and go back to: the pill's own place, each
 *  half a whole disc the joined pill's height whatever size the pill is now,
 *  so they come out of the small pill and go back into it. */
function podSeed() {
  const R = K.num("desktop.pill.listenHeight", 38) / 2;
  const cy = H - K.num("desktop.pill.bottomPad", 14) - P.h / 2;
  if (CAPSULE()) {
    // From the middle of each half of the capsule as it is now.
    const x0 = W / 2 - P.w / 2, seam = x0 + P.w - P.cap;
    const lc = (x0 + seam) / 2, rc = (seam + x0 + P.w) / 2;
    return { x: lc - R, y: cy - R, w: rc - lc + 2 * R, h: 2 * R };
  }
  const w = Math.max(P.w, 2 * R);
  return { x: W / 2 - w / 2, y: cy - R, w, h: 2 * R };
}

// ---- the canvas -------------------------------------------------------------------
const cv = document.getElementById("c"), ctx = cv.getContext("2d");
let W = 0, H = 0, DPR = 1;
// Moved to a monitor at another scale (100% beside 150%), the window keeps
// its size in points, so no resize fires, and the canvas stayed at the old
// monitor's pixel density: blurred, or drawn at the wrong size. A change of
// scale is its own event.
let scaleQuery = null;
function watchScale() {
  if (scaleQuery) scaleQuery.removeEventListener("change", fit);
  scaleQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
  scaleQuery.addEventListener("change", fit);
}

// Animated values. The pill's box, and one "atom" per bar.
const P = { w: 40, h: 16, solid: 0, buttons: 0, text: 0, cap: 20 };   // cap: the cream half's width
const A = []; // { x, h, y, a, hot }
function atoms(n) { while (A.length < n) A.push({ x: W / 2, h: 3, y: 0, a: 0, hot: 0 }); return A; }

function textW(s) { ctx.save(); ctx.font = FONT(); const w = ctx.measureText(s).width; ctx.restore(); return w; }
function doneLabel() {
  const n = S.data.words | 0;
  return n === 1 ? K.txt("desktop.pill.doneOne", "1 word") : n > 0 ? K.txt("desktop.pill.done", "{n} words", { n }) : K.txt("desktop.pill.doneNone", "Done");
}
