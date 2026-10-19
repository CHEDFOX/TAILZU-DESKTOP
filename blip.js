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
    let last = 0;
    let buf = null, cellPx = 0;
    let anchor = [0, 0];
    let tip = null;

    function pose(name) { if (POSES[name]) poseName = name; }
    function size(h) { H = h; buf = null; }

    /** The figure, in greys, in its own box: W wide, H tall, the card's edge at
     *  EDGE·H. Returns where the pointing fingertip ended (box coords). */
    function figure(g, W, p, t) {
      const EDGE = .5;
      const cx = W / 2;
      const bob = Math.sin(t * TAU * .9) * .008 * H - p.hop * Math.abs(Math.sin(t * TAU * 1.6)) * .05 * H;
      const lift = (1 - clamp(p.rise, 0, 1.2)) * .52 * H;  // how far below its peek it sits
      const dy = lift + bob;
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
      g.save(); g.translate(hx, hy + R); g.rotate(p.tilt + Math.sin(t * TAU * .45) * .02); g.translate(-hx, -(hy + R));
      // The antennae (one curled with a ball, one bent at a knee) are thin
      // lines, too fine for dots: drawn solid with the face (see drawFace).
      const wob = Math.sin(t * TAU * (live ? 2.6 : 1.6)) * .025 * H;
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
      const blink = ((t * 1000 + 300) % 3700) < 120;
      const lid = blink ? 1 : clamp(p.lid);
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
      const face = { hx, hy, R, angle: p.tilt + Math.sin(t * TAU * .45) * .02, ex, ey, er, lx, ly, lid, blink, brows: p.brows, wob };
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
      if (live) { c.fillStyle = o.live; c.globalAlpha = .25; c.beginPath(); c.arc(kx, ky, br * 2.1, 0, TAU); c.fill(); c.globalAlpha = 1; }
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

    /** One frame. `ax, ay`: the middle of its stretch of the card's top edge. */
    function draw(ctx, ax, ay, t, dpr) {
      const dt = Math.min(.1, Math.max(0, t - last)); last = t;
      const goal = POSES[poseName];
      const rate = 1 - Math.pow(.0009, dt);   // ~120 ms to most of the way
      for (const k of Object.keys(cur)) cur[k] += (goal[k] - cur[k]) * rate;
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
      const on = new Uint8Array(bw * bh);
      for (let i = 0; i < bw * bh; i++) on[i] = src[i * 4 + 3] > 60 ? 1 : 0;
      ctx.save();
      ctx.beginPath(); ctx.rect(ox - cell * 2, oy - cell * 2, W + cell * 4, EDGE * H + cell * 2); ctx.clip();
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
      lookAt(p) { look = p ? [p[0], p[1]] : null; },
      pointAt(p) { target = p ? [p[0], p[1]] : null; },
      speaking(on) { speaking = !!on; },
      live(on) { live = !!on; },
      fingertip() { return tip; },
      shown() { return cur.rise > .05; },
      state() { return Object.assign({ pose: poseName }, cur); },
    };
  }

  return { createBlip, POSES };
});
