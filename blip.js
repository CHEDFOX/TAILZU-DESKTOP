/**
 * BLIP — the guide's small presenter: one great eye under a heavy lid and a
 * single brow, a head too big on a neck too long, two antennae (one bent) and
 * noodle arms. The same figure as the Mac lessons (TAILZU-FRONTEND
 * tools/media/social.html, drawFigureBlip), drawn small, peeking over the top
 * edge of the guide's card.
 *
 * DOTS, LIKE THE FILMS. The figure is painted in greys into a buffer one cell
 * per dot, then an 8×8 ordered dither decides which cells are lit; each lit
 * cell is drawn as a round pale dot. Under the dots is the figure's own
 * silhouette, grown by one cell, in ink: a sticker edge, so Blip reads over a
 * white document and over a dark editor alike.
 *
 * Only what shows above the card is drawn — head, antennae, the top of the
 * neck, hands on the edge — and it is clipped at the edge, so the card hides
 * the rest. One amber, when something is live (the microphone open): the bent
 * antenna's tip.
 *
 * Coordinates: `draw(ctx, ax, ay, t)` puts the middle of Blip's stretch of the
 * card's top edge at (ax, ay), in CSS pixels of a context already scaled for
 * the display. `fingertip()` is where a pointing hand ends, for the thread.
 *
 * It also peeks over the text box you are dictating into, small, at the
 * cursor (guide.js peek): `peekSpot()` below says where it stands for a
 * caret and a field, and the same figure is drawn there on that edge.
 *
 * And it walks: `createWalker()` at the foot of this file is the whole Blip,
 * standing on the ground, who goes with you through the onboarding (sdui.js
 * OnboardStage). One canvas for the life of the window; each step only says
 * where he should stand.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.TailzuBlip = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const TAU = Math.PI * 2;
  const BAYER = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
    3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21];
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const grey = (l) => { const v = Math.round(clamp(l) * 255); return `rgb(${v},${v},${v})`; };

  // The faces it can make. Each value is eased toward, never jumped to.
  //   rise   how far it has come up over the edge (0 hidden, 1 peeking)
  //   tilt   head tilt, radians
  //   brows  -1 frowning … 1 raised
  //   lid    0 open … 1 shut (the heavy lid's resting droop is .18)
  //   hands  0 both on the edge … 1 the near hand up and pointing
  //   hop    a little jump (done)
  const POSES = {
    hidden:    { rise: 0,    tilt: 0,    brows: 0,    lid: .18, hands: 0, hop: 0 },
    peek:      { rise: 1,    tilt: .04,  brows: .1,   lid: .18, hands: 0, hop: 0 },
    listening: { rise: 1.06, tilt: -.1,  brows: .55,  lid: .02, hands: 0, hop: 0 },
    thinking:  { rise: 1,    tilt: .16,  brows: .85,  lid: .3,  hands: 0, hop: 0 },
    point:     { rise: 1.04, tilt: 0,    brows: .4,   lid: .08, hands: 1, hop: 0 },
    confirm:   { rise: 1.02, tilt: -.06, brows: .7,   lid: .1,  hands: 1, hop: 0 },
    done:      { rise: 1.1,  tilt: .08,  brows: .5,   lid: .3,  hands: 0, hop: 1 },
    oops:      { rise: .9,   tilt: -.14, brows: -.8,  lid: .34, hands: 0, hop: 0 },
  };

  function createBlip(opts) {
    const o = Object.assign({ height: 96, pale: [243, 226, 198], ink: "rgba(15,13,11,.94)", live: "#E8A23C" }, opts || {});
    let H = o.height;
    let poseName = "hidden";
    const cur = Object.assign({}, POSES.hidden);
    let look = null;          // where the eye looks, canvas CSS px; null wanders
    let target = null;        // where the pointing hand points, canvas CSS px
    let speaking = false;
    let live = false;
    let level = 0;            // the voice, 0..1: the lit antenna's glow breathes with it
    let still = false;        // reduced motion: no bob, no sway, no hop, no nod
    let nodNext = false, nodAt = -1e9;
    let last = 0;
    let buf = null, cellPx = 0;
    let on = null;            // which cells the figure touches, this frame (kept, not made anew each frame)
    let anchor = [0, 0];
    let tip = null;

    function pose(name) { if (POSES[name]) poseName = name; }
    function size(h) { H = h; buf = null; }

    /** The figure, in greys, in its own box: W wide, H tall, the card's edge at
     *  EDGE·H. Returns where the pointing fingertip ended (box coords). */
    function figure(g, W, p, t) {
      const EDGE = .5;
      const cx = W / 2;
      const bob = still ? 0 : Math.sin(t * TAU * .9) * .008 * H - p.hop * Math.abs(Math.sin(t * TAU * 1.6)) * .05 * H;
      const lift = (1 - clamp(p.rise, 0, 1.2)) * .52 * H;  // how far below its peek it sits
      // A nod: the head dips and comes back up, its lid with it. Over a text
      // box it says "got that" as each chunk of words lands.
      const nk = (t - nodAt) / .34, nod = still || nk < 0 || nk >= 1 ? 0 : Math.sin(Math.PI * nk);
      const dy = lift + bob + nod * .07 * H;
      const sway = still ? 0 : Math.sin(t * TAU * .45) * .02;
      // Where things are aimed from: the eye, and the near shoulder.
      const hx = cx, hy = .3 * H + dy, R = .16 * H;
      const side = target && target[0] < anchor[0] ? -1 : 1;

      // NOODLE ARMS. Each is one curve from a shoulder hidden behind the card
      // to a mitt: both mitts resting on the edge, or the near one raised and
      // pointing toward the target with the far one still holding on.
      let fingertip = null;
      const shoulderY = .56 * H + dy * .3;
      const armTone = .4, armHi = .56;
      const drawArm = (s, hand) => {
        const sx = cx + s * .11 * H;
        let mx = cx + s * .2 * H, my = EDGE * H - .035 * H + dy * .15;
        let dir = null;
        if (hand > 0 && target) {
          // Toward the target, from the shoulder, a fixed reach.
          const ox = anchor[0] - W / 2, oy = anchor[1] - EDGE * H;   // box → canvas offset
          const tx = target[0] - ox, ty = target[1] - oy;
          let vx = tx - sx, vy = ty - shoulderY; const L = Math.hypot(vx, vy) || 1; vx /= L; vy /= L;
          // Never down into the card: a target below points out to the side.
          if (vy > -.15) { vy = -.15; const n = Math.hypot(vx, vy); vx /= n; vy /= n; }
          const reach = .36 * H;
          const px = sx + vx * reach, py = shoulderY + vy * reach;
          mx = mx + (px - mx) * hand; my = my + (py - my) * hand;
          dir = [vx, vy];
        }
        g.lineCap = "round"; g.lineJoin = "round";
        const c1x = (sx + mx) / 2 + s * .07 * H, c1y = (shoulderY + my) / 2 + .02 * H;
        g.strokeStyle = grey(armTone); g.lineWidth = .075 * H;
        g.beginPath(); g.moveTo(sx, shoulderY); g.quadraticCurveTo(c1x, c1y, mx, my); g.stroke();
        g.strokeStyle = grey(armHi); g.lineWidth = .024 * H;
        g.beginPath(); g.moveTo(sx - s * .01 * H, shoulderY - .018 * H); g.quadraticCurveTo(c1x - s * .01 * H, c1y - .018 * H, mx - s * .008 * H, my - .016 * H); g.stroke();
        // The mitt, and on a pointing hand, the finger.
        g.fillStyle = grey(.86); g.beginPath(); g.arc(mx, my, .05 * H, 0, TAU); g.fill();
        if (dir && hand > .5) {
          g.strokeStyle = grey(.86); g.lineWidth = .032 * H;
          const fx = mx + dir[0] * .095 * H, fy = my + dir[1] * .095 * H;
          g.beginPath(); g.moveTo(mx, my); g.lineTo(fx, fy); g.stroke();
          fingertip = [fx, fy];
        } else {
          // Resting: three finger-bumps over the edge.
          g.fillStyle = grey(.9);
          for (let i = -1; i <= 1; i++) { g.beginPath(); g.arc(mx + i * .028 * H, my + .03 * H, .017 * H, 0, TAU); g.fill(); }
        }
      };
      drawArm(-side, 0);

      // The neck, a little curved, too long.
      g.strokeStyle = grey(.72); g.lineWidth = .028 * H; g.lineCap = "round";
      g.beginPath(); g.moveTo(cx, .53 * H + dy); g.quadraticCurveTo(cx + .035 * H, .49 * H + dy, cx, .44 * H + dy); g.stroke();

      // THE HEAD, tilted from the base of the neck.
      g.save(); g.translate(hx, hy + R); g.rotate(p.tilt + sway + nod * .08); g.translate(-hx, -(hy + R));
      // The antennae (one curled with a ball, one bent at a knee) are thin
      // lines, too fine for dots: drawn solid with the face (see drawFace).
      const wob = still ? 0 : Math.sin(t * TAU * (live ? 2.6 : 1.6)) * .025 * H;
      // The skull, lit from the top left.
      const sg = g.createRadialGradient(hx - .06 * H, hy - .06 * H, 0, hx, hy, R * 1.3);
      sg.addColorStop(0, grey(.82)); sg.addColorStop(.55, grey(.6)); sg.addColorStop(1, grey(.36));
      g.fillStyle = sg; g.beginPath(); g.ellipse(hx, hy, R * 1.1, R * .94, 0, 0, TAU); g.fill();
      // The ear-bolts.
      g.fillStyle = grey(.5);
      [-1, 1].forEach((s) => { g.beginPath(); g.rect(hx + s * R * 1.1 - .012 * H, hy - .015 * H, .024 * H, .03 * H); g.fill(); });
      // THE EYE is not dotted: it is drawn solid over the dots (see draw), so
      // the one great eye is what you see first at any size. Here only its
      // place is kept clear, and where it looks is worked out.
      const ex = hx - .005 * H, ey = hy - .012 * H, er = .09 * H;
      // Held still (reduced motion), it does not blink either: a flicker
      // every few seconds at the cursor is still a movement there.
      const blink = !still && ((t * 1000 + 300) % 3700) < 120;
      const lid = blink ? 1 : clamp(p.lid + nod * .3);
      g.save(); g.globalCompositeOperation = "destination-out"; g.beginPath(); g.arc(ex, ey, er + .012 * H, 0, TAU); g.fill(); g.restore();
      let lx, ly;
      if (look) {
        const ox = anchor[0] - W / 2, oy = anchor[1] - EDGE * H;
        const vx = look[0] - ox - ex, vy = look[1] - oy - ey, L = Math.hypot(vx, vy) || 1;
        const k = Math.min(1, L / (2 * H));
        lx = vx / L * .036 * H * k; ly = vy / L * .03 * H * k;
      } else {
        lx = .018 * H * Math.sin(t * .9) + .006 * H * Math.sin(t * 2.3);
        ly = .008 * H * Math.cos(t * 1.3);
      }
      // The face's frame (the head's tilt), for the solid pass.
      const face = { hx, hy, R, angle: p.tilt + sway + nod * .08, ex, ey, er, lx, ly, lid, blink, brows: p.brows, wob };
      g.restore();

      // The near arm last, over the face if it crosses it.
      drawArm(side, clamp(p.hands));
      return { fingertip, face };
    }

    /** The face, solid: the eye (an ink rim, the pale white, a pupil and its
     *  glint, the heavy lid), the one brow, the mouth. In box coordinates. */
    function drawFace(c, f, t) {
      const { hx, hy, R, ex, ey, er, lx, ly, lid } = f;
      const [pr, pg, pb] = o.pale, pale = `rgb(${pr},${pg},${pb})`, ink = "#0F0D0B";
      c.save();
      c.translate(hx, hy + R); c.rotate(f.angle); c.translate(-hx, -(hy + R));
      // The antennae, rooted in the skull.
      const wob = f.wob, kx = hx - .068 * H + wob, ky = hy - R * 1.62;
      c.lineCap = "round"; c.lineJoin = "round";
      const stalks = () => {
        c.beginPath(); c.moveTo(hx - .045 * H, hy - R * .82); c.quadraticCurveTo(hx - .115 * H, hy - R * 1.34, kx, ky);
        c.moveTo(hx + .05 * H, hy - R * .82); c.lineTo(hx + .092 * H, hy - R * 1.24); c.lineTo(hx + .142 * H, hy - R * 1.17);
        c.stroke();
      };
      c.strokeStyle = "rgba(15,13,11,.94)"; c.lineWidth = Math.max(2.6, .032 * H); stalks();
      c.strokeStyle = pale; c.lineWidth = Math.max(1, .011 * H); stalks();
      // The ball: amber while the microphone is open.
      const br = .03 * H;
      // (At a quarter of whatever the caller draws it at: Blip fades with the
      // card when the card folds away.) With a voice (`level`) the glow
      // swells and brightens with it, the way the pill's thread is plucked.
      if (live) {
        const a0 = c.globalAlpha, lv = clamp(level);
        c.fillStyle = o.live; c.globalAlpha = a0 * (.25 + .45 * lv);
        c.beginPath(); c.arc(kx, ky, br * (2.1 + 2.2 * lv), 0, TAU); c.fill(); c.globalAlpha = a0;
      }
      c.fillStyle = ink; c.beginPath(); c.arc(kx, ky, br + .012 * H, 0, TAU); c.fill();
      c.fillStyle = live ? o.live : pale; c.beginPath(); c.arc(kx, ky, br, 0, TAU); c.fill();
      c.fillStyle = ink; c.beginPath(); c.arc(ex, ey, er + .016 * H, 0, TAU); c.fill();
      c.fillStyle = pale; c.beginPath(); c.arc(ex, ey, er, 0, TAU); c.fill();
      const pr2 = .042 * H;
      c.fillStyle = ink; c.beginPath(); c.arc(ex + lx * 1.15, ey + ly * 1.15, pr2, 0, TAU); c.fill();
      c.fillStyle = pale; c.beginPath(); c.arc(ex + lx * 1.15 - pr2 * .38, ey + ly * 1.15 - pr2 * .42, pr2 * .3, 0, TAU); c.fill();
      if (lid > .01) {
        // The lid comes down from the top: a skull-dark cap, its edge a line.
        c.save(); c.beginPath(); c.arc(ex, ey, er + .001 * H, 0, TAU); c.clip();
        const ly0 = ey - er + 2 * er * lid;
        c.fillStyle = "#3A332D"; c.fillRect(ex - er - 1, ey - er - 1, 2 * er + 2, ly0 - (ey - er) + 1);
        c.strokeStyle = ink; c.lineWidth = Math.max(1, .014 * H); c.beginPath(); c.moveTo(ex - er, ly0); c.lineTo(ex + er, ly0); c.stroke();
        c.restore();
      }
      // The one brow: up when it is curious, down at the middle when it is sorry.
      c.strokeStyle = ink; c.lineWidth = Math.max(1.4, .022 * H); c.lineCap = "round";
      const by = ey - er - .03 * H - f.brows * .022 * H;
      c.beginPath();
      if (f.brows < -.2) { c.moveTo(ex - er * .95, by - .012 * H); c.quadraticCurveTo(ex, by + .02 * H, ex + er * .95, by - .012 * H); }
      else { c.moveTo(ex - er * .95, by + .01 * H); c.quadraticCurveTo(ex, by - .028 * H, ex + er * .95, by + .01 * H); }
      c.stroke();
      // The mouth, small and off to one side; open and shut while it speaks.
      const mx = hx + .045 * H, my = hy + .108 * H;
      c.fillStyle = ink; c.strokeStyle = ink; c.lineWidth = Math.max(1.2, .016 * H);
      if (poseName === "done") { c.beginPath(); c.ellipse(mx, my - .004 * H, .034 * H, .022 * H, -.15, 0, Math.PI); c.fill(); }
      else if (speaking && Math.sin(t * TAU * 6.5) > -.2) { c.beginPath(); c.ellipse(mx, my, .016 * H, .019 * H * (.6 + .4 * Math.abs(Math.sin(t * TAU * 6.5))), 0, 0, TAU); c.fill(); }
      else if (f.brows < -.2) { c.beginPath(); c.arc(mx, my + .018 * H, .026 * H, Math.PI * 1.2, Math.PI * 1.8); c.stroke(); }
      else { c.beginPath(); c.arc(mx, my - .02 * H, .03 * H, Math.PI * .22, Math.PI * .72); c.stroke(); }
      c.restore();
    }

    /** The face moves toward its pose by the time since the last frame. */
    function step(t) {
      const dt = Math.min(.1, Math.max(0, t - last)); last = t;
      if (nodNext) { nodNext = false; nodAt = t; }
      const goal = POSES[poseName];
      const rate = 1 - Math.pow(.0009, dt);   // ~120 ms to most of the way
      for (const k in cur) cur[k] += (goal[k] - cur[k]) * rate;
    }

    /** One frame. `ax, ay`: the middle of its stretch of the card's top edge. */
    function draw(ctx, ax, ay, t, dpr) {
      step(t);
      anchor = [ax, ay];
      if (cur.rise < .02) { tip = null; return; }

      const r = dpr || 1;
      // A dot is about 1.6 CSS px: a whole number of device pixels, never under two.
      const cell = Math.max(2, Math.round(1.6 * r)) / r;
      const W = H * 1.3, EDGE = .5;
      const bw = Math.ceil(W / cell), bh = Math.ceil(EDGE * H / cell) + 1;
      if (!buf || cellPx !== cell || buf.width !== bw || buf.height !== bh) {
        buf = (typeof OffscreenCanvas !== "undefined") ? new OffscreenCanvas(bw, bh) : Object.assign(document.createElement("canvas"), { width: bw, height: bh });
        cellPx = cell;
      }
      const g = buf.getContext("2d", { willReadFrequently: true });
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, bw, bh);
      g.setTransform(1 / cell, 0, 0, 1 / cell, 0, 0);
      const f = figure(g, W, cur, t);
      const src = g.getImageData(0, 0, bw, bh).data;

      const ox = ax - W / 2, oy = ay - EDGE * H;
      // The sticker: every cell the figure touches, grown by one, in ink.
      if (!on || on.length !== bw * bh) on = new Uint8Array(bw * bh);
      for (let i = 0; i < bw * bh; i++) on[i] = src[i * 4 + 3] > 60 ? 1 : 0;
      ctx.save();
      // Cut at the edge it stands on, and only there: two cells over the top
      // of its box cut the antenna's ball off at the top of a hop, and its
      // glow off while it listened.
      const over = cell * 2 + .14 * H;
      ctx.beginPath(); ctx.rect(ox - cell * 2, oy - over, W + cell * 4, EDGE * H + over); ctx.clip();
      ctx.fillStyle = o.ink;
      ctx.beginPath();
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        let hit = on[y * bw + x];
        if (!hit) {
          for (let j = -1; j <= 1 && !hit; j++) for (let i = -1; i <= 1 && !hit; i++) {
            const xx = x + i, yy = y + j;
            if (xx >= 0 && yy >= 0 && xx < bw && yy < bh && on[yy * bw + xx]) hit = 1;
          }
        }
        if (hit) { const px = ox + x * cell, py = oy + y * cell; ctx.moveTo(px + cell, py + cell / 2); ctx.arc(px + cell / 2, py + cell / 2, cell * .62, 0, TAU); }
      }
      ctx.fill();
      // The dots: lit where the grey beats the dither's threshold.
      const [pr, pg, pb] = o.pale;
      ctx.fillStyle = `rgb(${pr},${pg},${pb})`;
      ctx.beginPath();
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        const i = (y * bw + x) * 4, a = src[i + 3];
        if (a < 90) continue;
        const lum = (src[i] * .3 + src[i + 1] * .59 + src[i + 2] * .11) / 255 * (a / 255);
        if (lum > (BAYER[(y & 7) * 8 + (x & 7)] + .5) / 64) {
          const px = ox + x * cell + cell / 2, py = oy + y * cell + cell / 2;
          ctx.moveTo(px + cell * .47, py); ctx.arc(px, py, cell * .47, 0, TAU);
        }
      }
      ctx.fill();
      // The face, solid, over the dots.
      ctx.save(); ctx.translate(ox, oy); drawFace(ctx, f.face, t); ctx.restore();
      ctx.restore();
      tip = f.fingertip ? [ox + f.fingertip[0], oy + f.fingertip[1]] : null;
    }

    return {
      pose, size, draw,
      // Not drawn this frame (the card it stands on has gone): it still
      // ducks, so it is not left half up for the next card, and shown()
      // can say when it is down.
      step,
      lookAt(p) { look = p ? [p[0], p[1]] : null; },
      pointAt(p) { target = p ? [p[0], p[1]] : null; },
      speaking(on) { speaking = !!on; },
      live(on) { live = !!on; },
      /** The voice, 0..1, for the lit antenna's glow. */
      level(v) { level = typeof v === "number" && Number.isFinite(v) ? clamp(v) : 0; },
      /** A nod, once, from the next frame. */
      nod() { if (!still) nodNext = true; },
      /** Reduced motion: it holds still, faces and all (see snap). */
      still(on) { still = !!on; },
      /** The pose's face at once, not eased toward: it appears and goes, and
       *  changes its face, without moving to get there. */
      snap() { Object.assign(cur, POSES[poseName]); },
      fingertip() { return tip; },
      shown() { return cur.rise > .05; },
      state() { return Object.assign({ pose: poseName }, cur); },
    };
  }

  // ---- where it peeks over a text box --------------------------------------------
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  /** [x, y, w, h] of plain finite numbers, none negative in size; else null.
   *  Only numbers: Number(null) is 0, and a frame with a missing y would be
   *  one at the top of the screen. */
  function frameOf(r) {
    if (!Array.isArray(r) || r.length !== 4 || !r.every(isNum)) return null;
    return r[2] >= 0 && r[3] >= 0 ? r.slice() : null;
  }
  /**
   * WHERE BLIP PEEKS FROM while you dictate: over the top edge of the text
   * box, at the cursor, as if reading over your shoulder. Pure, so it can be
   * tested away from a page.
   *
   *   caret, field   [x, y, w, h] or null, in the guide window's coordinates
   *   view           { w, h, top }: the window, and where its usable top is
   *                  (below a Mac's menu bar)
   *   o              { height: Blip's height, tall: a field taller than this
   *                  is a document }
   *
   * → null (no peek: it never shows where it cannot know where the cursor
   * is), or { x, y, side, look, tall }: (x, y) is the middle of its stretch
   * of the edge it stands on; side is where its head points, "top" (up, over
   * a top edge), or "right" / "left" (out from beside the field, when there
   * is no room above it); look is where its eye looks.
   *
   *  - A short field: it stands on the field's top edge, at the caret's x
   *    (+10, just past it), kept 24 px in from the field's ends.
   *  - A tall one (a document, a long message box): on the caret's own line
   *    top instead, a little to its right (+18), so it never covers the
   *    cursor or the words just written.
   *  - No caret, only a field: the field's top-right corner.
   *  - No room above (the field at the top of the screen): from beside its
   *    right edge at the caret's height, else its left; never off screen,
   *    and nowhere at all when neither side has room.
   *  - A field larger than the window is cut to it. A caret far outside its
   *    field is not believed (the field is), one just outside is brought in.
   */
  function peekSpot(caret, field, view, o) {
    const W = view && isNum(view.w) ? view.w : 0, VH = view && isNum(view.h) ? view.h : 0;
    const top = view && isNum(view.top) ? Math.max(0, view.top) : 0;
    const h = o && isNum(o.height) && o.height > 0 ? o.height : 54;
    const tallAt = o && isNum(o.tall) ? o.tall : 120;
    if (W < 40 || VH < 40) return null;
    // Room the head needs past the edge, and half of what shows of it along
    // the edge (its head and its hands, about a third of its height either
    // side; its box is wider, but that is empty while it only peeks).
    const need = .62 * h + 4, half = .3 * h + 2;
    let f = frameOf(field), c = frameOf(caret);
    let tall = false;
    if (f) {
      tall = f[3] > tallAt;
      // What of it is on this window: a scrolled document's text view is
      // taller than the screen, and its own top may be far above it.
      const x0 = Math.max(0, f[0]), y0 = Math.max(0, f[1]), x1 = Math.min(W, f[0] + f[2]), y1 = Math.min(VH, f[1] + f[3]);
      f = x1 - x0 >= 16 && y1 - y0 >= 8 ? [x0, y0, x1 - x0, y1 - y0] : null;
    }
    if (c) {
      // A caret is a line high. No height (an empty rect) or one far taller
      // than a line (a whole paragraph's bounds) is not a caret.
      if (!(c[3] > 0) || c[3] > 160) c = null;
      else if (c[0] + c[2] / 2 < 0 || c[0] + c[2] / 2 > W || c[1] + c[3] / 2 < 0 || c[1] + c[3] / 2 > VH) c = null;
    }
    if (c && f) {
      const mx = c[0] + c[2] / 2, my = c[1] + c[3] / 2, g = 40;
      if (mx < f[0] - g || mx > f[0] + f[2] + g || my < f[1] - g || my > f[1] + f[3] + g) c = null;
      else {
        c[0] = Math.max(f[0], Math.min(f[0] + f[2], c[0]));
        c[1] = Math.max(f[1], Math.min(f[1] + Math.max(0, f[3] - c[3]), c[1]));
      }
    }
    if (!f && !c) return null;
    // Only a caret: a box of its own around it, just over its line.
    if (!f) f = [c[0] - 40, c[1] - 4, 80, c[3] + 8];
    const right = f[0] + f[2];
    const look = c ? [c[0] + c[2] / 2, c[1] + c[3] / 2] : [f[0] + f[2] / 2, f[1] + Math.min(f[3] / 2, 40)];
    let edge = f[1], x = right - 30;
    if (c) { edge = tall ? c[1] - 2 : f[1]; x = c[0] + (tall ? 18 : 10); }
    x = f[2] >= 48 ? Math.max(f[0] + 24, Math.min(right - 24, x)) : f[0] + f[2] / 2;
    x = Math.max(half, Math.min(W - half, x));
    if (edge - need >= top && edge <= VH) return { x, y: edge, side: "top", look, tall };
    // No room above: out from beside the field, at the caret's height (or
    // by its top-right corner), its hands on the field's side edge.
    let y = c ? c[1] + c[3] / 2 : f[1] + 18;
    y = f[3] >= 32 ? Math.max(f[1] + 16, Math.min(f[1] + f[3] - 16, y)) : f[1] + f[3] / 2;
    y = Math.max(top + half, Math.min(VH - half, y));
    if (W - right >= need) return { x: right, y, side: "right", look, tall };
    if (f[0] >= need) return { x: f[0], y, side: "left", look, tall };
    return null;
  }


  // ---- the whole Blip, who walks the onboarding --------------------------------------
  //
  // The figure, its dither and its poses are the approved prototype's (section 01
  // of the assistant direction), ported as they are: the same numbers, so he is
  // the same character here as on the phone and on the site. What changed is
  // only where they live: one canvas the size of the window, feet at (x, y) in
  // CSS pixels, and a clock the caller can hold in its hand (tests, mostly).
  const lerp = (a, b, k) => a + (b - a) * k;
  const WALKER_POSES = {
    present: { ra0: 1.22, ra1: .4, la0: .2, la1: .16, tilt: -.03, brows: .45, lx: .9, ly: -.35, thumb: 0, point: 0, hop: 0, grin: 0 },
    tap: { ra0: 1.8, ra1: .06, la0: .18, la1: .14, tilt: -.05, brows: .55, lx: 1, ly: -.45, thumb: 0, point: 1, hop: 0, grin: 0 },
    pointd: { ra0: 1.0, ra1: .25, la0: .2, la1: .16, tilt: -.04, brows: .6, lx: .9, ly: .3, thumb: 0, point: 1, hop: 0, grin: 0 },
    tada: { ra0: 2.62, ra1: .24, la0: 2.62, la1: .24, tilt: 0, brows: .9, lx: .3, ly: -.2, thumb: 0, point: 0, hop: 1, grin: 1 },
    thumbs: { ra0: .62, ra1: 1.92, la0: .18, la1: .14, tilt: -.06, brows: .7, lx: .4, ly: -.1, thumb: 1, point: 0, hop: 0, grin: 1 },
    wave: { ra0: 2.5, ra1: -.55, la0: .16, la1: .12, tilt: -.06, brows: .75, lx: .1, ly: 0, thumb: 0, point: 0, hop: 0, grin: 1 },
    listen: { ra0: 2.5, ra1: 1.0, la0: .2, la1: .16, tilt: -.13, brows: .8, lx: .6, ly: -.2, thumb: 0, point: 0, hop: 0, grin: 0 },
    carry: { ra0: 1.5, ra1: -.3, la0: .35, la1: .2, tilt: -.04, brows: .6, lx: .8, ly: .2, thumb: 0, point: 0, hop: 0, grin: 1 },
  };
  WALKER_POSES.wait = { ra0: .35, ra1: .2, la0: .2, la1: .16, tilt: -.06, brows: .5, lx: .9, ly: -.4, thumb: 0, point: 0, hop: 0, grin: 0 };
  WALKER_POSES.key = WALKER_POSES.carry;
  WALKER_POSES.nod = WALKER_POSES.thumbs;
  // `walk` belongs to the walker: it is what he does between two places, never a spot's pose.
  WALKER_POSES.walk = { ra0: .32, ra1: .22, la0: .32, la1: .2, tilt: -.03, brows: .5, lx: .9, ly: -.1, thumb: 0, point: 0, hop: 0, grin: 0 };
  WALKER_POSES.think = { ra0: 1.9, ra1: 2.75, la0: .2, la1: .16, tilt: -.1, brows: .9, lx: .8, ly: -.7, thumb: 0, point: 0, hop: 0, grin: 0 };
  /** How lit the antenna's ball is in each pose. */
  const GLOW = { listen: 1, tada: .9, wait: 1 };
  /** The poses whose hands are busy: he keeps them while he walks. */
  const KEEPS_POSE = { wave: 1, key: 1, carry: 1 };
  /** Poses in which his arms swing as he walks. */
  const SWINGS = { walk: 1, wave: 1, key: 1, carry: 1 };
  /** The pause before he moves, a small crouch (ms). */
  const CROUCH = 90;
  /** Closer than this (px, plus half the change in height) he hops instead of walking. */
  const HOP_UNDER = 46;
  /** Within this he is already there: a new pose, no journey. */
  const SAME_SPOT = 8;
  /** A reduced-motion person's whole journey: a beat, then he is there. */
  const SNAP_MS = 160;

  function rr(g, x, y, w, h, r) {
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }

  /** One noodle arm: shoulder, elbow, hand. Returns where the hand ended. */
  function arm(g, H, sx, sy, s, a1, a2) {
    const L1 = .2 * H, L2 = .18 * H;
    const ex = sx + s * Math.sin(a1) * L1, ey = sy + Math.cos(a1) * L1;
    const a = a1 + a2, hx = ex + s * Math.sin(a) * L2, hy = ey + Math.cos(a) * L2;
    g.lineCap = "round"; g.lineJoin = "round";
    g.strokeStyle = grey(.5); g.lineWidth = .085 * H;
    g.beginPath(); g.moveTo(sx, sy); g.lineTo(ex, ey); g.lineTo(hx, hy); g.stroke();
    g.strokeStyle = grey(.68); g.lineWidth = .028 * H;
    g.beginPath(); g.moveTo(sx - s * .012 * H, sy - .02 * H); g.lineTo(ex - s * .012 * H, ey - .02 * H); g.stroke();
    const px = hx + s * Math.sin(a) * .035 * H, py = hy + Math.cos(a) * .035 * H;
    g.fillStyle = grey(.84); g.beginPath(); g.arc(px, py, .052 * H, 0, TAU); g.fill();
    return [px, py];
  }

  /**
   * The figure, in greys, in a box W wide and H tall with his feet on the
   * bottom edge. `st` is the pose he is in this frame (arms, brows, head tilt,
   * legs mid-step, how far he has dropped); `t` is seconds, for the blink and
   * the antenna. Returns where his hand and the antenna's ball ended up.
   */
  function walkerFigure(g, W, H, st, t) {
    const cx = W / 2, bob = st.bob, sway = Math.sin(t * TAU * .45) * .025 * st.swayK, drop = st.drop;
    [-1, 1].forEach((s, i) => {
      const L = st.legs[i], hx = cx + s * .06 * H, hy = .72 * H + drop, len = .21 * H;
      const ax = hx + Math.sin(L.th) * len + s * .012 * H, ay = hy + Math.cos(L.th) * len - L.lift;
      g.strokeStyle = grey(.34); g.lineWidth = .034 * H; g.lineCap = "round";
      g.beginPath(); g.moveTo(hx, hy); g.lineTo(ax, ay); g.stroke();
      // Striped stockings: four bands, dark and light.
      g.lineCap = "butt"; g.lineWidth = .038 * H;
      for (let k = 0; k < 4; k++) {
        const f0 = .5 + k * .105, f1 = f0 + .105;
        g.strokeStyle = grey(k % 2 ? .88 : .16);
        g.beginPath(); g.moveTo(lerp(hx, ax, f0), lerp(hy, ay, f0)); g.lineTo(lerp(hx, ax, f1), lerp(hy, ay, f1)); g.stroke();
      }
      const dir = lerp(s, 1, st.walkK);
      g.save(); g.translate(ax + dir * .038 * H, ay + .026 * H); g.rotate(-L.lift / H * 2.2 * Math.sign(dir || 1));
      g.fillStyle = grey(.14); g.beginPath(); g.ellipse(0, 0, .105 * H, .04 * H, 0, 0, TAU); g.fill();
      g.fillStyle = grey(.42); g.beginPath(); g.ellipse(dir * .005 * H, -.016 * H, .065 * H, .013 * H, 0, 0, TAU); g.fill();
      g.restore();
    });
    const top = .52 * H + bob + drop, bot = .75 * H + drop;
    g.save(); g.beginPath(); g.moveTo(cx - .085 * H, top); g.quadraticCurveTo(cx - .2 * H, bot, cx - .17 * H, bot);
    g.lineTo(cx + .17 * H, bot); g.quadraticCurveTo(cx + .2 * H, bot, cx + .085 * H, top); g.closePath(); g.clip();
    for (let i = 0; i < 7; i++) { g.fillStyle = grey(i % 2 ? .66 : .38); g.fillRect(cx - .22 * H, top + i * .035 * H, .44 * H, .035 * H); }
    g.restore();
    const hand = arm(g, H, cx + .1 * H, top + .035 * H, 1, st.ra[0], st.ra[1]);
    if (st.point > .02 || st.thumb > .02) {
      const a = st.ra[0] + st.ra[1];
      g.strokeStyle = grey(.84); g.lineCap = "round";
      if (st.point > .02) {
        g.lineWidth = .026 * H; g.beginPath(); g.moveTo(hand[0], hand[1]);
        g.lineTo(hand[0] + Math.sin(a) * .075 * H * st.point, hand[1] + Math.cos(a) * .075 * H * st.point); g.stroke();
      }
      if (st.thumb > .02) {
        g.lineWidth = .032 * H; g.beginPath(); g.moveTo(hand[0], hand[1] - .02 * H);
        g.lineTo(hand[0] - .006 * H, hand[1] - .02 * H - .055 * H * st.thumb); g.stroke();
      }
    }
    arm(g, H, cx - .1 * H, top + .035 * H, -1, st.la[0], st.la[1]);
    // The neck.
    g.strokeStyle = grey(.72); g.lineWidth = .028 * H; g.lineCap = "round";
    g.beginPath(); g.moveTo(cx, top + .01 * H); g.quadraticCurveTo(cx + .035 * H, .49 * H + bob + drop, cx, .44 * H + bob + drop); g.stroke();
    const hx = cx, hy = .3 * H + bob + drop, R = .16 * H, rot = st.tilt + sway;
    g.save(); g.translate(hx, hy + R); g.rotate(rot); g.translate(-hx, -(hy + R));
    // The two antennae: one curled with a ball, one bent at a knee.
    const wob = Math.sin(t * TAU * 1.6) * .025 * H + st.antWob;
    g.strokeStyle = grey(.55); g.lineWidth = .012 * H;
    g.beginPath(); g.moveTo(hx - .05 * H, hy - R * .9); g.quadraticCurveTo(hx - .11 * H, hy - R * 1.35, hx - .065 * H + wob, hy - R * 1.55); g.stroke();
    g.fillStyle = grey(.96); g.beginPath(); g.arc(hx - .065 * H + wob, hy - R * 1.55, .024 * H, 0, TAU); g.fill();
    g.beginPath(); g.moveTo(hx + .055 * H, hy - R * .88); g.lineTo(hx + .09 * H, hy - R * 1.22); g.lineTo(hx + .135 * H, hy - R * 1.16); g.stroke();
    const sg = g.createRadialGradient(hx - .06 * H, hy - .06 * H, 0, hx, hy, R * 1.3);
    sg.addColorStop(0, grey(.93)); sg.addColorStop(.6, grey(.75)); sg.addColorStop(1, grey(.46));
    g.fillStyle = sg; g.beginPath(); g.ellipse(hx, hy, R * 1.1, R * .94, 0, 0, TAU); g.fill();
    g.fillStyle = grey(.5);
    [-1, 1].forEach((s) => { rr(g, hx + s * R * 1.1 - .012 * H, hy - .015 * H, .024 * H, .03 * H, .006 * H); g.fill(); });
    // The one great eye, and its blink every 3.1 s.
    const blink = ((t * 1000 + 300) % 3100) < 130, ex = hx - .005 * H, ey = hy - .012 * H, er = .082 * H;
    g.fillStyle = grey(.1); g.beginPath(); g.arc(ex, ey, er + .011 * H, 0, TAU); g.fill();
    if (!blink) {
      g.fillStyle = grey(.99); g.beginPath(); g.arc(ex, ey, er, 0, TAU); g.fill();
      const lx = st.look[0] * .034 * H, ly = .004 * H + st.look[1] * .026 * H;
      g.fillStyle = grey(.05); g.beginPath(); g.arc(ex + lx, ey + ly, .036 * H, 0, TAU); g.fill();
      g.fillStyle = grey(.99); g.beginPath(); g.arc(ex + lx - .011 * H, ey + ly - .012 * H, .009 * H, 0, TAU); g.fill();
      g.fillStyle = grey(.62); g.beginPath(); g.arc(ex, ey, er + .002 * H, Math.PI * 1.1, Math.PI * 1.9); g.closePath(); g.fill();
    } else {
      g.fillStyle = grey(.62); g.beginPath(); g.arc(ex, ey, er, 0, TAU); g.fill();
      g.strokeStyle = grey(.1); g.lineWidth = .013 * H; g.beginPath(); g.moveTo(ex - er * .8, ey + .01 * H); g.lineTo(ex + er * .8, ey + .01 * H); g.stroke();
    }
    g.strokeStyle = grey(.1); g.lineWidth = .017 * H; g.lineCap = "round";
    g.beginPath(); g.arc(ex, ey - .016 * H - st.brows * .018 * H, er * 1.2, Math.PI * 1.22, Math.PI * 1.78); g.stroke();
    g.fillStyle = grey(.3);
    [[.075, .055], [.095, .07], [.07, .08]].forEach(([dx, dy]) => { g.beginPath(); g.arc(hx + dx * H, hy + dy * H, .006 * H, 0, TAU); g.fill(); });
    const mx = hx + .035 * H, my = hy + .105 * H;
    if (st.mouth === "grin") {
      g.fillStyle = grey(.08); g.beginPath(); g.ellipse(mx, my, .05 * H, .03 * H, -.15, 0, Math.PI); g.fill();
      g.fillStyle = grey(.97); g.fillRect(mx - .012 * H, my - .002 * H, .02 * H, .014 * H);
    } else {
      g.strokeStyle = grey(.1); g.lineWidth = .014 * H; g.beginPath(); g.arc(mx, my - .022 * H, .04 * H, Math.PI * .2, Math.PI * .75); g.stroke();
      g.fillStyle = grey(.97); g.fillRect(mx - .004 * H, my + .012 * H, .014 * H, .012 * H);
    }
    g.restore();
    // Where the antenna's ball is on the page, once the head's tilt has moved it.
    const bx = hx - .065 * H + wob - hx, by = hy - R * 1.55 - (hy + R), c = Math.cos(rot), sn = Math.sin(rot);
    return { hand, ball: [hx + bx * c - by * sn, hy + R + bx * sn + by * c] };
  }

  const hexRgb = (hex, fallback) => {
    const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ""));
    return m ? [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)] : fallback;
  };

  /**
   * A small canvas to draw the greys on and read back. A page's own canvas
   * where there is a page: read back every frame, it is kept in software, and
   * an OffscreenCanvas is not, which moved a few edge cells of the dither off
   * the prototype's. Without a page (a test) the offscreen one.
   */
  function scratch(w, h) {
    if (typeof document !== "undefined" && document.createElement) return Object.assign(document.createElement("canvas"), { width: w, height: h });
    return new OffscreenCanvas(w, h);
  }

  /**
   * The dither renderer: the figure is painted in greys into a buffer one cell
   * per dot, an ink sticker is grown a cell around it, and the dots the 8x8
   * dither lets through go on top, with the antenna's glow last. Same as the
   * peek's, with the sticker, the dots and the glow coloured by the stage.
   */
  function walkerDots(look) {
    let buf = null, on = null;
    const [gr, gg, gb] = look.glowRgb;
    // The glow's heart is the colour lightened a third of the way to white.
    const heart = [gr, gg, gb].map((v) => Math.round(v + (255 - v) * .31));
    return function (g, o) {
      const H = o.H, W = H * .84, cell = o.cell, PX = o.padX || 0, st = o.st, TOP = .14 * H;
      const bw = Math.ceil((W + PX * 2) / cell), bh = Math.ceil((H + TOP) / cell) + 1, lift = o.lift || 0;
      if (!buf || buf.width !== bw || buf.height !== bh) { buf = scratch(bw, bh); on = new Uint8Array(bw * bh); }
      const fg = buf.getContext("2d", { willReadFrequently: true });
      fg.setTransform(1, 0, 0, 1, 0, 0); fg.clearRect(0, 0, bw, bh);
      fg.setTransform(1 / cell, 0, 0, 1 / cell, 0, 0); fg.translate(PX, TOP);
      // Facing: 1 right, -1 left, and a squeeze through zero when he turns.
      const sx0 = o.sx === undefined ? 1 : o.sx, sx = Math.abs(sx0) < .06 ? (sx0 < 0 ? -.06 : .06) : sx0;
      if (sx !== 1) { fg.translate(W / 2, 0); fg.scale(sx, 1); fg.translate(-W / 2, 0); }
      const f = walkerFigure(fg, W, H, st, o.t), map = (fx, fy) => [o.x + (fx - W / 2) * sx, o.y - lift - H + fy];
      const src = fg.getImageData(0, 0, bw, bh).data, ox = o.x - W / 2 - PX, oy = o.y - lift - H - TOP, sk = 1 - clamp(lift / (H * .3)) * .5;
      // His shadow, smaller the higher he hops.
      g.fillStyle = "rgba(28,24,18," + (.1 * sk) + ")"; g.beginPath(); g.ellipse(o.x, o.y - .004 * H, H * .2 * sk, H * .022 * sk, 0, 0, TAU); g.fill();
      for (let i = 0; i < bw * bh; i++) on[i] = src[i * 4 + 3] > 60 ? 1 : 0;
      g.fillStyle = look.sticker; g.beginPath();
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        let hit = on[y * bw + x];
        if (!hit) {
          for (let j = -1; j <= 1 && !hit; j++) for (let i = -1; i <= 1 && !hit; i++) {
            const xx = x + i, yy = y + j;
            if (xx >= 0 && yy >= 0 && xx < bw && yy < bh && on[yy * bw + xx]) hit = 1;
          }
        }
        if (hit) { const px = ox + x * cell + cell / 2, py = oy + y * cell + cell / 2; g.moveTo(px + cell * .64, py); g.arc(px, py, cell * .64, 0, TAU); }
      }
      g.fill();
      g.fillStyle = look.dot; g.beginPath();
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        const i = (y * bw + x) * 4, a = src[i + 3];
        if (a < 90) continue;
        const lum = (src[i] * .3 + src[i + 1] * .59 + src[i + 2] * .11) / 255 * (a / 255);
        if (lum > (BAYER[(y & 7) * 8 + (x & 7)] + .5) / 64) {
          const px = ox + x * cell + cell / 2, py = oy + y * cell + cell / 2;
          g.moveTo(px + cell * .46, py); g.arc(px, py, cell * .46, 0, TAU);
        }
      }
      g.fill();
      const hand = map(f.hand[0], f.hand[1]), ball = map(f.ball[0], f.ball[1]);
      if (o.glow > .02) {
        const [x, y] = ball, r = H * .05, gd = g.createRadialGradient(x, y, 0, x, y, r * 2.4);
        gd.addColorStop(0, `rgba(${heart[0]},${heart[1]},${heart[2]},${.55 * o.glow})`);
        gd.addColorStop(.3, `rgba(${gr},${gg},${gb},${.22 * o.glow})`);
        gd.addColorStop(1, `rgba(${gr},${gg},${gb},0)`);
        g.fillStyle = gd; g.beginPath(); g.arc(x, y, r * 2.4, 0, TAU); g.fill();
      }
      return { hand, ball };
    };
  }

  const nowMs = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

  /**
   * THE WALKER: Blip on the ground, for the life of the window.
   *
   * It owns where he is, what he is doing and how he gets from one place to
   * the next; the page tells it where he should stand and in which pose. It
   * never reads the page.
   *
   *   canvas   the one canvas, the size of the window (size() keeps it so)
   *   opts     dpr, reduced (motion), now (a clock in ms), raf/caf (a frame
   *            loop), dot / sticker / glow / paper (his colours, the stage's)
   *
   * Everything is in CSS pixels of that canvas: (x, y) is where his feet are.
   * The numbers are the prototype's: a 90 ms crouch, then a hop (460 ms) under
   * 46 px or a walk of clamp(430 + 2.3 d, 520, 960) ms, eased, his pose
   * switching on the way (at 45% of a hop, 60% of a walk) and a squash when he
   * lands. Reduced motion has no journey: a beat of 160 ms and he is there.
   */
  function createWalker(canvas, opts) {
    const o = Object.assign({
      dpr: 1, reduced: false, now: nowMs, raf: null, caf: null,
      dot: "#F3E2C6", sticker: "#151311", glow: "#39FF14", paper: "#FCFBF8",
    }, opts || {});
    const g = canvas.getContext("2d");
    const render = walkerDots({ dot: o.dot, sticker: o.sticker, glowRgb: hexRgb(o.glow, [57, 255, 20]) });
    const cellFor = (H) => Math.max(2, Math.round(H / 92 * o.dpr)) / o.dpr;
    const bot = {
      x: 0, y: 0, H: 120, cell: 2, lift: 0, walk: 0, ph: 0, fx: 1, hopK: 0, sq: 0, sqV: 0,
      pose: "present", S: Object.assign({}, WALKER_POSES.present), V: {},
      t: 0, osc: 0, nod: 0, glow: 0, tr: null, lt: 0,
    };
    let placed = false;      // has he stood anywhere yet (since he was last sent away)
    let shown = false;       // is he being drawn
    let dirty = true;        // reduced motion: something changed since the last frame
    let last = null;         // the box he was last drawn in, to be cleared
    let raf = 0, lastFrame = 0, fast = false;
    bot.cell = cellFor(bot.H);

    function size(w, h, dpr) {
      if (dpr) o.dpr = dpr;
      canvas.width = Math.max(1, Math.round(w * o.dpr)); canvas.height = Math.max(1, Math.round(h * o.dpr));
      bot.cell = cellFor(bot.H); last = null; dirty = true; wake();
    }

    function wake() { if (!raf && o.raf && shown) raf = o.raf(loop); }

    /** He is here, now, in this pose: no journey. */
    function snap(x, y, H, pose) {
      bot.tr = null; bot.x = x; bot.y = y; bot.H = H; bot.cell = cellFor(H);
      bot.lift = 0; bot.walk = 0; bot.fx = 1; bot.hopK = 0; bot.sq = 0; bot.sqV = 0;
      if (pose) bot.pose = pose;
      placed = true; shown = true; dirty = true; wake();
    }

    /** He goes to (x, y) at height H, and has `pose` when he gets there. */
    function travel(x1, y1, H1, pose1, onland) {
      const t0 = o.now();
      if (o.reduced) {
        bot.tr = { reduced: true, at: t0 + SNAP_MS, x1, y1, H1, pose1, onland };
        dirty = true; wake();
        return;
      }
      // His hands full, he keeps what he is holding; otherwise he walks.
      if (!KEEPS_POSE[bot.pose]) bot.pose = "walk";
      const dx = x1 - bot.x, dy = y1 - bot.y, dist = Math.hypot(dx, dy) + Math.abs(H1 - bot.H) * .5, hop = dist < HOP_UNDER;
      bot.tr = {
        x0: bot.x, y0: bot.y, H0: bot.H, x1, y1, H1, c0: bot.cell, c1: cellFor(H1), t0: t0 + CROUCH,
        T: hop ? 460 : clamp(430 + dist * 2.3, 520, 960), dist, hop,
        dir: Math.abs(dx) < 8 ? 0 : Math.sign(dx), pose1, swapAt: hop ? .45 : .6, swapped: false, onland, ph0: bot.ph,
      };
      wake();
    }

    /**
     * The page's one question: Blip is to be here, so what does he do?
     *   "snap"    he was not anywhere (the first spot, or the first after he
     *             was sent away): he is simply there
     *   "pose"    he is already within 8 px at the same height: a new pose, no journey
     *   "travel"  he goes
     * `onland(kind)` runs when he arrives (kind is the word above), at once for the first two.
     */
    function go(x, y, H, pose, onland) {
      if (!placed) { snap(x, y, H, pose); if (onland) onland("snap"); return "snap"; }
      if (!bot.tr && Math.abs(x - bot.x) <= SAME_SPOT && Math.abs(y - bot.y) <= SAME_SPOT && Math.round(H) === Math.round(bot.H)) {
        bot.x = x; bot.y = y; bot.pose = pose; dirty = true; wake();
        if (onland) onland("pose");
        return "pose";
      }
      travel(x, y, H, pose, onland);
      return "travel";
    }

    /** The place he is going to (or standing at) has moved, by scrolling or a resize: follow it, with no walk. */
    function retarget(x, y, H) {
      if (bot.tr) {
        bot.tr.x1 = x; bot.tr.y1 = y; bot.tr.H1 = H;
        if (bot.tr.reduced) return;
        bot.tr.c1 = cellFor(H);
      } else { bot.x = x; bot.y = y; bot.H = H; bot.cell = cellFor(H); }
      dirty = true; wake();
    }

    /** Sent away: he is no longer drawn, and the next spot is his first again. */
    function hide() {
      placed = false; shown = false; bot.tr = null; dirty = true;
      if (raf && o.caf) o.caf(raf);
      raf = 0;
      if (last) { g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, canvas.width, canvas.height); last = null; }
    }

    function setPose(name) { if (WALKER_POSES[name]) { bot.pose = name; dirty = true; wake(); } }
    function setReduced(on) { o.reduced = !!on; dirty = true; wake(); }

    /** Moves him along his journey to the time `ms`. */
    function tick(ms) {
      const dt = Math.min(.05, Math.max(0, (ms - (bot.lt || ms)) / 1000)); bot.lt = ms;
      const tr = bot.tr;
      let sqT = 0, walkT = 0, fxT = 1;
      if (tr && tr.reduced) {
        if (ms >= tr.at) {
          bot.x = tr.x1; bot.y = tr.y1; bot.H = tr.H1; bot.cell = cellFor(tr.H1); bot.pose = tr.pose1;
          bot.tr = null; dirty = true;
          if (tr.onland) tr.onland("travel");
        }
        return;
      }
      if (tr) {
        fxT = tr.dir || 1;
        if (ms < tr.t0) { sqT = .17; bot.lift *= .6; bot.hopK *= .6; }
        else {
          const p = clamp((ms - tr.t0) / tr.T), e = p * p * (3 - 2 * p);
          bot.x = lerp(tr.x0, tr.x1, e); bot.y = lerp(tr.y0, tr.y1, e); bot.H = lerp(tr.H0, tr.H1, e); bot.cell = lerp(tr.c0, tr.c1, e);
          if (tr.hop) { bot.hopK = Math.sin(Math.PI * p); bot.lift = bot.hopK * 20; sqT = p < .45 ? -.08 : 0; }
          else { walkT = p < .97 ? 1 : 0; bot.ph = tr.ph0 + e * tr.dist / (bot.H * .9) * TAU; }
          if (!tr.swapped && p >= tr.swapAt) { tr.swapped = true; bot.pose = tr.pose1; }
          if (p >= 1) {
            bot.x = tr.x1; bot.y = tr.y1; bot.H = tr.H1; bot.cell = tr.c1; bot.lift = 0; bot.hopK = 0;
            bot.sq = .17; bot.sqV = 0; bot.pose = tr.pose1; bot.tr = null;
            if (tr.onland) tr.onland("travel");
          }
        }
      }
      bot.walk = lerp(bot.walk, walkT, 1 - Math.exp(-dt * 12)); bot.fx = lerp(bot.fx, fxT, 1 - Math.exp(-dt * 16));
      if (Math.abs(bot.fx - fxT) < .004) bot.fx = fxT;
      if (bot.walk < .004 && !walkT) bot.walk = 0;
      // The landing squash is a spring too: pulled toward sqT, damped.
      bot.sqV += ((sqT - bot.sq) * 260 - bot.sqV * 15) * dt; bot.sq += bot.sqV * dt;
      if (!sqT && Math.abs(bot.sq) < .002 && Math.abs(bot.sqV) < .02) { bot.sq = 0; bot.sqV = 0; }
    }

    /** Paints one frame. */
    function draw(dt) {
      const tg = WALKER_POSES[bot.pose] || WALKER_POSES.present, S = bot.S, still = o.reduced;
      if (still) { Object.assign(S, tg); bot.glow = GLOW[bot.pose] || 0; bot.osc = 0; }
      else {
        spring(S, bot.V, tg, dt);
        bot.osc = lerp(bot.osc, bot.pose === "wave" ? 1 : 0, 1 - Math.exp(-dt * 6));
        bot.nod = lerp(bot.nod, bot.pose === "nod" ? 1 : 0, 1 - Math.exp(-dt * 6));
        // Waiting, the antenna blinks; otherwise it eases to the pose's glow.
        const gt = bot.pose === "wait" ? (Math.sin(bot.t * TAU * 1.2) > 0 ? 1 : .05) : (GLOW[bot.pose] || 0);
        bot.glow = lerp(bot.glow, gt, 1 - Math.exp(-dt * (bot.pose === "wait" ? 14 : 4)));
      }
      const H = bot.H, t = still ? .5 : (bot.t += dt), w = bot.walk, hk = bot.hopK, sw = Math.sin(bot.ph) * w, A = .55;
      const legs = hk > .01
        ? [{ th: -.32 * hk, lift: .07 * H * hk }, { th: .32 * hk, lift: .07 * H * hk }]
        : [{ th: sw * A, lift: Math.max(0, Math.cos(bot.ph)) * .05 * H * w }, { th: -sw * A, lift: Math.max(0, -Math.cos(bot.ph)) * .05 * H * w }];
      const wa = SWINGS[bot.pose] ? .5 * sw : 0;
      const st = {
        ra: [S.ra0 + (bot.pose === "walk" ? wa : 0), S.ra1 + .34 * bot.osc * Math.sin(t * TAU * 1.45)], la: [S.la0 + wa, S.la1],
        brows: S.brows, tilt: S.tilt, mouth: S.grin > .5 ? "grin" : "smile", legs,
        drop: hk > .01 ? 0 : .21 * H * (1 - Math.cos(sw * A)),
        bob: still ? 0 : Math.sin(t * TAU * .9) * .008 * H - S.hop * Math.abs(Math.sin(t * TAU * 1.1)) * .03 * H + bot.nod * Math.abs(Math.sin(t * TAU * 1.6)) * .03 * H,
        swayK: still ? 0 : 1, antWob: 0, walkK: w, look: [S.lx, S.ly], thumb: S.thumb, point: S.point,
      };
      g.setTransform(o.dpr, 0, 0, o.dpr, 0, 0);
      if (last) g.clearRect(last.x, last.y, last.w, last.h);
      // The box he can reach: his height either side and above, the hop, the glow, whatever he carries.
      last = { x: bot.x - H * .95, y: bot.y - H * 1.5 - 28, w: H * 1.9, h: H * 1.5 + 40 };
      const k = bot.sq;
      if (k) { g.save(); g.translate(bot.x, bot.y); g.scale(1 + k * .75, 1 - k); g.translate(-bot.x, -bot.y); }
      const r = render(g, { H, cell: bot.cell, x: bot.x, y: bot.y, sx: bot.fx, lift: bot.lift, st, t, glow: bot.glow, padX: H * .27 });
      if (bot.pose === "carry") {
        // A calendar tile in his hand: the app he brought.
        const s = H * .3, [x, y] = r.hand;
        g.save(); g.translate(x, y - s * .62); g.rotate(still ? 0 : Math.sin(t * 2.2) * .05);
        g.fillStyle = o.paper; g.strokeStyle = o.sticker; g.lineWidth = 1.8; rr(g, -s / 2, -s / 2, s, s, s * .2); g.fill(); g.stroke();
        g.fillStyle = o.sticker; rr(g, -s / 2, -s / 2, s, s * .3, s * .2); g.fill(); g.fillRect(-s / 2, -s * .3, s, s * .12);
        g.font = `700 ${s * .42}px ui-sans-serif,system-ui,sans-serif`; g.textAlign = "center"; g.fillText("17", 0, s * .32); g.restore();
      }
      if (bot.pose === "key") {
        // A key, with a lit bow: the way in.
        const s = H * .34, [x, y] = r.hand;
        g.save(); g.translate(x, y - s * .55); g.rotate(.18 + (still ? 0 : Math.sin(t * 2.2) * .05));
        g.fillStyle = o.paper; g.strokeStyle = o.sticker; g.lineWidth = 1.8; g.lineJoin = "round";
        rr(g, -s * .07, -s * .12, s * .14, s * .62, s * .05); g.fill(); g.stroke();
        rr(g, s * .07, s * .26, s * .18, s * .08, s * .02); g.fill(); g.stroke();
        rr(g, s * .07, s * .4, s * .13, s * .08, s * .02); g.fill(); g.stroke();
        g.beginPath(); g.arc(0, -s * .3, s * .22, 0, TAU); g.fill(); g.stroke();
        g.fillStyle = o.glow; g.beginPath(); g.arc(0, -s * .3, s * .08, 0, TAU); g.fill(); g.stroke(); g.restore();
      }
      if (k) g.restore();
      dirty = false;
    }

    /** One tick of the frame loop. Returns whether another is wanted. */
    function frame(ms) {
      tick(ms);
      if (!shown) return false;
      const dt = Math.min(.06, Math.max(0, (ms - (lastFrame || ms)) / 1000));
      lastFrame = ms;
      draw(dt);
      fast = !!bot.tr;
      // Held still, nothing moves between his journeys: no frames until the next change.
      return !o.reduced || !!bot.tr || dirty;
    }

    function loop(ms) {
      raf = 0;
      // 60 fps while he walks, about 30 at rest: the dots are not cheap and a bob does not need more.
      if (ms - lastFrame < (fast ? 13 : 28)) { if (shown && o.raf) raf = o.raf(loop); return; }
      const more = frame(ms);
      if (more && shown && o.raf) raf = o.raf(loop);
    }

    return {
      size, snap, travel, go, retarget, hide, tick, draw, frame,
      pose: setPose, reduced: setReduced,
      /** The wall clock for tests: where he is and what he is doing. */
      state() {
        return {
          x: bot.x, y: bot.y, H: bot.H, pose: bot.pose, traveling: !!bot.tr, hop: !!(bot.tr && bot.tr.hop),
          sq: bot.sq, lift: bot.lift, placed, shown, journey: bot.tr && !bot.tr.reduced ? { t0: bot.tr.t0, T: bot.tr.T, hop: bot.tr.hop, swapAt: bot.tr.swapAt, dist: bot.tr.dist } : null,
        };
      },
    };
  }

  /**
   * CONFETTI from the bot when he lands at the end (Done, a first good Try it):
   * 22 small pieces thrown out of (x, y) and gone in 1.4 s. `host` is the
   * element they are put in (position: fixed), x and y in its pixels. Held
   * still (reduced motion), nothing is thrown. Returns the pieces.
   */
  function burst(host, x, y, opts) {
    const o = Object.assign({ reduced: false, rand: Math.random, colors: ["#1C1A17", "#39FF14", "#F3E2C6", "#8D8983"], ttl: 1400 }, opts || {});
    if (o.reduced || !host) return [];
    const doc = host.ownerDocument || document, out = [];
    for (let i = 0; i < 22; i++) {
      const e = doc.createElement("i");
      e.className = "cf";
      e.style.left = x + "px"; e.style.top = y + "px"; e.style.background = o.colors[i % o.colors.length];
      e.style.setProperty("--dx", (o.rand() * 240 - 120) + "px");
      e.style.setProperty("--dy", (o.rand() * 200 - 130) + "px");
      e.style.setProperty("--r", (o.rand() * 720 - 360) + "deg");
      host.appendChild(e);
      setTimeout(() => { if (e.remove) e.remove(); }, o.ttl);
      out.push(e);
    }
    return out;
  }

  /** The spring that eases his limbs toward a pose (k 150, damping 17), by the time since the last frame. */
  function spring(S, V, tg, dt) {
    const h = Math.min(dt, .05);
    for (const k in tg) { const x = S[k], v = V[k] || 0, acc = (tg[k] - x) * 150 - v * 17; V[k] = v + acc * h; S[k] = x + V[k] * h; }
  }

  return { createBlip, POSES, peekSpot, createWalker, burst, WALKER_POSES, walkerFigure };
});
