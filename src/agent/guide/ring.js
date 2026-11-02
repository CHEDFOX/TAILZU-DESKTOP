// The ring around what the answer is about, and its label.
"use strict";

function placeChip() {
  if (!S.ring || !S.ring.caption || S.ring.tentative) { chip.classList.remove("on"); S.chipBox = null; return; }
  const pad = K.num("desktop.guide.ringPad", 6);
  const [rx, ry, rw, rh] = S.ring.frame;
  const cw = chip.offsetWidth || 80, chh = chip.offsetHeight || 24;
  const x = Math.max(M, Math.min(W - M - cw, rx - pad));
  // Above the ring, else below it, else to one side: wherever the card is
  // not, and always on screen. A target at the very top (a tab, a toolbar,
  // a menu-bar item) has no room above it, and the card below takes the
  // spot under it, so the side spots sit level with it, kept in the window.
  const b = S.box, hits = (cx, cy) => b && cx < b.x + b.w && cx + cw > b.x && cy < b.y + b.h + 8 && cy + chh > b.y - 60;
  const ring = (cx, cy) => cx < rx + rw + pad && cx + cw > rx - pad && cy < ry + rh + pad && cy + chh > ry - pad;
  const inWin = (cx, cy) => cx >= M && cx + cw <= W - M && cy >= M && cy + chh <= H - M;
  const level = Math.max(M, Math.min(H - M - chh, ry + rh / 2 - chh / 2));
  // A number on the ring's corner (the step being done, ringed and
  // numbered both) keeps the corner: the label starts just past it, and
  // reads "2 · MESSAGE #DESIGN" rather than sitting on the number.
  const past = (sx, sy) => {
    for (const m of marks) {
      const d = m.disc;
      if (d && !m.fadeAt && sx < d.x + 13 && sx + cw > d.x - 13 && sy < d.y + 13 && sy + chh > d.y - 13) sx = d.x + 13 + 5;
    }
    return sx;
  };
  const above = ry - pad - 34, under = ry + rh + pad + 10;
  const spots = [[past(x, above), above], [past(x, under), under], [rx - pad - cw - 12, level], [rx + rw + pad + 12, level]];
  const fits = (s) => inWin(s[0], s[1]) && !ring(s[0], s[1]);
  const [cx, cy] = spots.find((s) => fits(s) && !hits(s[0], s[1])) || spots.find(fits)
    || [x, Math.max(M, Math.min(H - M - chh, spots[1][1]))];
  chip.style.setProperty("--x", Math.round(cx) + "px");
  chip.style.setProperty("--y", Math.round(cy) + "px");
  chip.classList.add("on");
  S.chipBox = { x: cx, y: cy, w: cw, h: chh };
}

function roundRect(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
/** A point `d` along a rounded rectangle's edge, clockwise from its top-left. */
function alongRect(x, y, w, h, d) {
  const P = 2 * (w + h); d = ((d % P) + P) % P;
  if (d < w) return [x + d, y];
  if (d < w + h) return [x + w, y + d - w];
  if (d < 2 * w + h) return [x + w - (d - w - h), y + h];
  return [x, y + h - (d - 2 * w - h)];
}
function dot(g, x, y, r, fill) {
  const bots = BOTS();
  g.beginPath(); g.arc(x, y, r + .9, 0, TAU); g.fillStyle = bots ? "rgba(255,255,255,.85)" : "rgba(15,13,11,.62)"; g.fill();
  g.beginPath(); g.arc(x, y, r, 0, TAU); g.fillStyle = fill || (bots ? "#0a0a0a" : "#F3E2C6"); g.fill();
}
function drawRing(t) {
  const R = S.ring; if (!R) return;
  if (R.tentative) { drawHint(t, R); return; }
  const pad = K.num("desktop.guide.ringPad", 6);
  const k = Math.min(1, (t - R.at) / .32), e = 1 - Math.pow(1 - k, 3);
  const back = 1 + (1 - e) * .28 + Math.sin(Math.PI * k) * .04;
  const [fx0, fy0, fw, fh] = R.frame;
  const cx = fx0 + fw / 2, cy = fy0 + fh / 2;
  const w = (fw + 2 * pad) * back, h = (fh + 2 * pad) * back;
  const x = cx - w / 2, y = cy - h / 2, rad = Math.min(12, h / 2);
  ctx.save();
  ctx.globalAlpha = e * (S.hideAt ? Math.max(0, 1 - (t - S.hideAt) / .25) : 1);
  // The ripple, once, as it lands.
  const rk = (t - R.at - .2) / .7;
  if (rk > 0 && rk < 1 && !reduced) {
    const g = 10 * rk;
    roundRect(ctx, x - g, y - g, w + 2 * g, h + 2 * g, rad + g);
    ctx.strokeStyle = BOTS() ? `rgba(10,10,10,${.35 * (1 - rk)})` : `rgba(232,162,60,${.5 * (1 - rk)})`; ctx.lineWidth = 2; ctx.stroke();
  }
  // The ring: amber, with its own glow, over an ink hairline that keeps it
  // visible on amber-ish backgrounds.
  roundRect(ctx, x, y, w, h, rad);
  if (BOTS()) {
    // The Bots look: an ink ring with a white edge, so it holds on a dark app too. No glow.
    ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 5; ctx.stroke();
    ctx.strokeStyle = K.color("desktop.guide.botsRing", "#0a0a0a"); ctx.lineWidth = 2; ctx.stroke();
  } else {
    ctx.strokeStyle = "rgba(15,13,11,.35)"; ctx.lineWidth = 4; ctx.stroke();
    ctx.shadowColor = "rgba(232,162,60,.65)"; ctx.shadowBlur = 14;
    ctx.strokeStyle = K.color("desktop.guide.ring", "#E8A23C"); ctx.lineWidth = 2; ctx.stroke();
  }
  ctx.shadowBlur = 0;
  // Dots marching round it, a step outside: the films' dots.
  const gapPx = 11, o = 6, P = 2 * (w + 2 * o + h + 2 * o);
  const n = Math.floor(P / gapPx), shift = reduced ? 0 : (t * 14) % gapPx;
  for (let i = 0; i < n; i++) {
    const [px, py] = alongRect(x - o, y - o, w + 2 * o, h + 2 * o, i * gapPx + shift);
    dot(ctx, px, py, 1.25);
  }
  ctx.restore();
}
/** The tentative ring: what their words so far seem to name, or the part
 *  of the window a picture is being taken of. Drawn lightly — a thin
 *  dotted line that breathes, no glow, no ripple, no thread and no label —
 *  so a guess that changes with the next word never reads as an answer.
 *  The answer's own ring lands in its place. */
function drawHint(t, R) {
  const pad = K.num("desktop.guide.ringPad", 6);
  const k = Math.min(1, (t - R.at) / .24), e = 1 - Math.pow(1 - k, 3);
  const breath = reduced ? 1 : .62 + .38 * (.5 + .5 * Math.sin((t - R.at) * K.num("desktop.guide.hintPulse", 4.2) - Math.PI / 2));
  const [fx0, fy0, fw, fh] = R.frame;
  const cx = fx0 + fw / 2, cy = fy0 + fh / 2;
  const grow = 1 + (1 - e) * .1 + (reduced ? 0 : (breath - .62) * .035);
  const w = (fw + 2 * pad) * grow, h = (fh + 2 * pad) * grow;
  const x = cx - w / 2, y = cy - h / 2, rad = Math.min(12, h / 2);
  ctx.save();
  ctx.globalAlpha = e * breath * (S.hideAt ? Math.max(0, 1 - (t - S.hideAt) / .25) : 1);
  ctx.lineCap = "round";
  // Round dots, each with an ink rim so they hold on a white page, the
  // way the ring's own marching dots do; walking slowly round.
  ctx.setLineDash([0, K.num("desktop.guide.hintGap", 6)]);
  ctx.lineDashOffset = reduced ? 0 : -t * 9;
  roundRect(ctx, x, y, w, h, rad);
  ctx.strokeStyle = BOTS() ? "rgba(255,255,255,.85)" : "rgba(15,13,11,.4)"; ctx.lineWidth = 3.8; ctx.stroke();
  ctx.strokeStyle = BOTS() ? K.color("desktop.guide.botsRing", "#0a0a0a") : K.color("desktop.guide.hint", "#E8A23C"); ctx.lineWidth = 2.6; ctx.stroke();
  ctx.restore();
}
/** Tied to the pill, a ring lower than the card's top (a Dock icon,
 *  something beside the pill) is one Blip cannot point at without
 *  reaching down through the card: the thread leaves the card's own edge
 *  for it, and Blip only looks. */
function lowRing(rc) {
  const R = S.ring;
  return !!(S.docked && R && !R.tentative && rc && R.frame[1] + R.frame[3] / 2 > rc.top);
}
/** The thread: dots from Blip's fingertip to the nearest edge of the ring. */
function drawThread(t, rc) {
  const R = S.ring;
  if (!R || R.tentative) return;
  const [rx, ry, rw, rh] = R.frame;
  const rcx = rx + rw / 2, rcy = ry + rh / 2;
  // From Blip's finger; or, when the card sits above the ring and Blip
  // cannot reach past it, from the card's own bottom edge; or, for a ring
  // lower than the card's top, from the card's nearer side, at the ring's
  // height.
  let tip = blip.fingertip();
  if (rc && (S.where === "above" || (lowRing(rc) && ry > rc.bottom && rcx > rc.left && rcx < rc.right))) {
    tip = [Math.max(rc.left + 28, Math.min(rc.right - 28, rcx)), rc.bottom + 4];
  } else if (rc && lowRing(rc)) {
    const right = rcx > (rc.left + rc.right) / 2;
    tip = [right ? rc.right + 4 : rc.left - 4, Math.max(rc.top + 18, Math.min(rc.bottom - 18, rcy))];
  }
  if (!tip) return;
  const pad = K.num("desktop.guide.ringPad", 6) + 9;
  const tx = Math.max(rx - pad, Math.min(rx + rw + pad, tip[0]));
  const ty = Math.max(ry - pad, Math.min(ry + rh + pad, tip[1]));
  const dx = tx - tip[0], dy = ty - tip[1], L = Math.hypot(dx, dy);
  if (L < 14) return;
  // A gentle arc, bowing away from the card.
  let nx = -dy / L, ny = dx / L;
  const bow = Math.min(60, L * .18), mx = (tip[0] + tx) / 2, my = (tip[1] + ty) / 2;
  if (rc) {
    const ccx = (rc.left + rc.right) / 2, ccy = (rc.top + rc.bottom) / 2;
    if (Math.hypot(mx - nx * bow - ccx, my - ny * bow - ccy) > Math.hypot(mx + nx * bow - ccx, my + ny * bow - ccy)) { nx = -nx; ny = -ny; }
  }
  const cxp = mx + nx * bow, cyp = my + ny * bow;
  const k = reduced ? 1 : Math.min(1, Math.max(0, (t - R.at - .12) / .38));
  const n = Math.max(2, Math.floor(L / 8));
  ctx.save();
  ctx.globalAlpha = S.hideAt ? Math.max(0, 1 - (t - S.hideAt) / .2) : 1;
  for (let i = 1; i <= n * k; i++) {
    const u = i / n, a = 1 - u;
    const px = a * a * tip[0] + 2 * a * u * cxp + u * u * tx, py = a * a * tip[1] + 2 * a * u * cyp + u * u * ty;
    dot(ctx, px, py, i === n ? 2 : 1.35);
  }
  ctx.restore();
}
