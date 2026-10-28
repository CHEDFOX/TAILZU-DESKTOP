// GENERATED: do not edit. The living bot tiles' physics and drawing, shared with the phone.
// Source: TAILZU-FRONTEND/app/src/botTiles/core.ts; regenerate with `node src/botTiles/genDesktop.mjs` there.
// core.ts sha256 2cef81277d31529d4b4b9d12817167b63f98d9b02a61516be67ff286b8154f5e
// body sha256 9bc52c274632abb372e705b5234590bfaf4fc86060ffa63ab1343f582f75ef1d
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.TailzuBotTiles = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  /**
   * LIVING BOT TILES: THE PHYSICS AND THE DRAWING (one core, both apps).
   *
   * Home's bot tiles (the SDUI node BotTiles) and the first-arrival card (BotCard) each hold a tiny Blip in his bot's
   * colour, playing on a faint woven fabric that the bot's movements push around. Everything that moves here is
   * physics: particles integrated with Verlet at a fixed step, distance constraints, springs and forces. Nothing
   * follows a keyframed path. A small "brain" per bot only decides goals (where to walk, when to hop, which prop to
   * kick, where to look); the body gets there through forces, and the props, the fabric and the bot's own noodle arms
   * and antennae answer through the same integrator.
   *
   *   BotTile        one tile: a bot (13 particles), its props (<= 8 bodies), its fabric (14 x 9 points).
   *   BotTilesWorld  the tiles of one grid, laid out in one space, so every other bot can look at a tapped one.
   *   TileCtx        what drawing needs: a strict subset of CanvasRenderingContext2D. The window and the phone on the
   *                  web hand a real canvas context; the phone hands onboard/skiaCtx.ts's SkiaCtx (Skia).
   *
   * THE SAME FILE RUNS IN BOTH APPS. This is the source; TAILZU-DESKTOP/botTiles.js is generated from it
   * (`node src/botTiles/genDesktop.mjs`), and tests on both sides fail if the two drift. So: plain TypeScript that
   * Node can strip (no enums, no parameter properties), no imports, no DOM and no React Native.
   *
   * Cheap on purpose (a mid Android draws four of these at 60 fps): typed arrays allocated once, no allocation in a
   * frame, a fixed 1/120 s step with the frame time clamped to 1/20 s, and drawing batched into a few paths.
   */
  /** The tap: press, the other bots look, the others' words fade to fadeTo, and after holdMs the tile's action runs. */
  const TAP = { holdMs: 1000, fadeTo: 0.35, fadeMs: 260, pressScale: 0.97, restoreMs: 1400 };
  /** The fixed step, and the longest frame that is simulated (a longer pause is not caught up). */
  const STEP = 1 / 120;
  const MAX_FRAME = 1 / 20;
  /** The colours a bot may wear (STYLE.md): Make a bot puts itself together in each in turn. */
  const PALETTE = ["#2F5D50", "#6E4A6B", "#7A6440", "#5F6B6E", "#4F7A3A", "#A9573A", "#8F6A1F", "#3E6E8E"];
  const INK = "#0a0a0a";
  const PAPER = "#ffffff";
  const TAU = Math.PI * 2;
  /** A built-in's play by its slug; anything else plays as anyone's own bot. */
  function kindOf(slug) {
      return slug === "code" || slug === "keybot" || slug === "plan" || slug === "travel" || slug === "make" ? slug : "custom";
  }
  /** mulberry32: small, fast, and the same everywhere. */
  function rng(seed) {
      let a = (seed >>> 0) || 0x9e3779b9;
      return () => {
          a = (a + 0x6d2b79f5) >>> 0;
          let t = a;
          t = Math.imul(t ^ (t >>> 15), t | 1);
          t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
  }
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  // ===================================================================== the fabric
  /**
   * A woven sheet behind the bot: 14 x 9 points, each held to its place by a soft spring and to its four neighbours
   * by stiffer ones (a discrete wave equation on the points' displacement), damped. The bot's body parts drag the
   * threads near them along (a wake), and a landing or a press sends a ripple out. Drawn as ink threads at a few %.
   */
  class Fabric {
      constructor(seed) {
          this.nx = 14;
          this.ny = 9;
          this.n = 126;
          this.x0 = 0;
          this.y0 = 0;
          this.dx = 1;
          this.dy = 1;
          this.lim = 4;
          /** Rest springs, neighbour springs, damping (per second). */
          this.k0 = 70;
          this.k1 = 900;
          this.c = 6.5;
          const n = this.n;
          this.ux = new Float64Array(n);
          this.uy = new Float64Array(n);
          this.vx = new Float64Array(n);
          this.vy = new Float64Array(n);
          this.fx = new Float64Array(n);
          this.fy = new Float64Array(n);
          this.jx = new Float64Array(n);
          this.jy = new Float64Array(n);
          const r = rng(seed ^ 0x5bd1e995);
          for (let j = 0; j < this.ny; j++) {
              for (let i = 0; i < this.nx; i++) {
                  const k = j * this.nx + i;
                  const over = (i + j) % 2 ? 0.22 : -0.22;
                  this.jx[k] = over + (r() - 0.5) * 0.35;
                  this.jy[k] = -over + (r() - 0.5) * 0.35;
              }
          }
      }
      layout(w, h) {
          const m = 3;
          this.x0 = -m;
          this.y0 = -m;
          this.dx = (w + 2 * m) / (this.nx - 1);
          this.dy = (h + 2 * m) / (this.ny - 1);
          this.lim = 0.42 * Math.min(this.dx, this.dy);
      }
      reset() {
          this.ux.fill(0);
          this.uy.fill(0);
          this.vx.fill(0);
          this.vy.fill(0);
          this.fx.fill(0);
          this.fy.fill(0);
      }
      /** A body part at (sx, sy) moving at (svx, svy) px/s: the threads within `rad` are dragged along and pushed aside. */
      wake(sx, sy, svx, svy, rad, gain) {
          const nx = this.nx, dx = this.dx, dy = this.dy;
          let i0 = Math.floor((sx - rad - this.x0) / dx), i1 = Math.ceil((sx + rad - this.x0) / dx);
          let j0 = Math.floor((sy - rad - this.y0) / dy), j1 = Math.ceil((sy + rad - this.y0) / dy);
          if (i1 < 0 || j1 < 0 || i0 >= nx || j0 >= this.ny)
              return;
          if (i0 < 0)
              i0 = 0;
          if (j0 < 0)
              j0 = 0;
          if (i1 >= nx)
              i1 = nx - 1;
          if (j1 >= this.ny)
              j1 = this.ny - 1;
          const r2 = rad * rad, ux = this.ux, uy = this.uy, fx = this.fx, fy = this.fy;
          const sp = Math.sqrt(svx * svx + svy * svy);
          const push = 18 + sp * 0.9;
          for (let j = j0; j <= j1; j++) {
              for (let i = i0; i <= i1; i++) {
                  const k = j * nx + i;
                  const rx = this.x0 + i * dx + ux[k] - sx, ry = this.y0 + j * dy + uy[k] - sy;
                  const d2 = rx * rx + ry * ry;
                  if (d2 >= r2)
                      continue;
                  const d = Math.sqrt(d2) + 0.001;
                  let w = 1 - d / rad;
                  w *= w * gain;
                  fx[k] += (svx * 40 + (rx / d) * push * 20) * w;
                  fy[k] += (svy * 40 + (ry / d) * push * 20) * w;
              }
          }
      }
      /** A ripple from (sx, sy): outward (strength > 0) or drawn in, like a finger pressing the cloth (< 0). */
      kick(sx, sy, strength, rad) {
          const nx = this.nx, ux = this.ux, uy = this.uy, vx = this.vx, vy = this.vy;
          for (let j = 0; j < this.ny; j++) {
              for (let i = 0; i < nx; i++) {
                  const k = j * nx + i;
                  const rx = this.x0 + i * this.dx + ux[k] - sx, ry = this.y0 + j * this.dy + uy[k] - sy;
                  const d = Math.sqrt(rx * rx + ry * ry) + 0.001;
                  if (d >= rad)
                      continue;
                  const w = 1 - d / rad;
                  vx[k] += (rx / d) * strength * w;
                  vy[k] += (ry / d) * strength * w;
              }
          }
      }
      step(h) {
          const nx = this.nx, ny = this.ny, ux = this.ux, uy = this.uy, vx = this.vx, vy = this.vy, fx = this.fx, fy = this.fy;
          const k0 = this.k0, k1 = this.k1, c = this.c, lim = this.lim;
          for (let j = 0; j < ny; j++) {
              for (let i = 0; i < nx; i++) {
                  const k = j * nx + i;
                  const x = ux[k], y = uy[k];
                  let lx = 0, ly = 0;
                  if (i > 0) {
                      lx += ux[k - 1] - x;
                      ly += uy[k - 1] - y;
                  }
                  if (i < nx - 1) {
                      lx += ux[k + 1] - x;
                      ly += uy[k + 1] - y;
                  }
                  if (j > 0) {
                      lx += ux[k - nx] - x;
                      ly += uy[k - nx] - y;
                  }
                  if (j < ny - 1) {
                      lx += ux[k + nx] - x;
                      ly += uy[k + nx] - y;
                  }
                  vx[k] += (-k0 * x + k1 * lx - c * vx[k] + fx[k]) * h;
                  vy[k] += (-k0 * y + k1 * ly - c * vy[k] + fy[k]) * h;
                  fx[k] = 0;
                  fy[k] = 0;
              }
          }
          for (let k = 0; k < this.n; k++) {
              let x = ux[k] + vx[k] * h, y = uy[k] + vy[k] * h;
              if (x > lim) {
                  x = lim;
                  vx[k] *= 0.5;
              }
              else if (x < -lim) {
                  x = -lim;
                  vx[k] *= 0.5;
              }
              if (y > lim) {
                  y = lim;
                  vy[k] *= 0.5;
              }
              else if (y < -lim) {
                  y = -lim;
                  vy[k] *= 0.5;
              }
              ux[k] = x;
              uy[k] = y;
          }
      }
      energy() {
          let e = 0;
          for (let k = 0; k < this.n; k++)
              e += this.vx[k] * this.vx[k] + this.vy[k] * this.vy[k] + this.k0 * (this.ux[k] * this.ux[k] + this.uy[k] * this.uy[k]);
          return e * 0.5;
      }
      /** Largest displacement of any crossing, px. */
      maxShift() {
          let m = 0;
          for (let k = 0; k < this.n; k++)
              m = Math.max(m, Math.abs(this.ux[k]), Math.abs(this.uy[k]));
          return m;
      }
      draw(ctx, alpha) {
          const nx = this.nx, ny = this.ny, ux = this.ux, uy = this.uy, jx = this.jx, jy = this.jy;
          ctx.strokeStyle = INK;
          ctx.lineWidth = 0.75;
          ctx.lineCap = "butt";
          ctx.lineJoin = "round";
          // The weft: across.
          ctx.globalAlpha = 0.06 * alpha;
          ctx.beginPath();
          for (let j = 0; j < ny; j++) {
              for (let i = 0; i < nx; i++) {
                  const k = j * nx + i;
                  const x = this.x0 + i * this.dx + ux[k] + jx[k] * 0.4, y = this.y0 + j * this.dy + uy[k] + jy[k];
                  if (i === 0)
                      ctx.moveTo(x, y);
                  else
                      ctx.lineTo(x, y);
              }
          }
          ctx.stroke();
          // The warp: down, a shade fainter.
          ctx.globalAlpha = 0.042 * alpha;
          ctx.beginPath();
          for (let i = 0; i < nx; i++) {
              for (let j = 0; j < ny; j++) {
                  const k = j * nx + i;
                  const x = this.x0 + i * this.dx + ux[k] + jx[k], y = this.y0 + j * this.dy + uy[k] + jy[k] * 0.4;
                  if (j === 0)
                      ctx.moveTo(x, y);
                  else
                      ctx.lineTo(x, y);
              }
          }
          ctx.stroke();
          ctx.globalAlpha = 1;
      }
  }
  // ===================================================================== the bot's body
  // Particles 0..12 are the bot; props follow.
  const HEAD = 0, NECK = 1, HIP = 2, FOOT_L = 3, FOOT_R = 4, ELB_L = 5, HAND_L = 6, ELB_R = 7, HAND_R = 8;
  const ANT_A1 = 9, ANT_A2 = 10, ANT_B1 = 11, ANT_B2 = 12;
  const NBOT = 13;
  const CAP = 40;
  const CCAP = 64;
  const DUST = 128;
  const SPARKS = 8;
  // Prop kinds.
  const P_ZERO = 1, P_ONE = 2, P_KEY = 3, P_DAY = 4, P_PLANE = 5, P_BALL = 6;
  // Contact flags (per particle, per step).
  const C_FLOOR = 1, C_WALL = 2, C_CEIL = 4, C_SUPPORT = 8;
  // Acts.
  const A_STAND = 0, A_WANDER = 1, A_SIT = 2, A_STRETCH = 3, A_PEEK = 4, A_LOOK = 5, A_PLAY = 6, A_NEEDS = 7;
  class BotTile {
      constructor(o) {
          // The tile.
          this.w = 0;
          this.h = 0;
          this.floor = 0;
          this.S = 30;
          this.g = 800;
          this.placed = false;
          this.t = 0;
          this.acc = 0;
          /** Reduce Motion: drawn in a resting pose, nothing steps. */
          this.still = false;
          // Particles (structure of arrays).
          this.n = 0;
          this.x = new Float64Array(CAP);
          this.y = new Float64Array(CAP);
          this.px = new Float64Array(CAP);
          this.py = new Float64Array(CAP);
          this.ax = new Float64Array(CAP);
          this.ay = new Float64Array(CAP);
          this.im = new Float64Array(CAP);
          this.rad = new Float64Array(CAP);
          this.keep = new Float64Array(CAP);
          this.bnc = new Float64Array(CAP);
          this.frc = new Float64Array(CAP);
          this.vin = new Float64Array(CAP);
          this.hit = new Uint8Array(CAP);
          /** The prop a particle stood on this step (-1: the floor or nothing). */
          this.on = new Int8Array(CAP);
          // Distance constraints: mode 0 off, 1 rigid, 2 rope (only pulls).
          this.nc = 0;
          this.ca = new Int16Array(CCAP);
          this.cb = new Int16Array(CCAP);
          this.cr = new Float64Array(CCAP);
          this.ck = new Float64Array(CCAP);
          this.cm = new Uint8Array(CCAP);
          // Props (<= 8 bodies).
          this.np = 0;
          this.pk = new Uint8Array(8);
          this.p0 = new Int16Array(8);
          this.pn = new Int8Array(8);
          this.pr = new Float64Array(8);
          /** Keycaps: the rest height of the top, the dip; day tiles: their size. */
          this.pa = new Float64Array(8);
          this.pb = new Float64Array(8);
          this.pc = new Float64Array(8);
          this.pl = new Float64Array(8);
          /** A day tile's place in the stack, or a key's last press time. */
          this.ptime = new Float64Array(8);
          // Holds: hand -> prop particle (constraint indices, -1 when free).
          this.holdL = -1;
          this.holdR = -1;
          this.held = -1;
          /** A prop just thrown: it passes through the bot for a moment. */
          this.ghost = -1;
          this.ghostT = 0;
          // The bot's proportions (px), from S.
          this.rH = 6;
          this.lNeck = 9;
          this.lTorso = 5;
          this.lLeg = 5;
          this.lArm = 4;
          this.lAnt1 = 4;
          this.lAnt2 = 3;
          this.baseA_u = 0;
          this.baseA_w = 0;
          this.baseB_u = 0;
          this.baseB_w = 0;
          this.rAntA1 = 0;
          this.rAntB1 = 0;
          this.upperMass = 5;
          this.ant = new Float64Array(2);
          this.box = new Float64Array(2);
          // Body control (set by the brain each step).
          this.goalX = NaN;
          this.speed = 1;
          this.crouch = 0;
          this.sit = 0;
          this.lean = 0;
          this.tilt = 0;
          this.armL = false;
          this.armR = false;
          this.armLx = 0;
          this.armLy = 0;
          this.armRx = 0;
          this.armRy = 0;
          this.armK = 0;
          this.limp = 0;
          this.wallL = 0;
          this.wallR = 0;
          this.grounded = 0;
          this.wasGrounded = 0;
          this.airT = 0;
          this.stepCool = 0;
          this.landed = 0;
          // Face: eye (in head space: w across, u up), lid, facing, glow.
          this.face = 1;
          this.faceV = 0;
          this.faceTo = 1;
          this.ew = 0;
          this.eu = 0;
          this.ewV = 0;
          this.euV = 0;
          this.lid = 0.12;
          this.lidV = 0;
          this.lidTo = 0.12;
          this.blinkAt = 2;
          this.blinkT = 0;
          this.glow = 0;
          this.glowV = 0;
          this.lookX = NaN;
          this.lookY = NaN;
          this.lookOut = 0;
          /** A look asked from outside (the tap moment): it wins over the brain's own. */
          this.focusX = NaN;
          this.focusY = NaN;
          /** Where he steps to when another tile is tapped: set once, on the first frame of the look. */
          this.focusGoal = NaN;
          this.cheerT = -1;
          // The brain.
          this.act = A_STAND;
          this.actT = 0;
          this.actDur = 1;
          this.phase = 0;
          this.phaseT = 0;
          this.target = -1;
          this.count = 0;
          this.tx = 0;
          this.ty = 0;
          this.side = 1;
          this.wave = 0;
          this.dx = new Float64Array(DUST);
          this.dy = new Float64Array(DUST);
          this.dvx = new Float64Array(DUST);
          this.dvy = new Float64Array(DUST);
          this.dk = new Float64Array(DUST);
          this.ddelay = new Float64Array(DUST);
          this.together = 1;
          /** Make a bot's solid figure over his dots (0: loose dots, 1: a bot). */
          this.solid = 0;
          this.hue = 0;
          this.makeColor = PALETTE[0];
          this.assembleT = 0;
          // Sparks: what a key press or a header throws off (dots that rise or fall and fade).
          this.sx = new Float64Array(SPARKS);
          this.sy = new Float64Array(SPARKS);
          this.svx = new Float64Array(SPARKS);
          this.svy = new Float64Array(SPARKS);
          this.slife = new Float64Array(SPARKS);
          this.sbuoy = new Float64Array(SPARKS);
          this.sNext = 0;
          this.fixedS = 0;
          this.sitWant = 0;
          this.lookNext = 0;
          this.flyT = 0;
          this.catchIt = false;
          this.tmp = new Float64Array(2);
          this.kind = o.kind;
          this.color = o.color || INK;
          this.mood = o.mood ?? "idle";
          this.seed = (o.seed ?? 1) >>> 0;
          this.rand = rng(this.seed);
          this.fabric = new Fabric(this.seed);
          this.fixedS = o.size ?? 0;
          this.skin = { a: new Int8Array(DUST), b: new Int8Array(DUST), t: new Float32Array(DUST), u: new Float32Array(DUST), w: new Float32Array(DUST), head: new Uint8Array(DUST), lift: new Float32Array(DUST), n: 0 };
          this.on.fill(-1);
      }
      // ------------------------------------------------------------------- layout
      /**
       * The tile's size and where its words start (`floor`: the bot plays above it and the words stay readable). The
       * first call places everyone; later calls keep them and only move the walls and the floor.
       */
      resize(w, h, floor) {
          const fl = clamp(floor ?? h * 0.55, h * 0.35, h - 4);
          if (this.placed && Math.abs(w - this.w) < 0.5 && Math.abs(h - this.h) < 0.5 && Math.abs(fl - this.floor) < 0.5)
              return;
          const first = !this.placed;
          const dy = fl - this.floor, sx = this.w > 0 ? w / this.w : 1;
          this.w = w;
          this.h = h;
          this.floor = fl;
          this.fabric.layout(w, h);
          if (first) {
              this.setup();
              this.placed = true;
              return;
          }
          // Keep them where they were, on the new floor.
          for (let i = 0; i < this.n; i++) {
              this.x[i] *= sx;
              this.px[i] *= sx;
              this.y[i] += dy;
              this.py[i] += dy;
          }
          for (let p = 0; p < this.np; p++) {
              this.pb[p] += dy;
              this.pc[p] *= sx;
              this.pl[p] *= sx;
          }
          this.wallL = 3;
          this.wallR = w - 3;
      }
      setMood(m) {
          if (m === this.mood)
              return;
          this.mood = m;
          this.next(true);
      }
      /** Look at a point in the tile's own space (it may be outside the tile: another tile's middle). */
      lookAt(x, y) {
          this.focusX = x;
          this.focusY = y;
      }
      lookAway() {
          this.focusX = NaN;
          this.focusY = NaN;
          this.focusGoal = NaN;
      }
      /** A press at (x, y): the cloth is drawn in under the finger, and the bot perks up and looks out at the person. */
      press(x, y) {
          this.fabric.kick(x, y, -55, this.S * 1.8);
          this.cheer();
      }
      /** A small happy moment: a hop with both arms up, and the antenna lights. */
      cheer() {
          this.cheerT = 0;
          this.glowV += 9;
      }
      // ------------------------------------------------------------------- set up
      addP(x, y, m, r, keep, bnc, frc) {
          const i = this.n++;
          this.x[i] = x;
          this.y[i] = y;
          this.px[i] = x;
          this.py[i] = y;
          this.ax[i] = 0;
          this.ay[i] = 0;
          this.im[i] = m > 0 ? 1 / m : 0;
          this.rad[i] = r;
          this.keep[i] = keep;
          this.bnc[i] = bnc;
          this.frc[i] = frc;
          this.on[i] = -1;
          return i;
      }
      addC(a, b, rest, k, mode) {
          const c = this.nc++;
          this.ca[c] = a;
          this.cb[c] = b;
          this.cr[c] = rest;
          this.ck[c] = k;
          this.cm[c] = mode;
          return c;
      }
      setup() {
          const w = this.w, fl = this.floor;
          const S = this.fixedS || clamp(Math.min(this.h * 0.28, (fl - 4) * 0.6), 20, 46);
          this.S = S;
          this.g = 26 * S;
          // Blip's proportions (the hello pose, tulmi/blip/bots): a big round head on a short neck, a sack of a body,
          // short legs and big feet, noodle arms, two antennae (one bent over).
          this.rH = 0.2 * S;
          this.lNeck = 0.255 * S;
          this.lTorso = 0.25 * S;
          this.lLeg = 0.15 * S;
          this.lArm = 0.14 * S;
          this.lAnt1 = 0.12 * S;
          this.lAnt2 = 0.09 * S;
          this.wallL = 3;
          this.wallR = w - 3;
          this.n = 0;
          this.nc = 0;
          this.np = 0;
          // The bot, standing a third of the way in.
          const bx = w * (0.2 + this.rand() * 0.12);
          const hipY = fl - this.lLeg * 0.92;
          const neckY = hipY - this.lTorso, headY = neckY - this.lNeck;
          const r = this.rH, S2 = this.S;
          this.addP(bx, headY, 1.4, r, 0.995, 0, 0.6); // HEAD
          this.addP(bx, neckY, 1.0, 0.08 * S2, 0.995, 0, 0.6); // NECK
          this.addP(bx, hipY, 1.4, 0.09 * S2, 0.995, 0, 0.6); // HIP
          this.addP(bx - 0.07 * S2, fl - 0.03 * S2, 0.6, 0.03 * S2, 0.995, 0, 0.92); // FOOT_L
          this.addP(bx + 0.07 * S2, fl - 0.03 * S2, 0.6, 0.03 * S2, 0.995, 0, 0.92); // FOOT_R
          this.addP(bx - 0.06 * S2, neckY + this.lArm, 0.25, 0.02 * S2, 0.985, 0, 0.5); // ELB_L
          this.addP(bx - 0.08 * S2, neckY + 2 * this.lArm, 0.25, 0.035 * S2, 0.985, 0, 0.5); // HAND_L
          this.addP(bx + 0.06 * S2, neckY + this.lArm, 0.25, 0.02 * S2, 0.985, 0, 0.5); // ELB_R
          this.addP(bx + 0.08 * S2, neckY + 2 * this.lArm, 0.25, 0.035 * S2, 0.985, 0, 0.5); // HAND_R
          // Antennae: A straight, B bent; each base sits on the head's crown.
          this.baseA_u = 0.9 * r;
          this.baseA_w = -0.4 * r;
          this.baseB_u = 0.9 * r;
          this.baseB_w = 0.42 * r;
          let t = this.antTarget(bx, headY, 0, 0, 1);
          const a1x = t[0], a1y = t[1];
          this.addP(a1x, a1y, 0.12, 0.01, 0.97, 0, 0); // ANT_A1
          this.addP(a1x, a1y - this.lAnt2, 0.1, 0.01, 0.97, 0, 0); // ANT_A2
          t = this.antTarget(bx, headY, 0, 1, 1);
          const b1x = t[0], b1y = t[1];
          this.addP(b1x, b1y, 0.12, 0.01, 0.97, 0, 0); // ANT_B1
          this.addP(b1x + this.lAnt2 * 0.7, b1y - this.lAnt2 * 0.7, 0.1, 0.01, 0.97, 0, 0); // ANT_B2
          this.addC(HEAD, NECK, this.lNeck, 1, 1);
          this.addC(NECK, HIP, this.lTorso, 1, 1);
          this.addC(HIP, FOOT_L, this.lLeg, 1, 2);
          this.addC(HIP, FOOT_R, this.lLeg, 1, 2);
          this.addC(NECK, ELB_L, this.lArm, 0.9, 1);
          this.addC(ELB_L, HAND_L, this.lArm, 0.9, 1);
          this.addC(NECK, ELB_R, this.lArm, 0.9, 1);
          this.addC(ELB_R, HAND_R, this.lArm, 0.9, 1);
          this.addC(FOOT_L, FOOT_R, 0.05 * S2, 1, 3); // feet never cross through each other (a minimum distance)
          this.rAntA1 = Math.hypot(a1x - bx, a1y - headY);
          this.rAntB1 = Math.hypot(b1x - bx, b1y - headY);
          this.upperMass = 0;
          for (let i = 0; i < NBOT; i++)
              if (i !== FOOT_L && i !== FOOT_R)
                  this.upperMass += 1 / this.im[i];
          this.addC(HEAD, ANT_A1, this.rAntA1, 0.7, 1);
          this.addC(ANT_A1, ANT_A2, this.lAnt2, 0.8, 1);
          this.addC(HEAD, ANT_B1, this.rAntB1, 0.7, 1);
          this.addC(ANT_B1, ANT_B2, this.lAnt2, 0.8, 1);
          this.holdL = this.addC(HAND_L, HAND_L, 0, 0, 0);
          this.holdR = this.addC(HAND_R, HAND_R, 0, 0, 0);
          this.buildSkin();
          this.props();
          if (this.kind === "make")
              this.scatterDust(true);
          this.blinkAt = 1 + this.rand() * 3;
          this.next(true);
      }
      /** Where an antenna's first joint wants to be: on the crown, out along its own angle (head at hx, hy, turned by `ang`). */
      antTarget(hx, hy, ang, which, face) {
          const f = face < 0 ? -1 : 1, c = Math.cos(ang), s = Math.sin(ang);
          const bu = which ? this.baseB_u : this.baseA_u, bw = (which ? this.baseB_w : this.baseA_w) * f;
          // head space to the screen: across (c, s), up (s, -c)
          const ox = hx + c * bw + s * bu, oy = hy + s * bw - c * bu;
          const da = ang + (which ? 0.32 : -0.14) * f;
          this.ant[0] = ox + Math.sin(da) * this.lAnt1;
          this.ant[1] = oy - Math.cos(da) * this.lAnt1;
          return this.ant;
      }
      /**
       * The halftone: where each dot sits on the skeleton (between particles a and b, at t, then u along and w across).
       * The head's and the body's dots are the perforations of the solid figure (Blip's dots, light on his colour);
       * Make a bot is drawn from all of them, loose, before he is put together.
       */
      buildSkin() {
          const k = this.skin, S = this.S, r = this.rH;
          let n = 0;
          const put = (a, b, t, u, w, kind, lift) => {
              if (n >= DUST)
                  return;
              k.a[n] = a;
              k.b[n] = b;
              k.t[n] = t;
              k.u[n] = u;
              k.w[n] = w;
              k.head[n] = kind;
              k.lift[n] = lift;
              n++;
          };
          const sp = 0.062 * S, rim = 0.055 * S;
          // The head: a disc on a hex lattice. kind 1: inside (a perforation), 3: on the rim (Make a bot only).
          for (let row = -5; row <= 5; row++) {
              const u = row * sp * 0.866, off = row % 2 ? sp / 2 : 0;
              for (let col = -5; col <= 5; col++) {
                  const w = col * sp + off, d = Math.sqrt(u * u + w * w);
                  if (d > r - 0.02 * S)
                      continue;
                  put(NECK, HEAD, 1, u, w, d > r - rim ? 3 : 1, 0.66 + (u / r) * 0.25);
              }
          }
          // The body, from the hips up: wider at the bottom.
          const L = this.lTorso;
          for (let row = 0;; row++) {
              const u = 0.025 * S + row * sp * 0.866;
              if (u > L - 0.01 * S)
                  break;
              const hw = 0.165 * S + (0.135 * S - 0.165 * S) * (u / L) - 0.015 * S, off = row % 2 ? sp / 2 : 0;
              for (let col = -4; col <= 4; col++) {
                  const w = col * sp + off;
                  if (Math.abs(w) > hw)
                      continue;
                  const edge = Math.abs(w) > hw - 0.04 * S || u < 0.05 * S || u > L - 0.045 * S;
                  put(HIP, NECK, 0, u, w, edge ? 4 : 2, 0.2 + (u / L) * 0.25);
              }
          }
          // The rest, for Make a bot: neck, arms, legs, feet, antennae (kind 0).
          put(NECK, HEAD, 0.12, 0, 0, 0, 0.47);
          put(NECK, ELB_L, 0.6, 0, 0, 0, 0.4);
          put(NECK, ELB_L, 1, 0, 0, 0, 0.36);
          put(ELB_L, HAND_L, 0.55, 0, 0, 0, 0.3);
          put(ELB_L, HAND_L, 1, 0, 0, 0, 0.26);
          put(NECK, ELB_R, 0.6, 0, 0, 0, 0.4);
          put(NECK, ELB_R, 1, 0, 0, 0, 0.36);
          put(ELB_R, HAND_R, 0.55, 0, 0, 0, 0.3);
          put(ELB_R, HAND_R, 1, 0, 0, 0, 0.26);
          put(HIP, FOOT_L, 0.45, 0, 0, 0, 0.1);
          put(HIP, FOOT_L, 1, 0, -0.03 * S, 0, 0);
          put(HIP, FOOT_L, 1, 0, 0.03 * S, 0, 0);
          put(HIP, FOOT_R, 0.45, 0, 0, 0, 0.1);
          put(HIP, FOOT_R, 1, 0, -0.03 * S, 0, 0);
          put(HIP, FOOT_R, 1, 0, 0.03 * S, 0, 0);
          put(HEAD, ANT_A1, 0.85, 0, 0, 0, 0.95);
          put(ANT_A1, ANT_A2, 1, 0, 0, 0, 1);
          put(HEAD, ANT_B1, 0.85, 0, 0, 0, 0.95);
          put(ANT_B1, ANT_B2, 1, 0, 0, 0, 1);
          k.n = n;
      }
      /** Each bot's toys. */
      props() {
          const S = this.S, w = this.w, fl = this.floor, r = this.rand;
          if (this.kind === "code") {
              // Two 0s and two 1s: capsules of two particles.
              for (let i = 0; i < 4; i++) {
                  const one = i % 2 === 1;
                  const len = one ? 0.24 * S : 0.1 * S, rr = one ? 0.045 * S : 0.085 * S;
                  const cx = w * (0.45 + 0.13 * i) + (r() - 0.5) * 6, cy = fl - rr;
                  this.addProp(one ? P_ONE : P_ZERO, rr, cx - len / 2, cy, cx + len / 2, cy, 0.5, 0.35);
              }
          }
          else if (this.kind === "custom") {
              const rr = 0.11 * S;
              const p = this.np++;
              this.pk[p] = P_BALL;
              this.pr[p] = rr;
              this.pn[p] = 1;
              this.p0[p] = this.addP(w * 0.68, fl - rr, 0.5, rr, 0.998, 0.72, 0.12);
          }
          else if (this.kind === "keybot") {
              const keys = w > S * 6.2 ? 4 : 3;
              const kw = 0.5 * S, kh = 0.2 * S;
              for (let i = 0; i < keys; i++) {
                  const cx = w * (0.48 + (0.42 * i) / Math.max(1, keys - 1)) - (keys === 4 ? w * 0.08 : 0);
                  const p = this.np++;
                  this.pk[p] = P_KEY;
                  this.pr[p] = kh;
                  this.pn[p] = 2;
                  this.pa[p] = fl - kh; // the top at rest
                  this.pc[p] = cx;
                  this.pl[p] = kw;
                  this.pb[p] = fl;
                  const a = this.addP(cx - kw / 2, fl - kh, 0.9, 0.5, 0.99, 0, 0.5);
                  this.addP(cx + kw / 2, fl - kh, 0.9, 0.5, 0.99, 0, 0.5);
                  this.p0[p] = a;
                  this.addC(a, a + 1, kw, 1, 1);
                  this.ptime[p] = -9;
              }
          }
          else if (this.kind === "plan") {
              const sz = 0.27 * S;
              for (let i = 0; i < 4; i++) {
                  const cx = w * (0.42 + 0.14 * i) + (r() - 0.5) * 4;
                  this.addBox(cx, fl - sz / 2, sz);
              }
              this.tx = w * 0.7;
          }
          else if (this.kind === "travel") {
              const L = 0.52 * S;
              const cx = w * 0.7, cy = fl - 0.08 * S;
              const p = this.np++;
              this.pk[p] = P_PLANE;
              this.pr[p] = L;
              this.pn[p] = 3;
              this.p0[p] = this.addP(cx + L / 2, cy, 0.18, 0.6, 1, 0.1, 0.7); // nose
              this.addP(cx - L / 2, cy - 0.03 * S, 0.2, 0.6, 1, 0.1, 0.7); // tail
              this.addP(cx - L * 0.1, cy + 0.1 * S, 0.2, 0.6, 1, 0.1, 0.7); // keel
              const a = this.p0[p];
              this.addC(a, a + 1, L, 1, 1);
              this.addC(a, a + 2, Math.hypot(L * 0.6, 0.1 * S), 1, 1);
              this.addC(a + 1, a + 2, Math.hypot(L * 0.4, 0.13 * S), 1, 1);
          }
      }
      addProp(kind, rr, x0, y0, x1, y1, m, bnc) {
          const p = this.np++;
          this.pk[p] = kind;
          this.pr[p] = rr;
          this.pn[p] = 2;
          const a = this.addP(x0, y0, m, rr, 0.998, bnc, 0.25);
          this.addP(x1, y1, m, rr, 0.998, bnc, 0.25);
          this.p0[p] = a;
          this.addC(a, a + 1, Math.hypot(x1 - x0, y1 - y0), 1, 1);
          return p;
      }
      addBox(cx, cy, sz) {
          const p = this.np++;
          this.pk[p] = P_DAY;
          this.pr[p] = sz;
          this.pn[p] = 4;
          const h = sz / 2;
          const a = this.addP(cx - h, cy - h, 0.35, 0.4, 0.998, 0.05, 0.85);
          this.addP(cx + h, cy - h, 0.35, 0.4, 0.998, 0.05, 0.85);
          this.addP(cx + h, cy + h, 0.35, 0.4, 0.998, 0.05, 0.85);
          this.addP(cx - h, cy + h, 0.35, 0.4, 0.998, 0.05, 0.85);
          this.p0[p] = a;
          this.addC(a, a + 1, sz, 1, 1);
          this.addC(a + 1, a + 2, sz, 1, 1);
          this.addC(a + 2, a + 3, sz, 1, 1);
          this.addC(a + 3, a, sz, 1, 1);
          this.addC(a, a + 2, sz * Math.SQRT2, 1, 1);
          this.addC(a + 1, a + 3, sz * Math.SQRT2, 1, 1);
      }
      // ------------------------------------------------------------------- stepping
      /** Advance by a frame's time (seconds). Fixed steps inside; a long pause is clamped, not caught up. */
      step(dt) {
          if (!this.placed || this.still)
              return;
          this.acc += clamp(dt, 0, MAX_FRAME);
          let k = 0;
          while (this.acc >= STEP && k < 8) {
              this.stepOnce(STEP);
              this.acc -= STEP;
              k++;
          }
      }
      stepOnce(h) {
          this.t += h;
          this.think(h);
          this.forces(h);
          this.integrate(h);
          this.hit.fill(0, 0, this.n);
          for (let it = 0; it < 3; it++) {
              this.solve();
              this.collide();
          }
          this.contacts(h);
          this.faceStep(h);
          this.sparksStep(h);
          if (this.kind === "make")
              this.dustStep(h);
          this.feedFabric(h);
          this.fabric.step(h);
      }
      vx(i) { return (this.x[i] - this.px[i]) / STEP; }
      vy(i) { return (this.y[i] - this.py[i]) / STEP; }
      setV(i, vx, vy) { this.px[i] = this.x[i] - vx * STEP; this.py[i] = this.y[i] - vy * STEP; }
      addV(i, vx, vy) { this.px[i] = this.px[i] - vx * STEP; this.py[i] = this.py[i] - vy * STEP; }
      /** The head's turn from upright, radians (positive: toward +x). */
      headAngle() {
          return Math.atan2(this.x[HEAD] - this.x[NECK], this.y[NECK] - this.y[HEAD]);
      }
      forces(h) {
          const x = this.x, y = this.y, ax = this.ax, ay = this.ay, n = this.n, g = this.g, S = this.S;
          for (let i = 0; i < n; i++) {
              ax[i] = 0;
              ay[i] = this.im[i] > 0 ? g : 0;
          }
          const live = 1 - this.limp;
          const hipVx = this.vx(HIP), hipVy = this.vy(HIP);
          // Standing: the legs hold the body up, as a spring, while a foot is down.
          if (this.grounded && live > 0) {
              const sup = this.supportY();
              const ride = 0.93 - 0.42 * this.crouch - 0.28 * this.sit;
              const want = sup - this.lLeg * ride - 0.03 * S;
              const err = y[HIP] - want;
              const share = this.grounded === 2 ? 1 : 0.85;
              // Legs push, they cannot pull: at most a little help down (a crouch is quick).
              const up = clamp(-g * share - err * 420 - hipVy * 26, -g * 3, g * 0.25);
              for (let i = 0; i < NBOT; i++) {
                  if (i === FOOT_L || i === FOOT_R)
                      continue;
                  ay[i] += up * live;
              }
              // Feet are pushed into what they stand on: a key dips under him.
              this.pressSupport(-up * live);
              // Walking: a push on the body toward the goal, braked near it.
              if (this.goalX === this.goalX) {
                  const d = this.goalX - x[HIP];
                  const top = 7.5 * S * this.speed;
                  const want = clamp(d * 9, -top, top);
                  const fx = clamp((want - hipVx) * 10, -S * 42, S * 42);
                  for (let i = 0; i < NBOT; i++)
                      if (i !== FOOT_L && i !== FOOT_R)
                          ax[i] += fx * live;
              }
              else {
                  for (let i = 0; i < NBOT; i++)
                      if (i !== FOOT_L && i !== FOOT_R)
                          ax[i] += -hipVx * 8 * live;
              }
          }
          if (live > 0)
              this.posture(h, live);
          this.feet(h, live);
          this.arms(live);
          this.antennae(live);
          if (this.kind === "travel")
              this.aero();
          if (this.kind === "keybot")
              this.keySprings();
      }
      supportY() {
          const a = this.hit[FOOT_L] & (C_FLOOR | C_SUPPORT) ? 1 : 0, b = this.hit[FOOT_R] & (C_FLOOR | C_SUPPORT) ? 1 : 0;
          const fa = this.y[FOOT_L] + this.rad[FOOT_L], fb = this.y[FOOT_R] + this.rad[FOOT_R];
          if (a && b)
              return (fa + fb) / 2;
          if (a)
              return fa;
          if (b)
              return fb;
          return Math.max(fa, fb);
      }
      /** The bot's weight on what its feet stand on (keys dip, tiles are pressed). */
      pressSupport(accUp) {
          if (accUp <= 0)
              return;
          for (let f = FOOT_L; f <= FOOT_R; f++) {
              const p = this.on[f];
              if (p < 0 || this.pk[p] !== P_KEY)
                  continue;
              const a = this.p0[p];
              // The weight this foot carries, over the key's two top corners.
              const force = (accUp * this.upperMass) / Math.max(1, this.grounded);
              for (let k = 0; k < 2; k++)
                  this.ay[a + k] += (force * 0.5) * this.im[a + k];
          }
      }
      /** Upright: the torso over the hips and the head over the neck, by springs that lean and tilt as the brain asks. */
      posture(h, live) {
          const x = this.x, y = this.y, ax = this.ax, ay = this.ay;
          const lean = this.lean + this.sit * 0.12 * this.face;
          // Torso.
          let s = Math.sin(lean), c = Math.cos(lean);
          let tx = x[HIP] + s * this.lTorso, ty = y[HIP] - c * this.lTorso;
          let k = 380 * live, d = 22 * live;
          let fx = (tx - x[NECK]) * k - (this.vx(NECK) - this.vx(HIP)) * d;
          let fy = (ty - y[NECK]) * k - (this.vy(NECK) - this.vy(HIP)) * d;
          ax[NECK] += fx;
          ay[NECK] += fy;
          ax[HIP] -= fx * 0.6;
          ay[HIP] -= fy * 0.6;
          // Head, on its long neck.
          const tilt = lean + this.tilt;
          s = Math.sin(tilt);
          c = Math.cos(tilt);
          tx = x[NECK] + s * this.lNeck;
          ty = y[NECK] - c * this.lNeck;
          k = 300 * live;
          d = 15 * live;
          fx = (tx - x[HEAD]) * k - (this.vx(HEAD) - this.vx(NECK)) * d;
          fy = (ty - y[HEAD]) * k - (this.vy(HEAD) - this.vy(NECK)) * d;
          ax[HEAD] += fx;
          ay[HEAD] += fy;
          ax[NECK] -= fx * 0.5;
          ay[NECK] -= fy * 0.5;
      }
      /** Feet: planted while standing; a foot left behind steps (a small hop of its own); in the air they tuck. */
      feet(h, live) {
          const x = this.x, y = this.y, S = this.S;
          this.stepCool -= h;
          const hipVx = this.vx(HIP);
          const stance = (0.065 + 0.05 * this.sit) * S;
          if (this.grounded && live > 0.5) {
              let worst = -1, wd = 0;
              for (let f = FOOT_L; f <= FOOT_R; f++) {
                  const side = f === FOOT_L ? -1 : 1;
                  const want = x[HIP] + side * stance + this.sit * this.face * 0.1 * S + clamp(hipVx * 0.09, -0.25 * S, 0.25 * S);
                  const off = Math.abs(x[f] - want);
                  if (this.hit[f] & (C_FLOOR | C_SUPPORT) && off > 0.1 * S && off > wd) {
                      worst = f;
                      wd = off;
                  }
                  if (this.sit > 0.5)
                      this.ax[f] += (want - x[f]) * 120;
              }
              if (worst >= 0 && this.stepCool <= 0 && this.sit < 0.5) {
                  const side = worst === FOOT_L ? -1 : 1;
                  const want = x[HIP] + side * stance + clamp(hipVx * 0.2, -0.35 * S, 0.35 * S);
                  const tAir = 0.11;
                  this.setV(worst, clamp((want - x[worst]) / tAir, -14 * S, 14 * S), -this.g * tAir * 0.5);
                  this.stepCool = 0.075;
              }
          }
          else if (live > 0.5) {
              // Airborne: tuck under the hips.
              for (let f = FOOT_L; f <= FOOT_R; f++) {
                  const side = f === FOOT_L ? -1 : 1;
                  this.ax[f] += (x[HIP] + side * stance * 0.8 - x[f]) * 260 - this.vx(f) * 10;
                  this.ay[f] += (y[HIP] + this.lLeg * 0.8 - y[f]) * 260 - this.vy(f) * 10;
              }
          }
      }
      /** Noodle arms: they hang and swing unless the brain reaches for something. */
      arms(live) {
          const x = this.x, y = this.y, S = this.S;
          for (let s = 0; s < 2; s++) {
              const hand = s ? HAND_R : HAND_L, elb = s ? ELB_R : ELB_L, side = s ? 1 : -1;
              const reach = s ? this.armR : this.armL;
              let tx, ty, k;
              if (reach) {
                  tx = s ? this.armRx : this.armLx;
                  ty = s ? this.armRy : this.armLy;
                  k = this.armK || 520;
              }
              else {
                  tx = x[NECK] + side * 0.21 * S + this.face * 0.02 * S;
                  ty = y[NECK] + 0.17 * S;
                  k = 45;
              }
              k *= live;
              this.ax[hand] += (tx - x[hand]) * k - (this.vx(hand) - this.vx(NECK)) * (reach ? 18 : 2.5) * live;
              this.ay[hand] += (ty - y[hand]) * k - (this.vy(hand) - this.vy(NECK)) * (reach ? 18 : 2.5) * live;
              // The elbow bows outward.
              this.ax[elb] += side * 40 * live;
          }
      }
      /** Antennae: springs that want their angle on the crown; they lag and wobble when he moves. */
      antennae(live) {
          const x = this.x, y = this.y;
          const ang = this.headAngle();
          const f = this.face >= 0 ? 1 : -1;
          const hx = x[HEAD], hy = y[HEAD];
          for (let s = 0; s < 2; s++) {
              const j1 = s ? ANT_B1 : ANT_A1, j2 = s ? ANT_B2 : ANT_A2;
              const t = this.antTarget(hx, hy, ang, s, f);
              const k = 520 * (0.3 + 0.7 * live);
              this.ax[j1] += (t[0] - x[j1]) * k - (this.vx(j1) - this.vx(HEAD)) * 7;
              this.ay[j1] += (t[1] - y[j1]) * k - (this.vy(j1) - this.vy(HEAD)) * 7;
              // The tip: straight on for A, bent over for B.
              const dx = x[j1] - hx, dy = y[j1] - hy, d = Math.sqrt(dx * dx + dy * dy) + 1e-6;
              let ux = dx / d, uy = dy / d;
              if (s) {
                  const b = 0.95 * f, c = Math.cos(b), sn = Math.sin(b);
                  const rx = ux * c - uy * sn, ry = ux * sn + uy * c;
                  ux = rx;
                  uy = ry;
              }
              const tx = x[j1] + ux * this.lAnt2, ty = y[j1] + uy * this.lAnt2;
              this.ax[j2] += (tx - x[j2]) * 380 - (this.vx(j2) - this.vx(j1)) * 5;
              this.ay[j2] += (ty - y[j2]) * 380 - (this.vy(j2) - this.vy(j1)) * 5;
          }
      }
      keySprings() {
          for (let p = 0; p < this.np; p++) {
              if (this.pk[p] !== P_KEY)
                  continue;
              const a = this.p0[p];
              for (let k = 0; k < 2; k++) {
                  const i = a + k;
                  const rx = this.pc[p] + (k ? 0.5 : -0.5) * this.pl[p];
                  this.ax[i] += (rx - this.x[i]) * 900 - this.vx(i) * 30;
                  this.ay[i] += (this.pa[p] - this.y[i]) * 1100 - this.vy(i) * 18 - this.g;
              }
          }
      }
      /**
       * The paper plane, as a flat plate: the air resists it moving across its wing far more than along it (that is its
       * lift and its drag), and its tail turns it into its path, held a little nose-up (its trim). It glides, stalls,
       * dives and pulls out by itself.
       */
      aero() {
          const S = this.S, g = this.g;
          for (let p = 0; p < this.np; p++) {
              if (this.pk[p] !== P_PLANE || this.held === p)
                  continue;
              const a = this.p0[p], nose = a, tail = a + 1, keel = a + 2;
              const vx = (this.vx(nose) + this.vx(tail) + this.vx(keel)) / 3, vy = (this.vy(nose) + this.vy(tail) + this.vy(keel)) / 3;
              const sp = Math.sqrt(vx * vx + vy * vy);
              if (sp < 6)
                  continue;
              const nx = vx / sp, ny = vy / sp;
              const hx0 = this.x[nose] - this.x[tail], hy0 = this.y[nose] - this.y[tail];
              const hl = Math.sqrt(hx0 * hx0 + hy0 * hy0) + 1e-6, hx = hx0 / hl, hy = hy0 / hl;
              const nhx = -hy, nhy = hx;
              // The plate.
              const k = Math.min(sp / S, 6);
              const vn = vx * nhx + vy * nhy, va = vx * hx + vy * hy;
              let fx = -20 * k * vn * nhx - 0.15 * k * va * hx, fy = -20 * k * vn * nhy - 0.15 * k * va * hy;
              const fl = Math.sqrt(fx * fx + fy * fy), cap = g * 3;
              if (fl > cap) {
                  fx *= cap / fl;
                  fy *= cap / fl;
              }
              for (let j = 0; j < 3; j++) {
                  this.ax[a + j] += fx;
                  this.ay[a + j] += fy;
              }
              // The tail: toward the path turned a little up (the side away from the keel).
              const mx = (this.x[nose] + this.x[tail]) / 2, my = (this.y[nose] + this.y[tail]) / 2;
              let lx = -ny, ly = nx;
              if (lx * (mx - this.x[keel]) + ly * (my - this.y[keel]) < 0) {
                  lx = -lx;
                  ly = -ly;
              }
              const tau = 0.16, tx = nx * Math.cos(tau) + lx * Math.sin(tau), ty = ny * Math.cos(tau) + ly * Math.sin(tau);
              const cross = hx * ty - hy * tx;
              const spin = (this.vx(nose) - this.vx(tail)) * nhx + (this.vy(nose) - this.vy(tail)) * nhy;
              const turn = clamp(cross * sp * 10 - spin * 9, -g * 2, g * 2);
              this.ax[nose] += nhx * turn;
              this.ay[nose] += nhy * turn;
              this.ax[tail] -= nhx * turn;
              this.ay[tail] -= nhy * turn;
          }
      }
      integrate(h) {
          const x = this.x, y = this.y, px = this.px, py = this.py, h2 = h * h;
          for (let i = 0; i < this.n; i++) {
              if (this.im[i] === 0)
                  continue;
              const k = this.keep[i];
              let vx = (x[i] - px[i]) * k, vy = (y[i] - py[i]) * k;
              // A speed limit, so nothing can tunnel or run away.
              const lim = this.S * 0.9;
              if (vx > lim)
                  vx = lim;
              else if (vx < -lim)
                  vx = -lim;
              if (vy > lim)
                  vy = lim;
              else if (vy < -lim)
                  vy = -lim;
              px[i] = x[i];
              py[i] = y[i];
              x[i] = x[i] + vx + this.ax[i] * h2;
              y[i] = y[i] + vy + this.ay[i] * h2;
              this.vin[i] = vy;
          }
      }
      solve() {
          const x = this.x, y = this.y, im = this.im;
          for (let c = 0; c < this.nc; c++) {
              const mode = this.cm[c];
              if (!mode)
                  continue;
              const a = this.ca[c], b = this.cb[c];
              const wa = im[a], wb = im[b], ws = wa + wb;
              if (ws === 0)
                  continue;
              const dx = x[b] - x[a], dy = y[b] - y[a];
              const d = Math.sqrt(dx * dx + dy * dy);
              const rest = this.cr[c];
              if (mode === 2 && d <= rest)
                  continue;
              if (mode === 3 && d >= rest)
                  continue;
              if (d < 1e-6)
                  continue;
              const k = ((d - rest) / d) * this.ck[c] / ws;
              x[a] = x[a] + dx * k * wa;
              y[a] = y[a] + dy * k * wa;
              x[b] = x[b] - dx * k * wb;
              y[b] = y[b] - dy * k * wb;
          }
      }
      collide() {
          const x = this.x, y = this.y, n = this.n, fl = this.floor;
          // Props against each other, and the bot's parts against the props.
          for (let p = 0; p < this.np; p++) {
              const kind = this.pk[p];
              if (kind === P_ZERO || kind === P_ONE) {
                  for (let q = p + 1; q < this.np; q++)
                      if (this.pk[q] === P_ZERO || this.pk[q] === P_ONE)
                          this.capCap(p, q);
              }
              else if (kind === P_DAY) {
                  for (let q = p + 1; q < this.np; q++)
                      if (this.pk[q] === P_DAY) {
                          this.boxBox(p, q);
                          this.boxBox(q, p);
                      }
              }
              if (this.limp > 0.5 || p === this.ghost)
                  continue;
              for (let i = 0; i < NBOT; i++) {
                  if (i === ELB_L || i === ELB_R || i >= ANT_A1)
                      continue;
                  this.partProp(i, p);
              }
          }
          // The tile's bounds.
          const bl = this.wallL, br = this.wallR;
          for (let i = 0; i < n; i++) {
              if (this.im[i] === 0)
                  continue;
              const r = this.rad[i];
              const L = i < NBOT ? bl : 3, R = i < NBOT ? br : this.w - 3;
              if (y[i] > fl - r) {
                  y[i] = fl - r;
                  this.hit[i] |= C_FLOOR;
                  this.on[i] = -1;
              }
              if (y[i] < r + 1 && i >= NBOT) {
                  y[i] = r + 1;
                  this.hit[i] |= C_CEIL;
              }
              if (x[i] < L + r) {
                  x[i] = L + r;
                  this.hit[i] |= C_WALL;
              }
              else if (x[i] > R - r) {
                  x[i] = R - r;
                  this.hit[i] |= C_WALL;
              }
          }
      }
      /** One bot part against one prop. */
      partProp(i, p) {
          const kind = this.pk[p], a = this.p0[p];
          const r = i === HEAD ? this.rH : this.rad[i];
          if (kind === P_ZERO || kind === P_ONE) {
              this.pointSeg(i, r, a, a + 1, this.pr[p], p);
          }
          else if (kind === P_BALL) {
              this.pointPoint(i, r, a, p);
          }
          else if (kind === P_KEY) {
              if (i !== FOOT_L && i !== FOOT_R && i !== HIP)
                  return;
              const x0 = this.x[a], x1 = this.x[a + 1], xi = this.x[i];
              if (xi < x0 - r * 0.3 || xi > x1 + r * 0.3)
                  return;
              const t = clamp((xi - x0) / (x1 - x0), 0, 1);
              const top = this.y[a] + (this.y[a + 1] - this.y[a]) * t;
              const yi = this.y[i];
              if (yi + r <= top || yi - r > top + this.pr[p] * 0.8)
                  return;
              if (this.py[i] + r > top + this.pr[p] * 0.5)
                  return; // came from the side, under the top: no
              const pen = yi + r - top;
              const wi = this.im[i], wk = this.im[a];
              const k = pen / (wi + wk);
              this.y[i] = yi - k * wi;
              this.y[a] = this.y[a] + k * wk * (1 - t);
              this.y[a + 1] = this.y[a + 1] + k * wk * t;
              this.hit[i] |= C_SUPPORT;
              this.on[i] = p;
          }
          else if (kind === P_DAY) {
              // He walks in front of the day tiles; only his hands touch them, when he means to push the pile over.
              if (this.held === p || (i !== HAND_L && i !== HAND_R) || !(this.act === A_PLAY && this.phase === 5))
                  return;
              this.pointBox(i, r, p);
          }
      }
      pointPoint(i, r, j, p) {
          const dx = this.x[j] - this.x[i], dy = this.y[j] - this.y[i];
          const R = r + this.pr[p];
          const d2 = dx * dx + dy * dy;
          if (d2 >= R * R || d2 < 1e-9)
              return;
          const d = Math.sqrt(d2), pen = (R - d) / d;
          const wi = this.im[i], wj = this.im[j], ws = wi + wj;
          this.x[i] = this.x[i] - dx * pen * (wi / ws);
          this.y[i] = this.y[i] - dy * pen * (wi / ws);
          this.x[j] = this.x[j] + dx * pen * (wj / ws);
          this.y[j] = this.y[j] + dy * pen * (wj / ws);
          this.touch(i, p);
      }
      /** A point of radius r against a capsule a-b of radius rr. */
      pointSeg(i, r, a, b, rr, p) {
          const x = this.x, y = this.y;
          const ex = x[b] - x[a], ey = y[b] - y[a];
          const l2 = ex * ex + ey * ey + 1e-9;
          const t = clamp(((x[i] - x[a]) * ex + (y[i] - y[a]) * ey) / l2, 0, 1);
          const qx = x[a] + ex * t, qy = y[a] + ey * t;
          const dx = x[i] - qx, dy = y[i] - qy;
          const R = r + rr, d2 = dx * dx + dy * dy;
          if (d2 >= R * R || d2 < 1e-9)
              return;
          const d = Math.sqrt(d2), pen = R - d, nx = dx / d, ny = dy / d;
          const wi = this.im[i], wa = this.im[a] * (1 - t), wb = this.im[b] * t;
          const ws = wi + wa + wb + 1e-9;
          x[i] = x[i] + nx * pen * (wi / ws);
          y[i] = y[i] + ny * pen * (wi / ws);
          x[a] = x[a] - nx * pen * (wa / ws);
          y[a] = y[a] - ny * pen * (wa / ws);
          x[b] = x[b] - nx * pen * (wb / ws);
          y[b] = y[b] - ny * pen * (wb / ws);
          if (ny < -0.6 && i < NBOT) {
              this.hit[i] |= C_SUPPORT;
              this.on[i] = p;
          }
          this.touch(i, p);
      }
      capCap(p, q) {
          const a = this.p0[p], b = this.p0[q];
          this.pointSeg(a, this.pr[p], b, b + 1, this.pr[q], q);
          this.pointSeg(a + 1, this.pr[p], b, b + 1, this.pr[q], q);
          this.pointSeg(b, this.pr[q], a, a + 1, this.pr[p], p);
          this.pointSeg(b + 1, this.pr[q], a, a + 1, this.pr[p], p);
      }
      /** A point (radius r) out of a convex box (four particles, clockwise on screen). */
      pointBox(i, r, p) {
          const a = this.p0[p], x = this.x, y = this.y;
          let best = -1, bestD = -1e9, bnx = 0, bny = 0;
          for (let e = 0; e < 4; e++) {
              const e0 = a + e, e1 = a + ((e + 1) & 3);
              const ex = x[e1] - x[e0], ey = y[e1] - y[e0];
              const el = Math.sqrt(ex * ex + ey * ey) + 1e-9;
              const nx = ey / el, ny = -ex / el; // outward for a clockwise box on screen
              const d = (x[i] - x[e0]) * nx + (y[i] - y[e0]) * ny - r;
              if (d > 0)
                  return;
              if (d > bestD) {
                  bestD = d;
                  best = e;
                  bnx = nx;
                  bny = ny;
              }
          }
          if (best < 0)
              return;
          const e0 = a + best, e1 = a + ((best + 1) & 3);
          const ex = x[e1] - x[e0], ey = y[e1] - y[e0];
          const t = clamp(((x[i] - x[e0]) * ex + (y[i] - y[e0]) * ey) / (ex * ex + ey * ey + 1e-9), 0, 1);
          const pen = -bestD;
          const wi = this.im[i], w0 = this.im[e0] * (1 - t), w1 = this.im[e1] * t, ws = wi + w0 + w1 + 1e-9;
          x[i] = x[i] + bnx * pen * (wi / ws);
          y[i] = y[i] + bny * pen * (wi / ws);
          x[e0] = x[e0] - bnx * pen * (w0 / ws);
          y[e0] = y[e0] - bny * pen * (w0 / ws);
          x[e1] = x[e1] - bnx * pen * (w1 / ws);
          y[e1] = y[e1] - bny * pen * (w1 / ws);
          // Friction along the edge: a tile on a tile does not skate off.
          const tx = -bny, ty = bnx;
          const vt = ((x[i] - this.px[i]) - ((x[e0] - this.px[e0]) * (1 - t) + (x[e1] - this.px[e1]) * t)) * tx +
              ((y[i] - this.py[i]) - ((y[e0] - this.py[e0]) * (1 - t) + (y[e1] - this.py[e1]) * t)) * ty;
          const mu = 0.35 * vt;
          x[i] = x[i] - tx * mu * (wi / ws);
          y[i] = y[i] - ty * mu * (wi / ws);
          x[e0] = x[e0] + tx * mu * (w0 / ws);
          y[e0] = y[e0] + ty * mu * (w0 / ws);
          x[e1] = x[e1] + tx * mu * (w1 / ws);
          y[e1] = y[e1] + ty * mu * (w1 / ws);
          if (bny < -0.6) {
              this.hit[i] |= C_SUPPORT;
              this.on[i] = p;
          }
          if (i < NBOT)
              this.touch(i, p);
      }
      boxBox(p, q) {
          const a = this.p0[p];
          for (let k = 0; k < 4; k++)
              this.pointBox(a + k, 0.4, q);
      }
      /** A bot part touched a prop: the brain may turn that touch into a kick, a header, a catch. */
      touch(i, p) {
          if (i >= NBOT)
              return;
          if (this.kind === "code" || this.kind === "custom")
              this.juggleTouch(i, p);
      }
      /** After the steps: friction and bounce once, landings (a ripple), and whether the bot stands. */
      contacts(h) {
          const n = this.n;
          if (this.ghostT > 0) {
              this.ghostT -= h;
              if (this.ghostT <= 0)
                  this.ghost = -1;
          }
          let feet = 0;
          for (let i = 0; i < n; i++) {
              const c = this.hit[i];
              if (!c) {
                  if (i < NBOT)
                      this.on[i] = -1;
                  continue;
              }
              const vx = this.x[i] - this.px[i];
              if (c & (C_FLOOR | C_SUPPORT)) {
                  const vin = this.vin[i];
                  const fr = this.frc[i];
                  this.px[i] = this.x[i] - vx * (1 - fr);
                  if (vin > 0) {
                      this.py[i] = this.y[i] + vin * this.bnc[i];
                      const sp = vin / h;
                      if (sp > this.S * 4 && (i >= NBOT || i === FOOT_L || i === FOOT_R)) {
                          this.fabric.kick(this.x[i], this.y[i], Math.min(sp * 0.35, 90), this.S * 1.6);
                      }
                  }
              }
              if (c & C_WALL)
                  this.px[i] = this.x[i] + vx * 0.3;
              if (c & C_CEIL)
                  this.py[i] = this.y[i];
          }
          for (let f = FOOT_L; f <= FOOT_R; f++)
              if (this.hit[f] & (C_FLOOR | C_SUPPORT))
                  feet++;
          // The head or the hips on the floor count as down too (a tumble, or sitting).
          this.wasGrounded = this.grounded;
          this.grounded = this.limp > 0.5 ? 0 : feet;
          if (this.grounded)
              this.airT = 0;
          else
              this.airT += h;
          this.landed = !this.wasGrounded && this.grounded && this.airT === 0 ? 1 : 0;
      }
      /** The eye, the lid, the facing and the antenna's glow are springs too. */
      faceStep(h) {
          const S = this.S, r = this.rH;
          // Where to look: a look from outside, else the brain's.
          let lx = this.focusX, ly = this.focusY, out = this.lookOut;
          if (lx === lx)
              out = 0;
          else {
              lx = this.lookX;
              ly = this.lookY;
          }
          const hx = this.x[HEAD], hy = this.y[HEAD];
          let gw = 0, gu = 0;
          if (out > 0.5) {
              this.faceTo = 0;
          }
          else if (lx === lx) {
              const dx = lx - hx, dy = ly - hy, d = Math.sqrt(dx * dx + dy * dy) + 1e-6;
              if (Math.abs(dx) > S * 0.25)
                  this.faceTo = dx > 0 ? 1 : -1;
              // into head space: across (w) and up (u)
              const ang = this.headAngle(), c = Math.cos(ang), s = Math.sin(ang);
              gw = (dx * c + dy * s) / d;
              gu = (dx * s - dy * c) / d;
          }
          else {
              const v = this.vx(HIP);
              if (Math.abs(v) > S * 0.8)
                  this.faceTo = v > 0 ? 1 : -1;
          }
          this.faceV += ((this.faceTo - this.face) * 70 - this.faceV * 13) * h;
          this.face = clamp(this.face + this.faceV * h, -1, 1);
          const tw = this.face * 0.22 * r + gw * 0.2 * r, tu = 0.02 * r + gu * 0.18 * r;
          this.ewV += ((tw - this.ew) * 420 - this.ewV * 26) * h;
          this.euV += ((tu - this.eu) * 420 - this.euV * 26) * h;
          this.ew += this.ewV * h;
          this.eu += this.euV * h;
          // Blinks.
          this.blinkAt -= h;
          if (this.blinkAt <= 0) {
              this.blinkT = 0.11;
              this.blinkAt = 1.8 + this.rand() * 3.6;
          }
          let lidTo = this.lidTo;
          if (this.blinkT > 0) {
              this.blinkT -= h;
              lidTo = 1;
          }
          if (this.kind === "make" && this.solid < 0.5)
              lidTo = 1;
          this.lidV += ((lidTo - this.lid) * 1400 - this.lidV * 55) * h;
          this.lid = clamp(this.lid + this.lidV * h, 0, 1);
          this.glowV += (-this.glow * 60 - this.glowV * 9) * h;
          this.glow += this.glowV * h;
      }
      /** Each body part drags the threads near it along. */
      feedFabric(h) {
          if (this.kind === "make" && this.together < 0.5) {
              // The loose dots ripple it instead (a few of them).
              for (let i = 0; i < this.skin.n; i += 6)
                  this.fabric.wake(this.dx[i], this.dy[i], this.dvx[i], this.dvy[i], this.S * 0.5, 0.25);
          }
          else {
              const R = this.S * 0.62;
              this.fabric.wake(this.x[HEAD], this.y[HEAD], this.vx(HEAD), this.vy(HEAD), R * 1.1, 0.45);
              this.fabric.wake(this.x[HIP], this.y[HIP], this.vx(HIP), this.vy(HIP), R, 0.4);
              this.fabric.wake(this.x[FOOT_L], this.y[FOOT_L], this.vx(FOOT_L), this.vy(FOOT_L), R * 0.6, 0.3);
              this.fabric.wake(this.x[FOOT_R], this.y[FOOT_R], this.vx(FOOT_R), this.vy(FOOT_R), R * 0.6, 0.3);
              this.fabric.wake(this.x[HAND_L], this.y[HAND_L], this.vx(HAND_L), this.vy(HAND_L), R * 0.45, 0.22);
              this.fabric.wake(this.x[HAND_R], this.y[HAND_R], this.vx(HAND_R), this.vy(HAND_R), R * 0.45, 0.22);
          }
          for (let p = 0; p < this.np; p++) {
              const a = this.p0[p];
              this.fabric.wake(this.x[a], this.y[a], this.vx(a), this.vy(a), this.S * 0.4, 0.22);
          }
      }
      // ------------------------------------------------------------------- sparks
      spark(x, y, vx, vy, buoy) {
          const i = this.sNext;
          this.sNext = (i + 1) % SPARKS;
          this.sx[i] = x;
          this.sy[i] = y;
          this.svx[i] = vx;
          this.svy[i] = vy;
          this.slife[i] = 1;
          this.sbuoy[i] = buoy;
      }
      sparksStep(h) {
          for (let i = 0; i < SPARKS; i++) {
              if (this.slife[i] <= 0)
                  continue;
              this.svy[i] = this.svy[i] + (this.g * 0.35 - this.sbuoy[i] * this.g * 0.5) * h;
              this.svx[i] = this.svx[i] * (1 - 2.2 * h);
              this.svy[i] = this.svy[i] * (1 - 2.2 * h);
              this.sx[i] = this.sx[i] + this.svx[i] * h;
              this.sy[i] = this.sy[i] + this.svy[i] * h;
              this.slife[i] = this.slife[i] - h * 1.4;
          }
      }
      // ------------------------------------------------------------------- the brain
      jump(vx, vy) {
          for (let i = 0; i < NBOT; i++) {
              const k = i === HAND_L || i === HAND_R || i === ELB_L || i === ELB_R ? 0.85 : 1;
              this.setV(i, vx * k + this.vx(i) * (1 - k), vy * k + this.vy(i) * (1 - k));
          }
          this.grounded = 0;
      }
      /** Hop so the hips land at (tx, ty_hips), rising `apex` above the higher of the two. */
      jumpTo(tx, tyHip, apex) {
          const g = this.g, y0 = this.y[HIP];
          const top = Math.min(y0, tyHip) - apex;
          const vy = -Math.sqrt(2 * g * Math.max(1, y0 - top));
          const tUp = -vy / g, tDown = Math.sqrt((2 * Math.max(1, tyHip - top)) / g);
          this.jump((tx - this.x[HIP]) / (tUp + tDown), vy);
      }
      /** Done with what it was doing: choose what comes next (by its kind and its mood). */
      next(reset) {
          const r = this.rand();
          const busy = this.mood === "working";
          this.actT = 0;
          this.phase = 0;
          this.phaseT = 0;
          this.count = 0;
          this.target = -1;
          if (reset)
              this.release();
          if (this.mood === "needs" && this.kind !== "make") {
              this.act = A_NEEDS;
              this.actDur = 3;
              return;
          }
          if (this.kind === "make") {
              this.act = A_PLAY;
              this.actDur = 99;
              return;
          }
          const play = busy ? 0.8 : 0.42;
          if (r < play) {
              this.act = A_PLAY;
              this.actDur = busy ? 14 : 9;
          }
          else if (busy) {
              this.act = r < 0.9 ? A_LOOK : A_WANDER;
              this.actDur = 1.4 + this.rand();
          }
          else {
              const q = (r - play) / (1 - play);
              if (q < 0.3) {
                  this.act = A_SIT;
                  this.actDur = 2.6 + this.rand() * 2.4;
              }
              else if (q < 0.48) {
                  this.act = A_STRETCH;
                  this.actDur = 1.6;
              }
              else if (q < 0.66) {
                  this.act = A_PEEK;
                  this.actDur = 5;
                  this.side = this.x[HIP] < this.w / 2 ? -1 : 1;
              }
              else if (q < 0.84) {
                  this.act = A_LOOK;
                  this.actDur = 2 + this.rand() * 1.5;
              }
              else {
                  this.act = A_WANDER;
                  this.actDur = 3;
                  this.tx = this.w * (0.15 + this.rand() * 0.7);
              }
          }
      }
      release() {
          if (this.holdL >= 0)
              this.cm[this.holdL] = 0;
          if (this.holdR >= 0)
              this.cm[this.holdR] = 0;
          this.held = -1;
      }
      hold(p, iL, iR) {
          this.held = p;
          if (iL >= 0) {
              this.cb[this.holdL] = iL;
              this.cr[this.holdL] = 0;
              this.ck[this.holdL] = 0.5;
              this.cm[this.holdL] = 1;
          }
          if (iR >= 0) {
              this.cb[this.holdR] = iR;
              this.cr[this.holdR] = 0;
              this.ck[this.holdR] = 0.5;
              this.cm[this.holdR] = 1;
          }
      }
      think(h) {
          const S = this.S;
          this.actT += h;
          this.phaseT += h;
          // The defaults: stand, hands down, eyes ahead; the act below changes what it needs.
          this.crouch = 0;
          this.sitWant = 0;
          this.lean = 0;
          this.tilt = 0;
          this.armL = false;
          this.armR = false;
          this.armK = 0;
          this.speed = this.mood === "working" ? 1.3 : 0.85;
          this.lookOut = 0;
          this.lidTo = this.mood === "idle" ? 0.22 : 0.1;
          this.wallL = 3;
          this.wallR = this.w - 3;
          if (this.limp > 0 && this.kind !== "make")
              this.limp = Math.max(0, this.limp - h * 2);
          // A look from outside (another tile was tapped): stop, turn the head to it.
          const focused = this.focusX === this.focusX && (this.kind !== "make" || this.together > 0.9);
          if (focused) {
              const dx = this.focusX - this.x[HEAD], dy = this.focusY - this.y[HEAD];
              // Readable at tile size: one step its way, the head turned hard to it, the body leaning in.
              if (this.focusGoal !== this.focusGoal)
                  this.focusGoal = clamp(this.x[HIP] + (dx >= 0 ? 1 : -1) * S * 0.9, this.wallL + S, this.wallR - S);
              this.goalX = this.focusGoal;
              this.tilt = clamp(Math.atan2(dx, -dy) * 0.6, -0.62, 0.62);
              this.lean = clamp(dx / (Math.abs(dx) + S * 3), -0.3, 0.3);
              this.lidTo = 0;
              this.sitTo(0, h);
              return;
          }
          if (this.cheerT >= 0) {
              this.cheerStep(h);
              if (this.cheerT >= 0) {
                  this.sitTo(0, h);
                  return;
              }
          }
          switch (this.act) {
              case A_NEEDS:
                  this.needs(h);
                  break;
              case A_SIT:
                  this.goalX = NaN;
                  this.sitWant = 1;
                  this.lidTo = 0.4;
                  this.idleLook(h, 0.4);
                  break;
              case A_STRETCH:
                  this.stretch();
                  break;
              case A_PEEK:
                  this.peek(h);
                  break;
              case A_LOOK:
                  this.goalX = NaN;
                  this.idleLook(h, 0.9);
                  break;
              case A_WANDER:
                  this.goalX = this.tx;
                  if (Math.abs(this.x[HIP] - this.tx) < S * 0.2 && this.actT > 0.6)
                      this.actT = this.actDur;
                  break;
              case A_PLAY:
                  this.play(h);
                  break;
              default: this.goalX = NaN;
          }
          if (this.actT >= this.actDur && this.act !== A_PLAY)
              this.next(false);
          this.sitTo(this.sitWant, h);
      }
      sitTo(v, h) {
          this.sit += (v - this.sit) * Math.min(1, h * 6);
      }
      cheerStep(h) {
          const t = this.cheerT;
          this.cheerT += h;
          this.goalX = NaN;
          this.lookOut = 1;
          this.lidTo = 0;
          if (t < 0.1) {
              this.crouch = 0.5;
          }
          else if (this.grounded && t < 0.2) {
              this.jump(0, -Math.sqrt(2 * this.g * this.S * 0.45));
              this.glowV += 6;
              this.cheerT = 0.2;
          }
          this.armL = this.armR = true;
          this.armLx = this.x[NECK] - this.S * 0.16;
          this.armLy = this.y[NECK] - this.S * 0.22;
          this.armRx = this.x[NECK] + this.S * 0.16;
          this.armRy = this.y[NECK] - this.S * 0.22;
          if (t > 0.85)
              this.cheerT = -1;
      }
      idleLook(h, rate) {
          if (this.phaseT > this.lookNext || (this.lookX !== this.lookX && this.lookOut < 0.5 && this.phaseT > 0.4)) {
              this.phaseT = 0;
              this.lookNext = (0.7 + this.rand() * 1.6) / rate;
              if (this.rand() < 0.25) {
                  this.lookX = NaN;
                  this.lookOut = 1;
              }
              else {
                  this.lookX = this.w * this.rand();
                  this.lookY = this.floor * (0.1 + this.rand() * 0.9);
              }
          }
      }
      needs(h) {
          // Stop, turn to the person, and every few seconds a small "hey": a bob and a raised hand.
          this.goalX = NaN;
          this.lookOut = 1;
          this.lookX = NaN;
          this.lidTo = 0;
          const cyc = this.actT % 3.2;
          if (cyc > 2.2 && cyc < 3.0) {
              this.armR = true;
              this.armK = 380;
              this.armRx = this.x[NECK] + this.S * (0.2 + 0.05 * Math.sign(Math.sin(this.actT * 22)));
              this.armRy = this.y[NECK] - this.S * 0.2;
          }
          if (cyc > 2.05 && cyc < 2.2)
              this.crouch = 0.35;
          if (this.actT > 9.6)
              this.actT -= 9.6;
      }
      stretch() {
          this.goalX = NaN;
          const t = this.actT, S = this.S;
          if (t > 0.2 && t < 1.3) {
              this.armL = this.armR = true;
              this.armK = 300;
              this.armLx = this.x[NECK] - S * 0.1;
              this.armLy = this.y[NECK] - S * 0.27;
              this.armRx = this.x[NECK] + S * 0.1;
              this.armRy = this.y[NECK] - S * 0.27;
              this.crouch = -0.1;
              this.tilt = -0.25 * this.face;
              this.lidTo = 0.9;
          }
          else if (t <= 0.2)
              this.crouch = 0.25;
      }
      peek(h) {
          const S = this.S, side = this.side;
          // Out over the edge (the tile clips him), then lean back in and look.
          if (side < 0)
              this.wallL = -S * 0.9;
          else
              this.wallR = this.w + S * 0.9;
          const out = side < 0 ? -S * 0.32 : this.w + S * 0.32;
          if (this.phase === 0) {
              this.goalX = out;
              if (Math.abs(this.x[HIP] - out) < S * 0.25 || this.phaseT > 3) {
                  this.phase = 1;
                  this.phaseT = 0;
              }
          }
          else if (this.phase === 1) {
              this.goalX = out;
              this.lean = -side * 0.42;
              this.tilt = -side * 0.3;
              this.lookX = this.w / 2;
              this.lookY = this.floor * 0.5;
              this.lidTo = 0;
              if (this.phaseT > 1.5) {
                  this.phase = 2;
                  this.phaseT = 0;
              }
          }
          else {
              this.goalX = this.w * (side < 0 ? 0.3 : 0.7);
              if (this.phaseT > 1.2)
                  this.actT = this.actDur;
          }
      }
      play(h) {
          switch (this.kind) {
              case "code":
              case "custom":
                  this.juggle(h);
                  break;
              case "keybot":
                  this.keys(h);
                  break;
              case "plan":
                  this.stack(h);
                  break;
              case "travel":
                  this.fly(h);
                  break;
              case "make":
                  this.make(h);
                  break;
          }
          if (this.actT > this.actDur && this.kind !== "make" && this.held < 0 && (this.phase === 0 || this.kind === "code" || this.kind === "custom"))
              this.next(true);
      }
      // ---- Code bot (and anyone's own bot, with a ball): kicks, headers, juggling.
      /** The prop in play: a body that is up in the air, else the nearest one on the floor. */
      pick() {
          let best = -1, bd = 1e9;
          for (let p = 0; p < this.np; p++) {
              const a = this.p0[p];
              const d = Math.abs(this.x[a] - this.x[HIP]);
              const air = this.y[a] < this.floor - this.pr[p] * 2.5 ? -1e6 : 0;
              if (d + air < bd) {
                  bd = d + air;
                  best = p;
              }
          }
          return best;
      }
      juggle(h) {
          const S = this.S, p = this.target >= 0 ? this.target : (this.target = this.pick());
          if (p < 0) {
              this.goalX = NaN;
              return;
          }
          const a = this.p0[p], b = this.pn[p] === 2 ? a + 1 : a;
          const cx = (this.x[a] + this.x[b]) / 2, cy = (this.y[a] + this.y[b]) / 2;
          const vx = (this.vx(a) + this.vx(b)) / 2, vy = (this.vy(a) + this.vy(b)) / 2;
          this.lookX = cx;
          this.lookY = cy;
          const onFloor = cy > this.floor - this.pr[p] * 3 && Math.abs(vy) < S * 2;
          if (this.phase === 0) {
              // Walk up to it and kick it up.
              if (!onFloor) {
                  this.phase = 1;
                  this.phaseT = 0;
                  return;
              }
              const side = this.x[HIP] < cx ? -1 : 1;
              this.goalX = cx + side * S * 0.2;
              this.side = side;
              if (Math.abs(this.x[HIP] - this.goalX) < S * 0.1 && this.grounded) {
                  // The kick: a little crouch, then the near foot swings into it.
                  this.crouch = 0.35;
                  if (this.phaseT > 0.12) {
                      const f = side < 0 ? FOOT_R : FOOT_L;
                      this.setV(f, -side * S * 7, -S * 2.2);
                      this.phase = 3;
                      this.phaseT = 0;
                  }
              }
              else
                  this.phaseT = Math.min(this.phaseT, 0.05);
              if (this.actT > 6 && this.count === 0)
                  this.next(true);
          }
          else if (this.phase === 3) {
              // The kick lands when the foot gets to it.
              this.goalX = NaN;
              const f = this.side < 0 ? FOOT_R : FOOT_L;
              const d = Math.hypot(this.x[f] - cx, this.y[f] - cy);
              if (d < this.pr[p] + S * 0.14) {
                  this.launch(p, false);
                  return;
              }
              if (this.phaseT > 0.35) {
                  this.phase = onFloor ? 0 : 1;
                  this.phaseT = 0;
              }
          }
          else if (this.phase === 1) {
              // Get under it. Where will it be at head height?
              if (onFloor) {
                  // It got away: a moment's look, then go again (or something else).
                  this.goalX = NaN;
                  this.tilt = 0.2 * this.face;
                  if (this.phaseT > 0.7) {
                      if (this.count > 5 || this.rand() < 0.3)
                          this.next(true);
                      else {
                          this.phase = 0;
                          this.phaseT = 0;
                          this.target = -1;
                      }
                  }
                  return;
              }
              const hy = this.y[HEAD] - this.rH;
              const g = this.g, dy = hy - cy;
              const tt = vy * vy + 2 * g * dy > 0 ? (vy + Math.sqrt(vy * vy + 2 * g * dy)) / g : 0;
              const land = clamp(cx + vx * tt, this.S * 0.4, this.w - this.S * 0.4);
              this.goalX = land;
              this.speed = 1.6;
              this.phaseT = 0;
              this.tilt = clamp((cx - this.x[HEAD]) / (S * 3), -0.3, 0.3);
          }
      }
      /** A touch on the prop in play: a kick from a foot, a header, a bump from a hand. */
      juggleTouch(i, p) {
          if (this.act !== A_PLAY || p !== this.target)
              return;
          if (this.mood === "needs" || this.focusX === this.focusX)
              return;
          const a = this.p0[p], b = this.pn[p] === 2 ? a + 1 : a, S = this.S;
          const vy = (this.vy(a) + this.vy(b)) / 2;
          const isFoot = i === FOOT_L || i === FOOT_R, isHead = i === HEAD;
          if (!(isFoot && this.phase === 3) && !(isHead && this.phase === 1 && vy > -S))
              return;
          this.launch(p, isHead);
      }
      /** Send the prop in play up again: from a kick, or a header (with a nod into it). */
      launch(p, isHead) {
          const a = this.p0[p], b = this.pn[p] === 2 ? a + 1 : a, S = this.S;
          const room = Math.max(S * 0.8, this.floor - S * 1.1);
          const apex = room * (this.mood === "working" ? 0.45 + this.rand() * 0.25 : 0.55 + this.rand() * 0.35);
          const toMid = (this.w * (0.3 + this.rand() * 0.4) - this.x[a]) * 0.9;
          const up = -Math.sqrt(2 * this.g * apex);
          const spin = (this.rand() - 0.5) * S * 14;
          if (this.pn[p] === 2) {
              // Two ends, a little apart in speed: it tumbles.
              const ex = this.x[b] - this.x[a], ey = this.y[b] - this.y[a], el = Math.sqrt(ex * ex + ey * ey) + 1e-6;
              this.setV(a, toMid - (ey / el) * spin, up + (ex / el) * spin);
              this.setV(b, toMid + (ey / el) * spin, up - (ex / el) * spin);
          }
          else
              this.setV(a, toMid, up);
          if (isHead) {
              // A nod into it.
              this.addV(HEAD, 0, S * 3);
              this.count++;
          }
          this.glowV += 5;
          this.spark(this.x[a], this.y[a], (this.rand() - 0.5) * S * 3, -S * 2, 0.9);
          this.fabric.kick(this.x[a], this.y[a], 30, S * 1.2);
          this.phase = 1;
          this.phaseT = 0;
      }
      // ---- Keybot: hops from key to key; each one dips under him and a typed dot floats up.
      keys(h) {
          const S = this.S;
          let keys = 0;
          for (let p = 0; p < this.np; p++)
              if (this.pk[p] === P_KEY)
                  keys++;
          if (!keys)
              return;
          const busy = this.mood === "working";
          if (this.phase === 0) {
              // Choose the next key (not the one under him).
              let k = Math.floor(this.rand() * keys);
              if (k === this.target)
                  k = (k + 1 + Math.floor(this.rand() * (keys - 1))) % keys;
              this.target = k;
              this.phase = 1;
              this.phaseT = 0;
          }
          const p = this.target;
          const a = this.p0[p];
          const kx = this.pc[p], top = Math.min(this.y[a], this.y[a + 1]);
          this.lookX = kx;
          this.lookY = top;
          if (this.phase === 1) {
              // Settle, then crouch.
              this.goalX = NaN;
              const wait = busy ? 0.08 : 0.35 + this.rand() * 0.02;
              if (this.phaseT > wait)
                  this.crouch = 0.55;
              if (this.phaseT > wait + 0.12 && this.grounded) {
                  const hipOn = top - this.lLeg * 0.9 - 0.03 * S;
                  this.jumpTo(kx + (this.rand() - 0.5) * S * 0.08, hipOn, S * (busy ? 0.28 : 0.42));
                  this.phase = 2;
                  this.phaseT = 0;
              }
          }
          else if (this.phase === 2) {
              this.goalX = NaN;
              this.armL = this.armR = true;
              this.armK = 160;
              this.armLx = this.x[NECK] - S * 0.2;
              this.armLy = this.y[NECK] - S * 0.02;
              this.armRx = this.x[NECK] + S * 0.2;
              this.armRy = this.y[NECK] - S * 0.02;
              if (this.landed || (this.grounded && this.phaseT > 0.12)) {
                  this.count++;
                  // The key he landed on: lit, and a typed dot floats up from it.
                  const on = this.on[FOOT_L] >= 0 ? this.on[FOOT_L] : this.on[FOOT_R];
                  if (on >= 0) {
                      this.ptime[on] = this.t;
                      this.spark(this.pc[on], this.pa[on] - S * 0.1, (this.rand() - 0.5) * S * 2, -S * 3, 1.6);
                      this.glowV += 7;
                  }
                  this.phase = 3;
                  this.phaseT = 0;
              }
              if (this.phaseT > 1.5) {
                  this.phase = 0;
              }
          }
          else if (this.phase === 3) {
              this.goalX = this.pc[p];
              const more = busy ? 9 : 4;
              if (this.phaseT > (busy ? 0.15 : 0.55)) {
                  if (this.count >= more) {
                      // A rest on the key (it dips under him).
                      if (!busy && this.rand() < 0.5) {
                          this.phase = 4;
                          this.phaseT = 0;
                      }
                      else
                          this.next(true);
                  }
                  else
                      this.phase = 0;
              }
          }
          else if (this.phase === 4) {
              this.goalX = this.pc[p];
              this.sitWant = 1;
              this.lidTo = 0.45;
              if (this.phaseT > 2.6)
                  this.next(true);
          }
      }
      // ---- Plan bot: tosses day tiles onto a stack; the stack wobbles and topples; he looks, and starts again.
      stackCount() {
          let n = 0;
          for (let p = 0; p < this.np; p++) {
              if (this.pk[p] !== P_DAY || this.held === p)
                  continue;
              if (Math.abs(this.boxCenter(p)[0] - this.tx) < this.pr[p] * 0.6)
                  n++;
          }
          return n;
      }
      boxCenter(p) {
          const a = this.p0[p], c = this.box;
          c[0] = (this.x[a] + this.x[a + 1] + this.x[a + 2] + this.x[a + 3]) / 4;
          c[1] = (this.y[a] + this.y[a + 1] + this.y[a + 2] + this.y[a + 3]) / 4;
          return c;
      }
      stack(h) {
          const S = this.S, stackX = this.tx;
          const busy = this.mood === "working";
          if (this.phase === 0) {
              // The nearest tile that is not on the pile.
              let best = -1, bd = 1e9;
              for (let p = 0; p < this.np; p++) {
                  if (this.pk[p] !== P_DAY)
                      continue;
                  const cx = this.boxCenter(p)[0];
                  if (Math.abs(cx - stackX) < this.pr[p] * 0.6)
                      continue;
                  const d = Math.abs(cx - this.x[HIP]);
                  if (d < bd) {
                      bd = d;
                      best = p;
                  }
              }
              this.lookX = stackX;
              this.lookY = this.floor - S * 0.4;
              if (best < 0) {
                  this.phase = 5;
                  this.phaseT = 0;
                  return;
              }
              this.target = best;
              this.phase = 1;
              this.phaseT = 0;
          }
          const p = this.target;
          const bc = this.boxCenter(p);
          const c0 = bc[0], c1 = bc[1], sz = this.pr[p], a = this.p0[p];
          if (this.phase === 1) {
              // Go round to the far side of it from the pile (or the open side, by a wall), and reach down.
              let side = c0 < stackX ? -1 : 1;
              if (c0 < S * 0.45)
                  side = 1;
              else if (c0 > this.w - S * 0.45)
                  side = -1;
              this.goalX = c0 + side * S * 0.24;
              this.lookX = c0;
              this.lookY = c1;
              if (Math.abs(this.x[HIP] - this.goalX) < S * 0.1 && this.grounded) {
                  this.crouch = 0.6;
                  this.armL = this.armR = true;
                  this.armLx = this.armRx = c0;
                  this.armLy = this.armRy = c1;
                  if (this.phaseT > 0.28) {
                      // The flip: a throw onto the top of the pile, flat, from where it lies.
                      const n = this.stackCount();
                      const tx = stackX + (this.rand() - 0.5) * sz * (busy ? 0.5 : 0.3);
                      const ty = this.floor - sz * (n + 0.5) - 0.5;
                      const g = this.g, top = Math.min(c1, ty) - S * (0.32 + 0.1 * n);
                      const vy = -Math.sqrt(2 * g * Math.max(1, c1 - top));
                      const tt = -vy / g + Math.sqrt((2 * Math.max(1, ty - top)) / g);
                      const vx = (tx - c0) / tt;
                      for (let k = 0; k < 4; k++)
                          this.setV(a + k, vx, vy);
                      this.ghost = p;
                      this.ghostT = 0.6;
                      this.glowV += 5;
                      this.phase = 4;
                      this.phaseT = 0;
                  }
              }
              else
                  this.phaseT = 0;
              if (this.actT > 10)
                  this.next(true);
          }
          else if (this.phase === 4) {
              // Follow-through: arms up, and watch it land.
              this.goalX = NaN;
              this.lookX = c0;
              this.lookY = c1;
              this.armL = this.armR = this.phaseT < 0.3;
              this.armLx = this.x[NECK] - this.face * S * 0.05;
              this.armLy = this.y[NECK] - S * 0.24;
              this.armRx = this.x[NECK] + this.face * S * 0.15;
              this.armRy = this.y[NECK] - S * 0.24;
              if (this.phaseT > (busy ? 0.75 : 1.2))
                  this.phase = 0;
          }
          else if (this.phase === 5) {
              // All up: admire it, then walk into it.
              this.lookX = stackX;
              this.lookY = this.floor - S;
              this.goalX = NaN;
              if (this.phaseT > (busy ? 0.9 : 1.6)) {
                  const side = this.x[HIP] < stackX ? -1 : 1;
                  this.goalX = stackX;
                  this.speed = 0.7;
                  this.armL = this.armR = true;
                  this.armLx = this.armRx = stackX;
                  this.armLy = this.armRy = this.floor - S * 0.5;
                  if (this.phaseT > 3.2 && this.grounded && this.stackCount() >= 3)
                      this.jump(-side * S * 2, -Math.sqrt(2 * this.g * S * 0.3));
                  if (this.stackCount() < 3 || this.phaseT > 5) {
                      this.phase = 6;
                      this.phaseT = 0;
                  }
              }
          }
          else if (this.phase === 6) {
              // Look at the mess. Then again.
              this.goalX = NaN;
              this.tilt = 0.3 * this.face;
              this.lookX = stackX;
              this.lookY = this.floor;
              if (this.phaseT > 1.3) {
                  this.phase = 0;
                  this.next(true);
              }
          }
          else
              this.phase = 0;
      }
      // ---- Travel bot: throws the paper plane, chases it, catches it.
      fly(h) {
          const S = this.S;
          const p = 0, a = this.p0[p], nose = a, tail = a + 1;
          const cx = (this.x[nose] + this.x[tail]) / 2, cy = (this.y[nose] + this.y[tail]) / 2;
          const vx = this.vx(nose), vy = this.vy(nose);
          const resting = cy > this.floor - S * 0.25 && Math.abs(vx) + Math.abs(vy) < S * 1.5;
          this.lookX = cx;
          this.lookY = cy;
          const busy = this.mood === "working";
          if (this.phase === 0) {
              if (this.held === p) {
                  this.phase = 2;
                  this.phaseT = 0;
                  return;
              }
              if (!resting) {
                  this.phase = 3;
                  this.phaseT = 0;
                  return;
              }
              // Walk to it and pick it up by the tail.
              this.goalX = this.x[tail] + (this.x[HIP] < this.x[tail] ? -1 : 1) * S * 0.15;
              if (Math.abs(this.x[HIP] - this.goalX) < S * 0.15) {
                  this.crouch = 0.65;
                  this.armR = true;
                  this.armRx = this.x[tail];
                  this.armRy = this.y[tail];
                  if (Math.hypot(this.x[HAND_R] - this.x[tail], this.y[HAND_R] - this.y[tail]) < S * 0.2) {
                      this.hold(p, -1, tail);
                      this.phase = 2;
                      this.phaseT = 0;
                  }
              }
              if (this.phaseT > 6)
                  this.next(true);
          }
          else if (this.phase === 2) {
              // Aim: toward the open side; arm back, then throw.
              const dir = this.x[HIP] < this.w / 2 ? 1 : -1;
              this.faceTo = dir;
              this.goalX = this.w * (dir > 0 ? 0.22 : 0.78);
              this.armR = true;
              this.armK = 420;
              const back = this.phaseT > (busy ? 0.4 : 0.9);
              this.armRx = this.x[NECK] + (back ? -dir * S * 0.22 : dir * S * 0.15);
              this.armRy = this.y[NECK] - S * (back ? 0.18 : 0.02);
              this.lookX = this.x[HEAD] + dir * S * 3;
              this.lookY = this.y[HEAD] - S;
              if (back && this.phaseT > (busy ? 0.65 : 1.2) && this.grounded) {
                  this.release();
                  const sp = S * (busy ? 4.4 : 3.8) * (0.9 + this.rand() * 0.25);
                  const ang = -0.04 - this.rand() * 0.16;
                  const tvx = dir * sp * Math.cos(ang), tvy = sp * Math.sin(ang);
                  // Point it along the throw, then let go.
                  const L = this.pr[p], mx = this.x[HAND_R] + dir * S * 0.15, my = this.y[HAND_R] - S * 0.05;
                  this.x[nose] = mx + dir * L / 2;
                  this.y[nose] = my + Math.sin(ang) * L / 2;
                  this.x[tail] = mx - dir * L / 2;
                  this.y[tail] = my - Math.sin(ang) * L / 2;
                  this.x[a + 2] = mx - dir * L * 0.1;
                  this.y[a + 2] = my + S * 0.1;
                  for (let k = 0; k < 3; k++)
                      this.setV(a + k, tvx, tvy);
                  this.glowV += 6;
                  this.ghost = p;
                  this.ghostT = 0.3;
                  this.flyT = 0;
                  // Some throws he runs to catch; some he lets land.
                  this.catchIt = this.rand() < (busy ? 0.7 : 0.45);
                  this.phase = 3;
                  this.phaseT = 0;
                  this.count++;
              }
          }
          else if (this.phase === 3) {
              // Chase: where it is going, and a jump to catch it if it comes in reach.
              if (resting) {
                  this.goalX = NaN;
                  this.tilt = 0.25 * this.face;
                  if (this.phaseT > 0.6) {
                      this.phase = 0;
                      this.phaseT = 0;
                      if (this.count >= (busy ? 5 : 2))
                          this.next(true);
                  }
                  return;
              }
              this.phaseT = 0;
              this.flyT += h;
              if (this.flyT < 0.4) {
                  // Watch it go, the arm still out after the throw.
                  this.goalX = NaN;
                  this.armR = true;
                  this.armK = 300;
                  this.armRx = this.x[NECK] + this.face * S * 0.24;
                  this.armRy = this.y[NECK] - S * 0.12;
                  return;
              }
              const ahead = clamp(cx + vx * 0.35, S * 0.3, this.w - S * 0.3);
              this.goalX = ahead;
              this.speed = busy ? 1.25 : 0.95;
              const hd = Math.hypot(this.x[HAND_R] - cx, this.y[HAND_R] - cy);
              if (this.catchIt && hd < S * 0.3 && this.flyT > 0.75 && vy > 0) {
                  this.hold(p, -1, tail);
                  this.phase = 2;
                  this.phaseT = 0;
                  this.glowV += 4;
                  return;
              }
              this.armR = cy < this.y[NECK];
              this.armRx = cx;
              this.armRy = cy;
              const dx = Math.abs(cx - this.x[HIP]);
              if (this.catchIt && this.flyT > 0.6 && this.grounded && dx < S * 0.5 && cy < this.y[HEAD] - S * 0.1 && cy > this.y[HEAD] - S * 1.4 && vy > -S) {
                  this.jump(clamp((cx - this.x[HIP]) * 4, -S * 4, S * 4), -Math.sqrt(2 * this.g * Math.max(S * 0.2, this.y[HEAD] - cy)));
              }
          }
      }
      // ---- Make a bot: dots on the floor put themselves together into a bot, live a moment, and fall apart.
      scatterDust(first) {
          const k = this.skin, S = this.S;
          for (let i = 0; i < k.n; i++) {
              if (first) {
                  this.dx[i] = this.w * (0.2 + this.rand() * 0.6);
                  this.dy[i] = this.floor - S * 0.03;
                  this.dvx[i] = 0;
                  this.dvy[i] = 0;
              }
              this.dk[i] = 0;
          }
          this.together = 0;
      }
      dustPos(i, out) {
          const k = this.skin, a = k.a[i], b = k.b[i], t = k.t[i];
          const xa = this.x[a], ya = this.y[a], xb = this.x[b], yb = this.y[b];
          let ex = xb - xa, ey = yb - ya;
          const el = Math.sqrt(ex * ex + ey * ey) + 1e-6;
          ex /= el;
          ey /= el;
          // along: (ex, ey); across: (-ey, ex) mirrored by the facing
          const f = this.face >= 0 ? 1 : -1;
          out[0] = xa + (xb - xa) * t + ex * k.u[i] - ey * k.w[i] * f;
          out[1] = ya + (yb - ya) * t + ey * k.u[i] + ex * k.w[i] * f;
      }
      dustStep(h) {
          const k = this.skin, S = this.S, g = this.g, fl = this.floor;
          let close = 0;
          for (let i = 0; i < k.n; i++) {
              let ax = 0, ay = g;
              const kk = this.dk[i];
              if (kk > 0) {
                  this.dustPos(i, this.tmp);
                  const tx = this.tmp[0], ty = this.tmp[1];
                  const ex = tx - this.dx[i], ey = ty - this.dy[i];
                  const c = 2 * Math.sqrt(kk) * 0.55;
                  ax = ex * kk - this.dvx[i] * c;
                  ay = ey * kk - this.dvy[i] * c + g * (1 - Math.min(1, kk / 400));
                  if (ex * ex + ey * ey < 0.36)
                      close++;
              }
              this.dvx[i] = this.dvx[i] + ax * h;
              this.dvy[i] = this.dvy[i] + ay * h;
              this.dx[i] = this.dx[i] + this.dvx[i] * h;
              this.dy[i] = this.dy[i] + this.dvy[i] * h;
              const r = S * 0.03;
              if (this.dy[i] > fl - r) {
                  this.dy[i] = fl - r;
                  if (this.dvy[i] > 0)
                      this.dvy[i] = -this.dvy[i] * 0.35;
                  this.dvx[i] = this.dvx[i] * 0.86;
              }
              if (this.dx[i] < 3) {
                  this.dx[i] = 3;
                  this.dvx[i] = Math.abs(this.dvx[i]) * 0.5;
              }
              if (this.dx[i] > this.w - 3) {
                  this.dx[i] = this.w - 3;
                  this.dvx[i] = -Math.abs(this.dvx[i]) * 0.5;
              }
          }
          this.together = k.n ? close / k.n : 1;
          // Whole once nearly every dot is home; then whole until he falls apart (a hop shakes the dots, not him).
          const want = this.phase === 2 && this.limp < 0.5 && (this.together > 0.85 || this.solid > 0.5) ? 1 : 0;
          this.solid += (want - this.solid) * Math.min(1, h * (want ? 7 : 14));
      }
      make(h) {
          const S = this.S, k = this.skin;
          if (this.phase === 0) {
              // Loose dots; now and then one hops, as if something stirs.
              this.limp = 1;
              this.goalX = NaN;
              if (this.rand() < h * 2.2) {
                  const i = Math.floor(this.rand() * k.n);
                  this.dvy[i] = -S * (2 + this.rand() * 3);
                  this.dvx[i] = (this.rand() - 0.5) * S * 2;
              }
              if (this.phaseT > 1.4 + this.rand() * 0.02 + (this.focusX === this.focusX ? 9 : 0)) {
                  // Stand the (unseen) skeleton up where most dots are, then pull them in from the feet up.
                  let mx = 0;
                  for (let i = 0; i < k.n; i++)
                      mx += this.dx[i];
                  mx = clamp(mx / Math.max(1, k.n), this.w * 0.25, this.w * 0.75);
                  this.standAt(mx);
                  this.limp = 0;
                  this.hue = (this.hue + 1) % PALETTE.length;
                  this.makeColor = PALETTE[this.hue];
                  for (let i = 0; i < k.n; i++) {
                      this.ddelay[i] = (k.lift[i] * 0.55 + this.rand() * 0.25);
                      this.dk[i] = 0;
                  }
                  this.phase = 1;
                  this.phaseT = 0;
              }
          }
          else if (this.phase === 1) {
              this.goalX = NaN;
              for (let i = 0; i < k.n; i++) {
                  const t = this.phaseT - this.ddelay[i];
                  this.dk[i] = t <= 0 ? 0 : Math.min(1, t / 0.25) * 650;
              }
              this.lookOut = 1;
              if (this.together > 0.9 || this.phaseT > 2.6) {
                  this.phase = 2;
                  this.phaseT = 0;
                  this.glowV += 9;
                  this.count = 0;
              }
          }
          else if (this.phase === 2) {
              // Alive: a look round, a wave, a hop or two.
              const t = this.phaseT;
              this.goalX = NaN;
              if (t < 1.0) {
                  this.lookOut = 1;
              }
              else if (t < 2.1) {
                  this.lookOut = 1;
                  this.armR = true;
                  this.armK = 380;
                  this.armRx = this.x[NECK] + S * (0.19 + 0.06 * Math.sign(Math.sin(t * 20)));
                  this.armRy = this.y[NECK] - S * 0.22;
              }
              else if (t < 3.6) {
                  this.lookX = this.w * 0.5 + Math.sin(t * 2) * this.w * 0.4;
                  this.lookY = this.floor * 0.5;
                  if (this.grounded && this.count < 2 && t > 2.4 + this.count * 0.55) {
                      this.count++;
                      this.jump((this.rand() - 0.5) * S * 2, -Math.sqrt(2 * this.g * S * 0.35));
                  }
              }
              else {
                  // Falling apart: the dots let go and spill.
                  for (let i = 0; i < k.n; i++) {
                      this.dk[i] = 0;
                      this.dvx[i] = this.dvx[i] + (this.rand() - 0.5) * S * 7;
                      this.dvy[i] = this.dvy[i] - this.rand() * S * 4;
                  }
                  this.limp = 1;
                  this.fabric.kick(this.x[HIP], this.floor - S * 0.2, 50, S * 2);
                  this.phase = 0;
                  this.phaseT = 0;
              }
          }
      }
      /** Put the skeleton upright with its hips over x (no velocity). */
      standAt(bx) {
          const dx = bx - this.x[HIP];
          const fl = this.floor, hipY = fl - this.lLeg * 0.92 - 0.03 * this.S;
          const dy = hipY - this.y[HIP];
          for (let i = 0; i < NBOT; i++) {
              this.x[i] = this.x[i] + dx;
              this.y[i] = this.y[i] + dy;
          }
          // Upright from the hip.
          const S = this.S;
          this.x[NECK] = bx;
          this.y[NECK] = hipY - this.lTorso;
          this.x[HEAD] = bx;
          this.y[HEAD] = this.y[NECK] - this.lNeck;
          this.x[FOOT_L] = bx - 0.065 * S;
          this.y[FOOT_L] = fl - this.rad[FOOT_L];
          this.x[FOOT_R] = bx + 0.065 * S;
          this.y[FOOT_R] = fl - this.rad[FOOT_R];
          this.x[ELB_L] = bx - 0.06 * S;
          this.y[ELB_L] = this.y[NECK] + this.lArm;
          this.x[HAND_L] = bx - 0.08 * S;
          this.y[HAND_L] = this.y[NECK] + 2 * this.lArm;
          this.x[ELB_R] = bx + 0.06 * S;
          this.y[ELB_R] = this.y[NECK] + this.lArm;
          this.x[HAND_R] = bx + 0.08 * S;
          this.y[HAND_R] = this.y[NECK] + 2 * this.lArm;
          const f = this.face >= 0 ? 1 : -1;
          let t = this.antTarget(bx, this.y[HEAD], 0, 0, f);
          this.x[ANT_A1] = t[0];
          this.y[ANT_A1] = t[1];
          this.x[ANT_A2] = t[0];
          this.y[ANT_A2] = t[1] - this.lAnt2;
          t = this.antTarget(bx, this.y[HEAD], 0, 1, f);
          this.x[ANT_B1] = t[0];
          this.y[ANT_B1] = t[1];
          this.x[ANT_B2] = t[0] + f * this.lAnt2 * 0.7;
          this.y[ANT_B2] = t[1] - this.lAnt2 * 0.7;
          for (let i = 0; i < NBOT; i++) {
              this.px[i] = this.x[i];
              this.py[i] = this.y[i];
          }
          this.grounded = 2;
      }
      // ------------------------------------------------------------------- Reduce Motion
      /**
       * A resting pose, and no motion: standing (needs: facing the person), or sitting (idle); props where they lie; the
       * fabric flat. Deterministic. After it, step() does nothing until settle(false).
       */
      settle(on = true) {
          if (!on) {
              this.still = false;
              return;
          }
          if (!this.placed)
              return;
          this.still = false;
          this.fabric.reset();
          const keepFocus = this.focusX;
          this.focusX = NaN;
          this.standAt(this.w * 0.3);
          if (this.kind === "make") {
              // Put together, in its first colour, looking out.
              this.limp = 0;
              this.makeColor = PALETTE[this.hue];
              for (let i = 0; i < this.skin.n; i++)
                  this.dk[i] = 650;
              this.phase = 2;
              this.solid = 1;
          }
          this.act = this.mood === "needs" ? A_NEEDS : this.mood === "idle" && this.kind !== "make" ? A_SIT : A_STAND;
          this.actT = 0;
          this.actDur = 1e9;
          this.cheerT = -1;
          for (let i = 0; i < 160; i++) {
              this.t += STEP;
              this.goalX = NaN;
              this.crouch = 0;
              this.sitTo(this.act === A_SIT ? 1 : 0, STEP);
              this.lookOut = 1;
              this.lean = 0;
              this.tilt = 0;
              this.armL = this.armR = false;
              this.blinkAt = 9;
              this.lidTo = this.act === A_SIT ? 0.35 : 0.08;
              this.forces(STEP);
              this.integrate(STEP);
              this.hit.fill(0, 0, this.n);
              for (let it = 0; it < 3; it++) {
                  this.solve();
                  this.collide();
              }
              this.contacts(STEP);
              this.faceStep(STEP);
              if (this.kind === "make")
                  this.dustStep(STEP);
          }
          for (let i = 0; i < this.n; i++) {
              this.px[i] = this.x[i];
              this.py[i] = this.y[i];
          }
          if (this.kind === "make")
              for (let i = 0; i < this.skin.n; i++) {
                  this.dustPos(i, this.tmp);
                  this.dx[i] = this.tmp[0];
                  this.dy[i] = this.tmp[1];
                  this.dvx[i] = 0;
                  this.dvy[i] = 0;
              }
          this.sparksClear();
          this.focusX = keepFocus;
          this.still = true;
      }
      sparksClear() { this.slife.fill(0); }
      // ------------------------------------------------------------------- read-outs (tests, tuning)
      /** Kinetic energy of every particle (px²/s², unit masses) plus the fabric's. */
      energy() {
          let e = 0;
          for (let i = 0; i < this.n; i++) {
              const vx = this.vx(i), vy = this.vy(i);
              e += vx * vx + vy * vy;
          }
          return e * 0.5 + this.fabric.energy();
      }
      finite() {
          for (let i = 0; i < this.n; i++)
              if (!Number.isFinite(this.x[i]) || !Number.isFinite(this.y[i]) || !Number.isFinite(this.px[i]) || !Number.isFinite(this.py[i]))
                  return false;
          for (let k = 0; k < this.fabric.n; k++)
              if (!Number.isFinite(this.fabric.ux[k]) || !Number.isFinite(this.fabric.uy[k]))
                  return false;
          for (let i = 0; i < this.skin.n; i++)
              if (!Number.isFinite(this.dx[i]) || !Number.isFinite(this.dy[i]))
                  return false;
          return Number.isFinite(this.ew) && Number.isFinite(this.eu) && Number.isFinite(this.lid);
      }
      /** Everything inside the tile (with the room a peek over the edge takes). */
      inside() {
          const m = this.S * 1.6;
          for (let i = 0; i < this.n; i++)
              if (this.x[i] < -m || this.x[i] > this.w + m || this.y[i] < -m || this.y[i] > this.floor + 1)
                  return false;
          return true;
      }
      /** Where the eye looks, in the head's own space (across, up), and the head's position. */
      gaze() {
          return { w: this.ew, u: this.eu, face: this.face, headX: this.x[HEAD], headY: this.y[HEAD], tilt: this.headAngle() };
      }
      // ------------------------------------------------------------------- drawing
      /** The whole tile at the tile's own coordinates (the caller scales for the screen and clips to the card). */
      draw(ctx, alpha = 1) {
          if (!this.placed)
              return;
          this.fabric.draw(ctx, alpha);
          // On the floor, his toys are behind him; up in the air (a glyph, the plane), in front.
          this.drawProps(ctx, alpha, 0);
          if (this.kind === "make")
              this.drawDust(ctx, alpha);
          else
              this.drawBot(ctx, alpha, this.color);
          this.drawProps(ctx, alpha, 1);
          this.drawSparks(ctx, alpha);
          ctx.globalAlpha = 1;
      }
      /**
       * Dots of the skin, in one path: from the skeleton (kinds a and b only), or where each loose dot is (free, all).
       */
      dots(ctx, free, ka, kb) {
          const k = this.skin, S = this.S, out = this.tmp;
          const rd = free ? S * 0.03 : S * 0.021;
          const eyeR = this.rH * 0.46 + rd * 1.6, e2 = eyeR * eyeR, f = this.face >= 0 ? 1 : -1;
          ctx.beginPath();
          for (let i = 0; i < k.n; i++) {
              let px, py;
              const kind = k.head[i];
              if (free) {
                  px = this.dx[i];
                  py = this.dy[i];
              }
              else {
                  if (kind !== ka && kind !== kb)
                      continue;
                  if (kind === 1) {
                      const du = k.u[i] - this.eu, dw = k.w[i] * f - this.ew;
                      if (du * du + dw * dw < e2)
                          continue;
                  }
                  this.dustPos(i, out);
                  px = out[0];
                  py = out[1];
              }
              ctx.moveTo(px + rd, py);
              ctx.arc(px, py, rd, 0, TAU);
          }
          ctx.fill();
      }
      /** The one great eye under its heavy lid, and the light on the bent antenna. */
      drawFace(ctx, alpha, col) {
          const x = this.x, y = this.y, S = this.S, r = this.rH;
          const ang = this.headAngle(), c = Math.cos(ang), s = Math.sin(ang);
          // head space to the screen: across (c, s), up (s, -c)
          const ew = this.ew, eu = this.eu;
          const ex = x[HEAD] + c * ew + s * eu, ey = y[HEAD] + s * ew - c * eu;
          const re = r * 0.46;
          ctx.globalAlpha = alpha;
          ctx.fillStyle = PAPER;
          ctx.beginPath();
          ctx.arc(ex, ey, re, 0, TAU);
          ctx.fill();
          // The pupil, toward where he looks.
          ctx.fillStyle = col;
          const pw = (this.ew - this.face * 0.22 * r) * 1.1, pu = (this.eu - 0.02 * r) * 1.1;
          ctx.beginPath();
          ctx.arc(ex + c * pw + s * pu, ey + s * pw - c * pu, re * 0.5, 0, TAU);
          ctx.fill();
          // The heavy lid: a chord across the top of the eye, as low as the lid is shut.
          if (this.lid > 0.02) {
              const yc = -re + 2 * re * this.lid;
              const phi = Math.asin(clamp(yc / re, -1, 1));
              ctx.beginPath();
              ctx.arc(ex, ey, re * 1.06, Math.PI - phi + ang, TAU + phi + ang);
              ctx.closePath();
              ctx.fill();
          }
          // The light on the bent antenna's tip: brighter when something happens, and while he works.
          const g = clamp(this.glow, 0, 1.5);
          const tipX = x[ANT_B2], tipY = y[ANT_B2];
          ctx.globalAlpha = alpha * (0.12 + 0.24 * g + (this.mood === "working" ? 0.1 : 0));
          ctx.beginPath();
          ctx.arc(tipX, tipY, S * (0.09 + 0.06 * g), 0, TAU);
          ctx.fill();
          ctx.globalAlpha = alpha;
          ctx.beginPath();
          ctx.arc(tipX, tipY, S * 0.048, 0, TAU);
          ctx.fill();
      }
      /** The bot: his solid figure in his colour, perforated with light dots, and his one great eye. */
      drawBot(ctx, alpha, col) {
          const x = this.x, y = this.y, S = this.S, r = this.rH;
          const f = this.face >= 0 ? 1 : -1;
          // The body's frame: up from the hips, and across.
          let ux = x[NECK] - x[HIP], uy = y[NECK] - y[HIP];
          const ul = Math.sqrt(ux * ux + uy * uy) + 1e-6;
          ux /= ul;
          uy /= ul;
          const wx = -uy, wy = ux;
          ctx.globalAlpha = alpha;
          ctx.fillStyle = col;
          ctx.strokeStyle = col;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          // Arms (behind the body): shoulder, elbow, hand.
          ctx.lineWidth = S * 0.065;
          ctx.beginPath();
          for (let s = 0; s < 2; s++) {
              const side = s ? 1 : -1, elb = s ? ELB_R : ELB_L, hand = s ? HAND_R : HAND_L;
              const sx = x[NECK] + wx * side * 0.11 * S - ux * 0.05 * S, sy = y[NECK] + wy * side * 0.11 * S - uy * 0.05 * S;
              ctx.moveTo(sx, sy);
              ctx.quadraticCurveTo(x[elb], y[elb], x[hand], y[hand]);
          }
          ctx.stroke();
          // Legs and feet.
          ctx.lineWidth = S * 0.075;
          ctx.beginPath();
          for (let s = 0; s < 2; s++) {
              const side = s ? 1 : -1, foot = s ? FOOT_R : FOOT_L;
              ctx.moveTo(x[HIP] + wx * side * 0.07 * S + ux * 0.02 * S, y[HIP] + wy * side * 0.07 * S + uy * 0.02 * S);
              ctx.lineTo(x[foot], y[foot]);
              ctx.moveTo(x[foot] - f * 0.035 * S, y[foot] + 0.005 * S);
              ctx.lineTo(x[foot] + f * 0.06 * S, y[foot] + 0.005 * S);
          }
          ctx.stroke();
          // The neck, and the antennae.
          ctx.lineWidth = S * 0.08;
          ctx.beginPath();
          ctx.moveTo(x[NECK], y[NECK]);
          ctx.lineTo(x[HEAD], y[HEAD]);
          ctx.stroke();
          ctx.lineWidth = S * 0.042;
          ctx.beginPath();
          const ang = this.headAngle(), c = Math.cos(ang), sn = Math.sin(ang);
          for (let s = 0; s < 2; s++) {
              const j1 = s ? ANT_B1 : ANT_A1, j2 = s ? ANT_B2 : ANT_A2;
              const bu = s ? this.baseB_u : this.baseA_u, bw = (s ? this.baseB_w : this.baseA_w) * f;
              ctx.moveTo(x[HEAD] + c * bw + sn * bu * 0.85, y[HEAD] + sn * bw - c * bu * 0.85);
              ctx.lineTo(x[j1], y[j1]);
              ctx.lineTo(x[j2], y[j2]);
          }
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(x[ANT_A2], y[ANT_A2], S * 0.04, 0, TAU);
          ctx.moveTo(x[HAND_L] + S * 0.042, y[HAND_L]);
          ctx.arc(x[HAND_L], y[HAND_L], S * 0.042, 0, TAU);
          ctx.moveTo(x[HAND_R] + S * 0.042, y[HAND_R]);
          ctx.arc(x[HAND_R], y[HAND_R], S * 0.042, 0, TAU);
          ctx.fill();
          // The body: a sack, wider at the bottom, its corners rounded.
          const tl = 0.135 * S, bl = 0.165 * S, rr = 0.05 * S;
          const ax = x[HIP] - wx * bl, ay = y[HIP] - wy * bl, bx = x[HIP] + wx * bl, by = y[HIP] + wy * bl;
          const cx = x[NECK] + wx * tl, cy = y[NECK] + wy * tl, dx = x[NECK] - wx * tl, dy = y[NECK] - wy * tl;
          ctx.beginPath();
          ctx.moveTo(ax + wx * rr, ay + wy * rr);
          ctx.lineTo(bx - wx * rr, by - wy * rr);
          ctx.quadraticCurveTo(bx, by, bx + ux * rr, by + uy * rr);
          ctx.lineTo(cx - ux * rr, cy - uy * rr);
          ctx.quadraticCurveTo(cx, cy, cx - wx * rr, cy - wy * rr);
          ctx.lineTo(dx + wx * rr, dy + wy * rr);
          ctx.quadraticCurveTo(dx, dy, dx - ux * rr, dy - uy * rr);
          ctx.lineTo(ax + ux * rr, ay + uy * rr);
          ctx.quadraticCurveTo(ax, ay, ax + wx * rr, ay + wy * rr);
          ctx.closePath();
          ctx.fill();
          // The head.
          ctx.beginPath();
          ctx.arc(x[HEAD], y[HEAD], r, 0, TAU);
          ctx.fill();
          // The perforations: light dots through the head and the body.
          ctx.fillStyle = PAPER;
          ctx.globalAlpha = alpha * 0.5;
          this.dots(ctx, null, 1, 2);
          this.drawFace(ctx, alpha, col);
      }
      /** Make a bot: loose dots (ink), or put together (his new colour), the solid figure fading in once he is whole. */
      drawDust(ctx, alpha) {
          const solid = this.solid;
          const col = this.phase === 1 || this.phase === 2 ? this.makeColor : INK;
          if (solid < 0.98) {
              ctx.fillStyle = col;
              ctx.globalAlpha = (col === INK ? 0.45 : 0.9) * alpha * (1 - solid);
              this.dots(ctx, this.dx, 0, 0);
          }
          if (solid > 0.02)
              this.drawBot(ctx, alpha * solid, this.makeColor);
      }
      /** layer 0: the props on the floor (behind him); 1: those in the air, and the plane (in front). */
      drawProps(ctx, alpha, layer) {
          const col = this.color, S = this.S, x = this.x, y = this.y;
          ctx.fillStyle = col;
          ctx.strokeStyle = col;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          for (let p = 0; p < this.np; p++) {
              const a = this.p0[p], kind = this.pk[p];
              const up = kind === P_PLANE || ((kind === P_ZERO || kind === P_ONE || kind === P_BALL) && y[a] < this.floor - this.pr[p] * 2.2 - S * 0.12);
              if ((up ? 1 : 0) !== layer)
                  continue;
              // Behind the words: fainter.
              const low = y[a] > this.floor + 1 ? 0.4 : 1;
              if (kind === P_ONE || kind === P_ZERO) {
                  const ax0 = x[a], ay0 = y[a], bx = x[a + 1], by = y[a + 1];
                  let ex = bx - ax0, ey = by - ay0;
                  const el = Math.sqrt(ex * ex + ey * ey) + 1e-6;
                  ex /= el;
                  ey /= el;
                  ctx.globalAlpha = 0.62 * alpha * low;
                  ctx.lineWidth = S * 0.055;
                  ctx.beginPath();
                  if (kind === P_ONE) {
                      // "1": the stroke, and its little flag at the top end.
                      ctx.moveTo(bx - ex * el * 0.3 + ey * el * 0.28, by - ey * el * 0.3 - ex * el * 0.28);
                      ctx.lineTo(bx, by);
                      ctx.lineTo(ax0, ay0);
                      ctx.moveTo(ax0 + ey * el * 0.22, ay0 - ex * el * 0.22);
                      ctx.lineTo(ax0 - ey * el * 0.22, ay0 + ex * el * 0.22);
                  }
                  else {
                      // "0": an oval along the capsule.
                      const cx = (ax0 + bx) / 2, cy = (ay0 + by) / 2;
                      const ra = el / 2 + this.pr[p] * 0.55, rb = this.pr[p] * 0.78;
                      for (let k = 0; k <= 12; k++) {
                          const t = (k / 12) * TAU, ca = Math.cos(t) * ra, sb = Math.sin(t) * rb;
                          const qx = cx + ex * ca - ey * sb, qy = cy + ey * ca + ex * sb;
                          if (k === 0)
                              ctx.moveTo(qx, qy);
                          else
                              ctx.lineTo(qx, qy);
                      }
                      ctx.closePath();
                  }
                  ctx.stroke();
              }
              else if (kind === P_BALL) {
                  ctx.globalAlpha = 0.3 * alpha * low;
                  ctx.beginPath();
                  ctx.arc(x[a], y[a], this.pr[p], 0, TAU);
                  ctx.fill();
                  ctx.globalAlpha = 0.65 * alpha * low;
                  ctx.lineWidth = S * 0.04;
                  ctx.beginPath();
                  ctx.arc(x[a], y[a], this.pr[p], 0, TAU);
                  ctx.stroke();
              }
              else if (kind === P_KEY) {
                  const x0 = x[a], y0 = y[a], x1 = x[a + 1], y1 = y[a + 1], base = this.floor;
                  const lit = clamp(1 - (this.t - this.ptime[p]) * 2.5, 0, 1);
                  const rr = S * 0.05;
                  ctx.globalAlpha = (0.1 + 0.3 * lit) * alpha;
                  this.roundQuad(ctx, x0, y0, x1, y1, base, rr);
                  ctx.fill();
                  ctx.globalAlpha = 0.6 * alpha;
                  ctx.lineWidth = S * 0.035;
                  this.roundQuad(ctx, x0, y0, x1, y1, base, rr);
                  ctx.stroke();
                  // Its legend: a short mark on the cap.
                  ctx.lineWidth = S * 0.04;
                  ctx.beginPath();
                  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2 + (base - (y0 + y1) / 2) * 0.45;
                  ctx.moveTo(mx - S * 0.06, my);
                  ctx.lineTo(mx + S * 0.06, my);
                  ctx.stroke();
              }
              else if (kind === P_DAY) {
                  ctx.globalAlpha = 0.1 * alpha * low;
                  ctx.beginPath();
                  ctx.moveTo(x[a], y[a]);
                  ctx.lineTo(x[a + 1], y[a + 1]);
                  ctx.lineTo(x[a + 2], y[a + 2]);
                  ctx.lineTo(x[a + 3], y[a + 3]);
                  ctx.closePath();
                  ctx.fill();
                  ctx.globalAlpha = 0.62 * alpha * low;
                  ctx.lineWidth = S * 0.035;
                  ctx.stroke();
                  // The calendar's band across the top, and the day's dot.
                  const t = 0.32;
                  const lx = x[a] + (x[a + 3] - x[a]) * t, ly = y[a] + (y[a + 3] - y[a]) * t;
                  const rx = x[a + 1] + (x[a + 2] - x[a + 1]) * t, ry = y[a + 1] + (y[a + 2] - y[a + 1]) * t;
                  ctx.globalAlpha = 0.45 * alpha * low;
                  ctx.beginPath();
                  ctx.moveTo(x[a], y[a]);
                  ctx.lineTo(x[a + 1], y[a + 1]);
                  ctx.lineTo(rx, ry);
                  ctx.lineTo(lx, ly);
                  ctx.closePath();
                  ctx.fill();
                  const cx = (x[a] + x[a + 1] + x[a + 2] + x[a + 3]) / 4, cy = (y[a] + y[a + 1] + y[a + 2] + y[a + 3]) / 4;
                  ctx.globalAlpha = 0.7 * alpha * low;
                  ctx.beginPath();
                  ctx.arc(cx + (lx + rx - 2 * cx) * -0.12, cy + (ly + ry - 2 * cy) * -0.12, S * 0.03, 0, TAU);
                  ctx.fill();
              }
              else if (kind === P_PLANE) {
                  const nx = x[a], ny = y[a], tx = x[a + 1], ty = y[a + 1], kx = x[a + 2], ky = y[a + 2];
                  // The wing (nose, tail, a point above the fold) and the keel below it.
                  const mx = (nx + tx) / 2, my = (ny + ty) / 2;
                  const wx = mx + (mx - kx) * 0.55 + (tx - nx) * 0.18, wy = my + (my - ky) * 0.55 + (ty - ny) * 0.18;
                  ctx.globalAlpha = 0.22 * alpha * low;
                  ctx.beginPath();
                  ctx.moveTo(nx, ny);
                  ctx.lineTo(wx, wy);
                  ctx.lineTo(tx, ty);
                  ctx.closePath();
                  ctx.fill();
                  ctx.globalAlpha = 0.65 * alpha * low;
                  ctx.lineWidth = S * 0.03;
                  ctx.stroke();
                  ctx.beginPath();
                  ctx.moveTo(nx, ny);
                  ctx.lineTo(kx, ky);
                  ctx.lineTo(tx, ty);
                  ctx.stroke();
              }
          }
      }
      roundQuad(ctx, x0, y0, x1, y1, base, r) {
          ctx.beginPath();
          ctx.moveTo(x0 + r, y0 + (y1 - y0) * (r / (x1 - x0)));
          ctx.lineTo(x1 - r, y1 - (y1 - y0) * (r / (x1 - x0)));
          ctx.quadraticCurveTo(x1, y1, x1, y1 + r);
          ctx.lineTo(x1, base);
          ctx.lineTo(x0, base);
          ctx.lineTo(x0, y0 + r);
          ctx.quadraticCurveTo(x0, y0, x0 + r, y0 + (y1 - y0) * (r / (x1 - x0)));
          ctx.closePath();
      }
      drawSparks(ctx, alpha) {
          const S = this.S;
          ctx.fillStyle = this.kind === "make" ? this.makeColor : this.color;
          for (let i = 0; i < SPARKS; i++) {
              const l = this.slife[i];
              if (l <= 0)
                  continue;
              ctx.globalAlpha = alpha * clamp(l, 0, 1) * 0.7;
              ctx.beginPath();
              ctx.arc(this.sx[i], this.sy[i], S * (0.035 + 0.02 * l), 0, TAU);
              ctx.fill();
          }
      }
  }
  // ===================================================================== the grid
  /**
   * The tiles of one grid, in one space (the grid's own coordinates), so that a tap on one makes every other bot turn
   * its head to it.
   */
  class BotTilesWorld {
      constructor() {
          this.tiles = [];
          this.rx = [];
          this.ry = [];
          this.rw = [];
          this.rh = [];
          this.focused = -1;
      }
      add(tile) {
          this.tiles.push(tile);
          this.rx.push(0);
          this.ry.push(0);
          this.rw.push(0);
          this.rh.push(0);
          return this.tiles.length - 1;
      }
      /** Where tile i is in the grid, and where its words start (from its top). */
      place(i, x, y, w, h, floor) {
          this.rx[i] = x;
          this.ry[i] = y;
          this.rw[i] = w;
          this.rh[i] = h;
          this.tiles[i].resize(w, h, floor);
      }
      /** Tile i was tapped at (px, py) in its own space: it perks up, and every other bot looks at it. */
      focus(i, px, py) {
          this.focused = i;
          const cx = this.rx[i] + this.rw[i] / 2, cy = this.ry[i] + this.rh[i] / 2;
          for (let j = 0; j < this.tiles.length; j++) {
              const t = this.tiles[j];
              if (j === i) {
                  t.press(px ?? this.rw[i] / 2, py ?? this.rh[i] / 2);
                  continue;
              }
              t.lookAt(cx - this.rx[j], cy - this.ry[j]);
          }
      }
      release() {
          this.focused = -1;
          for (const t of this.tiles)
              t.lookAway();
      }
      step(dt) {
          for (const t of this.tiles)
              t.step(dt);
      }
      settle(on = true) {
          for (const t of this.tiles)
              t.settle(on);
      }
  }
  return { TAP, STEP, MAX_FRAME, PALETTE, INK, kindOf, rng, Fabric, BotTile, BotTilesWorld };
});
