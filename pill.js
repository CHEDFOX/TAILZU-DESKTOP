// pill.html's script: the pill, drawn on its canvas (see pill.html for the states).
(function () {
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
const SPLIT = () => K.bool("desktop.pill.split", true);
const INSET = () => K.num("desktop.pill.splitInset", 22);
const threadOpts = () => ({
  amp: K.num("desktop.pill.threadAmp", 16),
  hz: K.num("desktop.pill.threadHz", 5.5),
  sag: K.num("desktop.pill.threadSag", 3),
});
let splitT = 0;                 // 0 joined … 1 apart, at a constant pace, eased where drawn
const thread = SP.createThread();
let pluckedAt = -1e9;

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
  // NO "✓ 12 words". The owner, of the done label and the joined listening
  // pill: "these both we don't need". Written, the pill goes straight back
  // to rest; the words are in the field to be seen.
  if (name === "done" && !K.bool("desktop.pill.showDone", false)) name = "rest";
  S = { name, at: clock(), data: data || {} };
  if (name !== "listening") caption = "";
  wake();
}

/** Where the halves start from and go back to: the pill's own place, each
 *  half a whole disc the joined pill's height whatever size the pill is now,
 *  so they come out of the small pill and go back into it. */
function podSeed() {
  const R = K.num("desktop.pill.listenHeight", 38) / 2;
  const cy = H - K.num("desktop.pill.bottomPad", 14) - P.h / 2, w = Math.max(P.w, 2 * R);
  return { x: W / 2 - w / 2, y: cy - R, w, h: 2 * R };
}

// ---- the canvas -------------------------------------------------------------------
const cv = document.getElementById("c"), ctx = cv.getContext("2d");
let W = 0, H = 0, DPR = 1;
function fit() {
  DPR = window.devicePixelRatio || 1; W = window.innerWidth; H = window.innerHeight;
  cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR); cv.style.width = W + "px"; cv.style.height = H + "px";
  wake();
  watchScale();
}
window.addEventListener("resize", fit);
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
const P = { w: 48, h: 14, solid: 0, buttons: 0, text: 0 };
const A = []; // { x, h, y, a, hot }
function atoms(n) { while (A.length < n) A.push({ x: W / 2, h: 3, y: 0, a: 0, hot: 0 }); return A; }

function textW(s) { ctx.save(); ctx.font = FONT(); const w = ctx.measureText(s).width; ctx.restore(); return w; }
function doneLabel() {
  const n = S.data.words | 0;
  return n === 1 ? K.txt("desktop.pill.doneOne", "1 word") : n > 0 ? K.txt("desktop.pill.done", "{n} words", { n }) : K.txt("desktop.pill.doneNone", "Done");
}

/** Where everything wants to be this frame. */
function targets(t) {
  const st = S.name, sq = K.num("desktop.pill.atom", 3);
  const g = {};
  // SPLIT, THE PILL NEVER GROWS INTO A WIDE PILL OF DOTS. The small pill
  // comes apart where it is: the two halves leave it and it fades, and on
  // stop they come back into it, in its own place, and it writes there,
  // its three squares lighting in turn. The wide pill with its dots (joined
  // listening, and the rolling wave while writing) was what the owner did
  // not want: "the wave is still there".
  if ((st === "listening" || st === "writing") && SPLIT()) {
    g.w = K.num("desktop.pill.restWidth", 46); g.h = K.num("desktop.pill.restHeight", 14);
    g.solid = 1; g.buttons = 0; g.text = 0; g.show = 1;
    return g;
  }
  if (st === "rest") {
    const open = hovered && restShown && !!hint;
    g.w = open ? K.num("desktop.pill.hoverPad", 30) + 3 * sq + 10 + textW(hint) : K.num("desktop.pill.restWidth", 46);
    g.h = open ? K.num("desktop.pill.hoverHeight", 28) : K.num("desktop.pill.restHeight", 14);
    g.solid = open ? 1 : 0; g.buttons = 0; g.text = open ? 1 : 0; g.show = restShown ? 1 : 0;
  } else if (st === "listening") {
    g.w = K.num("desktop.pill.listenWidth", 188); g.h = K.num("desktop.pill.listenHeight", 38);
    g.solid = 1; g.buttons = 1; g.text = 0; g.show = 1;
  } else if (st === "writing") {
    g.w = K.num("desktop.pill.writeWidth", 124); g.h = K.num("desktop.pill.writeHeight", 30);
    g.solid = 1; g.buttons = 0; g.text = 0; g.show = 1;
  } else {
    const label = st === "done" ? doneLabel() : (S.data.label || K.txt("desktop.pill.errorDefault", "Something went wrong"));
    g.w = textW(label) + (st === "done" ? 46 : 38); g.h = K.num("desktop.pill.labelHeight", 30);
    g.solid = 1; g.buttons = 0; g.text = 1; g.show = 1;
  }
  return g;
}

let last = 0, running = false;
function wake() { if (!running && !CAPTURE) { running = true; last = clock(); requestAnimationFrame(loop); } }
function loop() { const settled = frame(); if (settled && S.name === "rest") { running = false; return; } requestAnimationFrame(loop); }

/** One frame. Returns true when nothing is moving. */
function frame() {
  const now = clock(), dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000)); last = now;
  const t = (now - S.at) / 1000;
  if (S.name === "done" && t * 1000 > K.num("desktop.pill.doneMs", 1300)) setState("rest");
  if (S.name === "error" && t * 1000 > K.num("desktop.pill.errorMs", 2400)) setState("rest");
  // Bands decay once the recorder goes quiet, so a dropped message never
  // freezes a bar mid-air.
  if (now - bandsAt > 250) for (let i = 0; i < bands.length; i++) bands[i] *= Math.exp(-dt * 10);

  // The halves: apart while it listens, straight out of the small pill,
  // together otherwise, at one pace both ways, so a stop in the middle of
  // coming apart simply turns them round.
  const wantSplit = SPLIT() && S.name === "listening" && t * 1000 >= K.num("desktop.pill.splitDelayMs", 0);
  const splitWas = splitT;
  splitT = clamp(splitT + (wantSplit ? dt : -dt) / Math.max(0.08, K.num("desktop.pill.splitMs", 700) / 1000));
  const se = SP.easeInOut(splitT), fade = SP.fades(se);
  if (splitT > 0 || thread.energy() > 0.05) {
    thread.step(dt, bands, S.name === "listening" && now - bandsAt < 250, threadOpts());
    // A pause wrote a chunk: the thread is plucked.
    if (flashAt > pluckedAt) { pluckedAt = flashAt; if (S.name === "listening") thread.pluck(0.7, threadOpts()); }
  }

  const g = targets(t), k = K.num("desktop.pill.spring", 16);
  const before = P.w + P.h + P.solid + P.buttons + P.text;
  P.w = ease(P.w, g.w, k, dt); P.h = ease(P.h, g.h, k, dt);
  P.solid = ease(P.solid, g.solid, k * .8, dt); P.buttons = ease(P.buttons, g.buttons, k * .9, dt);
  P.text = ease(P.text, g.text, k * .9, dt);
  P.show = ease(P.show ?? 1, g.show, k, dt);
  let moving = Math.abs(P.w + P.h + P.solid + P.buttons + P.text - before) > 0.01;
  if (splitT !== splitWas || thread.energy() > 0.05) moving = true;

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (P.show < 0.01) return !moving;
  const cx = W / 2, bottom = H - K.num("desktop.pill.bottomPad", 14);
  const x0 = cx - P.w / 2, y0 = bottom - P.h, cy = bottom - P.h / 2;
  ctx.globalAlpha = P.show;

  // The capsule. At rest it is a shade over the page; open, it is ink.
  const err = S.name === "error" ? outCubic(t / 0.2) : 0;
  const shake = S.name === "error" && t < 0.42 ? Math.sin(t * 60) * 3 * (1 - t / 0.42) : 0;
  ctx.save();
  ctx.translate(shake, 0);
  // The body fades as the halves leave it, and is back before they meet.
  const bodyA = fade.body;
  if (bodyA > 0.01) {
    ctx.shadowColor = `rgba(0,0,0,${(0.12 + 0.26 * P.solid) * bodyA})`; ctx.shadowBlur = 8 + 14 * P.solid; ctx.shadowOffsetY = 2 + 4 * P.solid;
    ctx.fillStyle = mixHex(K.color("desktop.pill.restFill", "#2A2522"), C.ink(), P.solid);
    ctx.globalAlpha = P.show * bodyA * (K.num("desktop.pill.restAlpha", 0.78) + (1 - K.num("desktop.pill.restAlpha", 0.78)) * P.solid);
    ctx.beginPath(); ctx.roundRect(x0, y0, P.w, P.h, P.h / 2); ctx.fill();
    ctx.shadowColor = "transparent"; ctx.globalAlpha = P.show * bodyA;
    ctx.strokeStyle = err ? rgba(C.rose(), .55 * err) : rgba(C.pale(), 0.12 + 0.06 * P.solid); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(x0 + .5, y0 + .5, P.w - 1, P.h - 1, (P.h - 1) / 2); ctx.stroke();
    ctx.globalAlpha = P.show;
  }

  // The thread, between the two halves: amber, because the microphone is
  // open, over a dark hair so it reads on a white page and a dark one alike.
  if (fade.thread > 0.01) {
    const pd = SP.pods(podSeed(), W, se, INSET());
    const x1 = pd.lx + pd.r * 0.9, x2 = pd.rx - pd.r * 0.9;
    const n = Math.max(16, Math.min(240, Math.round((x2 - x1) / Math.max(4, K.num("desktop.pill.threadStep", 12)))));
    const boil = Math.floor(now / (1000 / Math.max(1, K.num("desktop.pill.handFps", 12))));
    const pts = thread.points(x1, x2, cy, now / 1000, n, SP.tremor(boil, K.num("desktop.pill.hand", 0.8)), threadOpts());
    // A pluck on a loud syllable can swing past the window's strip: kept in it.
    for (const pt of pts) pt[1] = clamp(pt[1], 3, H - 3);
    const tw = K.num("desktop.pill.threadWidth", 1.6);
    const trace = () => {
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length - 1; i++) {
        ctx.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
      }
      const l = pts[pts.length - 1]; ctx.lineTo(l[0], l[1]);
    };
    ctx.save(); ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.globalAlpha = P.show * fade.thread;
    trace(); ctx.strokeStyle = rgba(C.ink(), K.num("desktop.pill.threadShadow", 0.1)); ctx.lineWidth = tw + 1.4; ctx.stroke();
    trace(); ctx.strokeStyle = C.amber(); ctx.lineWidth = tw; ctx.stroke();
    ctx.restore();
  }

  // Live captions, above: the tail of what is being said.
  if (S.name === "listening" && caption) {
    ctx.save(); ctx.font = FONT();
    const maxW = Math.min(W - 24, K.num("desktop.pill.captionWidth", 360));
    let s = caption; while (s.length > 1 && ctx.measureText("…" + s).width > maxW - 28) s = s.slice(1);
    if (s !== caption) s = "…" + s.trimStart();
    const cw = ctx.measureText(s).width + 28, ch = 28, ccy = y0 - 10 - ch;
    ctx.fillStyle = rgba(C.ink(), .94); ctx.beginPath(); ctx.roundRect(cx - cw / 2, ccy, cw, ch, 10); ctx.fill();
    ctx.fillStyle = C.pale(); ctx.textBaseline = "middle"; ctx.fillText(s, cx - cw / 2 + 14, ccy + ch / 2 + .5);
    ctx.restore();
  }

  // The atoms.
  const n = BARS(), mid = (n - 1) / 2, sq = K.num("desktop.pill.atom", 3), aa = atoms(n);
  const inner = P.h, bl = x0 + inner + 4, br = x0 + P.w - inner - 4;
  const maxH = Math.max(sq, P.h - K.num("desktop.pill.barInset", 16));
  const flashP = (now - flashAt) / 1000;
  const talking = now - bandsAt < 250;
  for (let i = 0; i < n; i++) {
    const a = aa[i], d = Math.abs(i - mid), side = i < mid ? -1 : 1;
    let tx = cx, th = sq, ty = 0, ta = 0, hot = 0;
    if (S.name === "rest" || (SPLIT() && (S.name === "listening" || S.name === "writing"))) {
      const open = P.text > .5 && hint;
      const gx = open ? x0 + 15 + sq : cx - 5 - sq / 2;
      if (d <= 1) { tx = gx + (i - mid + 1) * (sq + 2.6) + (open ? 0 : 5 - sq - 2.6 + sq / 2); ta = open ? .85 : .6; }
      else { tx = gx + 5; ta = 0; }
      // Writing, in the small pill: a light passes over its three squares,
      // left to right, again and again. Nothing moves, nothing grows.
      if (S.name === "writing" && d <= 1) {
        const pos = ((t * 1.5) % 1.5) * 3 - 0.75;
        ta = .3 + .65 * Math.exp(-Math.pow(i - mid + 1 - pos, 2) * 1.6);
      }
    } else if (S.name === "listening") {
      tx = n > 1 ? bl + (br - bl) * i / (n - 1) : cx;
      // Low voice in the middle, the rest mirrored outwards: a voice has one
      // shape, and a symmetric one reads as a voice rather than a meter.
      const band = bands[Math.min(bands.length - 1, Math.round(d * 1.35))] * (1 - 0.08 * ((i * 7) % 3));
      const env = 0.5 + 0.5 * Math.cos(Math.PI * d / (mid + 1.2));
      const breath = talking ? 0 : 0.5 + 0.5 * Math.sin(t * 3.2 - d * 0.7);
      const pulse = flashP < 0.6 ? Math.exp(-Math.pow(d - flashP / 0.6 * (mid + 1), 2) / 2) * (1 - flashP / 0.6) : 0;
      th = sq + (maxH - sq) * clamp(band * env * 1.25 + pulse * .55);
      ta = talking ? .95 : .45 + .4 * breath;
      hot = 1;
    } else if (S.name === "writing") {
      const gap = K.num("desktop.pill.writeGap", 6);
      tx = cx + (i - mid) * gap;
      ty = -Math.sin(t * 9 - i * 0.55) * 3 * clamp(t / 0.3);
      const sweep = ((t * 1.3) % 1.4) - 0.2, near = Math.exp(-Math.pow(i / (n - 1) - sweep, 2) * 40);
      ta = (d <= mid ? .5 : 0) + .45 * near; th = sq;
    } else {
      tx = x0 + 18; ta = 0; th = sq;
    }
    // Apart, the bars (or the small pill's squares) give way to the thread.
    ta *= 1 - SP.smooth(0, 0.3, se);
    const kk = K.num("desktop.pill.atomSpring", 22);
    a.x = ease(a.x, tx, kk, dt); a.h = ease(a.h, th, S.name === "listening" ? 30 : kk, dt);
    a.y = ease(a.y, ty, kk, dt); a.a = ease(a.a, ta, kk, dt); a.hot = ease(a.hot, hot, kk * .6, dt);
    if (Math.abs(a.x - tx) + Math.abs(a.h - th) + Math.abs(a.a - ta) > 0.05) moving = true;
    if (a.a < 0.01) continue;
    ctx.fillStyle = a.hot > .02 ? mixHex(C.pale(), C.amber(), a.hot) : C.pale();
    ctx.globalAlpha = P.show * a.a;
    const w = sq;
    ctx.beginPath(); ctx.roundRect(a.x - w / 2, cy - a.h / 2 + a.y, w, a.h, Math.min(w / 2, 1.2 + a.h / 6)); ctx.fill();
  }
  ctx.globalAlpha = P.show;

  // ✕ and ✓, while listening. The two halves, while they are out of the pill (leaving it, apart, or on
  // their way home); with the split off, the joined pill's ✕ and ✓.
  const halves = se > 0.001;
  if (halves || P.buttons > 0.01) {
    let lx, rx, r, b;
    if (halves) {
      const pd = SP.pods(podSeed(), W, se, INSET());
      // Out of the small pill they grow to their size; home, they shrink back into it.
      const grow = 0.3 + 0.7 * SP.smooth(0, 0.35, se);
      lx = pd.lx; rx = pd.rx; b = fade.disc; r = Math.max(2, (pd.r - 5) * grow);
      ctx.save();
      for (const px of [lx, rx]) {
        ctx.globalAlpha = P.show * b;
        ctx.shadowColor = "rgba(0,0,0,.34)"; ctx.shadowBlur = 18; ctx.shadowOffsetY = 5;
        ctx.fillStyle = C.ink(); ctx.beginPath(); ctx.arc(px, cy, pd.r * grow, 0, Math.PI * 2); ctx.fill();
        ctx.shadowColor = "transparent";
        ctx.strokeStyle = rgba(C.pale(), 0.18); ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(px, cy, pd.r * grow - .5, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
    } else {
      lx = x0 + P.h / 2; rx = x0 + P.w - P.h / 2; r = P.h / 2 - 5; b = P.buttons;
    }
    ctx.globalAlpha = P.show * b;
    ctx.fillStyle = rgba(C.pale(), overCancel ? .24 : .13); ctx.beginPath(); ctx.arc(lx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = rgba(C.pale(), .9); ctx.lineWidth = 1.6; ctx.lineCap = "round";
    const s = r * .36;
    ctx.beginPath(); ctx.moveTo(lx - s, cy - s); ctx.lineTo(lx + s, cy + s); ctx.moveTo(lx + s, cy - s); ctx.lineTo(lx - s, cy + s); ctx.stroke();
    ctx.fillStyle = C.pale(); ctx.beginPath(); ctx.arc(rx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = C.ink(); ctx.lineWidth = 1.8; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(rx - r * .38, cy + r * .02); ctx.lineTo(rx - r * .1, cy + r * .3); ctx.lineTo(rx + r * .4, cy - r * .3); ctx.stroke();
    ctx.globalAlpha = P.show;
  }

  // Words: the hint on hover, the count when done, the reason on error.
  if (P.text > 0.01) {
    // With the body: a reason does not float over the thread before the halves are home.
    ctx.save(); ctx.font = FONT(); ctx.textBaseline = "middle"; ctx.globalAlpha = P.show * outCubic(P.text) * bodyA;
    if (S.name === "rest") {
      ctx.fillStyle = rgba(C.pale(), .88); ctx.fillText(hint, x0 + 15 + 3 * sq + 12, cy + .5);
    } else if (S.name === "done") {
      // The check draws itself, born amber, and settles to pale.
      const p = outCubic(t / 0.35), ix = x0 + 18, s = 5;
      ctx.strokeStyle = mixHex(C.amber(), C.pale(), clamp((t - .35) / .5)); ctx.lineWidth = 2; ctx.lineCap = "round"; ctx.lineJoin = "round";
      const pts = [[ix - s, cy], [ix - s * .3, cy + s * .7], [ix + s * 1.1, cy - s * .8]];
      const L1 = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]), L2 = Math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1]);
      const len = (L1 + L2) * p;
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      if (len <= L1) ctx.lineTo(pts[0][0] + (pts[1][0] - pts[0][0]) * len / L1, pts[0][1] + (pts[1][1] - pts[0][1]) * len / L1);
      else { ctx.lineTo(pts[1][0], pts[1][1]); const u = (len - L1) / L2; ctx.lineTo(pts[1][0] + (pts[2][0] - pts[1][0]) * u, pts[1][1] + (pts[2][1] - pts[1][1]) * u); }
      ctx.stroke();
      ctx.fillStyle = C.pale(); ctx.fillText(doneLabel(), x0 + 32, cy + .5);
    } else if (S.name === "error") {
      ctx.fillStyle = C.rose(); ctx.beginPath(); ctx.arc(x0 + 17, cy, 3.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = C.pale(); ctx.fillText(S.data.label || K.txt("desktop.pill.errorDefault", "Something went wrong"), x0 + 27, cy + .5);
    }
    ctx.restore();
  }
  ctx.restore();
  if (S.name === "listening" || S.name === "writing" || S.name === "done" || S.name === "error") moving = true;
  // The pill changes size under a pointer that is not moving (listening
  // shrinks to writing, done to rest), and no mousemove says so: the window
  // went on taking clicks where the pill had been. Asked again as it moves.
  if (pointer) hoverAt(pointer.x, pointer.y);
  return !moving;
}

// ---- pointer: the window lets clicks through everywhere but the pill ------------
function pillRect() { const bottom = H - K.num("desktop.pill.bottomPad", 14); return { x: W / 2 - P.w / 2, y: bottom - P.h, w: P.w, h: P.h }; }
function podsNow() { return SP.pods(podSeed(), W, SP.easeInOut(splitT), INSET()); }
const apart = () => splitT > 0.02;
function inside(x, y, pad = 4) {
  // Apart, only the two halves take the pointer: the thread and the screen
  // between them stay the app's, clicks and all.
  if (apart()) return !!SP.podAt(podsNow(), x, y, pad);
  const r = pillRect(); return x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;
}
function onCancel(x, y) {
  if (S.name !== "listening") return false;
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
  const act = S.name === "rest" ? "start" : S.name === "listening" ? (onCancel(e.clientX, e.clientY) ? "cancel" : "finish") : null;
  if (act && bridge && bridge.pillAction) bridge.pillAction(act);
});

// ---- the main process -----------------------------------------------------------
function onPill(m) {
  if (!m || typeof m !== "object") return;
  // Shown again: the main process has made it click-through, and the
  // pointer it last saw is from before it was hidden.
  if (m.unhover) { pointer = null; hovered = false; overCancel = false; wake(); }
  if (typeof m.hint === "string") hint = m.hint;
  if (typeof m.rest === "boolean") restShown = m.rest;
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

// ---- review: a scripted run over a mock document -----------------------------------
if (DEMO) {
  const BARE = q.has("bare");   // the pill alone, over whatever the page behind it is
  if (!BARE) document.body.className = "demo";
  if (!BARE) document.body.insertAdjacentHTML("afterbegin", `<div class="doc"><div class="bar"><i style="left:14px"></i><i style="left:30px"></i><i style="left:46px"></i></div>
    <h4>Standup notes</h4><p>Design review moved to Thursday.</p><p id="line"><span id="typed"></span><span class="caret"></span></p></div>`);
  const SENT = "Can we push the call to four? The deck needs one more pass.";
  const script = [[0, "rest"], [1.1, "hover"], [2.2, "listening"], [6.9, "writing"], [7.9, "done"], [9.4, "rest"], [10.6, "listening2"], [12.2, "error"]];
  let step = -1;
  const speech = (t) => {           // syllables: bursts with gaps, as a voice has
    const syl = Math.max(0, Math.sin(t * 11.5)) * (0.55 + 0.45 * Math.sin(t * 2.3 + 1)) * (Math.sin(t * 0.9) > -0.6 ? 1 : 0.05);
    return syl;
  };
  window.__demo = (t) => {
    const s = script.reduce((k, [at], i) => (t >= at ? i : k), 0);
    if (s !== step) {
      step = s; const name = script[s][1];
      const typed = document.getElementById("typed");
      if (name === "rest") { setHover(false); onPill({ state: "rest", hint: "Tap Ctrl twice to talk", rest: true }); if (typed) typed.textContent = t > 9 ? SENT : ""; }
      if (name === "hover") { hovered = true; wake(); }
      if (name === "listening" || name === "listening2") { hovered = false; onPill({ state: "listening" }); }
      if (name === "writing") onPill({ state: "writing" });
      if (name === "done") { onPill({ state: "done", words: 12 }); }
      if (name === "error") onPill({ state: "error", label: "Didn't catch that" });
    }
    const name = script[step][1];
    if (name === "listening") {
      // At the levels the recorder sends for a real voice (the loud bands sit
      // near 1 while someone talks), not a whisper: a review that showed the
      // thread barely moving was showing a voice nobody has.
      const lt = t - 2.2, v = lt > 0.4 && lt < 4.4 ? Math.min(1, 0.3 + 0.9 * speech(lt)) : 0.02;
      const b = []; for (let i = 0; i < 16; i++) b.push(clamp(v * (1 - i * 0.045) * (0.75 + 0.25 * Math.sin(lt * 17 + i * 1.7))));
      onLevel({ bands: b });
      if (Math.abs(lt - 2.6) < 0.02) { flashAt = clock(); }
    }
    if (name === "done") {
      const p = clamp((t - 7.9) / 0.9);
      const typed = document.getElementById("typed"); if (typed) typed.textContent = SENT.slice(0, Math.round(SENT.length * outCubic(p)));
    }
  };
  if (CAPTURE) {
    window.__step = (ms) => { virtual += ms; window.__demo(virtual / 1000); frame(); };
    window.__ready = true;
    virtual = 0; last = 0; window.__demo(0); frame();
  } else {
    const t0 = performance.now();
    (function tick() { window.__demo(((performance.now() - t0) / 1000) % 13.5); requestAnimationFrame(tick); })();
  }
}
})();
