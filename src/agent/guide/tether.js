// The tether: the thread from the pill to the card, and from Blip's finger to
// the ring.
"use strict";

// A cubic from the bead (the pill's centre; main.js keeps the pill's window
// over this one, so the pill hides the first few pixels and the thread
// reads as coming out of the gap between its halves) to the card's bottom
// edge. It leaves the pill straight up and arrives straight up: straight
// when the card is centred, an S when it has gone aside. Sampled into
// buffers made once, so drawing it every frame makes nothing new.
const TN = 48;
const tq = new Float64Array((TN + 1) * 2);
const tl = new Float64Array(TN + 1);
const tline = new Float64Array(2 * 400);
const PT = [0, 0, 0, 0];
function tetherCurve(x0, y0, x3, y3) {
  const span = Math.max(24, Math.abs(y0 - y3));
  // Handles three quarters of the rise: with half, a card gone far aside
  // hung from a thread that read as a slack wire sagging to the pill,
  // not one that leaves the pill straight up and goes into the card.
  const y1 = y0 - span * .75, y2 = y3 + span * .75;
  let len = 0;
  for (let i = 0; i <= TN; i++) {
    const u = i / TN, a = 1 - u;
    const x = a * a * a * x0 + 3 * a * a * u * x0 + 3 * a * u * u * x3 + u * u * u * x3;
    const y = a * a * a * y0 + 3 * a * a * u * y1 + 3 * a * u * u * y2 + u * u * u * y3;
    if (i) len += Math.hypot(x - tq[2 * i - 2], y - tq[2 * i - 1]);
    tq[2 * i] = x; tq[2 * i + 1] = y; tl[i] = len;
  }
  return len;
}
/** The point `s` along the tether and the way it runs there, into PT. */
function pointOn(s) {
  let i = 1;
  while (i < TN && tl[i] < s) i++;
  const s0 = tl[i - 1], s1 = tl[i], k = s1 > s0 ? clamp((s - s0) / (s1 - s0)) : 0;
  const ax = tq[2 * i - 2], ay = tq[2 * i - 1], bx = tq[2 * i], by = tq[2 * i + 1];
  const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1;
  PT[0] = ax + dx * k; PT[1] = ay + dy * k; PT[2] = dx / L; PT[3] = dy / L;
  return PT;
}
/** A hand's tremor: one offset per point, new a dozen times a second (the
 *  pill's thread boils the same way). */
const tremor = (i, boil) => { const v = Math.sin(i * 12.9898 + boil * 78.233) * 43758.5453; return 2 * (v - Math.floor(v)) - 1; };
function drawTether(t, o) {
  const P = S.P, c = S.cur;
  if (!P || !c || !S.life.docked) return;
  if (o.tether <= .001 && !(P.seed && o.seed > .01)) return;
  const x0 = P.x + P.w / 2, y0 = P.y + P.h / 2;
  const total = tetherCurve(x0, y0, attachX(c), c.bottom);
  const reach = total * clamp(o.tether);
  const mix = S.lineMix;
  ctx.save();
  if (reach > .5) {
    if (mix > .01) { ctx.globalAlpha = o.fade * mix; tetherLine(t, total, reach); }
    if (mix < .99) tetherDots(t, total, reach, o.fade * (1 - mix));
  }
  // Its tip, while it grows or is pulled home: a bigger dot, the bead
  // carrying the card up, and taking it back down.
  if (o.tether > .01 && o.tether < .995 && !reduced) {
    pointOn(reach);
    ctx.globalAlpha = o.fade;
    dot(ctx, PT[0], PT[1], 2.4, mix > .5 ? (BOTS() ? K.color("desktop.guide.botsLive", "#A9573A") : K.color("desktop.guide.tetherLive", "#E8A23C")) : undefined);
  }
  // No pill on this display: the seed it rises from, drawn here.
  if (P.seed && o.seed > .01) {
    const r = SEED_R * o.seed;
    ctx.globalAlpha = o.fade;
    ctx.beginPath(); ctx.arc(x0, y0, r + 1, 0, TAU); ctx.fillStyle = BOTS() ? "rgba(255,255,255,.85)" : "rgba(15,13,11,.7)"; ctx.fill();
    ctx.beginPath(); ctx.arc(x0, y0, r, 0, TAU); ctx.fillStyle = BOTS() ? "#0a0a0a" : "#F3E2C6"; ctx.fill();
  }
  ctx.restore();
}
/** Listening: an amber line over an ink hair (the pill's split thread),
 *  plucked by the voice: a standing wave along it that the level drives,
 *  and a little tremor. Its ends stay where they are tied. */
function tetherLine(t, total, reach) {
  const amp = reduced ? 0 : K.num("desktop.guide.tetherAmp", 7) * clamp(S.level);
  const boil = Math.floor(t * 12), hand = reduced ? 0 : K.num("desktop.guide.tetherHand", 0.45);
  // A point every 5 px, or further apart on a thread longer than the
  // buffer holds (a card gone aside across an ultra-wide display): a fixed
  // 5 px stopped the line 2000 px out, short of the card.
  const gap = Math.max(5, reach / 396);
  let n = 0;
  for (let s = 0; n < 399; s += gap) {
    const ss = Math.min(s, reach);
    pointOn(ss);
    const u = ss / total, env = Math.sin(Math.PI * u);
    const w = amp * (env * Math.sin(t * TAU * 5.2) + .35 * Math.sin(TAU * u) * Math.sin(t * TAU * 7.9 + 1.3)) + env * hand * tremor(n, boil);
    tline[2 * n] = PT[0] - PT[3] * w; tline[2 * n + 1] = PT[1] + PT[2] * w;
    n++;
    if (ss >= reach) break;
  }
  const trace = () => {
    ctx.beginPath(); ctx.moveTo(tline[0], tline[1]);
    for (let i = 1; i < n - 1; i++) ctx.quadraticCurveTo(tline[2 * i], tline[2 * i + 1], (tline[2 * i] + tline[2 * i + 2]) / 2, (tline[2 * i + 1] + tline[2 * i + 3]) / 2);
    ctx.lineTo(tline[2 * n - 2], tline[2 * n - 1]);
  };
  const tw = K.num("desktop.guide.tetherWidth", 1.6);
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  trace(); ctx.strokeStyle = BOTS() ? "rgba(255,255,255,.8)" : "rgba(15,13,11,.3)"; ctx.lineWidth = tw + 1.6; ctx.stroke();
  trace(); ctx.strokeStyle = BOTS() ? K.color("desktop.guide.botsLive", "#A9573A") : K.color("desktop.guide.tetherLive", "#E8A23C"); ctx.lineWidth = tw; ctx.stroke();
}
/** Not listening: cream dots, every 8 px, still. Thinking, a light runs up
 *  them from the pill to the card (the card's own row of dots does the
 *  same). Gone wrong, the dot by the card is rose for a moment. */
function tetherDots(t, total, reach, alpha) {
  const thinking = S.state === "thinking" && !reduced;
  const head = thinking ? ((t - S.stateAt) * .85) % 1.35 - .15 : -9;
  const rose = S.state === "error" ? clamp(1 - (t - S.errAt) / 1.6) : 0;
  // About 8 px apart, spread evenly from the gap in the pill to just under
  // the card's edge, so the last dot touches the card wherever it is. A dot
  // every 8 px from the pill ended anywhere up to 8 px short of the card,
  // and the thread looked as if it did not reach it. (The spacing depends
  // on the whole thread, never on how far it has grown: the dots do not
  // slide while it grows or is pulled home.)
  const s0 = 4, end = Math.max(s0, total - 3), n = Math.max(1, Math.round((end - s0) / 8)), gap = (end - s0) / n;
  for (let i = 0; i <= n; i++) {
    const s = s0 + i * gap;
    if (s > reach) break;
    pointOn(s);
    const glow = thinking ? Math.exp(-Math.pow((s / total - head) / .09, 2)) : 0;
    // The light is the dots coming up to full where it is, from faint:
    // over a white page a brighter cream would not show, a stronger dot does.
    ctx.globalAlpha = alpha * (thinking ? .3 + .7 * glow : 1);
    const last = i === n || s + gap > reach;
    dot(ctx, PT[0], PT[1], 1.35 + glow * 1.1, last && rose > 0 ? mixRose(rose) : undefined);
  }
}
function mixRose(k) {
  const a = [243, 226, 198], b = [228, 88, 123];
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * k)).join(",")})`;
}
