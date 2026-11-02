// The rest window's page: Blip behind the screen's right edge, his antenna out, his head peeking out now and
// then, and gone while the pointer is near (main.js sends `duck`). Under Reduce Motion only the antenna shows, still.
(function () {
"use strict";
const K = window.TailzuKnobs;
const bridge = window.tailzu;
const cv = document.getElementById("c"), g = cv.getContext("2d");
const reduced = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
const size = () => Math.max(32, Math.min(120, K.num("desktop.rest.height", 64)));
let h = size();
const blip = window.TailzuBlip.createBlip({ height: h });

// How far below the edge he is, as a share of his height: the antenna alone, his head out, or out of sight.
const ANTENNA = () => K.num("desktop.rest.antenna", 0.35), OUT = 0, GONE = 1.2;
const S = { duck: false, sink: GONE, peekUntil: 0, nextPeek: 0, last: 0, raf: 0 };
let W = 0, H = 0, dpr = 1;

function fit() {
  dpr = window.devicePixelRatio || 1;
  W = window.innerWidth; H = window.innerHeight;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
}

function frame(ms) {
  S.raf = 0;
  const dt = Math.min(0.1, S.last ? (ms - S.last) / 1000 : 0);
  S.last = ms;
  const want = size();
  if (want !== h) { h = want; blip.size(h); }
  // Every 7 to 11 seconds his head comes out for a couple of seconds, looks about, and goes back.
  if (!reduced && !S.duck && ms > S.nextPeek) {
    S.peekUntil = ms + K.num("desktop.rest.peekMs", 2300);
    S.nextPeek = ms + 7000 + Math.random() * 4000;
  }
  const out = !reduced && !S.duck && ms < S.peekUntil;
  const target = S.duck ? GONE : out ? OUT : ANTENNA();
  S.sink = reduced ? target : S.sink + (target - S.sink) * (1 - Math.exp(-dt * 8));
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  // The screen's right edge is the edge he peeks over: his "up" is to the left, into the screen.
  g.save();
  g.translate(W, H / 2);
  g.rotate(-Math.PI / 2);
  g.beginPath(); g.rect(-2 * h, -2 * h, 4 * h, 2 * h); g.clip();
  blip.pose("peek");
  blip.still(reduced);
  blip.live(false);
  // Out, he looks across the screen and back; in, at nothing in particular.
  const t = ms / 1000;
  blip.lookAt(out ? [Math.sin(t * 1.3) * 40, -60] : null);
  blip.draw(g, 0, S.sink * h, t, dpr);
  g.restore();
  S.raf = requestAnimationFrame(frame);
}

function onRest(m) {
  if (!m || typeof m !== "object") return;
  if (typeof m.duck === "boolean") S.duck = m.duck;
  // Shown again: he comes up from below the edge, not already out.
  if (m.shown) { S.sink = GONE; S.nextPeek = performance.now() + 2500; }
  if (!S.raf) S.raf = requestAnimationFrame(frame);
}

fit();
window.addEventListener("resize", fit);
if (bridge) {
  if (bridge.onRest) bridge.onRest(onRest);
  if (bridge.onKnobs) bridge.onKnobs((k) => K.setKnobs(k));
  if (bridge.knobs) bridge.knobs().then((k) => K.setKnobs(k)).catch(() => {});
}
S.raf = requestAnimationFrame(frame);
})();
