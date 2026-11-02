// Where the card goes: docked over the pill, beside what it rings, or near the
// cursor, kept inside the work area.
"use strict";

const M = 16;                       // keep this far from the window's edge
const HEAD = 60;                    // room above the card for Blip's head
const SEED_R = 3.5;                 // the seed's radius: the pill's bead, as the guide draws its own
const ROUND = 18;                   // the card's corner (guide.html --r)
/** Where the card may be: the work area, less a margin. */
function room() {
  const i = S.inset;
  return { l: i.left + M, t: i.top + M, r: W - i.right - M, b: H - i.bottom - M };
}
// The height it is growing to, not the one it is passing through.
function cardSize() { return [card.offsetWidth || K.num("desktop.guide.width", 348), inner.offsetHeight || 120]; }
function clampX(x, w) { const a = room(); return Math.max(a.l, Math.min(a.r - w, x)); }
function clampY(y, h) { const a = room(); return Math.max(a.t + HEAD, Math.min(a.b - h, y)); }
/**
 * What the card is tied to, in this window's coordinates: the pill, where
 * ask.js says it is (dock); else a seed of the guide's own at the bottom of
 * the room, for the thread to rise from. Null when the card is tied to
 * nothing: the knob is off, or the pill is on another display than this
 * window (`seed: false`), where the card is placed as it was before it had
 * a pill.
 */
function pillRect() {
  if (!K.bool("desktop.guide.dock", true)) return null;
  const d = S.dock;
  if (d && d.pill) return d.pill;
  if (d && d.seed === false) return null;
  const a = room();
  const cx = (a.l + a.r) / 2, cy = a.b - K.num("desktop.guide.seedOffset", 40);
  return { x: cx - SEED_R, y: cy - SEED_R, w: 2 * SEED_R, h: 2 * SEED_R, seed: true };
}
/** Never taller than the room there is, Blip's head included: a long
 *  answer, a plan and a quote together once pushed Do it and Not now off
 *  the bottom of a small screen. What overflows is the answer and the
 *  plan, which scroll; the quote and the buttons are always there. Tied
 *  to the pill, the room is what is above the tether. */
function capCard() {
  const a = room(), P = pillRect();
  const bottom = P ? Math.min(a.b, P.y - K.num("desktop.guide.tether", 56)) : a.b;
  inner.style.maxHeight = Math.max(160, Math.floor(bottom - a.t - HEAD)) + "px";
}
/** The ring the card keeps beside. A tentative one while they are still
 *  talking is not: the guess changes with their words, and the card they
 *  are watching would chase it across the screen. */
function placedRing() {
  return S.ring && !(S.ring.tentative && S.state === "listening") ? S.ring : null;
}
/** The card's top-left, and what it is beside. */
function layout(P) {
  const [cw, ch] = cardSize();
  if (P) return docked(P, cw, ch);
  const ring = placedRing();
  if (ring) return beside(ring, cw, ch);
  const a = room();
  const blipRoom = K.num("desktop.guide.blipRoom", 66);   // Blip's head sticks up this far over the card
  if (S.anchor) {
    const [ax, ay] = S.anchor;
    const x = clampX(ax - cw * .3, cw);
    const below = Math.max(ay + 28 + blipRoom, a.t + HEAD);
    return [x, below + ch <= a.b ? below : clampY(ay - 28 - ch, ch), "anchor"];
  }
  // Nowhere in particular: low and centred, above where the pill lives.
  return [clampX((a.l + a.r - cw) / 2, cw), clampY(a.b - ch - K.num("desktop.guide.bottomOffset", 110), ch), "default"];
}
/** Beside the ring: below it if there is room, else above, else level with it. */
function beside(ring, cw, ch) {
  const a = room();
  const blipRoom = K.num("desktop.guide.blipRoom", 66);
  const pad = K.num("desktop.guide.ringPad", 6);
  const [rx, ry, rw, rh] = ring.frame;
  const r = { x: rx - pad, y: ry - pad, w: rw + 2 * pad, h: rh + 2 * pad };
  const x = clampX(r.x + r.w / 2 - cw * .32, cw);
  const gap = 18;
  // Below, with Blip's head between the ring and the card.
  const below = Math.max(r.y + r.h + gap + blipRoom, a.t + HEAD);
  if (below + ch <= a.b) return [x, below, "below"];
  // Above, a little further off: the thread runs down from the card to it.
  if (r.y - gap * 2 - ch >= a.t + blipRoom) return [x, r.y - gap * 2 - ch, "above"];
  // Beside: whichever side has room, level with the ring.
  const y = clampY(r.y + r.h / 2 - ch / 2, ch);
  if (r.x + r.w + gap * 2 + cw <= a.r) return [r.x + r.w + gap * 2, y, "right"];
  if (r.x - gap * 2 - cw >= a.l) return [r.x - gap * 2 - cw, y, "left"];
  return [x, clampY(a.b - ch, ch), "default"];
}
/**
 * TIED TO THE PILL: the card's bottom edge a tether's length above it,
 * centred on it. What the card (Blip's head included) would cover of the
 * answer's ring or of the marks drawn on the screen sends it sideways along
 * the bottom, to just right or just left of what it covered, wherever it
 * then covers none of them and moves least; the tether bends after it. A
 * ring too big for that (a whole pane) gets the card beside it as before
 * it had a pill, still tied. Marks it cannot get clear of it covers.
 */
function docked(P, cw, ch) {
  const a = room();
  const x = clampX(P.x + P.w / 2 - cw / 2, cw);
  const y = clampY(P.y - K.num("desktop.guide.tether", 56) - ch, ch);
  // Only an answer's ring moves it. A tentative one is a guess, or the
  // picture being looked at, which can be the whole window: kept clear of,
  // it sent the card gliding across the screen in the middle of an
  // answer, for a ring it can never be clear of.
  const ring = S.ring && !S.ring.tentative ? S.ring : null;
  // The marks too: the first one takes the place of the picture's
  // tentative ring, and the card, back over the pill, sat on the very
  // triangle it was drawing on, Blip's head over two of its marks.
  const keep = [];
  let ringBox = null;
  if (ring) {
    const pad = K.num("desktop.guide.ringPad", 6) + 12;    // the ring's marching dots, and a breath
    const [rx, ry, rw, rh] = ring.frame;
    ringBox = [rx - pad, ry - pad, rx + rw + pad, ry + rh + pad];
    keep.push(ringBox);
  }
  for (const m of marks) if (!m.fadeAt) for (const [ax, ay, aw, ah] of m.areas) keep.push([ax - 10, ay - 10, ax + aw + 10, ay + ah + 10]);
  // Gone aside, it stays aside when what it made room for goes: it moves
  // to make room, and coming back as an answer ends was movement for
  // nothing. The next card starts over the pill.
  if (!keep.length) return [S.slid && S.box ? clampX(S.box.x, cw) : x, y, "dock"];
  const blipRoom = K.num("desktop.guide.blipRoom", 66);
  const hits = ([l, t, r, b], cx) => cx < r && cx + cw > l && y - blipRoom < b && y + ch > t;
  const over = (cx) => keep.some((k) => hits(k, cx));
  if (!over(x)) return [x, y, "dock"];
  // Far enough off that the thread to the ring still shows between them;
  // nearer, down to a small gap, where the screen's edge leaves less room
  // (a wide ring, a message box across the window), rather than give up
  // the bottom and go over the ring with the tether through it.
  const gap = K.num("desktop.guide.slideGap", 44), least = 12;
  let best = null;
  for (const [l, , r] of keep) {
    for (const cx of [Math.min(r + gap, a.r - cw), Math.max(l - gap - cw, a.l)]) {
      if (cx < a.l || cx + cw > a.r || over(cx) || (cx > x ? cx < r + least : cx + cw > l - least)) continue;
      if (best === null || Math.abs(cx - x) < Math.abs(best - x)) best = cx;
    }
  }
  if (best !== null) return [best, y, "dock"];
  // Only the ring itself under the card sends it to the ring's side: a
  // ring at the top of the screen, with a mark under the card it could not
  // get clear of, sent it flying up there on a tether across the screen,
  // where it covered the work and was no clearer of the mark.
  if (!ringBox || !hits(ringBox, x)) return [x, y, "dock"];
  // Still tied: never lower than the tether lets it be, or the thread
  // between it and the pill would be all but gone. Where beside() has no
  // side for it either (a ring the whole screen wide), it is over the
  // ring wherever it goes, so it stays over the pill.
  const v1 = beside(ring, cw, ch);
  if (v1[2] === "default") return [x, y, "dock"];
  return [v1[0], Math.min(v1[1], y), v1[2]];
}
function place(instant) {
  if (!S.shown) return;
  const P = pillRect();
  S.P = P; S.docked = !!P;
  const [lx, ly, where] = layout(P);
  const [cw, ch] = cardSize();
  if (P) S.slid = Math.abs(lx - clampX(P.x + P.w / 2 - cw / 2, cw)) > 1;
  // Up, and tied to the pill now when it came up tied to nothing (the
  // pill is back on this display): the thread grows up to it from the
  // pill, the card as it is. Its life was not a docked one, and the
  // tether is only drawn for one that is.
  if (P && S.life.open && !S.life.docked) {
    const o = lifeAt(now());
    S.life = { open: true, at: now(), docked: true, from: { tether: 0, k: 1, ky: 1, alpha: o.alpha, inner: o.inner } };
  }
  // Whatever the ring's place, the card itself is always all on screen.
  const x = clampX(lx, cw), y = clampY(ly, ch);
  S.where = where; S.box = { x, y, w: cw, h: ch };
  if (instant || !S.cur) S.cur = { x, y, w: cw, h: ch, bottom: y + ch };
  placeChip();
  relabel();
  wake();
}
/** The card's height follows its content, smoothly (moveCard). */
const fit = () => place(false);
new ResizeObserver(fit).observe(inner);
const near = (v, to) => (Math.abs(v - to) < .05 ? to : v);
/** The card on its way to where it was laid out: it glides there. Tied to
 *  the pill its bottom edge is what is placed, so a growing answer grows
 *  the card upward and the tether's end stays put. */
function moveCard(dt) {
  const b = S.box, c = S.cur;
  if (!b || !c) return;
  // Under reduced motion it does not glide or grow: it is where it goes,
  // at the height it is, as it was when CSS moved it (only its opacity
  // was ever eased then).
  const kp = reduced ? 1 : 1 - Math.exp(-dt * K.num("desktop.guide.glideRate", 11));
  const kh = reduced ? 1 : 1 - Math.exp(-dt * K.num("desktop.guide.fitRate", 15));
  c.w = b.w;
  c.x = near(c.x + (b.x - c.x) * kp, b.x);
  c.h = near(c.h + (b.h - c.h) * kh, b.h);
  if (S.docked) { c.bottom = near(c.bottom + (b.y + b.h - c.bottom) * kp, b.y + b.h); c.y = c.bottom - c.h; }
  else { c.y = near(c.y + (b.y - c.y) * kp, b.y); c.bottom = c.y + c.h; }
}
/** Where the thread meets the card: under the pill, as far along the
 *  card's bottom edge as it reaches, 40 px short of its corners. */
function attachX(c) {
  const P = S.P;
  const px = P ? P.x + P.w / 2 : c.x + c.w / 2;
  return clamp(px, c.x + 40, c.x + c.w - 40);
}
const snap = (v) => Math.round(v * dpr) / dpr;
