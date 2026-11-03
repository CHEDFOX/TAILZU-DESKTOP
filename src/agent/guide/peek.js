// The peek: Blip over the text box at the cursor while a dictation records.
"use strict";

// While a dictation records, a small Blip peeks over the top edge of the
// text box at the cursor, as if reading over your shoulder: it looks down
// at the cursor with its antenna lit (the microphone is live), nods as each
// chunk of words lands, watches the last of them arrive (thinking), gives
// a little hop when they have, and ducks back below the edge. Where it
// stands is blip.js peekSpot's: on a short field's top edge at the caret,
// on a document's caret line, out from beside the field when there is no
// room above, nowhere when nothing says where the cursor is.
//
// It is Blip and nothing else: no card, ring, tether, thread or marks
// while it peeks, and a question (show) ends it first. It never takes the
// pointer: the window stays click-through, and nothing here calls
// bridge.mouse. It is decoration on top of dictation, so a message it
// cannot use is dropped without a word.
const PEEK_RISE = 280;   // ms: up over the edge, as over the card
const PEEK_DUCK = 300;   // ms: back down; ask.js hides the window about then
const PEEK_HOP = 560;    // ms: done's hop, before the duck (about 900 in all)
// ms: the hop between the pill and the text box. The pill's Blip is the one that peeks: he comes from the pill
// (the peek's `home`) and goes back to it, and the pill shows him again once he is there (ask.js PEEK_HOME_MS).
const PEEK_HOME = 440;
// ms: a peek nothing has been heard about for this long goes by itself.
// While the microphone is open the caret and the voice come several times
// a second, and the words are written in seconds; a lost unpeek (a window
// reloaded, a path that forgot it) would otherwise leave Blip over the
// text box for good, its antenna saying the microphone is on, and this
// page drawing it sixty times a second.
const PEEK_STALE = 60000;
let peekH = K.num("desktop.guide.peekHeight", 54);
const peekBlip = window.TailzuBlip.createBlip({ height: peekH });
// The whole Blip, on his way between the pill and the text box.
let tripBlip = null;
const tripper = () => tripBlip || (tripBlip = window.TailzuBlip.createPerformer({ dpr, reduced }));
const PK = {
  on: false,           // peeking: Blip-only, until it is down again
  phase: "down",       // coming (from the pill), rising, up, ducking, going (back to the pill), down
  home: null,          // [x, y]: where he stands in the pill, when he came from it
  at: 0,               // ms: when it began to rise, or to duck
  state: "listening",  // listening, writing, done
  doneAt: 0,           // ms: when it was told the words have landed
  spot: null,          // where it is going: blip.js peekSpot
  cur: null,           // where it is this frame, on its way there: { x, y, side, look }
  next: null,          // where to come up again once it is down (a far jump)
  level: 0, levelTo: 0,
  heard: 0,            // ms: when the main process last said anything of it (PEEK_STALE)
  drawn: { sink: 0, alpha: 0 },   // how far down, and how faded, it was last drawn
  from: { sink: 0, alpha: 0 },    // …and as its duck began
};
/** The size it is asked to be, from its knob, which may have come since. */
function peekSize() {
  const h = clamp(K.num("desktop.guide.peekHeight", 54), 24, 160);
  if (h !== peekH) { peekH = h; peekBlip.size(h); }
  return h;
}
/** A peek starts with nothing else of the guide up. A card still folding
 *  (a dictation started as an answer went away) is put away at once. */
function clearForPeek() {
  S.life = { open: false, at: -1e12, docked: false, from: { tether: 0, k: 0, ky: 0, alpha: 0, inner: 0 } };
  S.hideAt = 0;
  marks.length = 0;
  gone();
  blip.pose("hidden"); blip.snap();
}
function riseAt(spot, ms) {
  PK.spot = spot;
  PK.cur = { x: spot.x, y: spot.y, side: spot.side, look: spot.look.slice() };
  PK.phase = "rising"; PK.at = ms;
  PK.drawn.sink = .3 * peekH; PK.drawn.alpha = reduced ? 0 : 1;
  // From down, wherever the last peek left its face; and its clock set
  // now, or the first frame would ease a long gap's worth at once.
  peekBlip.pose("hidden"); peekBlip.snap(); peekBlip.step(ms / 1000);
}
function duckNow(ms) {
  if (PK.phase === "ducking") return;
  // From where it is: a duck that began while it was still rising (a far
  // jump, an unpeek, in its first 200 ms) bobbed up to its full height
  // before it went down, and under reduced motion flashed to full before
  // it faded.
  PK.from = { sink: PK.drawn.sink, alpha: PK.drawn.alpha };
  PK.phase = "ducking"; PK.at = ms;
}
function peek(m) {
  // A question has the guide: Ask wins (ask.js never sends one then; this
  // is the second lock).
  if (S.shown) return;
  const spot = window.TailzuBlip.peekSpot(m.caret, m.field, { w: W, h: H, top: S.inset.top },
    { height: peekSize(), tall: K.num("desktop.guide.peekTallField", 120) });
  // Nothing says where the cursor is now (a password field took focus,
  // the numbers made no sense): it goes rather than stay where it was.
  if (!spot) { unpeek(); return; }
  const state = m.state === "writing" || m.state === "done" ? m.state : "listening";
  const ms = now();
  // Done and on its way down: a late caret for the same dictation does not
  // bring it back up for a second hop.
  if (PK.on && PK.state === "done" && state === "done" && PK.phase === "ducking") return;
  PK.heard = ms;
  if (!PK.on) {
    clearForPeek();
    PK.on = true; PK.next = null;
    // A new dictation's voice, not the last one's: its antenna starts dark.
    PK.level = 0; PK.levelTo = 0;
    PK.home = Array.isArray(m.home) && Number.isFinite(m.home[0]) && Number.isFinite(m.home[1]) ? [m.home[0], m.home[1]] : null;
    if (PK.home && !reduced) {
      PK.spot = spot; PK.cur = { x: spot.x, y: spot.y, side: spot.side, look: spot.look.slice() };
      PK.phase = "coming"; PK.at = ms;
      tripper().play("travel", { now: ms });
    } else riseAt(spot, ms);
  } else if (PK.phase === "coming") {
    // Still on his way: he lands where the cursor is now.
    PK.spot = spot; PK.cur = { x: spot.x, y: spot.y, side: spot.side, look: spot.look.slice() };
  } else if (PK.phase === "ducking") {
    // On its way down (an unpeek, done's own duck, or a far jump): it
    // comes up again here once it is down.
    PK.next = spot;
  } else {
    const s = PK.spot;
    // Somewhere else altogether (the caret wrapped to the next line's
    // start, the field moved, its side changed): down here and up there,
    // rather than slide across the words. Under reduced motion it is just
    // there.
    const far = spot.side !== s.side || Math.abs(spot.x - s.x) > 300 || Math.abs(spot.y - s.y) > 160;
    if (far && !reduced) { duckNow(ms); PK.next = spot; }
    else {
      // Words landed: the caret moved on along the same line. (Not as
      // they all have: done's hop says that, and a nod on top of it shut
      // its eye.)
      if (state !== "done" && spot.side === s.side && Math.abs(spot.y - s.y) < 4 && spot.x > s.x + 4) peekBlip.nod();
      PK.spot = spot;
      if (reduced || far) PK.cur = { x: spot.x, y: spot.y, side: spot.side, look: spot.look.slice() };
    }
  }
  if (state === "done" && PK.state !== "done") PK.doneAt = ms;
  PK.state = state;
  wake();
}
/** Down below the edge at once, and gone once it is down. */
function unpeek() {
  if (!PK.on) return;
  PK.next = null;
  duckNow(now());
  wake();
}
/** Gone, now: a question is coming up in its place. */
function endPeek() {
  PK.on = false; PK.phase = "down"; PK.next = null; PK.home = null;
  peekBlip.pose("hidden"); peekBlip.snap();
}
/** One frame of the peek. False once it is over. */
function drawPeek(ms, t, dt) {
  if (!PK.on) return false;
  if (PK.phase === "coming" || PK.phase === "going") return drawTrip(ms);
  // Done: the hop, then down. And one nothing has been said of for a
  // minute: down (PEEK_STALE).
  if (PK.phase !== "ducking" && ((PK.state === "done" && ms - PK.doneAt >= PEEK_HOP) || ms - PK.heard >= PEEK_STALE)) { PK.next = null; duckNow(ms); }
  if (PK.phase === "ducking" && ms - PK.at >= (reduced ? 200 : PEEK_DUCK)) {
    if (!PK.next && PK.home && !reduced) { PK.phase = "going"; PK.at = ms; tripper().play("travel", { now: ms }); return drawTrip(ms); }
    if (!PK.next) { endPeek(); return false; }
    const s = PK.next;
    PK.next = null;
    // Back up for another go. Done while it was on its way down (the last
    // words wrapped the caret to the next line's start): its hop is up
    // there, from now. (Turned back into listening, it came up with its
    // antenna lit after the microphone had closed, and stayed so until
    // the unpeek.)
    if (PK.state === "done") PK.doneAt = ms;
    riseAt(s, ms);
  }
  if (PK.phase === "rising" && ms - PK.at >= PEEK_RISE) PK.phase = "up";
  const c = PK.cur, s = PK.spot, h = peekH;
  // Along the edge to the new caret: glided, never jumped.
  const k = reduced ? 1 : 1 - Math.exp(-dt * 10);
  c.x += (s.x - c.x) * k; c.y += (s.y - c.y) * k;
  c.look[0] += (s.look[0] - c.look[0]) * k; c.look[1] += (s.look[1] - c.look[1]) * k;
  PK.level += (PK.levelTo - PK.level) * (1 - Math.exp(-dt * 14));
  const ducking = PK.phase === "ducking";
  // Under reduced motion it does not duck: it keeps its face and fades
  // where it is. (Set to hidden at once, as its faces are, it was simply
  // gone on the first frame, with no fade at all.)
  peekBlip.pose(ducking && !reduced ? "hidden" : PK.state === "done" ? "done" : PK.state === "writing" ? "thinking" : "listening");
  peekBlip.still(reduced);
  if (reduced) peekBlip.snap();
  peekBlip.live(PK.state === "listening" && !ducking);
  // Under reduced motion the lit antenna holds still, as the pill's bead
  // does: lit, not swelling with every syllable.
  peekBlip.level(reduced ? 0 : PK.level);
  // Up: its hands come up over the edge as its head rises. Down: the head
  // drops and the hands let go a beat after, all of it below the edge in
  // 300 ms. (Left to its face's easing alone, the hands stayed on the edge
  // long after the head had gone, and the last of them was left there.)
  // Under reduced motion it fades in and out where it is.
  const e = ms - PK.at;
  let sink = 0, alpha = 1;
  if (reduced) alpha = ducking ? PK.from.alpha * (1 - clamp(e / 200)) : clamp(e / 200);
  else if (ducking) sink = Math.max(PK.from.sink, inCubic((e - 60) / (PEEK_DUCK - 60)) * .75 * h);
  else if (PK.phase === "rising") sink = (1 - outCubic(e / 200)) * .3 * h;
  PK.drawn.sink = sink; PK.drawn.alpha = alpha;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(snap(c.x), snap(c.y));
  if (c.side === "right") ctx.rotate(Math.PI / 2);
  else if (c.side === "left") ctx.rotate(-Math.PI / 2);
  // The edge it stands on hides the rest of it, as the card's does.
  ctx.beginPath(); ctx.rect(-2 * h, -2 * h, 4 * h, 2 * h); ctx.clip();
  // Its eye on the caret, in its own turned frame.
  const dx = c.look[0] - c.x, dy = c.look[1] - c.y;
  peekBlip.lookAt(c.side === "right" ? [dy, -dx] : c.side === "left" ? [-dy, dx] : [dx, dy]);
  peekBlip.draw(ctx, 0, sink, t, dpr);
  ctx.restore();
  return true;
}

/** He hops between the pill and the text box, along an arc; landed at the box he rises over its edge, back at the pill he is gone. */
function drawTrip(ms) {
  const coming = PK.phase === "coming", k = clamp((ms - PK.at) / PEEK_HOME);
  const from = coming ? PK.home : [PK.cur.x, PK.cur.y], to = coming ? [PK.spot.x, PK.spot.y] : PK.home;
  if (k >= 1) {
    if (coming) { riseAt(PK.spot, ms); return true; }
    endPeek(); return false;
  }
  const e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
  const dist = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const x = from[0] + (to[0] - from[0]) * e;
  const y = from[1] + (to[1] - from[1]) * e - Math.sin(Math.PI * k) * Math.max(50, dist * .3);
  ctx.save();
  tripper().draw(ctx, snap(x), snap(y), K.num("desktop.guide.tripHeight", 52), ms, 0);
  ctx.restore();
  return true;
}
