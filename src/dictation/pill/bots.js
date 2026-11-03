// The Bots look (DeskPill): the small white pill, Keylessbord's clay microphone
// and its words, behind the server's bots.app switch; with Blip
// (desktop.pill.blip), Blip in place of the microphone, bars, time and ✕.
"use strict";

// BLIP IS THE SYMBOL (the Bots look, desktop.pill.blip): no microphone, no dots, no tick, no ✕. Blip stands in the
// pill's left end doing what is happening with his own body (shared/blip.js BLIP_GESTURES): wakes when the key is held,
// listens with his neck stretched, thinks, flips as something is sent, runs on a job, covers his eye for a password,
// gives a thumbs-up when it is done. At rest he stands on his own: the white grows out from under his feet only when
// there are words, and goes back into him when they are gone.
const BLIP = () => BOTS() && K.bool("desktop.pill.blip", true) && !!(window.TailzuBlip && window.TailzuBlip.createPerformer);
let blipP = null, blipQuirkAt = 0;
function blipper() {
  if (!blipP) blipP = window.TailzuBlip.createPerformer({ dpr: window.devicePixelRatio || 1, reduced: REDUCED() });
  return blipP;
}
/** What a route's label was (routing.js `kind`), as the gesture he does with it. */
const ROUTED_GESTURE = { done: "done", send: "send", work: "work", look: "look", listen: "listen", routine: "routine", yourTurn: "yourTurn", bot: "send", celebrate: "celebrate" };
const lerpN = (a, b, k) => a + (b - a) * k;
let bCapK = 0;
// When Blip left to peek over the text box (0: he is here). Away longer than desktop.pill.blipAwayMaxMs, he is drawn
// again all the same: a peek whose end was never told must not leave the pill empty.
let blipAwayAt = 0;
// He rests at the screen's edge (main.js updateRest): at rest the pill leaves him out.
let blipResting = false;
const blipAway = (now) => blipAwayAt > 0 && now - blipAwayAt < K.num("desktop.pill.blipAwayMaxMs", 90000);
/** The gesture for a state the pill is put in (setState), from the one it was in. */
function blipFor(st, data, from) {
  const p = blipper(), now = clock();
  if (st === "listening") {
    // From rest he wakes first, quickly (under a second), and is listening while he does.
    if (!from || from === "rest" || from === "hidden") p.play("wake", { speed: K.num("desktop.pill.blipWakeSpeed", 2.3), then: "listen", now });
    else p.play("listen", { now });
  } else if (st === "writing") p.play("write", { now });
  else if (st === "done") p.play("done", { now, then: "rest" });
  else if (st === "error") p.play("oops", { now, then: "rest" });
  else if (st === "routed") { const g = ROUTED_GESTURE[data.kind] || "done"; p.play(g, { now, then: g === "send" || g === "celebrate" ? "done" : null, again: true }); }
  else if (st === "ask") p.play("look", { now });
  else if (st === "talk") talkGesture(p, data, from, now);
  else if (from === "writing" || from === "listening") p.play("done", { now, then: "rest" });
  else p.play("rest", { now });
  blipQuirkAt = now + 30000 + Math.random() * 20000;
}

/** Talk mode's gesture (talk.js sends it with each change): from rest he wakes into listening; one that ends (done,
 *  laugh, nope) goes back to talking while the answer is said, to listening while they speak. */
function talkGesture(p, data, from, now) {
  const g = data.gesture || "listen";
  if (g === "listen" && (!from || from === "rest" || from === "hidden")) { p.play("wake", { speed: K.num("desktop.pill.blipWakeSpeed", 2.3), then: "listen", now }); return; }
  p.play(g, { now, then: data.phase === "answer" ? "talk" : data.phase === "listen" ? "listen" : null });
}

// The app's white and ink, with Keylessbord's clay for what is live. Knobs like every other colour here.
const B = {
  paper: () => K.color("desktop.pill.botsPaper", "#ffffff"),
  line: () => K.color("desktop.pill.botsLine", "#e6e6e6"),
  ink: () => K.color("desktop.pill.botsInk", "#0a0a0a"),
  meta: () => K.color("desktop.pill.botsMeta", "#5c5c5c"),
  surface: () => K.color("desktop.pill.botsSurface", "#f5f5f5"),
  clay: () => K.color("desktop.pill.botsClay", "#A9573A"),
};
const BOTS_FACE = '-apple-system, "Segoe UI", system-ui, sans-serif';
const bFont = (size, medium) => (medium ? `500 ${size}px "Tailzu Geist Medium", ${BOTS_FACE}` : `400 ${size}px "Tailzu Geist", ${BOTS_FACE}`);
function bTextW(s, size, medium) { ctx.save(); ctx.font = bFont(size, medium); const w = ctx.measureText(s).width; ctx.restore(); return w; }
const BOTS_BARS = 14;
const bBars = new Float32Array(BOTS_BARS).fill(4);
const bDisc = () => K.num("desktop.pill.botsDisc", 40);
const bLabel = () => (S.name === "done" ? doneLabel() : S.name === "routed" ? routedLabel() : (S.data.label || K.txt("desktop.pill.errorDefault", "Something went wrong")));
const bWriting = () => K.txt("desktop.pill.botsWriting", "Writing");
/** How long it has been listening, as a clock reads: "0:07". */
function bTimer() { const s = Math.max(0, Math.floor((clock() - S.at) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }
/** Words, their tail when they are longer than the pill has room for. */
function bTail(text) {
  if (!text) return "";
  const maxW = K.num("desktop.pill.botsTextWidth", 280);
  let s = text;
  if (bTextW(s, 15) <= maxW) return s;
  while (s.length > 1 && bTextW("…" + s, 15) > maxW) s = s.slice(1);
  return "…" + s.trimStart();
}
// With Blip, your own words are not shown as you say them: he listens, and they land where they go (a text box,
// Ask, his answer). desktop.pill.heardWords brings them back.
const HEARD = () => !BLIP() || K.bool("desktop.pill.heardWords", false);
/** The words so far, while it listens. */
function bCaption() { return HEARD() ? bTail(caption) : ""; }
/** Talk mode's words: his as he answers (ink); theirs while they speak (grey) only with desktop.pill.heardWords. */
const talkAnswering = () => S.data.phase === "answer" || S.data.phase === "act";
function bTalkWords() { return bTail(talkAnswering() ? S.data.said || "" : HEARD() ? S.data.heard || "" : ""); }
// Hovered at rest, he does something (one that ends) instead of opening a hint: once a hover, never more than every 1.2 s.
const HOVER_GESTURES = ["jelly", "peekaboo", "laugh", "sneeze", "propeller", "dizzy", "headbang", "celebrate"];
let hoverGestureAt = 0;
function blipHover() {
  if (!BLIP() || S.name !== "rest" || blipResting || REDUCED()) return;
  const now = clock();
  if (now - hoverGestureAt < 1200) return;
  hoverGestureAt = now;
  blipper().play(HOVER_GESTURES[Math.floor(Math.random() * HOVER_GESTURES.length)], { now, then: "rest", again: true });
  wake();
}
/** The size for a state: the listening pill around its disc, bars, words, time and ✕; small at rest. */
// ---- Strolling (roam.js) ------------------------------------------------------------------------------------
// While nothing is asked of him (at rest, no hint open) he walks the bottom of the screen and now and then does
// something odd where he stops; while a task runs he walks about too, and the pill with its label stays put. A
// command stops him where he is and the pill opens there: he answers from that spot, not from the middle. Going to
// rest at the screen's edge (restAway with walkMs), he walks off its right end first. desktop.pill.roam turns it off.
const roam = window.TailzuRoam ? window.TailzuRoam.createRoam() : null;
let roamNow = { x: 0, dir: 1, walking: false, arrived: false };
let pillAnchor = 0;               // the pill's place: Blip's offset from the window's middle, eased, so it follows him
let workAnchor = null;            // where the pill stays while a task runs
let leaveUntil = 0, leaveMs = 0;  // walking off to the screen's edge, until then
let pillCX = 0;                   // the pill's middle this frame (pointer.js hit-tests it)
let spotSent = null, spotAt = 0;  // what main was last told of where he is (the hop to a text box starts there)
const ROAM_ON = () => !!roam && BLIP() && !REDUCED() && K.bool("desktop.pill.roam", true);
const WORKING = () => S.name === "routed" && (S.data.kind === "work" || S.data.kind === "look");
function roamMode() {
  if (!ROAM_ON()) return "stay";
  if (leaveUntil) return "leave";
  if (WORKING()) return "work";
  if (S.name === "rest" && !blipResting && !hovered && P.text < 0.01) return "wander";
  return "stay";
}
/** Main says he goes to (or comes back from) the screen's edge. With walkMs he walks off the strip's right end first. */
function blipRestAway(on, walkMs) {
  if (on && walkMs > 0 && ROAM_ON() && !blipResting) { leaveUntil = clock() + walkMs; leaveMs = walkMs; return; }
  leaveUntil = 0;
  // Back from the edge he is in the middle again; called back on his way there, he answers from where he is.
  if (!on && blipResting && roam) { roam.place(0); pillAnchor = 0; }
  blipResting = on;
}
/** The pill's middle this frame (frame.js): Blip's walk stepped once, and the pill placed where he is. */
function botsCenter(now, dt) {
  if (!BLIP() || !roam) { pillCX = W / 2; return pillCX; }
  const pf = blipper(), mode = roamMode();
  const span = Math.max(0, Math.min(K.num("desktop.pill.roamSpan", 360), W / 2 - 70));
  const free = pf.name === "rest" || pf.name === "work" || pf.name === "stroll";
  // While a task runs, the pill with its label (from the last frame) is what he walks round, not over.
  const avoid = mode === "work" ? [pillCX - P.w / 2 - 26 - W / 2, pillCX + P.w / 2 + 26 - W / 2] : null;
  roamNow = roam.step({ mode, now, span, speed: K.num("desktop.pill.roamSpeed", 60), free, avoid,
    pauseMs: mode === "work" ? [2000, 5000] : [5000, 11000], leaveTo: W / 2 + 60, leaveMs }, dt);
  if (mode === "leave" && (roamNow.arrived || now >= leaveUntil)) {
    leaveUntil = 0; blipResting = true; roam.place(0); pillAnchor = 0; roamNow = { x: 0, dir: 1, walking: false, arrived: false };
  }
  // Strolling while he walks; where he stops, back to work, or (idle) now and then something odd.
  if (roamNow.walking && pf.name !== "stroll" && (free || mode === "leave")) pf.play("stroll", { now });
  else if (!roamNow.walking && pf.name === "stroll") {
    if (mode === "work") pf.play("work", { now });
    else if (mode === "wander" && Math.random() < K.num("desktop.pill.roamQuirk", 0.4)) pf.play(pf.quirk(), { now, then: "rest" });
    else pf.play("rest", { now });
  }
  if (mode === "work") { if (workAnchor === null) workAnchor = pillAnchor; } else workAnchor = null;
  const want = blipResting ? 0 : workAnchor !== null ? workAnchor : roamNow.x;
  pillAnchor += (want - pillAnchor) * (1 - Math.exp(-dt * 12));
  // Blip's place in the pill, from its middle: its left end, or the middle while it is small.
  const st = S.name, slot = st === "ask" ? 0 : st === "rest" ? (7 + 14 - P.w / 2) * outCubic(P.text) : 22 - P.w / 2;
  const half = P.w / 2 + 8;
  pillCX = W / 2 + pillAnchor - slot;
  pillCX = W < 2 * half ? W / 2 : Math.max(half, Math.min(W - half, pillCX));
  // Main is told where he stands (a hop to a text box starts there) and where the pill is (Ask's thread docks to it).
  const spot = { blip: Math.round(mode === "work" || mode === "leave" ? roamNow.x : pillCX + slot - W / 2), pill: Math.round(pillCX - W / 2) };
  if ((!spotSent || Math.abs(spot.blip - spotSent.blip) > 2 || Math.abs(spot.pill - spotSent.pill) > 2) && now - spotAt > 150) {
    spotSent = spot; spotAt = now;
    if (bridge && bridge.pillSpot) bridge.pillSpot(spot);
  }
  return pillCX;
}

function botsTargets(st) {
  const g = { buttons: 0, show: 1, solid: 1, text: 0 };
  if (st === "listening" && BLIP()) {
    // Blip is the whole signal: no bars, no time, no ✕. The white comes only with the words (paperK).
    const cap = bCaption();
    g.h = 44; g.w = cap ? 8 + 28 + 14 + bTextW(cap, 15) + 18 : 44;
  } else if (st === "talk") {
    // Blip, and the words when there are some: the white only with them.
    const words = bTalkWords();
    g.h = 44; g.w = words ? 8 + 28 + 14 + bTextW(words, 15) + 18 : 44;
  } else if (st === "listening") {
    const cap = bCaption();
    g.h = bDisc() + 16;
    g.w = 8 + bDisc() + 12 + BOTS_BARS * 6 - 3 + 12 + (cap ? bTextW(cap, 15) + 12 : 0) + bTextW("0:00", 12) + 10 + 26 + 10;
  } else if (st === "writing" && BLIP()) {
    // No word while the words are finished: Blip types, and there is no white to hold one.
    g.h = 30; g.w = 40;
  } else if (st === "writing") {
    g.h = 40; g.w = 6 + 28 + 10 + bTextW(bWriting(), 13, true) + 16;
  } else if (st === "rest" || st === "ask") {
    const open = st === "rest" && hovered && restShown && !!hint && !BLIP();
    const blip = BLIP() && st === "rest";
    g.h = open ? (blip ? 36 : 32) : blip ? 30 : K.num("desktop.pill.restHeight", 14);
    g.w = open ? 7 + 18 + 8 + bTextW(hint, 13) + 14 + (blip ? 10 : 0) : blip ? 40 : K.num("desktop.pill.restWidth", 46);
    g.solid = open || st === "ask" ? 1 : 0; g.show = st === "ask" || restShown ? 1 : 0; g.text = open ? 1 : 0;
  } else {
    g.h = BLIP() ? 36 : 32; g.w = 12 + 12 + 8 + bTextW(bLabel(), 13) + 14 + (BLIP() ? 10 : 0); g.text = 1;
  }
  // Blip is over the text box and the words go into it as they are said: no pill and nothing in it, until he is home.
  if (BLIP() && blipAway(clock()) && (st === "listening" || st === "writing" || st === "done") && K.bool("desktop.pill.awayHides", true)) g.show = 0;
  return g;
}
/** The ✕ at the listening pill's end, where onCancel looks for it. */
function botsCancel() { const r = pillRect(); return { x: r.x + r.w - 10 - 13, y: r.y + r.h / 2, r: 13 }; }
/** The microphone, white, in a disc of `d` at (x, y). */
function bMic(x, y, d) {
  const s = d / 40;
  ctx.save(); ctx.translate(x - 12 * s * 0.9, y - 12 * s * 0.9); ctx.scale(s * 0.9, s * 0.9);
  ctx.strokeStyle = B.paper(); ctx.lineWidth = 1.9; ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.stroke(new Path2D("M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"));
  ctx.restore();
}
/** Talk mode is on: a faint clay ring behind Blip (desktop.talk.sign), breathing slowly unless motion is reduced. */
function talkSign(x, feet, h, now) {
  if (!K.bool("desktop.talk.sign", true)) return;
  const breath = REDUCED() ? 1 : 0.75 + 0.25 * Math.sin(now / 1000 * 2 * Math.PI / Math.max(0.5, K.num("desktop.talk.signBreathS", 2.4)));
  ctx.save();
  ctx.globalAlpha = P.show * clamp(K.num("desktop.talk.signAlpha", 0.22)) * breath;
  ctx.strokeStyle = B.clay(); ctx.lineWidth = K.num("desktop.talk.signWidth", 1.5);
  ctx.beginPath(); ctx.arc(x, feet - h * 0.5, h * K.num("desktop.talk.signSize", 0.55), 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

/** One frame of the Bots look. Returns true while something still moves. */
function drawBots(t, now, dt, x0, y0, cy) {
  let moving = false;
  const st = S.name, r = P.h / 2;
  ctx.save();
  if (st === "error" && t < 0.42) ctx.translate(Math.sin(t * 60) * 3 * (1 - t / 0.42), 0);
  // The pill: white with a line, a soft shadow that firms up once it is in use.
  bCapK = ease(bCapK, (st === "listening" && bCaption()) || (st === "talk" && bTalkWords()) ? 1 : 0, 9, dt);
  const paperK = !BLIP() ? 1 : st === "rest" ? outCubic(P.text) : st === "listening" || st === "talk" ? outCubic(bCapK) : st === "writing" ? 0 : 1;
  ctx.globalAlpha = P.show * (0.86 + 0.14 * P.solid) * paperK;
  ctx.shadowColor = `rgba(0,0,0,${0.08 + 0.06 * P.solid})`; ctx.shadowBlur = 10 + 10 * P.solid; ctx.shadowOffsetY = 2 + 4 * P.solid;
  ctx.fillStyle = B.paper(); ctx.beginPath(); ctx.roundRect(x0, y0, P.w, P.h, r); ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = B.line(); ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(x0 + .5, y0 + .5, P.w - 1, P.h - 1, Math.max(0, r - .5)); ctx.stroke();
  ctx.globalAlpha = P.show;
  const blip = BLIP();
  // What is in it stays in it while it grows and shrinks.
  ctx.save(); ctx.beginPath(); ctx.roundRect(x0, y0, P.w, P.h, r); ctx.clip();
  ctx.textBaseline = "middle";
  if (st === "listening") {
    const d = Math.max(0, P.h - 16), dx = x0 + 8 + d / 2;
    if (!blip) { ctx.fillStyle = B.clay(); ctx.beginPath(); ctx.arc(dx, cy, d / 2, 0, Math.PI * 2); ctx.fill(); }
    if (d > 12 && !blip) bMic(dx, cy, d);
    // The bars: the voice, low in the middle and mirrored outwards; breathing while it waits.
    const talking = now - bandsAt < 250, mid = (BOTS_BARS - 1) / 2, flashP = (now - flashAt) / 1000;
    const bx = x0 + 8 + d + 12, maxH = Math.max(6, Math.min(28, P.h - 24));
    for (let i = 0; i < (blip ? 0 : BOTS_BARS); i++) {
      const dd = Math.abs(i - mid);
      const band = bands[Math.min(bands.length - 1, Math.round(dd * 1.35))] * (1 - 0.08 * ((i * 7) % 3));
      const env = 0.5 + 0.5 * Math.cos(Math.PI * dd / (mid + 1.2));
      const breath = talking || REDUCED() ? 0 : 0.5 + 0.5 * Math.sin(t * 3.2 - dd * 0.7);
      const pulse = flashP < 0.6 ? Math.exp(-Math.pow(dd - flashP / 0.6 * (mid + 1), 2) / 2) * (1 - flashP / 0.6) : 0;
      const target = 4 + (maxH - 4) * clamp(band * env * 1.25 + pulse * .55 + breath * .12);
      bBars[i] = ease(bBars[i], target, 30, dt);
      if (Math.abs(bBars[i] - target) > 0.05) moving = true;
      ctx.globalAlpha = P.show * (talking ? 1 : 0.6);
      ctx.fillStyle = B.clay(); ctx.beginPath(); ctx.roundRect(bx + i * 6, cy - bBars[i] / 2, 3, bBars[i], 1.5); ctx.fill();
    }
    ctx.globalAlpha = P.show;
    const cap = bCaption();
    if (cap && blip) { ctx.globalAlpha = P.show * clamp((bCapK - .4) / .6); ctx.font = bFont(15); ctx.fillStyle = B.ink(); ctx.fillText(cap, x0 + 8 + 28 + 14, cy + .5); ctx.globalAlpha = P.show; }
    else if (cap) { ctx.font = bFont(15); ctx.fillStyle = B.ink(); ctx.fillText(cap, bx + BOTS_BARS * 6 - 3 + 12, cy + .5); }
    if (blip) { /* no time, no ✕: a press on the pill finishes, Esc throws it away */ } else {
    // The time, then the ✕ (cancel; a press anywhere else finishes).
    const c = { x: x0 + P.w - 10 - 13, y: cy, r: 13 };
    // The time and the ✕ come in once the pill has grown round the bars, not over them on the way.
    ctx.globalAlpha = P.show * clamp((P.w - (8 + d + 24 + BOTS_BARS * 6 + 60)) / 40);
    ctx.font = bFont(12); ctx.fillStyle = B.meta(); ctx.textAlign = "right"; ctx.fillText(bTimer(), c.x - c.r - 10, cy + .5); ctx.textAlign = "left";
    if (overCancel) { ctx.fillStyle = B.surface(); ctx.beginPath(); ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2); ctx.fill(); }
    const s = 4.2;
    ctx.strokeStyle = overCancel ? B.ink() : B.meta(); ctx.lineWidth = 1.6; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(c.x - s, c.y - s); ctx.lineTo(c.x + s, c.y + s); ctx.moveTo(c.x + s, c.y - s); ctx.lineTo(c.x - s, c.y + s); ctx.stroke();
    }
  } else if (st === "talk") {
    // Talk mode: their words grey, his in ink.
    const words = bTalkWords();
    if (words) { ctx.globalAlpha = P.show * clamp((bCapK - .4) / .6); ctx.font = bFont(15); ctx.fillStyle = talkAnswering() ? B.ink() : B.meta(); ctx.fillText(words, x0 + 8 + 28 + 14, cy + .5); ctx.globalAlpha = P.show; }
  } else if (st === "writing") {
    // The disc's three dots light in turn while the words are written.
    const dx = x0 + 6 + 14;
    if (!blip) { ctx.fillStyle = B.clay(); ctx.beginPath(); ctx.arc(dx, cy, 14, 0, Math.PI * 2); ctx.fill(); }
    const pos = REDUCED() ? 1 : ((t * 1.5) % 1.5) * 3 - 0.75;
    for (let i = 0; i < (blip ? 0 : 3); i++) {
      ctx.globalAlpha = P.show * (REDUCED() ? .9 : .35 + .65 * Math.exp(-Math.pow(i - pos, 2) * 1.6));
      ctx.fillStyle = B.paper(); ctx.beginPath(); ctx.arc(dx - 6 + i * 6, cy, 2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = P.show * clamp(P.w / 60 - .4);
    if (!blip) { ctx.font = bFont(13, true); ctx.fillStyle = B.ink(); ctx.fillText(bWriting(), x0 + 6 + 28 + 10, cy + .5); }
  } else if (st === "rest" || st === "ask") {
    if (P.text > 0.01) {
      // Hovered: the way in, beside a small clay disc.
      ctx.globalAlpha = P.show * outCubic(P.text);
      const dx = x0 + 7 + 9;
      if (!blip) { ctx.fillStyle = B.clay(); ctx.beginPath(); ctx.arc(dx, cy, 9, 0, Math.PI * 2); ctx.fill(); bMic(dx, cy, 18); }
      ctx.font = bFont(13); ctx.fillStyle = B.ink(); ctx.fillText(hint, x0 + 7 + 18 + 8 + (blip ? 10 : 0), cy + .5);
    }
    if (P.text < 0.99 && !blip) {
      // At rest: three small grey dots, the pill's way of saying it is there.
      ctx.globalAlpha = P.show * (1 - P.text) * .8;
      ctx.fillStyle = B.meta();
      for (let i = -1; i <= 1; i++) { ctx.beginPath(); ctx.arc(x0 + P.w / 2 + i * 6, cy, 1.5, 0, Math.PI * 2); ctx.fill(); }
    }
  } else {
    // Done: an ink tick that draws itself. An error: a small ink ✕ (never red). Then the words.
    ctx.globalAlpha = P.show * outCubic(P.text);
    const ix = x0 + 12 + 6, s = 4.5;
    ctx.strokeStyle = B.ink(); ctx.lineWidth = 1.8; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath();
    if (blip) { /* Blip says it with his body: no tick, no ✕ */ }
    else if (st === "done" || st === "routed") {
      const p = REDUCED() ? 1 : outCubic(t / 0.35);
      ctx.moveTo(ix - s, cy); ctx.lineTo(ix - s + (s * .7) * Math.min(1, p * 2), cy + s * .7 * Math.min(1, p * 2));
      if (p > .5) ctx.lineTo(ix - s * .3 + (s * 1.4) * (p - .5) * 2, cy + s * .7 - (s * 1.5) * (p - .5) * 2);
    } else {
      ctx.moveTo(ix - s * .8, cy - s * .8); ctx.lineTo(ix + s * .8, cy + s * .8); ctx.moveTo(ix + s * .8, cy - s * .8); ctx.lineTo(ix - s * .8, cy + s * .8);
    }
    ctx.stroke();
    ctx.font = bFont(13);
    const tx = x0 + 12 + 12 + 8 + (blip ? 10 : 0);
    if (st === "routed") drawRouted(tx, cy, B.meta(), B.ink());
    else { ctx.fillStyle = B.ink(); ctx.fillText(bLabel(), tx, cy + .5); }
  }
  ctx.restore();
  // Blip, over the pill's edge: feet in its left end, his head out over the top. Not clipped by it.
  if (blip && P.show > 0.01 && !blipAway(now) && !(st === "rest" && blipResting)) {
    const pf = blipper();
    if (st === "rest" && !REDUCED() && pf.name === "rest" && now > blipQuirkAt && P.text < 0.01) { pf.play(pf.quirk(), { now, then: "rest" }); blipQuirkAt = now + 30000 + Math.random() * 20000; }
    let bx, bh;
    if (st === "listening" || st === "talk") { bx = x0 + 8 + 14; bh = 52; }
    else if (st === "rest") { bx = lerpN(x0 + P.w / 2, x0 + 7 + 14, outCubic(P.text)); bh = 46; }
    else if (st === "ask") { bx = x0 + P.w / 2; bh = 40; }
    else { bx = x0 + 6 + 16; bh = 50; }
    // A task running, the pill stays put and he walks about the strip; going to the edge, he walks off it.
    const rm = roamMode();
    if (rm === "work" || rm === "leave") bx = W / 2 + roamNow.x;
    const hearing = st === "listening" || (st === "talk" && S.data.phase === "listen");
    const level = hearing && now - bandsAt < 250 ? Math.min(1, Math.max(...bands) * 1.3) : 0;
    if (st === "talk") talkSign(bx, y0 + P.h - 2, bh, now);
    ctx.globalAlpha = P.show;
    // Walking left, he is drawn the other way round: he faces where he goes.
    const back = roamNow.walking && roamNow.dir < 0;
    if (back) { ctx.save(); ctx.translate(bx, 0); ctx.scale(-1, 1); ctx.translate(-bx, 0); }
    pf.draw(ctx, bx, y0 + P.h - 2, bh, now, level);
    if (back) ctx.restore();
    moving = true;
  }
  // Ask: the bead on the small pill's top edge, where the guide's thread leaves it. Clay while it listens.
  if (bead > 0.01) {
    const R = K.num("desktop.pill.askBead", 3.5) * bead, still = REDUCED();
    const breath = still ? 1 : 0.5 + 0.5 * Math.sin(now / 1000 * 2 * Math.PI / Math.max(0.2, K.num("desktop.pill.askBreathS", 1.25)));
    const rr = R * (1 - 0.2 * beadHot * (1 - breath));
    ctx.globalAlpha = P.show * clamp(bead * 1.6);
    ctx.fillStyle = B.paper(); ctx.beginPath(); ctx.arc(x0 + P.w / 2, y0, rr + 1, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = mixHex(B.ink(), B.clay(), beadHot); ctx.beginPath(); ctx.arc(x0 + P.w / 2, y0, rr, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  return moving;
}
