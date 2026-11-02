// The capsule: the pill as two halves, ink and cream, that come apart while it
// listens and click shut again, and the bead between them.
"use strict";

/** The two halves at a separation `se`: where each is, how wide, how tall,
 *  and how far each has become a disc of its own (g). */
function halves(se) {
  const R = K.num("desktop.pill.listenHeight", 38) / 2, g = SP.smooth(0, 0.4, se);
  const pd = SP.pods(podSeed(), W, se, INSET());
  const to = (a, b) => a + (b - a) * g;
  return { lx: pd.lx, rx: pd.rx, lw: to(P.w - P.cap, 2 * R), rw: to(P.cap, 2 * R), hh: to(P.h, 2 * R), g };
}

function drawCapsule(se, cy, err, t, now) {
  // The seam rounds off quickly, so a half is a disc soon after it leaves.
  const hb = halves(se), g = hb.g, hh = hb.hh, outer = hh / 2, inner = Math.min(1, g * 1.8) * hh / 2, y = cy - hh / 2;
  const solid = Math.max(P.solid, g), restA = K.num("desktop.pill.restAlpha", 0.78);
  const a = P.show * (restA + (1 - restA) * solid);
  ctx.save();
  // Shut again: a small click, the capsule squashing and settling.
  const sk = (now - snapAt) / 300, snap = sk < 1 ? Math.sin(sk * Math.PI) * (1 - sk) : 0;
  if (snap) { ctx.translate(W / 2, cy); ctx.scale(1 + .12 * snap, 1 - .1 * snap); ctx.translate(-W / 2, -cy); }
  // Ask parts the halves at the seam, each by half the gap, so the gap (and
  // the bead in it) stays where the seam was. Its cut edges soften a little
  // as it opens: two pieces, not a capsule with a slot in it. Shut, both
  // are nothing, and the capsule is exactly what it was.
  const ag = askGapPx, seamR = Math.max(inner, Math.min(1, ag / 4) * K.num("desktop.pill.askSeamRound", 2.5));
  const parts = [
    { x: hb.lx - hb.lw / 2 - ag / 2, w: hb.lw, r: [outer, seamR, seamR, outer], fill: mixHex(K.color("desktop.pill.restFill", "#2A2522"), C.ink(), solid), edge: rgba(C.pale(), .16), gloss: .10 },
    { x: hb.rx - hb.rw / 2 + ag / 2, w: hb.rw, r: [seamR, outer, outer, seamR], fill: mixHex(C.pale(), C.rose(), err * (1 - g)), edge: rgba(C.ink(), .3), gloss: .45 },
  ];
  for (const h of parts) {
    if (h.w < 0.5) continue;
    ctx.globalAlpha = a;
    ctx.shadowColor = `rgba(0,0,0,${.16 + .18 * solid})`; ctx.shadowBlur = 6 + 12 * solid; ctx.shadowOffsetY = 2 + 3 * solid;
    ctx.fillStyle = h.fill; ctx.beginPath(); ctx.roundRect(h.x, y, h.w, hh, h.r); ctx.fill();
    ctx.shadowColor = "transparent";
    // Light along the top, as on a capsule.
    ctx.save(); ctx.clip();
    const gl = ctx.createLinearGradient(0, y, 0, y + hh * .55);
    gl.addColorStop(0, `rgba(255,255,255,${h.gloss})`); gl.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gl; ctx.fillRect(h.x, y, h.w, hh * .55);
    ctx.restore();
    ctx.strokeStyle = h.edge; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(h.x + .5, y + .5, Math.max(0, h.w - 1), hh - 1, h.r.map((r) => Math.max(0, r - .5))); ctx.stroke();
  }
  // Writing: a glint runs over the shut capsule, again and again.
  if (S.name === "writing" && g < .5) {
    ctx.save(); ctx.beginPath();
    for (const h of parts) ctx.roundRect(h.x, y, h.w, hh, h.r);
    ctx.clip();
    const from = parts[0].x - 12, span = parts[1].x + parts[1].w - parts[0].x + 24;
    const gx = from + ((t * 0.9) % 1.3) / 1.3 * span;
    ctx.transform(1, 0, -0.7, 1, 0.7 * cy, 0);   // slanted, as light on a curve
    const gr = ctx.createLinearGradient(gx - 6, 0, gx + 6, 0);
    gr.addColorStop(0, "rgba(255,255,255,0)"); gr.addColorStop(.5, `rgba(255,255,255,${.42 * (1 - 2 * g)})`); gr.addColorStop(1, "rgba(255,255,255,0)");
    ctx.globalAlpha = a; ctx.fillStyle = gr; ctx.fillRect(gx - 6, y, 12, hh);
    ctx.restore();
  }
  // The bead in the gap, never wider than the gap leaves room for: it comes
  // out of the seam as the halves part, and goes back into it as they shut.
  // Only with the halves home: a dictation that took the pill from a
  // question left it hanging alone in the middle as they flew to the
  // edges, and a question asked as they came back put it there before them.
  if (bead > 0.01 && ag > 2 && se <= 0.004) drawBead(W / 2, cy, (ag - 2) / 2, now);
  // ✕ on the ink half, ✓ on the cream one, as they become discs.
  const ic = SP.smooth(0.45, 1, g);
  if (ic > 0.01) {
    const r = Math.max(2, hh / 2 - 5), lx = hb.lx, rx = hb.rx;
    ctx.globalAlpha = P.show * ic;
    if (overCancel) { ctx.fillStyle = rgba(C.pale(), .14); ctx.beginPath(); ctx.arc(lx, cy, r + 3, 0, Math.PI * 2); ctx.fill(); }
    ctx.strokeStyle = rgba(C.pale(), .92); ctx.lineWidth = 1.7; ctx.lineCap = "round";
    const s = r * .4;
    ctx.beginPath(); ctx.moveTo(lx - s, cy - s); ctx.lineTo(lx + s, cy + s); ctx.moveTo(lx + s, cy - s); ctx.lineTo(lx - s, cy + s); ctx.stroke();
    ctx.strokeStyle = C.ink(); ctx.lineWidth = 1.9; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(rx - r * .42, cy + r * .02); ctx.lineTo(rx - r * .1, cy + r * .32); ctx.lineTo(rx + r * .44, cy - r * .32); ctx.stroke();
  }
  ctx.restore();
}

/**
 * THE BEAD, where the guide's thread leaves the pill. Amber and breathing
 * while the microphone is open (the one amber the brand allows: something
 * live), cream with a slow pulse while it thinks, steady cream while it
 * shows. An ink edge keeps it on a white page, as the guide's own seed has.
 * `room` is the most the gap leaves for its radius.
 */
function drawBead(x, y, room, now) {
  const R = K.num("desktop.pill.askBead", 3.5), s = now / 1000, still = REDUCED();
  // With reduced motion its glow and its light hold still too, at the top
  // of a breath, as the guide's lamp and thinking light do: only its size
  // held, and it went on pulsing its glow, and blinking while it thought.
  const breath = still ? 1 : 0.5 + 0.5 * Math.sin(s * 2 * Math.PI / Math.max(0.2, K.num("desktop.pill.askBreathS", 1.25)));
  const pulse = still ? 1 : 0.5 - 0.5 * Math.cos(s * 2 * Math.PI / Math.max(0.2, K.num("desktop.pill.askPulseS", 1.8)));
  // It breathes in from its full size, never out past it: the gap is cut to fit it.
  // With reduced motion it does not grow or shrink, only fades in and out.
  const size = still ? 1 : (1 - 0.22 * beadHot * (1 - breath) - 0.1 * beadSlow * (1 - pulse)) * bead;
  const r = Math.min(room, R * size);
  if (r < 0.3) return;
  ctx.save();
  ctx.globalAlpha = P.show * (1 - 0.45 * beadSlow * (1 - pulse)) * clamp(still ? bead : bead * 1.6);
  ctx.shadowColor = rgba(C.amber(), (0.3 + 0.45 * breath) * beadHot); ctx.shadowBlur = (4 + 5 * breath) * beadHot;
  ctx.fillStyle = mixHex(C.pale(), C.amber(), beadHot);
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  ctx.shadowColor = "transparent";
  // The edge thins out as the bead does: on a dot a pixel across it would
  // be all edge, a ring rather than a bead.
  const edge = .4 * clamp((r - 1) / 1.5);
  if (edge > 0.01) { ctx.strokeStyle = rgba(C.ink(), edge); ctx.lineWidth = .8; ctx.beginPath(); ctx.arc(x, y, Math.max(0, r - .4), 0, Math.PI * 2); ctx.stroke(); }
  ctx.restore();
}
