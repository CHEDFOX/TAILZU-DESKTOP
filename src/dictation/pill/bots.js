// The Bots look (DeskPill): the small white pill, Keylessbord's clay microphone
// and its words, behind the server's bots.app switch.
"use strict";

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
/** The words so far, their tail when they are longer than the pill has room for. */
function bCaption() {
  if (!caption) return "";
  const maxW = K.num("desktop.pill.botsTextWidth", 280);
  let s = caption;
  if (bTextW(s, 15) <= maxW) return s;
  while (s.length > 1 && bTextW("…" + s, 15) > maxW) s = s.slice(1);
  return "…" + s.trimStart();
}
/** The size for a state: the listening pill around its disc, bars, words, time and ✕; small at rest. */
function botsTargets(st) {
  const g = { buttons: 0, show: 1, solid: 1, text: 0 };
  if (st === "listening") {
    const cap = bCaption();
    g.h = bDisc() + 16;
    g.w = 8 + bDisc() + 12 + BOTS_BARS * 6 - 3 + 12 + (cap ? bTextW(cap, 15) + 12 : 0) + bTextW("0:00", 12) + 10 + 26 + 10;
  } else if (st === "writing") {
    g.h = 40; g.w = 6 + 28 + 10 + bTextW(bWriting(), 13, true) + 16;
  } else if (st === "rest" || st === "ask") {
    const open = st === "rest" && hovered && restShown && !!hint;
    g.h = open ? 32 : K.num("desktop.pill.restHeight", 14);
    g.w = open ? 7 + 18 + 8 + bTextW(hint, 13) + 14 : K.num("desktop.pill.restWidth", 46);
    g.solid = open || st === "ask" ? 1 : 0; g.show = st === "ask" || restShown ? 1 : 0; g.text = open ? 1 : 0;
  } else {
    g.h = 32; g.w = 12 + 12 + 8 + bTextW(bLabel(), 13) + 14; g.text = 1;
  }
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
/** One frame of the Bots look. Returns true while something still moves. */
function drawBots(t, now, dt, x0, y0, cy) {
  let moving = false;
  const st = S.name, r = P.h / 2;
  ctx.save();
  if (st === "error" && t < 0.42) ctx.translate(Math.sin(t * 60) * 3 * (1 - t / 0.42), 0);
  // The pill: white with a line, a soft shadow that firms up once it is in use.
  ctx.globalAlpha = P.show * (0.86 + 0.14 * P.solid);
  ctx.shadowColor = `rgba(0,0,0,${0.08 + 0.06 * P.solid})`; ctx.shadowBlur = 10 + 10 * P.solid; ctx.shadowOffsetY = 2 + 4 * P.solid;
  ctx.fillStyle = B.paper(); ctx.beginPath(); ctx.roundRect(x0, y0, P.w, P.h, r); ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = B.line(); ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(x0 + .5, y0 + .5, P.w - 1, P.h - 1, Math.max(0, r - .5)); ctx.stroke();
  ctx.globalAlpha = P.show;
  // What is in it stays in it while it grows and shrinks.
  ctx.save(); ctx.beginPath(); ctx.roundRect(x0, y0, P.w, P.h, r); ctx.clip();
  ctx.textBaseline = "middle";
  if (st === "listening") {
    const d = Math.max(0, P.h - 16), dx = x0 + 8 + d / 2;
    ctx.fillStyle = B.clay(); ctx.beginPath(); ctx.arc(dx, cy, d / 2, 0, Math.PI * 2); ctx.fill();
    if (d > 12) bMic(dx, cy, d);
    // The bars: the voice, low in the middle and mirrored outwards; breathing while it waits.
    const talking = now - bandsAt < 250, mid = (BOTS_BARS - 1) / 2, flashP = (now - flashAt) / 1000;
    const bx = x0 + 8 + d + 12, maxH = Math.max(6, Math.min(28, P.h - 24));
    for (let i = 0; i < BOTS_BARS; i++) {
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
    if (cap) { ctx.font = bFont(15); ctx.fillStyle = B.ink(); ctx.fillText(cap, bx + BOTS_BARS * 6 - 3 + 12, cy + .5); }
    // The time, then the ✕ (cancel; a press anywhere else finishes).
    const c = { x: x0 + P.w - 10 - 13, y: cy, r: 13 };
    // The time and the ✕ come in once the pill has grown round the bars, not over them on the way.
    ctx.globalAlpha = P.show * clamp((P.w - (8 + d + 24 + BOTS_BARS * 6 + 60)) / 40);
    ctx.font = bFont(12); ctx.fillStyle = B.meta(); ctx.textAlign = "right"; ctx.fillText(bTimer(), c.x - c.r - 10, cy + .5); ctx.textAlign = "left";
    if (overCancel) { ctx.fillStyle = B.surface(); ctx.beginPath(); ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2); ctx.fill(); }
    const s = 4.2;
    ctx.strokeStyle = overCancel ? B.ink() : B.meta(); ctx.lineWidth = 1.6; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(c.x - s, c.y - s); ctx.lineTo(c.x + s, c.y + s); ctx.moveTo(c.x + s, c.y - s); ctx.lineTo(c.x - s, c.y + s); ctx.stroke();
  } else if (st === "writing") {
    // The disc's three dots light in turn while the words are written.
    const dx = x0 + 6 + 14;
    ctx.fillStyle = B.clay(); ctx.beginPath(); ctx.arc(dx, cy, 14, 0, Math.PI * 2); ctx.fill();
    const pos = REDUCED() ? 1 : ((t * 1.5) % 1.5) * 3 - 0.75;
    for (let i = 0; i < 3; i++) {
      ctx.globalAlpha = P.show * (REDUCED() ? .9 : .35 + .65 * Math.exp(-Math.pow(i - pos, 2) * 1.6));
      ctx.fillStyle = B.paper(); ctx.beginPath(); ctx.arc(dx - 6 + i * 6, cy, 2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = P.show * clamp(P.w / 60 - .4);
    ctx.font = bFont(13, true); ctx.fillStyle = B.ink(); ctx.fillText(bWriting(), x0 + 6 + 28 + 10, cy + .5);
  } else if (st === "rest" || st === "ask") {
    if (P.text > 0.01) {
      // Hovered: the way in, beside a small clay disc.
      ctx.globalAlpha = P.show * outCubic(P.text);
      const dx = x0 + 7 + 9;
      ctx.fillStyle = B.clay(); ctx.beginPath(); ctx.arc(dx, cy, 9, 0, Math.PI * 2); ctx.fill();
      bMic(dx, cy, 18);
      ctx.font = bFont(13); ctx.fillStyle = B.ink(); ctx.fillText(hint, x0 + 7 + 18 + 8, cy + .5);
    }
    if (P.text < 0.99) {
      // At rest: three small grey dots, the pill's way of saying it is there.
      ctx.globalAlpha = P.show * (1 - P.text) * .8;
      ctx.fillStyle = B.meta();
      for (let i = -1; i <= 1; i++) { ctx.beginPath(); ctx.arc(W / 2 + i * 6, cy, 1.5, 0, Math.PI * 2); ctx.fill(); }
    }
  } else {
    // Done: an ink tick that draws itself. An error: a small ink ✕ (never red). Then the words.
    ctx.globalAlpha = P.show * outCubic(P.text);
    const ix = x0 + 12 + 6, s = 4.5;
    ctx.strokeStyle = B.ink(); ctx.lineWidth = 1.8; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath();
    if (st === "done" || st === "routed") {
      const p = REDUCED() ? 1 : outCubic(t / 0.35);
      ctx.moveTo(ix - s, cy); ctx.lineTo(ix - s + (s * .7) * Math.min(1, p * 2), cy + s * .7 * Math.min(1, p * 2));
      if (p > .5) ctx.lineTo(ix - s * .3 + (s * 1.4) * (p - .5) * 2, cy + s * .7 - (s * 1.5) * (p - .5) * 2);
    } else {
      ctx.moveTo(ix - s * .8, cy - s * .8); ctx.lineTo(ix + s * .8, cy + s * .8); ctx.moveTo(ix + s * .8, cy - s * .8); ctx.lineTo(ix - s * .8, cy + s * .8);
    }
    ctx.stroke();
    ctx.font = bFont(13);
    if (st === "routed") drawRouted(x0 + 12 + 12 + 8, cy, B.meta(), B.ink());
    else { ctx.fillStyle = B.ink(); ctx.fillText(bLabel(), x0 + 12 + 12 + 8, cy + .5); }
  }
  ctx.restore();
  // Ask: the bead on the small pill's top edge, where the guide's thread leaves it. Clay while it listens.
  if (bead > 0.01) {
    const R = K.num("desktop.pill.askBead", 3.5) * bead, still = REDUCED();
    const breath = still ? 1 : 0.5 + 0.5 * Math.sin(now / 1000 * 2 * Math.PI / Math.max(0.2, K.num("desktop.pill.askBreathS", 1.25)));
    const rr = R * (1 - 0.2 * beadHot * (1 - breath));
    ctx.globalAlpha = P.show * clamp(bead * 1.6);
    ctx.fillStyle = B.paper(); ctx.beginPath(); ctx.arc(W / 2, y0, rr + 1, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = mixHex(B.ink(), B.clay(), beadHot); ctx.beginPath(); ctx.arc(W / 2, y0, rr, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  return moving;
}
