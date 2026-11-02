// guide.html's scripts: the card, the ring, the thread, Blip, the tether to
// the pill, and the marks it draws on the screen. This file holds what the
// rest share (the page's elements, its clock, its state); placement.js,
// card.js, ring.js, tether.js, peek.js, pen.js, frame.js, speech.js and
// messages.js follow it, and demo.js (the review page) comes last. They are
// classic scripts sharing the page's global scope, loaded in that order.
//
// The main process says what to show (channel "guide", see agent.js and
// ask.js); this page decides where. A question grows out of the pill: a
// thread rises from the gap between its halves, the card blooms at the
// thread's end and stays tied to it while it is up, and folds back into it
// when it goes (docked: desktop.guide.dock). Docked, the card sits above the
// pill and moves only to keep clear of what it rings, sideways along the
// bottom, the tether bending after it. Not docked (the knob off, or the pill
// on another display), the card sits beside what it is talking about, as it
// did before it had a pill: below the ringed thing if there is room, else
// above, else to a side, and near the cursor when there is nothing to ring.
// Blip peeks over the card's edge on the side nearer the ring and points at
// it; a dotted thread runs from its finger to the ring. The marks are a
// teacher's pen: circles, arrows, underlines and numbers drawn on the screen
// as a hand would draw them, under everything else.
"use strict";
const K = window.TailzuKnobs;
const params = new URLSearchParams(location.search);
const DEMO = params.has("demo");
// Frame-exact review (?demo=<scene>&capture): the page's clock stands still
// and moves only when window.__step(ms) says, as pill.html's does, so a
// screenshot is of exactly that moment of a bloom or a fold rather than of
// whenever the browser got round to it.
const CAPTURE = DEMO && params.has("capture");
let mouseCalls = 0;     // the review page: how often it asked for the pointer (a peek never does)
const bridge = window.tailzuGuide || fakeBridge();
const reduced = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
const TAU = Math.PI * 2;
const $ = (id) => document.getElementById(id);
const card = $("card"), inner = $("inner"), fx = $("fx"), chip = $("chip"), wave = $("wave");
const ctx = fx.getContext("2d");
const wctx = wave.getContext("2d");
// THE BOTS LOOK (DeskAsk), behind the switch the window learns from its bootstrap (flag bots.app, which the
// knobs carry): a white card with an ink line, Geist, ink buttons, clay (Keylessbord's colour) for the open microphone,
// an ink ring and ink marks with a white edge. Off, or before the first bootstrap: the guide as it was. Only how it
// looks changes; what it does is the same. ?demo&bots shows it on the review page.
const BOTS = () => K.bool("bots.app", false) || (DEMO && params.has("bots"));
const look = () => document.documentElement.classList.toggle("bots", BOTS());
const blip = window.TailzuBlip.createBlip({ height: K.num("desktop.guide.blipHeight", 112) });

// ---- time -----------------------------------------------------------------------
let virtual = 0;
/** Milliseconds on the page's clock: a virtual one under ?capture. */
const now = () => (CAPTURE ? virtual : performance.now());
const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, k) => a + (b - a) * k;
const outCubic = (k) => 1 - Math.pow(1 - clamp(k), 3);
const inCubic = (k) => Math.pow(clamp(k), 3);
const inQuad = (k) => clamp(k) * clamp(k);
const outBack = (k) => { const c = 1.9, x = clamp(k) - 1; return 1 + (c + 1) * x * x * x + c * x * x; };
/** CSS's cubic-bezier(), as a function of time 0..1. */
function cubicBezier(x1, y1, x2, y2) {
  const at = (t, a, b) => 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0, hi = 1, t = x;
    for (let i = 0; i < 22; i++) { t = (lo + hi) / 2; if (at(t, x1, x2) < x) lo = t; else hi = t; }
    return at(t, y1, y2);
  };
}
// The bloom: out quickly, a touch past its size, and back. The fold is the
// same reversed, without the overshoot: an ease-in, so it is pulled home.
const BLOOM = cubicBezier(.2, 1.25, .35, 1);
// A knob colour at an alpha. The knob may be any CSS colour (knobs.js
// color), not only #RRGGBB: a canvas says it back, and says an opaque one
// as #rrggbb. Taken as it came, an ink of "rgb(232,162,60)" kept no alpha
// at all, and its glow was solid.
const probe = document.createElement("canvas").getContext("2d");
function rgba(color, a) {
  probe.fillStyle = "#000"; probe.fillStyle = String(color);
  const m = /^#([0-9a-f]{6})$/i.exec(probe.fillStyle);
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}

const S = {
  shown: false,
  state: "listening",
  stateAt: 0,          // seconds: when the state last changed (the thinking light runs from it)
  errAt: -1e9,         // seconds: when it last went wrong (the tether's end dot goes rose)
  risk: "confirm",
  server: false,       // the confirm card is the server's own (a connected app): Not now and Edit answer for themselves
  ring: null,          // { frame:[x,y,w,h], caption, at, tentative }
  where: "default",    // where the card went: dock, below / above / right / left (of the ring), anchor, default
  box: null,           // the card's rectangle as laid out (where it is going, not where it is)
  cur: null,           // { x, y, w, h, bottom }: where it is this frame, on its way to box
  anchor: null,        // [x, y]: where to be when there is nothing to ring
  dock: null,          // { pill: {x,y,w,h} | null, seed }: as ask.js last said (dock)
  slid: false,         // tied to the pill, it has gone aside for a ring (and stays there)
  P: null,             // the pill (or the seed) the card is tied to as laid out; null: not tied
  docked: false,
  // The card's birth or fold: open, since when (ms), tied to the pill or
  // not, and where it all was when it began (so a fold that is turned round
  // goes back from where it got to).
  life: { open: false, at: -1e12, docked: false, from: { tether: 0, k: 0, ky: 0, alpha: 0, inner: 0 } },
  lineMix: 1,          // the tether as listening's line (1) or as dots (0)
  level: 0, levelTo: 0,
  hideAt: 0,
  speaking: false,
  lastFrame: 0,
  chipBox: null,       // where the ring's label is, while it is on
  // What of the window is not the work area: on a Mac the window covers
  // the whole display so the menu bar's items can be ringed, and the card
  // keeps clear of the menu bar and the Dock.
  inset: { top: 0, right: 0, bottom: 0, left: 0 },
};
let dpr = 1, W = 0, H = 0;

// The bridge's stand-in on the review page (guide.html?demo), opened with no
// main process behind it.
function fakeBridge() {
  let cb = () => {};
  return {
    onGuide: (f) => { cb = f; }, send: (m) => cb(m),
    confirm: (y) => console.log("confirm", y), permit: (c) => console.log("permit", c), mouse: () => { mouseCalls++; }, spoken: () => {}, dismiss: () => console.log("dismiss"),
    offer: (k) => console.log("offer", k),
  };
}
