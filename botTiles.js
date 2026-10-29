// GENERATED: do not edit. The living bot tiles' physics and drawing, shared with the phone.
// Source: TAILZU-FRONTEND/app/src/botTiles/core.ts; regenerate with `node src/botTiles/genDesktop.mjs` there.
// core.ts sha256 5937b9d3c8cd77b4bb83bf8a4c04554bf2587e5b94a4b7f654cac235656891b3
// body sha256 8433a0bc94ff76c0d0bfa8150a968515fcc3029407f8fe654c6839da604d8007
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
   *   BotTile        one tile: a bot (13 particles), its props (<= 8 bodies), its fabric (14 x 9 points). On his own pages
   *                  (BotBuddy) the same bot has moments (BuddyAct); carrying, his stage is a chat's lane and his only prop
   *                  is a bag he hauls across, heavier each trip (CARRY, carrying()), until deliver() says the answer is here.
   *   BotTilesWorld  the tiles of one grid, laid out in one space, so every other bot can look at a tapped one.
   *   LiveMark       the Tailzu dot mark, alive (Home's header): its ring dots on springs, its eyes on the finger.
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
  /**
   * The carry act's knobs. A trip is a wait off stage, then the walk across; the load grows a step a trip and stops
   * growing at `trips` (the heaviest look is kept from then on). Times are on the act's own clock (BotTile.carryPace
   * runs it faster or slower); paces are in the bot's own heights a second.
   */
  const CARRY = {
      trips: 6,
      firstWait: 1.2,
      wait: 0.9,
      paceLight: 3.4,
      paceHeavy: 1.9,
      /** The bag: radius and mass, light to heaviest (radius in the bot's heights). */
      bagLight: 0.115,
      bagHeavy: 0.19,
      massLight: 0.3,
      massHeavy: 1.3,
      /** From this load on, a sweat drop now and then. */
      sweatFrom: 0.6,
  };
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
      return slug === "code" || slug === "keybot" || slug === "plan" || slug === "travel" || slug === "notes" || slug === "make" ? slug : "custom";
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
  // ===================================================================== looks and moments: data from the server
  /*
   * WHAT A BOT LOOKS LIKE AND WHAT HE DOES, AS DATA (the server's catalog: TAILZU-BACKEND tulmi/src/experience/bots/looks,
   * docs/bots-app.md "Looks and moments"). The apps carry a starter copy (starter.ts, generated from it) and keep the
   * server's newest.
   *
   *   Avatar   a bot's look from parts: his head's shape and size, his eyes, mouth, antennae, ears, the dots through him,
   *            his colours, and what he wears (small vector parts on an anchor). Today's kinds are avatars too (each kind
   *            wears the catalog's own, all of them Blip's look now), so a new look for any of them is a push.
   *   Moment   what he does, as tracks over time (a recipe): goals for his body (walk, hop, sit, crouch, lean, spin,
   *            shake, a kick), targets for his hands, where he looks, his eyes and mouth, props on him, particles he
   *            throws off, ripples in the fabric, what the bots near him do, named sounds. One interpreter plays every
   *            recipe through the same physics as the rest: a track sets a goal or a force, never a pose.
   *   Part     a small drawing (paths and circles, in bot heights) that avatars wear and moments throw.
   *
   * compileLooks() turns the catalog into these once (expressions into bytecode, paths into numbers): a frame never
   * parses or allocates. What this core does not know makes that avatar or moment unusable (the default look, or the
   * moment's plain act), never a crash.
   */
  /** The looks format this core draws and plays; a catalog or a recipe that says a higher one is not played. */
  const LOOKS_FORMAT = 1;
  // ---- the expression language (the mic program's, motionLang.ts on the server: same grammar, numbers only)
  /** The names an expression may read. t: seconds into the track; u: 0 to 1 through it; T: seconds into the moment; D: the track's length; beat: beats (bpm); k: loops so far; side: 1 facing right, -1 left; rnd, rnd2: random per play; W: the stage's width; x: his hips from its left; px: the other bot ahead of him (bot heights, 0: none). */
  const MOMENT_VARS = ["t", "u", "T", "D", "beat", "k", "side", "rnd", "rnd2", "W", "x", "px"];
  const XCONST = { pi: Math.PI, tau: TAU, e: Math.E };
  /** Built-ins: [id, fewest arguments, most]. motionLang's, and sign, tri (a triangle wave, period 1), hash (0 to 1 from n). */
  const XFUNC = {
      sin: [0, 1, 1], cos: [1, 1, 1], tan: [2, 1, 1], abs: [3, 1, 1], sqrt: [4, 1, 1], floor: [5, 1, 1], ceil: [6, 1, 1], round: [7, 1, 1],
      exp: [8, 1, 1], log: [9, 1, 1], atan2: [10, 2, 2], min: [11, 1, 8], max: [12, 1, 8], pow: [13, 2, 2], hypot: [14, 1, 8],
      clamp: [15, 3, 3], smooth: [16, 3, 3], lerp: [17, 3, 3], crest: [18, 1, 1], ramp: [19, 3, 4], run: [20, 5, 5], noise: [21, 1, 1],
      sign: [22, 1, 1], tri: [23, 1, 1], hash: [24, 1, 1],
  };
  const MOMENT_FUNCS = Object.keys(XFUNC);
  const XBIN = ["+", "-", "*", "/", "%", "^", "<", "<=", ">", ">=", "==", "!=", "&&", "||"];
  const XO_NUM = 1, XO_VAR = 2, XO_NEG = 3, XO_NOT = 4, XO_BIN = 5, XO_TERN = 6, XO_CALL = 7;
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const XP0 = { c: 0, code: null };
  /** Expression text into bytecode (a constant when it reads no name). Throws on anything it does not know. */
  function xcompile(src) {
      const toks = [];
      for (let i = 0; i < src.length;) {
          const ch = src.charCodeAt(i);
          if (ch === 32 || ch === 9 || ch === 10 || ch === 13) {
              i++;
              continue;
          }
          const dig = (k) => { const c = src.charCodeAt(k); return c >= 48 && c <= 57; };
          if (dig(i)) {
              let j = i;
              while (j < src.length && dig(j))
                  j++;
              if (src[j] === ".") {
                  j++;
                  while (j < src.length && dig(j))
                      j++;
              }
              if (src[j] === "e" || src[j] === "E") {
                  let k = j + 1;
                  if (src[k] === "+" || src[k] === "-")
                      k++;
                  if (dig(k)) {
                      j = k;
                      while (j < src.length && dig(j))
                          j++;
                  }
              }
              toks.push({ t: 0, v: "", n: parseFloat(src.slice(i, j)) });
              i = j;
              continue;
          }
          if ((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 95) {
              let j = i + 1;
              while (j < src.length && /[A-Za-z0-9_.]/.test(src[j]))
                  j++;
              toks.push({ t: 1, v: src.slice(i, j), n: 0 });
              i = j;
              continue;
          }
          const two = src.slice(i, i + 2);
          if (two === "||" || two === "&&" || two === "==" || two === "!=" || two === "<=" || two === ">=") {
              toks.push({ t: 2, v: two, n: 0 });
              i += 2;
              continue;
          }
          if ("-+*/%^<>!?:(),".indexOf(src[i]) >= 0) {
              toks.push({ t: 2, v: src[i], n: 0 });
              i++;
              continue;
          }
          throw new Error(`bad character "${src[i]}"`);
      }
      const code = [];
      let pos = 0, depth = 0, deepest = 0, reads = false;
      const push = () => { depth++; if (depth > deepest)
          deepest = depth; };
      const isOp = (v) => pos < toks.length && toks[pos].t === 2 && toks[pos].v === v;
      const take = (v) => { if (!isOp(v))
          throw new Error(`expected "${v}"`); pos++; };
      const bin = (op) => { code.push(XO_BIN, XBIN.indexOf(op)); depth--; };
      const ternary = () => { or(); if (isOp("?")) {
          pos++;
          ternary();
          take(":");
          ternary();
          code.push(XO_TERN);
          depth -= 2;
      } };
      const or = () => { and(); while (isOp("||")) {
          pos++;
          and();
          bin("||");
      } };
      const and = () => { eq(); while (isOp("&&")) {
          pos++;
          eq();
          bin("&&");
      } };
      const eq = () => { rel(); while (isOp("==") || isOp("!=")) {
          const o = toks[pos++].v;
          rel();
          bin(o);
      } };
      const rel = () => { add(); while (isOp("<") || isOp("<=") || isOp(">") || isOp(">=")) {
          const o = toks[pos++].v;
          add();
          bin(o);
      } };
      const add = () => { mul(); while (isOp("+") || isOp("-")) {
          const o = toks[pos++].v;
          mul();
          bin(o);
      } };
      const mul = () => { unary(); while (isOp("*") || isOp("/") || isOp("%")) {
          const o = toks[pos++].v;
          unary();
          bin(o);
      } };
      const unary = () => {
          if (isOp("-")) {
              pos++;
              unary();
              code.push(XO_NEG);
              return;
          }
          if (isOp("!")) {
              pos++;
              unary();
              code.push(XO_NOT);
              return;
          }
          power();
      };
      const power = () => { primary(); if (isOp("^")) {
          pos++;
          unary();
          bin("^");
      } };
      const primary = () => {
          const k = toks[pos];
          if (!k)
              throw new Error("unexpected end");
          if (k.t === 0) {
              pos++;
              code.push(XO_NUM, k.n);
              push();
              return;
          }
          if (k.t === 1) {
              pos++;
              if (isOp("(")) {
                  pos++;
                  const f = own(XFUNC, k.v) ? XFUNC[k.v] : null;
                  if (!f)
                      throw new Error(`unknown function ${k.v}`);
                  let n = 0;
                  if (!isOp(")")) {
                      ternary();
                      n++;
                      while (isOp(",")) {
                          pos++;
                          ternary();
                          n++;
                      }
                  }
                  take(")");
                  if (n < f[1] || n > f[2])
                      throw new Error(`${k.v} takes ${f[1] === f[2] ? f[1] : `${f[1]} to ${f[2]}`} arguments`);
                  code.push(XO_CALL, f[0], n);
                  depth -= n - 1;
                  return;
              }
              if (own(XCONST, k.v)) {
                  code.push(XO_NUM, XCONST[k.v]);
                  push();
                  return;
              }
              const vi = MOMENT_VARS.indexOf(k.v);
              if (vi < 0)
                  throw new Error(`unknown name ${k.v}`);
              code.push(XO_VAR, vi);
              reads = true;
              push();
              return;
          }
          if (isOp("(")) {
              pos++;
              ternary();
              take(")");
              return;
          }
          throw new Error(`unexpected "${k.v}"`);
      };
      ternary();
      if (pos < toks.length)
          throw new Error(`unexpected "${toks[pos].v}"`);
      if (deepest > 48)
          throw new Error("too deep");
      const bc = Float64Array.from(code);
      return reads ? { c: 0, code: bc } : { c: xrun(bc, XVARS0), code: null };
  }
  const XSTACK = new Float64Array(64);
  const XVARS0 = new Float64Array(MOMENT_VARS.length);
  function xbin(op, a, b) {
      switch (op) {
          case 0: return a + b;
          case 1: return a - b;
          case 2: return a * b;
          case 3: return b === 0 ? 0 : a / b;
          case 4: return b === 0 ? 0 : a - Math.floor(a / b) * b;
          case 5: return Math.pow(a, b);
          case 6: return a < b ? 1 : 0;
          case 7: return a <= b ? 1 : 0;
          case 8: return a > b ? 1 : 0;
          case 9: return a >= b ? 1 : 0;
          case 10: return a === b ? 1 : 0;
          case 11: return a !== b ? 1 : 0;
          case 12: return a && b ? 1 : 0;
          default: return a || b ? 1 : 0;
      }
  }
  function xcall(f, s, at, n) {
      const a = s[at], b = s[at + 1], c = s[at + 2];
      switch (f) {
          case 0: return Math.sin(a);
          case 1: return Math.cos(a);
          case 2: return Math.tan(a);
          case 3: return Math.abs(a);
          case 4: return a < 0 ? 0 : Math.sqrt(a);
          case 5: return Math.floor(a);
          case 6: return Math.ceil(a);
          case 7: return Math.round(a);
          case 8: return Math.exp(a);
          case 9: return a > 0 ? Math.log(a) : 0;
          case 10: return Math.atan2(a, b);
          case 11: {
              let m = a;
              for (let i = 1; i < n; i++)
                  if (s[at + i] < m)
                      m = s[at + i];
              return m;
          }
          case 12: {
              let m = a;
              for (let i = 1; i < n; i++)
                  if (s[at + i] > m)
                      m = s[at + i];
              return m;
          }
          case 13: return a < 0 && b !== Math.floor(b) ? 0 : Math.pow(a, b);
          case 14: {
              let q = 0;
              for (let i = 0; i < n; i++)
                  q += s[at + i] * s[at + i];
              return Math.sqrt(q);
          }
          case 15: return a < b ? b : a > c ? c : a;
          case 16: {
              const w = b === a ? (c >= b ? 1 : 0) : Math.min(1, Math.max(0, (c - a) / (b - a)));
              return w * w * (3 - 2 * w);
          }
          case 17: return a + (b - a) * c;
          case 18: {
              const q = Math.sin(a);
              return q > 0 ? Math.pow(q, 1.6) : 0;
          }
          case 19: {
              const e = (n > 3 ? s[at + 3] : 0) || 0.06;
              return a < b ? 0 : a < b + e ? (a - b) / e : a < b + c ? 1 : a < b + c + e ? 1 - (a - b - c) / e : 0;
          }
          case 20: {
              const w = s[at + 4], u = (b - c) / s[at + 3];
              if (!(u >= 0 && u <= 1))
                  return 0;
              const half = w / 2, mid = u * (1 + w) - half, q = Math.abs(a - mid) / half;
              return q >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * q);
          }
          case 21: return Math.sin(a * 1.7) * Math.sin(a * 0.61 + 2.1);
          case 22: return a > 0 ? 1 : a < 0 ? -1 : 0;
          case 23: {
              const q = a - Math.floor(a);
              return q < 0.25 ? 4 * q : q < 0.75 ? 2 - 4 * q : 4 * q - 4;
          }
          default: return hash01(a);
      }
  }
  /** Run bytecode on the names (MOMENT_VARS order). Anything not finite is 0. No allocation. */
  function xrun(code, vars) {
      const s = XSTACK, n = code.length;
      let sp = 0, i = 0;
      while (i < n) {
          const op = code[i];
          if (op === XO_NUM) {
              s[sp++] = code[i + 1];
              i += 2;
          }
          else if (op === XO_VAR) {
              s[sp++] = vars[code[i + 1]];
              i += 2;
          }
          else if (op === XO_BIN) {
              const b = s[--sp];
              s[sp - 1] = xbin(code[i + 1], s[sp - 1], b);
              i += 2;
          }
          else if (op === XO_NEG) {
              s[sp - 1] = -s[sp - 1];
              i++;
          }
          else if (op === XO_NOT) {
              s[sp - 1] = s[sp - 1] ? 0 : 1;
              i++;
          }
          else if (op === XO_TERN) {
              const b = s[--sp], a = s[--sp];
              s[sp - 1] = s[sp - 1] ? a : b;
              i++;
          }
          else {
              const argc = code[i + 2];
              sp -= argc;
              s[sp] = xcall(code[i + 1], s, sp, argc);
              sp++;
              i += 3;
          }
          if (s[sp - 1] - s[sp - 1] !== 0)
              s[sp - 1] = 0;
      }
      return s[0];
  }
  /** Check an expression the way a recipe's would be compiled (the server's checks and tests use this). */
  function checkExpression(src) {
      try {
          xcompile(src);
          return "";
      }
      catch (e) {
          return e.message;
      }
  }
  // ---- parts: small drawings in bot heights
  const PO_SHAPE = 1, PO_M = 2, PO_L = 3, PO_Q = 4, PO_Z = 5, PO_O = 6, PO_END = 7;
  /** A part, compiled: its drawing as numbers, and the paints it names. */
  class Part {
      constructor(id, ops, paints) { this.id = id; this.ops = ops; this.paints = paints; }
  }
  const PAINT_RE = /^#[0-9a-fA-F]{6}$/;
  const okPaint = (p, any = false) => typeof p === "string" && (PAINT_RE.test(p) || p === "$color" || p === "$paint" || p === "ink" || p === "paper" || (any && p === "$any"));
  function compilePart(id, spec, errs) {
      const at = `parts.${id}`;
      const sp = spec;
      if (!sp || typeof sp !== "object" || !Array.isArray(sp.draw) || !sp.draw.length || sp.draw.length > 12) {
          errs.push(`${at}: draw is a list of 1 to 12 shapes`);
          return null;
      }
      for (const k of Object.keys(sp))
          if (k !== "draw" && k !== "note") {
              errs.push(`${at}: unknown field ${k}`);
              return null;
          }
      const ops = [], paints = [];
      const pi = (p, where) => {
          if (p == null)
              return -1;
          if (!okPaint(p)) {
              errs.push(`${where}: bad paint ${String(p)}`);
              return -1;
          }
          let i = paints.indexOf(p);
          if (i < 0) {
              paints.push(p);
              i = paints.length - 1;
          }
          return i;
      };
      const n0 = errs.length;
      sp.draw.forEach((sh, si) => {
          const w = `${at}.draw[${si}]`;
          if (!sh || typeof sh !== "object" || typeof sh.d !== "string") {
              errs.push(`${w}: d is the path`);
              return;
          }
          for (const k of Object.keys(sh))
              if (!["d", "fill", "stroke", "width", "alpha"].includes(k))
                  errs.push(`${w}: unknown field ${k}`);
          if (sh.fill == null && sh.stroke == null)
              errs.push(`${w}: a fill or a stroke`);
          const width = sh.width ?? 0.03, alpha = sh.alpha ?? 1;
          if (typeof width !== "number" || !(width > 0 && width <= 0.3))
              errs.push(`${w}: width in (0, 0.3]`);
          if (typeof alpha !== "number" || !(alpha >= 0 && alpha <= 1))
              errs.push(`${w}: alpha in [0, 1]`);
          ops.push(PO_SHAPE, pi(sh.fill, w), pi(sh.stroke, w), Number(width) || 0.03, Number(alpha));
          const toks = sh.d.replace(/([MLQZO])/g, " $1 ").trim().split(/[\s,]+/).filter((x) => x !== "");
          let i = 0;
          const num = () => {
              const v = Number(toks[i++]);
              if (!Number.isFinite(v) || Math.abs(v) > 3) {
                  errs.push(`${w}: a number in [-3, 3] at "${toks[i - 1] ?? "end"}"`);
                  return 0;
              }
              return v;
          };
          let first = true;
          while (i < toks.length) {
              const c = toks[i++];
              if (c === "M")
                  ops.push(PO_M, num(), num());
              else if (c === "L" && !first)
                  ops.push(PO_L, num(), num());
              else if (c === "Q" && !first)
                  ops.push(PO_Q, num(), num(), num(), num());
              else if (c === "Z" && !first)
                  ops.push(PO_Z);
              else if (c === "O")
                  ops.push(PO_O, num(), num(), num());
              else {
                  errs.push(`${w}: "${c}" (paths are M, L, Q, Z and O, starting with M or O)`);
                  break;
              }
              first = false;
          }
          ops.push(PO_END);
      });
      if (ops.length > 900)
          errs.push(`${at}: too big`);
      return errs.length > n0 ? null : new Part(id, Float64Array.from(ops), paints);
  }
  // ---- avatars
  const HEAD_SHAPES = ["round", "oval", "square"];
  const EYE_STYLES = ["one", "two", "dots", "visor", "none"];
  const MOUTH_STYLES = ["none", "line", "smile", "o", "open"];
  const EAR_STYLES = ["none", "round", "bolt", "point"];
  const DOT_PATTERNS = ["hex", "grid", "none"];
  const TIP_KINDS = ["none", "ball", "light", "star"];
  const ANCHORS = ["head", "crown", "face", "mouth", "neck", "body", "hip", "hand_l", "hand_r", "hand_front", "hand_back", "foot_l", "foot_r", "ground"];
  const AN_HEAD = 0, AN_CROWN = 1, AN_FACE = 2, AN_MOUTH = 3, AN_NECK = 4, AN_BODY = 5, AN_HIP = 6, AN_HAND_L = 7, AN_HAND_R = 8, AN_HAND_F = 9, AN_HAND_B = 10, AN_FOOT_L = 11, AN_FOOT_R = 12, AN_GROUND = 13;
  /** Something worn: a part on an anchor (offset forward and down in bot heights, scaled, turned), in front or behind him. */
  class Wear {
      constructor(part, on, x, y, scale, rot, paint, back) {
          this.part = part;
          this.on = on;
          this.x = x;
          this.y = y;
          this.scale = scale;
          this.rot = rot;
          this.paint = paint;
          this.back = back;
      }
  }
  /** A look, compiled. Every default is Blip's, exactly as he was drawn before looks were data. */
  class Avatar {
      constructor() {
          this.id = "blip";
          this.label = "";
          this.head = 0;
          this.headR = 0.2;
          this.headW = 1;
          this.headH = 1;
          this.headRound = 0.35;
          this.eyes = 0;
          this.eyeR = 0.46;
          this.eyeGap = 0.36;
          this.pupil = 0.5;
          this.eyeY = 0.02;
          this.mouth = 0;
          this.mouthW = 0.3;
          this.mouthY = -0.6;
          this.antN = 2;
          this.antAt = [-0.4, 0.42];
          this.antUp = [0.9, 0.9];
          this.antLean = [-0.14, 0.32];
          this.antLen = [0.12, 0.12];
          this.antTipLen = [0.09, 0.09];
          this.antBend = [0, 0.95];
          this.antTip = [1, 2];
          this.antTipR = [0.04, 0.048];
          this.ears = 0;
          this.earR = 0.28;
          this.dots = 0;
          this.dotSp = 0.062;
          this.dotR = 0.021;
          this.dotA = 0.5;
          this.bodyTop = 0.135;
          this.bodyBottom = 0.165;
          this.bodyRound = 0.05;
          this.arm = 0.065;
          this.leg = 0.075;
          this.neck = 0.08;
          this.hand = 0.042;
          this.antW = 0.042;
          /** The carrying hand's size over the hand's (1 for Blip: S * 0.045). */
          this.handK = 1;
          this.pBody = "$color";
          this.pDots = "paper";
          this.pEye = "paper";
          this.pPupil = "$color";
          this.pMouth = "paper";
          this.pLight = "$color";
          this.pEars = "$color";
          this.wear = [];
          this.wearBack = false;
          this.wearFront = false;
          /** Which antenna carries the light (-1: none). */
          this.light = 1;
      }
  }
  /** Blip, as every bot looked before looks were data: what a tile wears when nothing says otherwise. */
  const BLIP = new Avatar();
  const isRec = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  /** An avatar from its spec (already merged with what it extends); `errs` collects what is wrong with it. */
  function buildAvatar(id, sp, parts, errs) {
      const a = new Avatar();
      a.id = id;
      const at = `avatars.${id}`;
      const known = ["extends", "label", "note", "head", "eyes", "mouth", "antennae", "ears", "dots", "body", "limbs", "paint", "wear"];
      for (const k of Object.keys(sp))
          if (!known.includes(k))
              errs.push(`${at}: unknown field ${k}`);
      const sub = (k, fields) => {
          const v = sp[k];
          if (v == null)
              return {};
          if (!isRec(v)) {
              errs.push(`${at}.${k}: an object`);
              return {};
          }
          for (const f of Object.keys(v))
              if (!fields.includes(f))
                  errs.push(`${at}.${k}: unknown field ${f}`);
          return v;
      };
      const num = (o, k, lo, hi, def, where) => {
          const v = o[k];
          if (v == null)
              return def;
          if (typeof v !== "number" || !(v >= lo && v <= hi)) {
              errs.push(`${where}.${k}: a number in [${lo}, ${hi}]`);
              return def;
          }
          return v;
      };
      const pick = (o, k, list, def, where) => {
          const v = o[k];
          if (v == null)
              return def;
          const i = list.indexOf(String(v));
          if (i < 0) {
              errs.push(`${where}.${k}: one of ${list.join(", ")}`);
              return def;
          }
          return i;
      };
      if (sp.label != null)
          a.label = String(sp.label);
      const h = sub("head", ["shape", "size", "w", "h", "round"]);
      a.head = pick(h, "shape", HEAD_SHAPES, 0, `${at}.head`);
      a.headR = num(h, "size", 0.12, 0.3, 0.2, `${at}.head`);
      a.headW = num(h, "w", 0.6, 1.5, 1, `${at}.head`);
      a.headH = num(h, "h", 0.6, 1.5, 1, `${at}.head`);
      a.headRound = num(h, "round", 0, 1, 0.35, `${at}.head`);
      const e = sub("eyes", ["style", "size", "gap", "pupil", "y"]);
      a.eyes = pick(e, "style", EYE_STYLES, 0, `${at}.eyes`);
      a.eyeR = num(e, "size", 0.1, 0.6, a.eyes === 0 ? 0.46 : a.eyes === 1 ? 0.3 : a.eyes === 2 ? 0.14 : 0.3, `${at}.eyes`);
      a.eyeGap = num(e, "gap", 0, 0.7, 0.36, `${at}.eyes`);
      a.pupil = num(e, "pupil", 0, 0.9, 0.5, `${at}.eyes`);
      a.eyeY = num(e, "y", -0.5, 0.5, 0.02, `${at}.eyes`);
      const m = sub("mouth", ["style", "size", "y"]);
      a.mouth = pick(m, "style", MOUTH_STYLES, 0, `${at}.mouth`);
      a.mouthW = num(m, "size", 0.1, 0.8, 0.3, `${at}.mouth`);
      a.mouthY = num(m, "y", -0.95, -0.1, -0.6, `${at}.mouth`);
      if (sp.antennae != null) {
          if (!Array.isArray(sp.antennae) || sp.antennae.length > 2)
              errs.push(`${at}.antennae: a list of at most 2`);
          else {
              const list = sp.antennae;
              a.antN = list.length;
              for (let i = 0; i < 2; i++) {
                  const s = isRec(list[i]) ? list[i] : {};
                  if (i < list.length && !isRec(list[i]))
                      errs.push(`${at}.antennae[${i}]: an object`);
                  for (const f of Object.keys(s))
                      if (!["at", "up", "lean", "len", "tipLen", "bend", "tip", "tipSize"].includes(f))
                          errs.push(`${at}.antennae[${i}]: unknown field ${f}`);
                  const w = `${at}.antennae[${i}]`;
                  a.antAt[i] = num(s, "at", -0.95, 0.95, a.antAt[i], w);
                  a.antUp[i] = num(s, "up", 0, 1.5, a.antUp[i], w);
                  a.antLean[i] = num(s, "lean", -1.6, 1.6, a.antLean[i], w);
                  a.antLen[i] = num(s, "len", 0.02, 0.3, a.antLen[i], w);
                  a.antTipLen[i] = num(s, "tipLen", 0.02, 0.25, a.antTipLen[i], w);
                  a.antBend[i] = num(s, "bend", -2.5, 2.5, a.antBend[i], w);
                  a.antTip[i] = pick(s, "tip", TIP_KINDS, a.antTip[i], w);
                  a.antTipR[i] = num(s, "tipSize", 0, 0.12, a.antTipR[i], w);
              }
          }
      }
      a.light = a.antN > 1 && a.antTip[1] === 2 ? 1 : a.antN > 0 && a.antTip[0] === 2 ? 0 : -1;
      const ea = sub("ears", ["style", "size"]);
      a.ears = pick(ea, "style", EAR_STYLES, 0, `${at}.ears`);
      a.earR = num(ea, "size", 0.1, 0.6, 0.28, `${at}.ears`);
      const d = sub("dots", ["pattern", "spacing", "size", "alpha"]);
      a.dots = pick(d, "pattern", DOT_PATTERNS, 0, `${at}.dots`);
      a.dotSp = num(d, "spacing", 0.04, 0.12, 0.062, `${at}.dots`);
      a.dotR = num(d, "size", 0.005, 0.05, 0.021, `${at}.dots`);
      a.dotA = num(d, "alpha", 0, 1, 0.5, `${at}.dots`);
      const b = sub("body", ["top", "bottom", "round"]);
      a.bodyTop = num(b, "top", 0.06, 0.25, 0.135, `${at}.body`);
      a.bodyBottom = num(b, "bottom", 0.06, 0.28, 0.165, `${at}.body`);
      a.bodyRound = num(b, "round", 0, 0.12, 0.05, `${at}.body`);
      const l = sub("limbs", ["arm", "leg", "neck", "hand", "antenna"]);
      a.arm = num(l, "arm", 0.02, 0.12, 0.065, `${at}.limbs`);
      a.leg = num(l, "leg", 0.02, 0.12, 0.075, `${at}.limbs`);
      a.neck = num(l, "neck", 0.02, 0.14, 0.08, `${at}.limbs`);
      a.hand = num(l, "hand", 0.015, 0.08, 0.042, `${at}.limbs`);
      a.antW = num(l, "antenna", 0.01, 0.08, 0.042, `${at}.limbs`);
      a.handK = a.hand / 0.042;
      const p = sub("paint", ["body", "dots", "eye", "pupil", "mouth", "light", "ears"]);
      const paint = (k, def) => {
          const v = p[k];
          if (v == null)
              return def;
          if (!okPaint(v) || v === "$paint") {
              errs.push(`${at}.paint.${k}: a colour`);
              return def;
          }
          return v;
      };
      a.pBody = paint("body", "$color");
      a.pDots = paint("dots", "paper");
      a.pEye = paint("eye", "paper");
      a.pPupil = paint("pupil", "$color");
      a.pMouth = paint("mouth", "paper");
      a.pLight = paint("light", "$color");
      a.pEars = paint("ears", a.pBody);
      if (sp.wear != null) {
          if (!Array.isArray(sp.wear) || sp.wear.length > 6)
              errs.push(`${at}.wear: a list of at most 6`);
          else
              sp.wear.forEach((wr, i) => {
                  const w = `${at}.wear[${i}]`;
                  if (!isRec(wr)) {
                      errs.push(`${w}: an object`);
                      return;
                  }
                  for (const f of Object.keys(wr))
                      if (!["part", "on", "x", "y", "scale", "rot", "paint", "back"].includes(f))
                          errs.push(`${w}: unknown field ${f}`);
                  const part = parts.get(String(wr.part));
                  if (!part) {
                      errs.push(`${w}: no part "${String(wr.part)}"`);
                      return;
                  }
                  const on = wr.on == null ? AN_HEAD : ANCHORS.indexOf(String(wr.on));
                  if (on < 0) {
                      errs.push(`${w}.on: one of ${ANCHORS.join(", ")}`);
                      return;
                  }
                  if (wr.paint != null && (!okPaint(wr.paint) || wr.paint === "$paint"))
                      errs.push(`${w}.paint: a colour`);
                  const back = wr.back === true;
                  a.wear.push(new Wear(part, on, num(wr, "x", -1, 1, 0, w), num(wr, "y", -1, 1, 0, w), num(wr, "scale", 0.2, 3, 1, w), num(wr, "rot", -3.2, 3.2, 0, w), String(wr.paint ?? "$color"), back));
                  if (back)
                      a.wearBack = true;
                  else
                      a.wearFront = true;
              });
      }
      return a;
  }
  /** One spec over another: its own parts of the look win; lists (antennae, wear) are whole. */
  function mergeAvatar(base, over) {
      const out = { ...base };
      for (const [k, v] of Object.entries(over)) {
          if (k === "extends")
              continue;
          out[k] = isRec(v) && isRec(out[k]) ? { ...out[k], ...v } : v;
      }
      return out;
  }
  // ---- moments: recipes
  const TRACK_KINDS = {
      walk: 1, crouch: 2, sit: 3, lean: 4, tilt: 5, arm: 6, look: 7, eyes: 8, mouth: 9, lid: 10, spin: 11, shake: 12, act: 13, prop: 14, emit: 15, face: 16,
      hop: 20, kick: 21, fabric: 22, glow: 23, sound: 24, others: 25, event: 26, blink: 27,
  };
  const TK_WALK = 1, TK_CROUCH = 2, TK_SIT = 3, TK_LEAN = 4, TK_TILT = 5, TK_ARM = 6, TK_LOOK = 7, TK_EYES = 8, TK_MOUTH = 9, TK_LID = 10, TK_SPIN = 11, TK_SHAKE = 12, TK_ACT = 13, TK_PROP = 14, TK_EMIT = 15, TK_FACE = 16;
  const TK_HOP = 20, TK_KICK = 21, TK_FABRIC = 22, TK_GLOW = 23, TK_SOUND = 24, TK_OTHERS = 25, TK_EVENT = 26, TK_BLINK = 27;
  /** Each track's own fields (besides do, at, to, after, if, chance, note). x: an expression allowed. */
  const TRACK_FIELDS = {
      walk: { x: "x", dx: "x", toward: "walk", gap: "x", speed: "x" },
      crouch: { v: "x" }, sit: { v: "x" }, lean: { v: "x" }, tilt: { v: "x" }, lid: { v: "x" },
      arm: { hand: "hand", x: "x", y: "x", from: "from", k: "x", over: "bool" },
      look: { target: "look", x: "x", y: "x", rate: "n" },
      eyes: { state: "eyes" }, mouth: { state: "mouth", v: "x" },
      spin: { rate: "x" }, shake: { amp: "x", freq: "x", part: "shake" }, act: { act: "act" },
      prop: { part: "part", on: "anchor", x: "x", y: "x", scale: "x", rot: "x", paint: "paint", pop: "bool" },
      emit: {
          part: "part", parts: "parts", from: "anchor", x: "x", y: "x", n: "n", every: "n", vx: "x", vy: "x", spread: "n", g: "n", drag: "n", life: "n",
          size: "x", grow: "n", spin: "n", paint: "paint", alpha: "n", floor: "bool", aim: "anchor", flight: "n", alt: "bool", miss: "n", onMiss: "name",
          pause: "n", orbit: "n", orbitRate: "n",
      },
      face: { target: "face" },
      hop: { h: "x", dx: "x" }, kick: { part: "kick", vx: "x", vy: "x" }, fabric: { from: "anchor", x: "x", y: "x", v: "x", r: "x" },
      glow: { v: "x" }, sound: { name: "name" }, others: { play: "moment", n: "n", near: "n" }, event: { name: "name" }, blink: {},
  };
  const TRACK_ENUMS = {
      hand: ["front", "back", "l", "r", "both"],
      from: ["neck", "head", "hip", "crown", "face", "body"],
      look: ["screen", "peer", "away", "point", "around", "down", "up", "ahead", "drop", "last", "hand"],
      eyes: ["rest", "open", "closed", "half", "squint", "wide", "x", "happy", "spiral"],
      mouth: ["rest", "none", "line", "smile", "open", "o", "wide", "wavy"],
      shake: ["body", "head", "all"],
      act: ["play", "wave", "survey", "read", "settle", "think", "stretch"],
      face: ["screen", "peer", "away", "left", "right", "forward", "back"],
      kick: ["head", "body", "all", "hands", "feet", "hand_front", "hand_back"],
      walk: ["peer", "center", "left", "right", "start", "away"],
  };
  const FROM_ANCHOR = [AN_NECK, AN_HEAD, AN_HIP, AN_CROWN, AN_FACE, AN_BODY];
  const EYE_REST = 0, EYE_OPEN = 1, EYE_CLOSED = 2, EYE_HALF = 3, EYE_SQUINT = 4, EYE_WIDE = 5, EYE_X = 6, EYE_HAPPY = 7, EYE_SPIRAL = 8;
  const MO_REST = 0, MO_NONE = 1, MO_LINE = 2, MO_SMILE = 3, MO_OPEN = 4, MO_O = 5, MO_WIDE = 6, MO_WAVY = 7;
  const LK_SCREEN = 0, LK_PEER = 1, LK_AWAY = 2, LK_POINT = 3, LK_AROUND = 4, LK_DOWN = 5, LK_UP = 6, LK_AHEAD = 7, LK_DROP = 8, LK_LAST = 9, LK_HAND = 10;
  /** The most tracks a recipe (or its end) may have, and events it may name. */
  const MOMENT_LIMITS = { tracks: 40, events: 8, dur: 60, props: 4 };
  /** A track, compiled. Which fields mean what depends on its kind (k). */
  class Track {
      constructor() {
          this.k = 0;
          this.at = 0;
          this.to = 0;
          this.inst = false;
          this.after = -1;
          this.cond = 0;
          this.chance = 1;
          /** Its numbers (expressions or constants): by kind, see Moment's interpreter. */
          this.a = XP0;
          this.b = XP0;
          this.c = XP0;
          this.d = XP0;
          this.e = XP0;
          /** Its choices: a hand, an anchor, a target, a state… */
          this.m = 0;
          this.m2 = -1;
          this.part = null;
          this.parts = null;
          this.paint = "$color";
          this.name = "";
          this.ref = null;
          this.ev = -1;
          // An emitter's own numbers.
          this.n = 1;
          this.every = 0;
          this.life = 1;
          this.g = 1;
          this.drag = 0;
          this.spread = 0;
          this.spin = 0;
          this.grow = 1;
          this.alpha = 1;
          this.flight = 0.5;
          this.miss = 0;
          this.pause = 0;
          this.orbit = 0;
          this.orbitW = 0;
          /** others: how near (bot heights) another bot is to answer. */
          this.near = 10;
          this.floor = false;
          this.alt = false;
          this.pop = false;
      }
  }
  /** A recipe, compiled. `ok` false: it cannot be played here (the reason in `why`); play its `fallback` instead. */
  class Moment {
      constructor(id) {
          this.ok = true;
          this.why = "";
          this.label = "";
          this.dur = 1;
          this.loop = false;
          this.loopFrom = 0;
          this.bpm = 0;
          this.still = 0;
          this.fallback = "play";
          this.react = false;
          this.tracks = [];
          this.end = [];
          this.endDur = 0;
          this.events = [];
          this.id = id;
      }
  }
  /** Compile one recipe's tracks; refs to other moments resolve through `all` (filled before). */
  function buildMoment(mo, spec, parts, all, errs) {
      const at = `moments.${mo.id}`;
      const n0 = errs.length;
      const fail = (msg) => { errs.push(`${at}${msg}`); };
      if (!isRec(spec)) {
          fail(": an object");
          mo.ok = false;
          mo.why = "not an object";
          return;
      }
      const sp = spec;
      for (const k of Object.keys(sp))
          if (!["label", "note", "format", "dur", "mode", "loopFrom", "bpm", "still", "fallback", "react", "tracks", "end"].includes(k))
              fail(`: unknown field ${k}`);
      if ((sp.format ?? 1) > LOOKS_FORMAT) {
          mo.ok = false;
          mo.why = `format ${sp.format}`;
          return;
      }
      if (typeof sp.dur !== "number" || !(sp.dur > 0 && sp.dur <= MOMENT_LIMITS.dur))
          fail(`.dur: seconds in (0, ${MOMENT_LIMITS.dur}]`);
      mo.dur = Number(sp.dur) || 1;
      mo.label = String(sp.label ?? "");
      if (sp.mode != null && sp.mode !== "once" && sp.mode !== "loop")
          fail(".mode: once or loop");
      mo.loop = sp.mode === "loop";
      mo.loopFrom = typeof sp.loopFrom === "number" && sp.loopFrom >= 0 && sp.loopFrom < mo.dur ? sp.loopFrom : 0;
      if (sp.loopFrom != null && mo.loopFrom !== sp.loopFrom)
          fail(".loopFrom: seconds in [0, dur)");
      mo.bpm = typeof sp.bpm === "number" && sp.bpm > 0 && sp.bpm <= 300 ? sp.bpm : 0;
      if (sp.bpm != null && mo.bpm !== sp.bpm)
          fail(".bpm: in (0, 300]");
      mo.still = typeof sp.still === "number" && sp.still >= 0 && sp.still <= mo.dur ? sp.still : 0;
      if (sp.still != null && mo.still !== sp.still)
          fail(".still: seconds in [0, dur]");
      const acts = ["play", "wave", "survey", "read", "settle", "think", "carry"];
      if (sp.fallback != null && !acts.includes(sp.fallback))
          fail(`.fallback: one of ${acts.join(", ")}`);
      mo.fallback = acts.includes(String(sp.fallback)) ? sp.fallback : "play";
      mo.react = sp.react === true;
      // Event names: those fired (event tracks, emitters' onMiss) and those followed (after).
      const evOf = (name, where) => {
          if (typeof name !== "string" || !/^[a-z][a-z0-9_.-]{0,23}$/.test(name)) {
              errs.push(`${where}: an event name`);
              return -1;
          }
          let i = mo.events.indexOf(name);
          if (i < 0) {
              if (mo.events.length >= MOMENT_LIMITS.events) {
                  errs.push(`${where}: at most ${MOMENT_LIMITS.events} events`);
                  return -1;
              }
              mo.events.push(name);
              i = mo.events.length - 1;
          }
          return i;
      };
      const fired = new Set(), followed = [];
      const list = (tracks, dur, where) => {
          if (!Array.isArray(tracks) || tracks.length > MOMENT_LIMITS.tracks) {
              errs.push(`${where}: a list of at most ${MOMENT_LIMITS.tracks} tracks`);
              return [];
          }
          let props = 0;
          return tracks.map((raw, ti) => {
              const w = `${where}[${ti}]`;
              const tr = new Track();
              if (!isRec(raw)) {
                  errs.push(`${w}: an object`);
                  return tr;
              }
              const kind = String(raw.do);
              const fields = own(TRACK_FIELDS, kind) ? TRACK_FIELDS[kind] : null;
              if (!fields) {
                  errs.push(`${w}: do "${kind}" is not one this build plays`);
                  return tr;
              }
              tr.k = TRACK_KINDS[kind];
              for (const f of Object.keys(raw))
                  if (!["do", "at", "to", "after", "if", "chance", "note"].includes(f) && !own(fields, f))
                      errs.push(`${w}: ${kind} has no field ${f}`);
              const tnum = (k, def, lo, hi) => {
                  const v = raw[k];
                  if (v == null)
                      return def;
                  if (typeof v !== "number" || !(v >= lo && v <= hi)) {
                      errs.push(`${w}.${k}: a number in [${lo}, ${hi}]`);
                      return def;
                  }
                  return v;
              };
              tr.at = tnum("at", 0, 0, dur);
              tr.inst = tr.k >= 20 || (tr.k === TK_EMIT && !(typeof raw.every === "number" && raw.every > 0));
              tr.to = tnum("to", tr.k === TK_HOP ? Math.min(dur, tr.at + 0.35) : tr.inst ? tr.at : dur, tr.at, dur);
              if (raw.to != null && tr.inst && tr.k !== TK_HOP)
                  errs.push(`${w}.to: ${kind} happens once, at "at"`);
              if (!tr.inst && raw.to != null && !(tr.to > tr.at))
                  errs.push(`${w}.to: after "at"`);
              tr.chance = tnum("chance", 1, 0, 1);
              if (raw.if != null) {
                  tr.cond = raw.if === "alone" ? 1 : raw.if === "paired" ? 2 : 0;
                  if (!tr.cond)
                      errs.push(`${w}.if: alone or paired`);
              }
              if (raw.after != null) {
                  tr.after = evOf(raw.after, `${w}.after`);
                  followed.push([tr.after, `${w}.after`]);
              }
              const x = (k, def) => {
                  const v = raw[k];
                  if (v == null)
                      return def === 0 ? XP0 : { c: def, code: null };
                  if (typeof v === "number") {
                      if (!Number.isFinite(v))
                          errs.push(`${w}.${k}: a number`);
                      return { c: v, code: null };
                  }
                  if (typeof v !== "string") {
                      errs.push(`${w}.${k}: a number or an expression`);
                      return XP0;
                  }
                  try {
                      return xcompile(v);
                  }
                  catch (e) {
                      errs.push(`${w}.${k}: ${e.message}`);
                      return XP0;
                  }
              };
              const en = (k, list, def) => {
                  const v = raw[k];
                  if (v == null)
                      return def;
                  const i = list.indexOf(String(v));
                  if (i < 0)
                      errs.push(`${w}.${k}: one of ${list.join(", ")}`);
                  return i < 0 ? def : i;
              };
              const anchor = (k, def) => en(k, ANCHORS, def);
              const part = (k) => {
                  const v = raw[k];
                  if (v == null)
                      return null;
                  const p = parts.get(String(v));
                  if (!p)
                      errs.push(`${w}.${k}: no part "${String(v)}"`);
                  return p ?? null;
              };
              const paint = (any) => {
                  const v = raw.paint;
                  if (v == null)
                      return "$color";
                  if (!okPaint(v, any) || v === "$paint")
                      errs.push(`${w}.paint: a colour`);
                  return String(v);
              };
              const name = (k) => {
                  const v = raw[k];
                  if (typeof v !== "string" || !/^[a-z][a-z0-9_.-]{0,31}$/.test(v)) {
                      errs.push(`${w}.${k}: a name (lower case)`);
                      return "";
                  }
                  return v;
              };
              switch (tr.k) {
                  case TK_WALK:
                      tr.m = en("toward", TRACK_ENUMS.walk, -1) + 1; // 0: by x / dx; else 1 + the place
                      tr.a = x("x", NaN);
                      tr.b = x("dx", 0);
                      tr.c = x("gap", 0.3);
                      tr.d = x("speed", 1);
                      tr.m2 = raw.x != null ? 1 : raw.dx != null ? 2 : 0;
                      if (!tr.m && !tr.m2)
                          errs.push(`${w}: walk where (x, dx or toward)`);
                      break;
                  case TK_CROUCH:
                  case TK_LEAN:
                  case TK_TILT:
                  case TK_LID:
                  case TK_GLOW:
                      tr.a = x("v", 0);
                      break;
                  case TK_SIT:
                      tr.a = x("v", 1);
                      break;
                  case TK_ARM: {
                      tr.m = en("hand", TRACK_ENUMS.hand, 0);
                      tr.m2 = FROM_ANCHOR[en("from", TRACK_ENUMS.from, 0)];
                      tr.a = x("x", 0.2);
                      tr.b = x("y", -0.2);
                      tr.c = x("k", 520);
                      // A hand at his face is drawn in front of his head (`over`; by default when it goes to the head, crown or face).
                      tr.pop = raw.over != null ? raw.over === true : tr.m2 === AN_HEAD || tr.m2 === AN_CROWN || tr.m2 === AN_FACE;
                      break;
                  }
                  case TK_LOOK:
                      tr.m = en("target", TRACK_ENUMS.look, 0);
                      tr.a = x("x", NaN);
                      tr.b = x("y", NaN);
                      tr.n = tnum("rate", 1.5, 0.1, 10);
                      break;
                  case TK_EYES:
                      tr.m = en("state", TRACK_ENUMS.eyes, 0);
                      break;
                  case TK_MOUTH:
                      tr.m = en("state", TRACK_ENUMS.mouth, 0);
                      tr.a = x("v", 1);
                      break;
                  case TK_SPIN:
                      tr.a = x("rate", 2);
                      break;
                  case TK_SHAKE:
                      tr.a = x("amp", 0.03);
                      tr.b = x("freq", 14);
                      tr.m = en("part", TRACK_ENUMS.shake, 0);
                      break;
                  case TK_ACT:
                      tr.m = en("act", TRACK_ENUMS.act, 0);
                      break;
                  case TK_FACE:
                      tr.m = en("target", TRACK_ENUMS.face, 0);
                      break;
                  case TK_PROP:
                      tr.part = part("part");
                      if (!tr.part)
                          errs.push(`${w}: a part`);
                      tr.m = anchor("on", AN_CROWN);
                      tr.a = x("x", 0);
                      tr.b = x("y", 0);
                      tr.c = x("scale", 1);
                      tr.d = x("rot", 0);
                      tr.paint = paint(false);
                      tr.pop = raw.pop !== false;
                      if (++props > MOMENT_LIMITS.props)
                          errs.push(`${w}: at most ${MOMENT_LIMITS.props} props in a recipe`);
                      break;
                  case TK_EMIT: {
                      tr.part = part("part");
                      if (Array.isArray(raw.parts)) {
                          tr.parts = [];
                          for (const id of raw.parts) {
                              const p = parts.get(String(id));
                              if (p)
                                  tr.parts.push(p);
                              else
                                  errs.push(`${w}.parts: no part "${String(id)}"`);
                          }
                          if (!tr.parts.length || tr.parts.length > 6)
                              errs.push(`${w}.parts: 1 to 6 parts`);
                      }
                      else if (raw.parts != null)
                          errs.push(`${w}.parts: a list`);
                      if (!tr.part && !tr.parts)
                          errs.push(`${w}: a part (or parts)`);
                      tr.m = anchor("from", AN_HEAD);
                      tr.m2 = raw.aim != null ? anchor("aim", -1) : -1;
                      tr.a = x("x", 0);
                      tr.b = x("y", 0);
                      tr.c = x("vx", 0);
                      tr.d = x("vy", 0);
                      tr.e = x("size", 1);
                      tr.n = tnum("n", 1, 1, 24);
                      tr.every = tnum("every", 0, 0, 10);
                      tr.spread = tnum("spread", 0, 0, 3);
                      tr.g = tnum("g", 1, -3, 3);
                      tr.drag = tnum("drag", 0, 0, 20);
                      tr.life = tnum("life", 1, 0.05, 10);
                      tr.grow = tnum("grow", 1, 0, 6);
                      tr.spin = tnum("spin", 0, 0, 30);
                      tr.alpha = tnum("alpha", 1, 0, 1);
                      tr.flight = tnum("flight", 0.5, 0.1, 3);
                      tr.miss = tnum("miss", 0, 0, 1);
                      tr.pause = tnum("pause", 0, 0, 10);
                      tr.orbit = tnum("orbit", 0, 0, 2);
                      tr.orbitW = tnum("orbitRate", 3, -20, 20);
                      tr.paint = paint(true);
                      tr.floor = raw.floor === true;
                      tr.alt = raw.alt === true;
                      if (raw.onMiss != null) {
                          tr.ev = evOf(raw.onMiss, `${w}.onMiss`);
                          fired.add(tr.ev);
                      }
                      break;
                  }
                  case TK_HOP:
                      tr.a = x("h", 0.3);
                      tr.b = x("dx", 0);
                      break;
                  case TK_KICK:
                      tr.m = en("part", TRACK_ENUMS.kick, 2);
                      tr.a = x("vx", 0);
                      tr.b = x("vy", 0);
                      break;
                  case TK_FABRIC:
                      tr.m = anchor("from", AN_HIP);
                      tr.a = x("x", 0);
                      tr.b = x("y", 0);
                      tr.c = x("v", 50);
                      tr.d = x("r", 1.6);
                      break;
                  case TK_SOUND:
                      tr.name = name("name");
                      break;
                  case TK_OTHERS: {
                      const id = String(raw.play);
                      tr.ref = all.get(id) ?? null;
                      if (!tr.ref)
                          errs.push(`${w}.play: no moment "${id}"`);
                      tr.n = tnum("n", 2, 1, 8);
                      tr.near = tnum("near", 10, 1, 40);
                      break;
                  }
                  case TK_EVENT:
                      tr.ev = evOf(raw.name, `${w}.name`);
                      fired.add(tr.ev);
                      break;
                  default: break;
              }
              return tr;
          });
      };
      mo.tracks = list(sp.tracks, mo.dur, `${at}.tracks`);
      if (sp.end != null) {
          if (!isRec(sp.end) || typeof sp.end.dur !== "number" || !(sp.end.dur > 0 && sp.end.dur <= 20))
              fail(".end: { dur (0, 20], tracks }");
          else {
              mo.endDur = sp.end.dur;
              mo.end = list(sp.end.tracks, mo.endDur, `${at}.end.tracks`);
          }
      }
      for (const [ev, w] of followed)
          if (ev >= 0 && !fired.has(ev))
              errs.push(`${w}: nothing fires "${mo.events[ev]}"`);
      if (errs.length > n0) {
          mo.ok = false;
          mo.why = errs[n0];
      }
  }
  /** The catalog, compiled: its parts, avatars and moments by id, which avatar each kind wears, and what was wrong. */
  class Looks {
      constructor() {
          this.v = 0;
          this.version = "";
          this.parts = new Map();
          this.avatars = new Map();
          this.moments = new Map();
          this.kinds = {};
          this.errors = [];
          /** Inline avatars (a node's own spec), compiled once each. */
          this.inline = new Map();
          /** The avatars' specs, merged (inline avatars extend them). */
          this.specs = new Map();
      }
      /** The look for a node: its avatar (an id, or a spec of its own over Blip), else the one its kind wears, else Blip. */
      avatar(kind, ref) {
          if (typeof ref === "string" && ref) {
              const a = this.avatars.get(ref);
              if (a)
                  return a;
          }
          else if (isRec(ref)) {
              const key = JSON.stringify(ref);
              let a = this.inline.get(key);
              if (!a) {
                  const errs = [];
                  const base = typeof ref.extends === "string" ? this.specs.get(ref.extends) : undefined;
                  a = buildAvatar("inline", mergeAvatar(base ?? {}, ref), this.parts, errs);
                  if (errs.length)
                      a = this.avatar(kind);
                  if (this.inline.size > 32)
                      this.inline.clear();
                  this.inline.set(key, a);
              }
              return a;
          }
          return this.avatars.get(this.kinds[kind] ?? "") ?? BLIP;
      }
      /** A recipe by id, when this build can play it (else null: play its fallback). */
      moment(id) {
          const m = this.moments.get(id);
          return m && m.ok ? m : null;
      }
      /** What a build that cannot play `id` does instead. */
      fallback(id) {
          return this.moments.get(id)?.fallback ?? "play";
      }
  }
  /**
   * The server's catalog (LooksSpec), compiled once: parts, then avatars (each over what it extends), then moments (two
   * passes, so one may name another). Errors are collected, never thrown: what is broken is left out (an avatar) or
   * marked unplayable (a moment), and the rest works.
   */
  function compileLooks(spec) {
      const L = new Looks();
      const errs = L.errors;
      if (!isRec(spec)) {
          errs.push("the catalog is an object");
          return L;
      }
      const sp = spec;
      for (const k of Object.keys(sp))
          if (!["v", "format", "note", "parts", "avatars", "moments", "kinds", "idle"].includes(k))
              errs.push(`unknown field ${k}`);
      if (typeof sp.v !== "number" || !(sp.v >= 1) || Math.floor(sp.v) !== sp.v)
          errs.push("v: a whole number from 1");
      L.v = Number(sp.v) || 0;
      if ((sp.format ?? 1) > LOOKS_FORMAT) {
          errs.push(`format ${sp.format}: newer than this build`);
          return L;
      }
      for (const [id, p] of Object.entries(isRec(sp.parts) ? sp.parts : {})) {
          const part = compilePart(id, p, errs);
          if (part)
              L.parts.set(id, part);
      }
      const raw = isRec(sp.avatars) ? sp.avatars : {};
      const merged = (id, seen) => {
          const s = raw[id];
          if (!isRec(s))
              return null;
          if (seen.includes(id)) {
              errs.push(`avatars.${id}: extends itself`);
              return null;
          }
          if (s.extends == null)
              return s;
          const base = merged(String(s.extends), [...seen, id]);
          if (!base) {
              errs.push(`avatars.${id}: extends "${String(s.extends)}", which is not there`);
              return null;
          }
          return mergeAvatar(base, s);
      };
      for (const id of Object.keys(raw)) {
          const s = merged(id, []);
          if (!s) {
              if (!isRec(raw[id]))
                  errs.push(`avatars.${id}: an object`);
              continue;
          }
          const n0 = errs.length;
          const a = buildAvatar(id, s, L.parts, errs);
          L.specs.set(id, s);
          if (errs.length === n0)
              L.avatars.set(id, a);
      }
      const moms = isRec(sp.moments) ? sp.moments : {};
      for (const id of Object.keys(moms))
          L.moments.set(id, new Moment(id));
      for (const id of Object.keys(moms))
          buildMoment(L.moments.get(id), moms[id], L.parts, L.moments, errs);
      if (sp.kinds != null) {
          if (!isRec(sp.kinds))
              errs.push("kinds: an object");
          else
              for (const [k, a] of Object.entries(sp.kinds)) {
                  if (!L.avatars.has(String(a)))
                      errs.push(`kinds.${k}: no avatar "${String(a)}"`);
                  else
                      L.kinds[k] = String(a);
              }
      }
      if (sp.idle != null) {
          const i = sp.idle;
          if (!isRec(i))
              errs.push("idle: an object");
          else {
              for (const k of Object.keys(i))
                  if (!["every", "chance", "moments"].includes(k))
                      errs.push(`idle: unknown field ${k}`);
              if (i.moments != null && (!Array.isArray(i.moments) || i.moments.some((m) => !L.moments.has(String(m)))))
                  errs.push("idle.moments: moments in this catalog");
          }
      }
      L.version = `${L.v}`;
      return L;
  }
  /** An avatar spec on its own (a node's inline look), over Blip. */
  function compileAvatar(spec, looks) {
      return (looks ?? EMPTY_LOOKS).avatar("custom", spec);
  }
  const EMPTY_LOOKS = new Looks();
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
  const DUST = 192;
  const SPARKS = 16;
  /** A moment's particles (pooled), the props it puts on him at once, the tracks and events a recipe may have. */
  const QCAP = 32;
  const WSLOTS = 4;
  const MO_TRACKS = 48;
  const MO_EVENTS = 8;
  /** A moment's particle: on the floor it bounces; thrown to a hand; dropped (a miss); circling an anchor; its miss still to be told. */
  const Q_FLOOR = 1, Q_AIM = 2, Q_MISS = 4, Q_ORBIT = 8, Q_EVENT = 16;
  // Prop kinds.
  const P_ZERO = 1, P_ONE = 2, P_KEY = 3, P_DAY = 4, P_PLANE = 5, P_BALL = 6, P_PAD = 7, P_BAG = 8;
  /** A spark's kind (shome): 0 rises or falls, 1 flows into his head (reading), 2 a torn-off page that flutters down, 3 a sweat drop. */
  const S_PAGE = 2, S_SWEAT = 3;
  /** The carry act's phases: off stage (the next bag packed), across, setting the bag down, walking off, gone. */
  const C_WAIT = 0, C_WALK = 1, C_DOWN = 2, C_OFF = 3, C_GONE = 4;
  /** The Notes bot's pad: lines to a page. */
  const PAD_LINES = 4;
  /** A number in [0, 1) from n: the same n, the same number (a scribbled line's length and wobble). */
  const hash01 = (n) => {
      const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
      return s - Math.floor(s);
  };
  // Contact flags (per particle, per step).
  const C_FLOOR = 1, C_WALL = 2, C_CEIL = 4, C_SUPPORT = 8;
  // Acts.
  const A_STAND = 0, A_WANDER = 1, A_SIT = 2, A_STRETCH = 3, A_PEEK = 4, A_LOOK = 5, A_PLAY = 6, A_NEEDS = 7;
  const A_WAVE = 8, A_SURVEY = 9, A_READ = 10, A_THINK = 11, A_CARRY = 12;
  /** A paint, resolved: the bot's colour, ink, paper, or a colour as given. */
  const paintOf = (p, col) => (p === "$color" ? col : p === "ink" ? INK : p === "paper" ? PAPER : p);
  /**
   * A part drawn at (ox, oy): its x along (fx, fy) and its y along (dx, dy), both unit vectors, `sc` px to a unit. Its own
   * "$paint" is `paint` (a wearer's or an emitter's), "$color" the bot's.
   */
  function drawPart(ctx, p, ox, oy, fx, fy, dx, dy, sc, col, paint, alpha) {
      const o = p.ops, n = o.length;
      let fill = -1, stroke = -1, lw = 0.03, a = 1;
      for (let i = 0; i < n;) {
          const op = o[i];
          if (op === PO_SHAPE) {
              fill = o[i + 1];
              stroke = o[i + 2];
              lw = o[i + 3];
              a = o[i + 4];
              ctx.beginPath();
              i += 5;
          }
          else if (op === PO_M || op === PO_L) {
              const u = o[i + 1], v = o[i + 2], X = ox + (fx * u + dx * v) * sc, Y = oy + (fy * u + dy * v) * sc;
              if (op === PO_M)
                  ctx.moveTo(X, Y);
              else
                  ctx.lineTo(X, Y);
              i += 3;
          }
          else if (op === PO_Q) {
              const cu = o[i + 1], cv = o[i + 2], u = o[i + 3], v = o[i + 4];
              ctx.quadraticCurveTo(ox + (fx * cu + dx * cv) * sc, oy + (fy * cu + dy * cv) * sc, ox + (fx * u + dx * v) * sc, oy + (fy * u + dy * v) * sc);
              i += 5;
          }
          else if (op === PO_Z) {
              ctx.closePath();
              i++;
          }
          else if (op === PO_O) {
              const u = o[i + 1], v = o[i + 2], r = o[i + 3] * Math.abs(sc), X = ox + (fx * u + dx * v) * sc, Y = oy + (fy * u + dy * v) * sc;
              ctx.moveTo(X + r, Y);
              ctx.arc(X, Y, r, 0, TAU);
              i += 4;
          }
          else {
              const own = paint === "$paint" ? "$color" : paint;
              if (fill >= 0) {
                  const q = p.paints[fill];
                  ctx.fillStyle = paintOf(q === "$paint" ? own : q, col);
                  ctx.globalAlpha = alpha * a;
                  ctx.fill();
              }
              if (stroke >= 0) {
                  const q = p.paints[stroke];
                  ctx.strokeStyle = paintOf(q === "$paint" ? own : q, col);
                  ctx.globalAlpha = alpha * a;
                  ctx.lineWidth = lw * Math.abs(sc);
                  ctx.lineCap = "round";
                  ctx.lineJoin = "round";
                  ctx.stroke();
              }
              i++;
          }
      }
  }
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
          /** How strongly the fabric is drawn (1: a tile's; 0: none, a bot on a page's own stage stands on nothing). */
          this.cloth = 1;
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
          /** Per antenna (A, B): its base across and up the crown, its first and second lengths (px; from his look). */
          this.antW0 = new Float64Array(2);
          this.antU0 = new Float64Array(2);
          this.antL1 = new Float64Array(2);
          this.antL2 = new Float64Array(2);
          this.rAntA1 = 0;
          this.rAntB1 = 0;
          /** The first of the antennae's four constraints. */
          this.cAnt = 0;
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
          /** A spark that flows into his head (reading) instead of rising or falling. */
          this.shome = new Uint8Array(SPARKS);
          this.sNext = 0;
          /** On his own page (BotBuddy): the moment he is in, and where the page's ask field is (0 none, 1 down, 2 left, 3 right, 4 up). */
          this.moment = "play";
          this.hintDir = 0;
          /**
           * Carrying (act "carry"): the trip he is on (0 the first), its load (0 light to 1 the heaviest), how fast the act's
           * clock runs (1: as CARRY says), whether the answer is here (deliver), the bag fading once it is down, his bob after a
           * step, and when the next sweat drop comes.
           */
          this.trip = 0;
          this.load = 0;
          this.carryPace = 1;
          this.delivered = false;
          this.bagFade = 1;
          this.bagDownAt = -1;
          this.dip = 0;
          this.sweatAt = 0;
          /** Heavy: now and then he stops a moment and hitches the bag up higher (when, and how long it has left). */
          this.hitchAt = 0;
          this.hitchT = 0;
          /** The stage holds his bag instead of his kind's toys, and it may go off stage with him. */
          this.stageCarry = false;
          /** Constraints of the bot alone (his toys' come after them). */
          this.nBotC = 0;
          /** The gait, set each step by the brain: how far a foot falls behind before it steps (bot heights), the rest after a step (s), how high a foot lifts. */
          this.gaitGap = 0.1;
          this.gaitRest = 0.075;
          this.gaitLift = 1;
          /** His look (an Avatar from the catalog; Blip unless told). */
          this.av = BLIP;
          /**
           * A MOMENT (a recipe from the catalog) he is playing, or null: how (a loop or once), where in it (s), how many loops,
           * whether its end is playing (after deliver), whether one has just finished; where he stood and faced at its start;
           * its random numbers for this play. Per track: fired yet (instants), on this play (chance), the next burst or glance
           * (track time), its prop's slot, its throws. When each event last fired (moment time; NaN: not yet).
           */
          this.mo = null;
          this.moLoop = false;
          this.moT = 0;
          this.moK = 0;
          this.moEnding = false;
          this.moDone = false;
          this.moX0 = 0;
          this.moSide = 1;
          this.moRnd = 0;
          this.moRnd2 = 0;
          this.moStamp = 0;
          this.moFired = new Uint8Array(MO_TRACKS);
          this.moOn = new Uint8Array(MO_TRACKS);
          this.moNext = new Float64Array(MO_TRACKS);
          this.moSlot = new Int8Array(MO_TRACKS);
          this.moThrow = new Uint16Array(MO_TRACKS);
          this.moEv = new Float64Array(MO_EVENTS);
          this.moVars = new Float64Array(MOMENT_VARS.length);
          /** The other bot a moment is with (his head, in this tile's space; NaN: none), and its index in the world. */
          this.peerX = NaN;
          this.peerY = NaN;
          this.partner = -1;
          /** A moment asked the bots near him to play something (the world hands it on): what, how many, how near. */
          this.outPlay = null;
          this.outN = 0;
          this.outNear = 0;
          /** A recipe's sound, by name (the app plays it, if it has it). */
          this.onSound = null;
          /** Set by a moment each step: his facing held (NaN: free), a shake (amplitude in bot heights, Hz, where), his eyes and mouth. */
          this.faceWant = NaN;
          this.shakeA = 0;
          this.shakeF = 0;
          this.shakeP = 0;
          this.eyeState = 0;
          this.mouthState = 0;
          this.mouthOpen = 1;
          /** Which way he faces for a moment's sake (1 right, -1 left), kept while he faces the person (face near 0 does not flip it). */
          this.faceSign = 1;
          /** A moment's hands over his face (1 the left, 2 the right): drawn in front of his head. */
          this.handOver = 0;
          /** The eye's size over his look's (a spring: wide eyes grow). */
          this.eyeK = 1;
          this.eyeKV = 0;
          /** A moment's particles: a pool, the next to use, how many live, the last thrown and the last dropped. */
          this.qx = new Float64Array(QCAP);
          this.qy = new Float64Array(QCAP);
          this.qvx = new Float64Array(QCAP);
          this.qvy = new Float64Array(QCAP);
          this.qlife = new Float64Array(QCAP);
          this.qmax = new Float64Array(QCAP);
          this.qt = new Float64Array(QCAP);
          this.qrot = new Float64Array(QCAP);
          this.qspin = new Float64Array(QCAP);
          this.qsize = new Float64Array(QCAP);
          this.qgrow = new Float64Array(QCAP);
          this.qg = new Float64Array(QCAP);
          this.qdrag = new Float64Array(QCAP);
          this.qalpha = new Float64Array(QCAP);
          this.qang = new Float64Array(QCAP);
          this.qorbR = new Float64Array(QCAP);
          this.qorbW = new Float64Array(QCAP);
          this.qflight = new Float64Array(QCAP);
          this.qflags = new Uint8Array(QCAP);
          this.qanc = new Int8Array(QCAP);
          this.qev = new Int8Array(QCAP);
          this.qpart = new Array(QCAP).fill(null);
          this.qpaint = new Array(QCAP).fill("");
          this.qNext = 0;
          this.qLive = 0;
          this.qLast = -1;
          this.qMiss = -1;
          /** Props a moment puts on him (party hat, bag): the part, where, how, and its pop (a spring to 1 while it lasts, to 0 after). */
          this.wparts = new Array(WSLOTS).fill(null);
          this.wanc = new Int8Array(WSLOTS);
          this.wx = new Float64Array(WSLOTS);
          this.wy = new Float64Array(WSLOTS);
          this.wsc = new Float64Array(WSLOTS);
          this.wrot = new Float64Array(WSLOTS);
          this.wpop = new Float64Array(WSLOTS);
          this.wpopV = new Float64Array(WSLOTS);
          this.wlive = new Uint8Array(WSLOTS);
          this.wseen = new Float64Array(WSLOTS);
          this.wtrack = new Int8Array(WSLOTS);
          this.wpaint = new Array(WSLOTS).fill("$color");
          this.wUsed = 0;
          /** An anchor's frame, filled by anchor(): its point, forward and down (unit vectors, mirrored by his facing). */
          this.af = new Float64Array(6);
          this.fixedS = 0;
          /** The Notes bot's pad, its width and height (px). */
          this.padW = 0;
          this.padH = 0;
          this.sitWant = 0;
          /** The Notes bot: when he next looks round while he listens, how long he listens, the page he watches fall, where his pencil writes. */
          this.noteLook = 0;
          this.listenFor = 0;
          this.pageSpark = -1;
          this.penX = NaN;
          this.penY = NaN;
          this.lookNext = 0;
          this.flyT = 0;
          this.catchIt = false;
          this.tmp = new Float64Array(2);
          /** Reduce Motion's pose is being taken: only the tracks that hold a pose count. */
          this.posing = false;
          /** The fill the face last set (so a light in the same paint needs no new one). */
          this.fillNow = "";
          this.kind = o.kind;
          this.color = o.color || INK;
          this.mood = o.mood ?? "idle";
          this.seed = (o.seed ?? 1) >>> 0;
          this.rand = rng(this.seed);
          this.fabric = new Fabric(this.seed);
          this.fixedS = o.size ?? 0;
          this.skin = { a: new Int8Array(DUST), b: new Int8Array(DUST), t: new Float32Array(DUST), u: new Float32Array(DUST), w: new Float32Array(DUST), head: new Uint8Array(DUST), lift: new Float32Array(DUST), n: 0 };
          this.on.fill(-1);
          this.av = o.avatar ?? BLIP;
          this.mrand = rng(this.seed ^ 0x2545f491);
          this.moSlot.fill(-1);
          this.wtrack.fill(-1);
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
      /**
       * On his own page (BotBuddy): what he does now (see BuddyAct). A change starts at once. "carry" again after a
       * delivery starts a new haul, from the first, light bag.
       */
      setAct(a) {
          const again = a === "carry" && this.delivered;
          if (a === this.moment && !again)
              return;
          this.moment = a;
          this.delivered = false;
          this.trip = 0;
          if (!this.placed)
              return;
          // Into carrying or out of it, the stage changes (his bag, or his toys); between other moments the toys stay where they are.
          if ((a === "carry") !== this.stageCarry || again)
              this.restage();
          this.next(true);
      }
      /**
       * Carrying: the answer is here. On stage he sets the bag down where he stands and walks off; off stage (or all but
       * gone) he is simply gone. Nothing for any other act.
       */
      deliver() {
          // A moment playing (and not carrying): its end, or its stop.
          if (this.mo && this.moment !== "carry") {
              this.deliverMoment();
              return;
          }
          if (this.moment !== "carry" || this.delivered)
              return;
          this.delivered = true;
          if (!this.placed || this.act !== A_CARRY)
              return;
          const x = this.x[HIP], S = this.S;
          if (this.still || this.phase === C_WAIT || this.phase === C_GONE) {
              this.carryTo(C_GONE);
              return;
          }
          // Leaving at the left, or barely in at the right: on his way, the bag with him.
          if (x < S * 0.4) {
              this.side = -1;
              this.carryTo(C_OFF);
              return;
          }
          if (x > this.w + S * 0.1) {
              this.side = 1;
              this.carryTo(C_OFF);
              return;
          }
          this.carryTo(C_DOWN);
      }
      /** Carrying: the answer was delivered and he has left the stage (it may fold away). */
      carryDone() {
          return this.moment === "carry" && this.delivered && (this.act !== A_CARRY || this.phase === C_GONE);
      }
      /** Where the page's ask field is from his stage ("down", "left", "right", "up"; anything else: none). He glances at it. */
      setLookTo(dir) {
          this.hintDir = dir === "down" ? 1 : dir === "left" ? 2 : dir === "right" ? 3 : dir === "up" ? 4 : 0;
      }
      /** A small happy moment: a hop with both arms up, and the antenna lights. */
      cheer() {
          // Carrying, his hands are full; in a moment, he is busy with it.
          if (this.act === A_CARRY || this.mo)
              return;
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
          // short legs and big feet, noodle arms, two antennae (one bent over). His head and antennae are his look's.
          this.lNeck = 0.255 * S;
          this.lTorso = 0.25 * S;
          this.lLeg = 0.15 * S;
          this.lArm = 0.14 * S;
          this.rH = this.av.headR * S;
          this.antennaGeometry();
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
          // Antennae (Blip's: A straight, B bent); each base sits on the head's crown, where his look puts it.
          let t = this.antTarget(bx, headY, 0, 0, 1);
          const a1x = t[0], a1y = t[1];
          this.addP(a1x, a1y, 0.12, 0.01, 0.97, 0, 0); // ANT_A1
          this.addP(a1x, a1y - this.antL2[0], 0.1, 0.01, 0.97, 0, 0); // ANT_A2
          t = this.antTarget(bx, headY, 0, 1, 1);
          const b1x = t[0], b1y = t[1];
          this.addP(b1x, b1y, 0.12, 0.01, 0.97, 0, 0); // ANT_B1
          this.addP(b1x + this.antL2[1] * 0.7, b1y - this.antL2[1] * 0.7, 0.1, 0.01, 0.97, 0, 0); // ANT_B2
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
          this.cAnt = this.nc;
          this.addC(HEAD, ANT_A1, this.rAntA1, 0.7, 1);
          this.addC(ANT_A1, ANT_A2, this.antL2[0], 0.8, 1);
          this.addC(HEAD, ANT_B1, this.rAntB1, 0.7, 1);
          this.addC(ANT_B1, ANT_B2, this.antL2[1], 0.8, 1);
          this.holdL = this.addC(HAND_L, HAND_L, 0, 0, 0);
          this.holdR = this.addC(HAND_R, HAND_R, 0, 0, 0);
          this.nBotC = this.nc;
          this.buildSkin();
          this.restage();
          if (this.kind === "make")
              this.scatterDust(true);
          this.blinkAt = 1 + this.rand() * 3;
          this.next(true);
      }
      /** His antennae from his look: where each sits on the crown, and how long (px). */
      antennaGeometry() {
          const av = this.av, r = this.rH, S = this.S;
          for (let s = 0; s < 2; s++) {
              this.antU0[s] = av.antUp[s] * r;
              this.antW0[s] = av.antAt[s] * r;
              this.antL1[s] = av.antLen[s] * S;
              this.antL2[s] = av.antTipLen[s] * S;
          }
          this.lAnt1 = this.antL1[0];
          this.lAnt2 = this.antL2[0];
      }
      /** Where an antenna's first joint wants to be: on the crown, out along its own angle (head at hx, hy, turned by `ang`). */
      antTarget(hx, hy, ang, which, face) {
          const f = face < 0 ? -1 : 1, c = Math.cos(ang), s = Math.sin(ang);
          const bu = this.antU0[which], bw = this.antW0[which] * f;
          // head space to the screen: across (c, s), up (s, -c)
          const ox = hx + c * bw + s * bu, oy = hy + s * bw - c * bu;
          const da = ang + this.av.antLean[which] * f;
          this.ant[0] = ox + Math.sin(da) * this.antL1[which];
          this.ant[1] = oy - Math.cos(da) * this.antL1[which];
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
          // His look's lattice: hex (Blip's) or square, never so fine that the dots would not fit.
          const av = this.av, hexed = av.dots !== 1;
          const area = Math.PI * av.headR * av.headW * av.headR * av.headH;
          const sp = Math.max(av.dotSp, Math.sqrt(area / (110 * 0.866))) * S, rim = 0.055 * S, rs = hexed ? sp * 0.866 : sp;
          const round = av.head !== 2 && av.headW === 1 && av.headH === 1;
          // The head: a disc on a hex lattice (or his head's own shape). kind 1: inside (a perforation), 3: on the rim (Make a bot only).
          const N = Math.max(5, Math.ceil((r * Math.max(av.headW, av.headH)) / rs));
          for (let row = -N; row <= N; row++) {
              const u = hexed ? row * sp * 0.866 : row * sp, off = hexed && row % 2 ? sp / 2 : 0;
              for (let col = -N; col <= N; col++) {
                  const w = col * sp + off, d = round ? Math.sqrt(u * u + w * w) : this.headDist(u, w);
                  if (d > r - 0.02 * S)
                      continue;
                  put(NECK, HEAD, 1, u, w, d > r - rim ? 3 : 1, 0.66 + (u / r) * 0.25);
              }
          }
          // The body, from the hips up: wider at the bottom.
          const L = this.lTorso, M = Math.max(4, Math.ceil((av.bodyBottom * S) / sp) + 1);
          for (let row = 0;; row++) {
              const u = 0.025 * S + (hexed ? row * sp * 0.866 : row * sp);
              if (u > L - 0.01 * S)
                  break;
              const hw = av.bodyBottom * S + (av.bodyTop * S - av.bodyBottom * S) * (u / L) - 0.015 * S, off = hexed && row % 2 ? sp / 2 : 0;
              for (let col = -M; col <= M; col++) {
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
      /**
       * How far (u up, w across, head space) is from the middle of his head, as a radius: a round head's distance, an oval's
       * scaled to it, a square's (rounded) corner as far as its side.
       */
      headDist(u, w) {
          const av = this.av, a = w / av.headW, b = u / av.headH;
          if (av.head !== 2)
              return Math.sqrt(a * a + b * b);
          const p = 2 + 8 * (1 - av.headRound), q = Math.pow(Math.abs(a), p) + Math.pow(Math.abs(b), p);
          return Math.pow(q, 1 / p);
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
          else if (this.kind === "notes") {
              // A little pad, standing on the floor until he picks it up.
              this.padW = 0.3 * S;
              this.padH = 0.36 * S;
              this.addPad(w * (0.62 + r() * 0.08), fl - this.padH / 2 - 0.5, this.padW, this.padH);
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
      /** What is on the stage with him, made afresh: his kind's toys, or (carrying) his bag alone. */
      restage() {
          this.release();
          this.n = NBOT;
          this.nc = this.nBotC;
          this.np = 0;
          this.ghost = -1;
          this.stageCarry = this.moment === "carry" && this.kind !== "make";
          if (this.stageCarry)
              this.addBag();
          else
              this.props();
      }
      /**
       * The bag: a sack on a short tie, two bodies. The knot (light) is what a hand holds; the sack (its weight) hangs from
       * it on a rigid tie, so it swings as he walks. Its size and weight are set per trip (packBag).
       */
      addBag() {
          const p = this.np++;
          this.pk[p] = P_BAG;
          this.pn[p] = 2;
          const S = this.S, r = S * CARRY.bagLight, x = this.w + S * 0.95, y = this.floor - S * 0.5;
          const a = this.addP(x, y, 0.08, S * 0.02, 0.99, 0, 0.8);
          this.addP(x, y + S * 0.03 + r, CARRY.massLight, r, 0.993, 0.05, 0.9);
          this.p0[p] = a;
          this.pr[p] = r;
          this.addC(a, a + 1, S * 0.03 + r, 1, 1);
      }
      /** The tie's length for a sack of radius r: from the knot to the sack's middle. */
      tieOf(r) { return this.S * 0.035 + r * 0.92; }
      /** This trip's bag: its size and weight from the load (0 light, 1 the heaviest). */
      packBag(load) {
          if (!this.stageCarry || this.np < 1)
              return;
          const S = this.S, a = this.p0[0], b = a + 1;
          const r = S * (CARRY.bagLight + (CARRY.bagHeavy - CARRY.bagLight) * load);
          this.pr[0] = r;
          this.rad[b] = r;
          this.im[b] = 1 / (CARRY.massLight + (CARRY.massHeavy - CARRY.massLight) * load);
          this.cr[this.nBotC] = this.tieOf(r);
          this.bagFade = 1;
          this.bagDownAt = -1;
      }
      /** Where the hand that carries the bag holds it: over the shoulder at his back (`back`: +1, his back is to the right). */
      carryGrip(back) {
          const S = this.S;
          this.armR = true;
          this.armRx = this.x[NECK] + back * S * (0.24 + 0.03 * this.load);
          this.armRy = this.y[NECK] - S * (0.04 + 0.13 * this.load);
          // Heavy: both hands on it.
          if (this.load >= 0.5) {
              this.armL = true;
              this.armLx = this.x[NECK] + back * S * 0.19;
              this.armLy = this.y[NECK] - S * (0.02 + 0.08 * this.load);
          }
          this.armK = 900 + 500 * this.load;
      }
      /** The bag in his hand where it hangs, at rest (a trip's start, Reduce Motion's pose). */
      hangBag() {
          if (!this.stageCarry || this.np < 1)
              return;
          const a = this.p0[0], b = a + 1, hx = this.x[HAND_R], hy = this.y[HAND_R];
          this.x[a] = hx;
          this.y[a] = hy;
          this.x[b] = hx;
          this.y[b] = hy + this.tieOf(this.pr[0]);
          this.px[a] = this.x[a];
          this.py[a] = this.y[a];
          this.px[b] = this.x[b];
          this.py[b] = this.y[b];
          this.hold(0, this.load >= 0.5 ? a : -1, a);
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
      /** The Notes bot's pad: a rigid rectangle of four particles (clockwise on screen: top left, top right, bottom right, bottom left). */
      addPad(cx, cy, pw, ph) {
          const p = this.np++;
          this.pk[p] = P_PAD;
          this.pr[p] = Math.max(pw, ph) / 2;
          this.pn[p] = 4;
          this.pa[p] = 0; // lines written on this page (the fraction is the line he is on)
          this.ptime[p] = 0; // pages torn off so far
          const hw = pw / 2, hh = ph / 2;
          const a = this.addP(cx - hw, cy - hh, 0.3, 0.4, 0.998, 0.05, 0.85);
          this.addP(cx + hw, cy - hh, 0.3, 0.4, 0.998, 0.05, 0.85);
          this.addP(cx + hw, cy + hh, 0.3, 0.4, 0.998, 0.05, 0.85);
          this.addP(cx - hw, cy + hh, 0.3, 0.4, 0.998, 0.05, 0.85);
          this.p0[p] = a;
          const dg = Math.hypot(pw, ph);
          this.addC(a, a + 1, pw, 1, 1);
          this.addC(a + 1, a + 2, ph, 1, 1);
          this.addC(a + 2, a + 3, pw, 1, 1);
          this.addC(a + 3, a, ph, 1, 1);
          this.addC(a, a + 2, dg, 1, 1);
          this.addC(a + 1, a + 3, dg, 1, 1);
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
          if (this.qLive > 0 || this.wUsed > 0)
              this.thingsStep(h);
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
          if (this.kind === "notes")
              this.padSprings();
          if (this.stageCarry)
              this.bagSprings();
          if (this.shakeA > 0 && live > 0)
              this.shakeForces(live);
      }
      /** The bag put down: it sits, its tie standing up a little slumped (a spring on the knot), not lying flat. */
      bagSprings() {
          if (this.held === 0 || this.np < 1)
              return;
          const a = this.p0[0], b = a + 1;
          if (this.y[b] < this.floor - this.rad[b] - this.S * 0.03)
              return;
          const tx = this.x[b] + this.S * 0.03, ty = this.y[b] - this.tieOf(this.pr[0]);
          this.ax[a] += (tx - this.x[a]) * 300 - this.vx(a) * 12;
          this.ay[a] += (ty - this.y[a]) * 300 - this.vy(a) * 12 - this.g;
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
                  if (this.hit[f] & (C_FLOOR | C_SUPPORT) && off > this.gaitGap * S && off > wd) {
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
                  this.setV(worst, clamp((want - x[worst]) / tAir, -14 * S, 14 * S), -this.g * tAir * 0.5 * this.gaitLift);
                  this.stepCool = this.gaitRest;
                  this.dip = 1;
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
              // The tip: straight on, or bent over (Blip's A and B).
              const dx = x[j1] - hx, dy = y[j1] - hy, d = Math.sqrt(dx * dx + dy * dy) + 1e-6;
              let ux = dx / d, uy = dy / d;
              const bend = this.av.antBend[s];
              if (bend !== 0) {
                  const b = bend * f, c = Math.cos(b), sn = Math.sin(b);
                  const rx = ux * c - uy * sn, ry = ux * sn + uy * c;
                  ux = rx;
                  uy = ry;
              }
              const tx = x[j1] + ux * this.antL2[s], ty = y[j1] + uy * this.antL2[s];
              this.ax[j2] += (tx - x[j2]) * 380 - (this.vx(j2) - this.vx(j1)) * 5;
              this.ay[j2] += (ty - y[j2]) * 380 - (this.vy(j2) - this.vy(j1)) * 5;
          }
      }
      /** The hand the Notes bot holds his pad in (the one behind him), and the one he writes with. */
      padHand() { return this.face >= 0 ? HAND_L : HAND_R; }
      penHand() { return this.face >= 0 ? HAND_R : HAND_L; }
      /** The pad's top left corner as he holds it: out in front of him, its near edge in his holding hand, a little below the middle. */
      padLeft() { return this.face >= 0 ? this.x[this.padHand()] : this.x[this.padHand()] - this.padW; }
      padTop() { return this.y[this.padHand()] - this.padH * 0.62; }
      /**
       * The held pad: its corners pulled by springs to an upright rectangle on his holding hand (gravity carried by the
       * grip). Let go, nothing holds it, and it falls where it is.
       */
      padSprings() {
          if (this.held < 0 || this.pk[this.held] !== P_PAD)
              return;
          const a = this.p0[this.held], L = this.padLeft(), T = this.padTop(), hand = this.padHand();
          const hvx = this.vx(hand), hvy = this.vy(hand);
          for (let k = 0; k < 4; k++) {
              const i = a + k;
              const tx = L + (k === 1 || k === 2 ? this.padW : 0), ty = T + (k >= 2 ? this.padH : 0);
              this.ax[i] += (tx - this.x[i]) * 700 - (this.vx(i) - hvx) * 30;
              this.ay[i] += (ty - this.y[i]) * 700 - (this.vy(i) - hvy) * 30 - this.g;
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
              if (this.limp > 0.5 || p === this.ghost || kind === P_BAG)
                  continue;
              for (let i = 0; i < NBOT; i++) {
                  if (i === ELB_L || i === ELB_R || i >= ANT_A1)
                      continue;
                  this.partProp(i, p);
              }
          }
          // The tile's bounds (his bag goes where he goes, off stage too).
          const bl = this.wallL, br = this.wallR, own = this.stageCarry;
          for (let i = 0; i < n; i++) {
              if (this.im[i] === 0)
                  continue;
              const r = this.rad[i];
              const L = i < NBOT || own ? bl : 3, R = i < NBOT || own ? br : this.w - 3;
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
          // A moment holding his facing (a spin, a turn to the other bot).
          if (this.faceWant === this.faceWant)
              this.faceTo = this.faceWant;
          this.faceV += ((this.faceTo - this.face) * 70 - this.faceV * 13) * h;
          this.face = clamp(this.face + this.faceV * h, -1, 1);
          if (this.face > 0.25)
              this.faceSign = 1;
          else if (this.face < -0.25)
              this.faceSign = -1;
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
          // Wide eyes grow (a spring, so they pop).
          if (this.eyeState === EYE_WIDE || this.eyeK !== 1) {
              this.eyeKV += (((this.eyeState === EYE_WIDE ? 1.32 : 1) - this.eyeK) * 900 - this.eyeKV * 34) * h;
              this.eyeK += this.eyeKV * h;
              if (this.eyeState !== EYE_WIDE && Math.abs(this.eyeK - 1) < 1e-3 && Math.abs(this.eyeKV) < 0.01) {
                  this.eyeK = 1;
                  this.eyeKV = 0;
              }
          }
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
          this.shome[i] = 0;
      }
      sparksStep(h) {
          for (let i = 0; i < SPARKS; i++) {
              if (this.slife[i] <= 0)
                  continue;
              if (this.shome[i] === S_PAGE) {
                  // A torn-off page: paper. Light, a lot of air drag, rocked from side to side as it falls; it lands, and fades.
                  const S = this.S, rest = this.floor - S * 0.03;
                  if (this.sy[i] < rest) {
                      this.svx[i] = this.svx[i] + (Math.sin(this.t * 5.5 + i * 1.7) * S * 9 - this.svx[i] * 3.2) * h;
                      this.svy[i] = this.svy[i] + (this.g * 0.22 - this.svy[i] * 4.5) * h;
                      this.slife[i] = this.slife[i] - h * 0.22;
                  }
                  else {
                      this.sy[i] = rest;
                      this.svy[i] = 0;
                      this.svx[i] = this.svx[i] * (1 - Math.min(1, 8 * h));
                      this.slife[i] = this.slife[i] - h * 0.7;
                  }
                  this.sx[i] = clamp(this.sx[i] + this.svx[i] * h, 3, this.w - 3);
                  this.sy[i] = Math.min(rest, this.sy[i] + this.svy[i] * h);
                  continue;
              }
              if (this.shome[i] === 1) {
                  // Into his head: a damped pull to it; it is gone when it arrives, and the antenna lights a little.
                  const dx = this.x[HEAD] - this.sx[i], dy = this.y[HEAD] - this.sy[i];
                  if (dx * dx + dy * dy < this.rH * this.rH) {
                      this.slife[i] = 0;
                      this.glowV += 2.5;
                      continue;
                  }
                  this.svx[i] = this.svx[i] + (dx * 14 - this.svx[i] * 3.2) * h;
                  this.svy[i] = this.svy[i] + (dy * 14 - this.svy[i] * 3.2) * h;
                  this.sx[i] = this.sx[i] + this.svx[i] * h;
                  this.sy[i] = this.sy[i] + this.svy[i] * h;
                  this.slife[i] = this.slife[i] - h * 0.45;
                  continue;
              }
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
          const m = this.moment;
          if (m === "carry" && this.stageCarry) {
              this.act = A_CARRY;
              this.actDur = 1e9;
              this.carryTo(this.delivered ? C_GONE : C_WAIT);
              return;
          }
          if (m === "think" && this.kind !== "make") {
              this.act = A_THINK;
              this.actDur = 99;
              return;
          }
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
          if (m === "read") {
              this.act = A_READ;
              this.actDur = 99;
              return;
          }
          if (m === "survey") {
              this.act = A_SURVEY;
              this.actDur = 99;
              this.tx = this.w * (0.15 + r * 0.7);
              return;
          }
          if (m === "settle") {
              if (r < 0.85) {
                  this.act = A_SIT;
                  this.actDur = 5 + this.rand() * 4;
              }
              else {
                  this.act = A_STRETCH;
                  this.actDur = 1.6;
              }
              return;
          }
          if (m === "wave") {
              if (r < 0.4) {
                  this.act = A_WAVE;
                  this.actDur = 2.4;
              }
              else {
                  this.act = A_PLAY;
                  this.actDur = 8;
              }
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
          this.penX = NaN;
          this.speed = this.mood === "working" ? 1.3 : 0.85;
          this.gaitGap = 0.1;
          this.gaitRest = 0.075;
          this.gaitLift = 1;
          this.lookOut = 0;
          this.lidTo = this.mood === "idle" ? 0.22 : 0.1;
          this.wallL = 3;
          this.wallR = this.w - 3;
          this.faceWant = NaN;
          this.shakeA = 0;
          this.handOver = 0;
          this.eyeState = EYE_REST;
          this.mouthState = MO_REST;
          this.mouthOpen = 1;
          // Carrying, he comes in and goes out past the stage's edges.
          if (this.act === A_CARRY) {
              this.wallL = -S * 1.4;
              this.wallR = this.w + S * 1.4;
          }
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
          // A moment (a recipe) holds him while it plays: a tap's look still wins, and carrying wins over it.
          if (this.mo && this.act !== A_CARRY) {
              this.runMoment(h);
              this.sitTo(this.sitWant, h);
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
              case A_WAVE:
                  this.waving();
                  break;
              case A_SURVEY:
                  this.survey();
                  break;
              case A_READ:
                  this.reading();
                  break;
              case A_THINK:
                  this.thinking();
                  break;
              case A_CARRY:
                  this.carrying(h);
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
              if (this.hintDir > 0 && this.rand() < 0.5)
                  this.lookToHint();
              else if (this.rand() < 0.25) {
                  this.lookX = NaN;
                  this.lookOut = 1;
              }
              else {
                  this.lookX = this.w * this.rand();
                  this.lookY = this.floor * (0.1 + this.rand() * 0.9);
              }
          }
      }
      /** A glance at the page's ask field (BotBuddy lookTo): below his stage, beside it, or above. */
      lookToHint() {
          const d = this.hintDir, S = this.S;
          this.lookOut = 0;
          this.lookX = d === 2 ? -this.w : d === 3 ? this.w * 2 : this.x[HEAD] + (this.face >= 0 ? 1 : -1) * S * 0.5;
          this.lookY = d === 1 ? this.h + S * 4 : d === 4 ? -S * 4 : this.floor * 0.5;
      }
      /** Hello: turned to the person, one hand up and waving, a small bob first. */
      waving() {
          const S = this.S, t = this.actT;
          this.goalX = NaN;
          this.lookOut = 1;
          this.lookX = NaN;
          this.lidTo = 0;
          if (t < 0.14) {
              this.crouch = 0.3;
              return;
          }
          if (t > 2.1)
              return;
          this.armR = true;
          this.armK = 420;
          this.armRx = this.x[NECK] + S * (0.2 + 0.08 * Math.sin((t - 0.14) * 15));
          this.armRy = this.y[NECK] - S * 0.24;
      }
      /** Over a list below him: a slow walk along it with his head bent to it, and a stop now and then to look closer. */
      survey() {
          const S = this.S;
          this.speed = 0.55;
          let dir = this.face >= 0 ? 1 : -1;
          if (this.phase === 0) {
              this.goalX = this.tx;
              dir = this.tx >= this.x[HIP] ? 1 : -1;
              if ((Math.abs(this.x[HIP] - this.tx) < S * 0.2 && this.phaseT > 0.4) || this.phaseT > 4) {
                  this.phase = 1;
                  this.phaseT = 0;
              }
          }
          else {
              this.goalX = NaN;
              this.crouch = 0.15;
              this.lean = 0.1 * dir;
              if (this.phaseT > 1.2) {
                  this.phase = 0;
                  this.phaseT = 0;
                  const to = this.w * (0.12 + this.rand() * 0.76);
                  this.tx = Math.abs(to - this.x[HIP]) < S * 0.6 ? this.w - to : to;
              }
          }
          this.lookX = this.x[HEAD] + dir * S * 0.9;
          this.lookY = this.floor + S * 2.5;
          this.tilt = 0.22 * dir;
          this.lidTo = 0.15;
      }
      /** Reading: he stands still, eyes half closed, and dots and short lines flow in from the right and above into his head. */
      reading() {
          const S = this.S, home = this.w * 0.3;
          if (this.phase === 0) {
              this.goalX = home;
              if (Math.abs(this.x[HIP] - home) < S * 0.25 || this.actT > 3)
                  this.phase = 1;
          }
          else
              this.goalX = NaN;
          this.lookX = this.w;
          this.lookY = this.y[HEAD] - S * 0.25;
          this.lidTo = 0.4;
          this.tilt = 0.06;
          if (this.phaseT > 0.12) {
              this.phaseT = 0;
              const top = this.rand() < 0.3;
              const x = top ? this.w * (0.45 + this.rand() * 0.5) : this.w - 2;
              const y = top ? 2 : this.floor * (0.12 + this.rand() * 0.7);
              const i = this.sNext;
              this.spark(x, y, -S * (1.2 + this.rand()), (this.rand() - 0.5) * S * 1.5, 0);
              this.shome[i] = 1;
          }
      }
      /** Thinking (an answer is on its way): still, a hand to his chin, eyes up and aside, the antenna pulsing, small dots rising. */
      thinking() {
          const S = this.S, f = this.face >= 0 ? 1 : -1;
          this.goalX = NaN;
          if (f > 0) {
              this.armR = true;
              this.armRx = this.x[HEAD] + S * 0.06;
              this.armRy = this.y[HEAD] + this.rH * 1.05;
          }
          else {
              this.armL = true;
              this.armLx = this.x[HEAD] - S * 0.06;
              this.armLy = this.y[HEAD] + this.rH * 1.05;
          }
          this.armK = 340;
          this.tilt = -0.16 * f;
          this.lookX = this.x[HEAD] + f * S * 0.8;
          this.lookY = this.y[HEAD] - S;
          this.lidTo = 0.3;
          if (this.phaseT > 0.55) {
              this.phaseT = 0;
              this.glowV += 7;
              this.spark(this.x[HEAD] + f * this.rH * 0.8, this.y[HEAD] - this.rH * 1.4, f * S * 0.3, -S * 0.9, 1.25);
          }
      }
      /** Carrying: into a phase, and what starting it takes. */
      carryTo(ph) {
          this.phase = ph;
          this.phaseT = 0;
          const S = this.S;
          if (ph === C_WAIT) {
              // Off stage at the right, out of sight: this trip's bag, a step heavier each trip, the heaviest from CARRY.trips on.
              this.load = clamp(this.trip / Math.max(1, CARRY.trips - 1), 0, 1);
              this.release();
              this.face = -1;
              this.faceV = 0;
              this.faceTo = -1;
              this.lookX = NaN;
              this.standAt(this.w + S * 0.95);
              this.packBag(this.load);
              // His hands already where they hold it, and the bag hanging from them.
              this.carryGrip(1);
              this.x[HAND_R] = this.armRx;
              this.y[HAND_R] = this.armRy;
              this.px[HAND_R] = this.armRx;
              this.py[HAND_R] = this.armRy;
              if (this.armL) {
                  this.x[HAND_L] = this.armLx;
                  this.y[HAND_L] = this.armLy;
                  this.px[HAND_L] = this.armLx;
                  this.py[HAND_L] = this.armLy;
              }
              this.hangBag();
              this.side = -1;
              this.dip = 0;
          }
          else if (ph === C_WALK) {
              this.sweatAt = this.t + 0.8 / (this.carryPace > 0 ? this.carryPace : 1);
              this.hitchAt = 0;
              this.hitchT = 0;
          }
          else if (ph === C_GONE) {
              this.release();
              this.bagFade = 0;
          }
      }
      /**
       * Carrying (act "carry"): trip after trip, in from the right with the bag over his shoulder, slowly across, out at the
       * left; off stage a moment, and in again with a heavier bag. The answer is here (deliver): he lowers the bag to the
       * floor, lets go, and walks off light; the bag gives its place to the answer. All of it on the act's own clock.
       */
      carrying(h) {
          const S = this.S, pace = this.carryPace > 0 ? this.carryPace : 1, x = this.x[HIP], L = this.load, held = this.held === 0;
          this.dip = Math.max(0, this.dip - h * 5);
          if (this.phase === C_WAIT) {
              this.goalX = NaN;
              if (held)
                  this.carryGrip(1);
              this.lookX = this.x[HEAD] - S * 3;
              this.lookY = this.y[HEAD];
              if (this.phaseT >= (this.trip === 0 ? CARRY.firstWait : CARRY.wait) / pace)
                  this.carryTo(C_WALK);
          }
          else if (this.phase === C_WALK) {
              this.goalX = -S * 1.2;
              this.speed = ((CARRY.paceLight + (CARRY.paceHeavy - CARRY.paceLight) * L) * pace) / 7.5;
              this.haul(L, -1, pace);
              if (x < -S * 0.85) {
                  this.trip++;
                  this.carryTo(C_WAIT);
              }
          }
          else if (this.phase === C_DOWN) {
              // Down with it: the bag lowered to the floor at his back, and let go once it sits there.
              this.goalX = NaN;
              const r = this.pr[0], b = this.p0[0] + 1;
              const tx = x + S * 0.24, ty = this.floor - this.tieOf(r) - r - S * 0.01;
              if (held) {
                  this.crouch = 0.75;
                  this.armR = true;
                  this.armRx = tx;
                  this.armRy = ty;
                  if (L >= 0.5) {
                      this.armL = true;
                      this.armLx = tx - S * 0.03;
                      this.armLy = ty;
                  }
                  this.armK = 700;
                  this.lean = 0.14;
                  this.tilt = 0.2;
                  this.lookX = tx;
                  this.lookY = this.floor;
                  if ((this.phaseT > 0.35 / pace && this.y[b] + this.rad[b] >= this.floor - 0.6) || this.phaseT > 1 / pace) {
                      this.release();
                      this.bagDownAt = this.t;
                      this.glowV += 7;
                      this.phaseT = 0;
                  }
              }
              else {
                  // Down: a stretch, arms up, light again; then off.
                  this.lookOut = 1;
                  this.lookX = NaN;
                  if (this.phaseT > 0.1 / pace && this.phaseT < 0.55 / pace) {
                      this.armL = this.armR = true;
                      this.armK = 300;
                      this.armLx = this.x[NECK] - S * 0.12;
                      this.armLy = this.y[NECK] - S * 0.26;
                      this.armRx = this.x[NECK] + S * 0.12;
                      this.armRy = this.y[NECK] - S * 0.26;
                      this.crouch = -0.1;
                      this.lidTo = 0.85;
                  }
                  if (this.phaseT > 0.7 / pace) {
                      this.side = -1;
                      this.carryTo(C_OFF);
                  }
              }
          }
          else if (this.phase === C_OFF) {
              // Light again (or, caught at an edge, still with it): off the way he faces.
              const d = this.side < 0 ? -1 : 1;
              this.goalX = d < 0 ? -S * 1.3 : this.w + S * 1.3;
              if (held) {
                  this.speed = ((CARRY.paceLight + (CARRY.paceHeavy - CARRY.paceLight) * L) * pace) / 7.5;
                  this.haul(L, d, pace);
              }
              else {
                  this.speed = (CARRY.paceLight * 1.3 * pace) / 7.5;
                  this.lookX = this.x[HEAD] + d * S * 3;
                  this.lookY = this.y[HEAD];
              }
              if ((d < 0 && x < -S * 0.85) || (d > 0 && x > this.w + S * 0.95))
                  this.carryTo(C_GONE);
          }
          else {
              this.goalX = NaN;
          }
          // Once down, the bag gives its place to the answer.
          if (this.bagDownAt >= 0)
              this.bagFade = clamp(1 - (this.t - this.bagDownAt - 0.45 / pace) / 0.6, 0, 1);
      }
      /**
       * Hauling the bag (load 0 to 1) toward `dir`: his grip over the shoulder, the lean into it, the slow, low, heavy gait
       * and the dip after each step (the legs' own spring does the bob), tired eyes on the floor ahead, and, heavy, sweat.
       */
      haul(L, dir, pace) {
          const S = this.S;
          this.carryGrip(-dir);
          this.lean = dir * (0.05 + 0.3 * L);
          this.tilt = dir * 0.08 * L;
          this.crouch = 0.04 + 0.2 * L + (0.06 + 0.26 * L) * this.dip;
          // A hitch (from a middling load on): he slows, dips, and heaves the bag up over his shoulder; it swings.
          if (L >= 0.4) {
              if (this.hitchAt <= 0)
                  this.hitchAt = this.t + (1.2 + this.rand() * 0.8) / pace;
              if (this.t >= this.hitchAt) {
                  this.hitchT = 0.42 / pace;
                  this.hitchAt = this.t + (3.4 - 0.8 * L + this.rand()) / pace;
              }
          }
          if (this.hitchT > 0) {
              this.hitchT -= STEP;
              const k = this.hitchT * pace;
              this.speed *= 0.35;
              if (k > 0.22)
                  this.crouch += 0.25 * L;
              else {
                  this.armRy -= S * 0.08;
                  if (this.armL)
                      this.armLy -= S * 0.07;
              }
          }
          this.gaitGap = 0.1 + 0.04 * L;
          this.gaitRest = 0.055 + 0.09 * L;
          this.gaitLift = 1 - 0.35 * L;
          this.lookX = this.x[HEAD] + dir * S * 2.5;
          this.lookY = this.y[HEAD] + S * (0.15 + 0.9 * L);
          this.lidTo = 0.12 + 0.36 * L;
          if (L >= CARRY.sweatFrom && this.t >= this.sweatAt) {
              this.sweatAt = this.t + (1.5 - 0.6 * L) / pace;
              const i = this.sNext;
              this.spark(this.x[HEAD] + dir * this.rH * 0.55, this.y[HEAD] - this.rH * 0.5, -dir * S * 0.6, -S * 0.8, 0);
              this.shome[i] = S_SWEAT;
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
              case "notes":
                  this.scribble(h);
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
      // ---- Notes: picks up his little pad, listens (a look round), scribbles a line, and another; a full page he tears
      // off, and it flutters down to the floor. Busy (a meeting is being noted): he listens less and writes faster.
      /** Where his pencil goes on line j of the page, `cur` of the way along it (a scribble: a quick wobble on the line). */
      penAt(j, cur) {
          const L = this.padLeft(), T = this.padTop(), pw = this.padW, ph = this.padH;
          const len = 0.55 + 0.4 * hash01(this.ptime[0] * 7 + j);
          this.penX = L + pw * (0.16 + 0.68 * len * cur);
          this.penY = T + ph * (0.3 + 0.15 * j) + Math.sin(this.t * 41) * this.S * 0.014;
      }
      /** Reach one hand to (x, y). */
      reach(hand, x, y) {
          if (hand === HAND_L) {
              this.armL = true;
              this.armLx = x;
              this.armLy = y;
          }
          else {
              this.armR = true;
              this.armRx = x;
              this.armRy = y;
          }
      }
      scribble(h) {
          const S = this.S, busy = this.mood === "working", p = 0;
          if (this.np < 1 || this.pk[p] !== P_PAD) {
              this.goalX = NaN;
              return;
          }
          const a = this.p0[p];
          if (this.held !== p) {
              // Go to the pad, crouch, and pick it up by its near top corner.
              const cx = (this.x[a] + this.x[a + 1] + this.x[a + 2] + this.x[a + 3]) / 4;
              const cy = (this.y[a] + this.y[a + 1] + this.y[a + 2] + this.y[a + 3]) / 4;
              const side = this.x[HIP] < cx ? -1 : 1;
              this.goalX = clamp(cx + side * (this.padW * 0.5 + S * 0.14), this.wallL + S * 0.2, this.wallR - S * 0.2);
              this.lookX = cx;
              this.lookY = cy;
              if (Math.abs(this.x[HIP] - this.goalX) < S * 0.14 && this.grounded) {
                  this.crouch = 0.6;
                  const hand = this.padHand(), ci = side < 0 ? a : a + 1;
                  this.reach(hand, this.x[ci], this.y[ci]);
                  const d = Math.hypot(this.x[hand] - this.x[ci], this.y[hand] - this.y[ci]);
                  if ((this.phaseT > 0.3 && d < S * 0.22) || this.phaseT > 1.4) {
                      this.held = p;
                      this.phase = 1;
                      this.phaseT = 0;
                      this.noteLook = this.actT;
                      this.listenFor = 0.4;
                      this.glowV += 3;
                  }
              }
              else
                  this.phaseT = 0;
              if (this.actT > 8)
                  this.next(true);
              return;
          }
          // Held: the pad against his chest, its near edge in his holding hand; the pencil in the other.
          const f = this.face >= 0 ? 1 : -1, pen = this.penHand();
          this.goalX = NaN;
          if (this.phase !== 5)
              this.reach(this.padHand(), this.x[NECK] + f * 0.1 * S, this.y[NECK] + 0.2 * S);
          if (this.phase === 0) {
              this.phase = 1;
              this.phaseT = 0;
              this.noteLook = this.actT;
              this.listenFor = busy ? 0.5 : 1.2;
          }
          if (this.phase === 1) {
              // Listening: a look round (at whoever is talking), the antenna pulsing now and then.
              this.lidTo = 0.12;
              if (this.actT >= this.noteLook) {
                  this.noteLook = this.actT + 0.45 + this.rand() * 0.7;
                  if (this.rand() < 0.3) {
                      this.lookX = NaN;
                      this.lookOut = 1;
                  }
                  else {
                      this.lookOut = 0;
                      this.lookX = this.w * this.rand();
                      this.lookY = this.floor * (0.15 + this.rand() * 0.5);
                  }
                  if (this.rand() < 0.4)
                      this.glowV += 2.5;
              }
              if (this.lookX !== this.lookX)
                  this.lookOut = 1;
              if (this.phaseT > this.listenFor) {
                  const done = this.count >= (busy ? 4 : 2) || this.actT > this.actDur * 2.5;
                  this.phase = done ? 5 : 2;
                  this.phaseT = 0;
              }
          }
          else if (this.phase === 2) {
              // Writing: head bent to the pad, the pencil running along the line.
              const before = Math.floor(this.pa[p]);
              this.pa[p] = Math.min(PAD_LINES, this.pa[p] + h * (busy ? 1.5 : 0.85));
              const j = Math.floor(this.pa[p]);
              if (j >= PAD_LINES) {
                  this.phase = 3;
                  this.phaseT = 0;
                  return;
              }
              this.penAt(j, this.pa[p] - j);
              this.reach(pen, this.penX, this.penY);
              this.armK = 650;
              this.lookOut = 0;
              this.lookX = this.penX;
              this.lookY = this.penY;
              this.tilt = 0.12 * f;
              this.lidTo = 0.38;
              if (j > before) {
                  // A line done: a little glow; now and then he stops to listen again.
                  this.glowV += 2;
                  if (this.rand() < (busy ? 0.25 : 0.45)) {
                      this.phase = 1;
                      this.phaseT = 0;
                      this.listenFor = busy ? 0.45 + this.rand() * 0.4 : 0.9 + this.rand() * 1.1;
                  }
              }
          }
          else if (this.phase === 3) {
              // The page is full: a hand to its far top corner, and a quick pull up and away.
              const L = this.padLeft(), T = this.padTop();
              const cx = f > 0 ? L + this.padW : L;
              this.reach(pen, cx, T + S * 0.02);
              this.armK = 600;
              this.lookOut = 0;
              this.lookX = cx;
              this.lookY = T;
              if (this.phaseT > (busy ? 0.18 : 0.3)) {
                  const i = this.sNext;
                  this.spark(L + this.padW * 0.5, T + this.padH * 0.4, f * S * (1.1 + this.rand() * 0.8), -S * (1.8 + this.rand() * 0.8), 0);
                  this.shome[i] = S_PAGE;
                  this.pageSpark = i;
                  this.pa[p] = 0;
                  this.ptime[p] = this.ptime[p] + 1;
                  this.count++;
                  this.glowV += 5;
                  this.fabric.kick(L + this.padW * 0.5, T, 25, S);
                  this.phase = 4;
                  this.phaseT = 0;
              }
          }
          else if (this.phase === 4) {
              // Watch it go.
              const i = this.pageSpark;
              if (i >= 0 && this.slife[i] > 0) {
                  this.lookOut = 0;
                  this.lookX = this.sx[i];
                  this.lookY = this.sy[i];
              }
              this.tilt = 0.15 * f;
              if (this.phaseT > (busy ? 0.6 : 1.1)) {
                  this.phase = 1;
                  this.phaseT = 0;
                  this.listenFor = busy ? 0.4 : 0.8;
              }
          }
          else if (this.phase === 5) {
              // Enough for now: a crouch, and he puts it down.
              this.crouch = 0.6;
              this.reach(this.padHand(), this.x[NECK] + f * 0.14 * S, this.y[NECK] + 0.27 * S);
              this.lookOut = 0;
              this.lookX = this.x[NECK] + f * S * 0.2;
              this.lookY = this.floor;
              if (this.phaseT > 0.45)
                  this.next(true);
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
          this.y[ANT_A2] = t[1] - this.antL2[0];
          t = this.antTarget(bx, this.y[HEAD], 0, 1, f);
          this.x[ANT_B1] = t[0];
          this.y[ANT_B1] = t[1];
          this.x[ANT_B2] = t[0] + f * this.antL2[1] * 0.7;
          this.y[ANT_B2] = t[1] - this.antL2[1] * 0.7;
          for (let i = 0; i < NBOT; i++) {
              this.px[i] = this.x[i];
              this.py[i] = this.y[i];
          }
          this.grounded = 2;
      }
      // ------------------------------------------------------------------- looks and moments
      /** Wear a look (null: Blip). Where he is stays; his head, antennae and dots take the new look at once. */
      setAvatar(av) {
          const a = av ?? BLIP;
          if (a === this.av)
              return;
          this.av = a;
          if (!this.placed)
              return;
          const S = this.S, before = this.skin.n;
          this.rH = a.headR * S;
          this.rad[HEAD] = this.rH;
          this.antennaGeometry();
          let t = this.antTarget(0, 0, 0, 0, 1);
          this.rAntA1 = Math.hypot(t[0], t[1]);
          t = this.antTarget(0, 0, 0, 1, 1);
          this.rAntB1 = Math.hypot(t[0], t[1]);
          const c = this.cAnt;
          this.cr[c] = this.rAntA1;
          this.cr[c + 1] = this.antL2[0];
          this.cr[c + 2] = this.rAntB1;
          this.cr[c + 3] = this.antL2[1];
          const ang = this.headAngle(), f = this.faceSign;
          for (let s = 0; s < 2; s++) {
              const j1 = s ? ANT_B1 : ANT_A1, j2 = s ? ANT_B2 : ANT_A2;
              t = this.antTarget(this.x[HEAD], this.y[HEAD], ang, s, f);
              const tx = t[0], ty = t[1];
              this.x[j1] = tx;
              this.y[j1] = ty;
              this.px[j1] = tx;
              this.py[j1] = ty;
              this.x[j2] = tx;
              this.y[j2] = ty - this.antL2[s];
              this.px[j2] = tx;
              this.py[j2] = this.y[j2];
          }
          this.buildSkin();
          // Make a bot: the dots his new look has more of start where they belong.
          for (let i = before; i < this.skin.n; i++) {
              this.dustPos(i, this.tmp);
              this.dx[i] = this.tmp[0];
              this.dy[i] = this.tmp[1];
              this.dvx[i] = 0;
              this.dvy[i] = 0;
              this.dk[i] = this.dk[0];
          }
      }
      /**
       * Play a moment (a compiled recipe): "once" (then back to his own play) or "loop" (until stopMoment or deliver); none
       * given, the recipe's own. `react`: another bot's moment asked for it, and it never cuts into his own. False: it cannot
       * be played here (a broken recipe, a newer format, Make a bot); play the recipe's fallback act instead.
       */
      playMoment(m, mode, react = false) {
          if (!m || !m.ok || this.kind === "make")
              return false;
          if (react && this.mo && !this.mo.react)
              return false;
          this.mo = m;
          this.moLoop = mode === "loop" || (mode !== "once" && m.loop);
          this.moDone = false;
          this.moEnding = false;
          this.moT = 0;
          this.moK = 0;
          this.moRnd = this.mrand();
          this.moRnd2 = this.mrand();
          this.moX0 = this.placed ? this.x[HIP] : this.w / 2;
          this.moSide = this.faceSign;
          if (!react)
              this.partner = -1;
          this.moReset(m.tracks);
          this.moEv.fill(NaN);
          this.cheerT = -1;
          this.release();
          return true;
      }
      /** Stop the moment now (its end is not played): back to his own play. */
      stopMoment() { if (this.mo)
          this.moFinish(); }
      /** A moment's end (deliver(), or a screen's momentEndWhen): its `end` plays, then it is over; none, over now. */
      deliverMoment() {
          const m = this.mo;
          if (!m)
              return;
          if (!m.end.length) {
              this.moFinish();
              return;
          }
          if (this.moEnding)
              return;
          this.moEnding = true;
          this.moT = 0;
          this.moReset(m.end);
          this.moEv.fill(NaN);
      }
      /** The id of the moment he is playing ("": none). */
      momentId() { return this.mo ? this.mo.id : ""; }
      /** A moment he played once (or was delivered) has finished, until the next one starts. */
      momentDone() { return this.moDone; }
      moReset(tracks) {
          for (let i = 0; i < MO_TRACKS; i++) {
              this.moFired[i] = 0;
              this.moNext[i] = 0;
              this.moThrow[i] = 0;
              this.moSlot[i] = -1;
              const tr = tracks[i];
              this.moOn[i] = tr && (tr.chance >= 1 || this.mrand() < tr.chance) ? 1 : 0;
          }
          for (let s = 0; s < WSLOTS; s++) {
              this.wlive[s] = 0;
              this.wtrack[s] = -1;
          }
      }
      moFinish() {
          this.mo = null;
          this.moDone = true;
          this.moEnding = false;
          this.partner = -1;
          this.peerX = NaN;
          this.peerY = NaN;
          for (let s = 0; s < WSLOTS; s++) {
              this.wlive[s] = 0;
              this.wtrack[s] = -1;
          }
          if (this.placed)
              this.next(true);
      }
      /** A compiled number, now. */
      xv(x) { return x.code ? xrun(x.code, this.moVars) : x.c; }
      /** One step of the moment: its clock (a loop goes round again from loopFrom), then every track that is on now. */
      runMoment(h) {
          const m = this.mo, S = this.S;
          this.moT += h;
          const dur = this.moEnding ? m.endDur : m.dur;
          if (this.moT >= dur) {
              if (this.moEnding || !this.moLoop) {
                  this.moFinish();
                  return;
              }
              // Round again: what lies before loopFrom played once; events and bursts keep their spacing.
              const back = dur - m.loopFrom;
              this.moT -= back;
              this.moK++;
              for (let i = 0; i < m.tracks.length; i++) {
                  const tr = m.tracks[i];
                  if (tr.after >= 0)
                      continue;
                  if (tr.at >= m.loopFrom) {
                      this.moFired[i] = 0;
                      this.moNext[i] = 0;
                      this.moThrow[i] = 0;
                      this.moOn[i] = tr.chance >= 1 || this.mrand() < tr.chance ? 1 : 0;
                  }
                  else
                      this.moNext[i] = this.moNext[i] - back;
              }
              for (let e = 0; e < MO_EVENTS; e++)
                  this.moEv[e] = this.moEv[e] - back;
          }
          this.momentVars();
          this.goalX = NaN;
          const tracks = this.moEnding ? m.end : m.tracks;
          this.moStamp++;
          for (let i = 0; i < tracks.length; i++)
              this.momentTrack(tracks[i], i, h);
          // A prop whose track is over pops away.
          for (let s = 0; s < WSLOTS; s++)
              if (this.wparts[s] && this.wlive[s] && this.wseen[s] !== this.moStamp) {
                  this.wlive[s] = 0;
                  this.wtrack[s] = -1;
              }
          if (this.wallL < 3)
              this.wallL = 3;
          if (this.wallR > this.w - 3)
              this.wallR = this.w - 3;
          void S;
      }
      /** The names expressions read (MOMENT_VARS), but for the track's own (t, u, D). */
      momentVars() {
          const m = this.mo, V = this.moVars, S = this.S, f = this.faceSign;
          V[2] = this.moT;
          V[4] = m.bpm > 0 ? (this.moT * m.bpm) / 60 : 0;
          V[5] = this.moK;
          V[6] = f;
          V[7] = this.moRnd;
          V[8] = this.moRnd2;
          V[9] = this.w / S;
          V[10] = this.x[HIP] / S;
          V[11] = this.peerX === this.peerX ? ((this.peerX - this.x[HEAD]) * f) / S : 0;
      }
      momentTrack(tr, i, h) {
          if (!this.moOn[i])
              return;
          let base = 0;
          if (tr.after >= 0) {
              base = this.moEv[tr.after];
              if (base !== base)
                  return;
          }
          const lt = this.moT - base - tr.at;
          if (lt < 0)
              return;
          if (tr.cond === 1 ? this.peerX === this.peerX : tr.cond === 2 ? this.peerX !== this.peerX : false)
              return;
          const V = this.moVars;
          if (tr.inst) {
              if (this.moFired[i] || this.posing)
                  return;
              V[0] = lt;
              V[1] = 1;
              V[3] = 0;
              if (tr.k === TK_HOP && !this.grounded) {
                  if (lt > tr.to - tr.at)
                      this.moFired[i] = 1;
                  return;
              }
              this.moFired[i] = 1;
              this.momentFire(tr, i);
              return;
          }
          const span = tr.to - tr.at;
          if (lt > span)
              return;
          if (this.posing && (tr.k === TK_WALK || tr.k === TK_SPIN || tr.k === TK_SHAKE || tr.k === TK_EMIT || tr.k === TK_ACT))
              return;
          V[0] = lt;
          V[1] = span > 0 ? lt / span : 1;
          V[3] = span;
          const S = this.S, f = this.faceSign;
          switch (tr.k) {
              case TK_WALK: {
                  let gx = NaN;
                  if (tr.m2 === 1)
                      gx = this.xv(tr.a) * this.w;
                  else if (tr.m2 === 2)
                      gx = this.moX0 + this.xv(tr.b) * S * this.moSide;
                  else if (tr.m === 1) {
                      if (this.peerX === this.peerX)
                          gx = this.peerX - (this.peerX > this.x[HIP] ? 1 : -1) * this.xv(tr.c) * S;
                  }
                  else if (tr.m === 2)
                      gx = this.w / 2;
                  else if (tr.m === 3)
                      gx = 0;
                  else if (tr.m === 4)
                      gx = this.w;
                  else if (tr.m === 5)
                      gx = this.moX0;
                  else if (tr.m === 6) {
                      if (this.peerX === this.peerX)
                          gx = this.moX0 - (this.peerX > this.moX0 ? 1 : -1) * this.xv(tr.c) * S;
                  }
                  if (gx === gx)
                      this.goalX = clamp(gx, this.wallL + S * 0.3, this.wallR - S * 0.3);
                  this.speed = this.xv(tr.d);
                  break;
              }
              case TK_CROUCH:
                  this.crouch += this.xv(tr.a);
                  break;
              case TK_SIT: {
                  const v = this.xv(tr.a);
                  if (v > this.sitWant)
                      this.sitWant = clamp(v, 0, 1);
                  break;
              }
              case TK_LEAN:
                  this.lean += this.xv(tr.a) * f;
                  break;
              case TK_TILT:
                  this.tilt += this.xv(tr.a) * f;
                  break;
              case TK_LID:
                  this.lidTo = clamp(this.xv(tr.a), 0, 1);
                  break;
              case TK_ARM:
                  this.momentArm(tr);
                  break;
              case TK_LOOK:
                  this.momentLook(tr, i, lt);
                  break;
              case TK_EYES:
                  this.eyeState = tr.m;
                  if (tr.m === EYE_OPEN || tr.m === EYE_WIDE)
                      this.lidTo = 0;
                  else if (tr.m === EYE_CLOSED)
                      this.lidTo = 1;
                  else if (tr.m === EYE_HALF)
                      this.lidTo = 0.45;
                  else if (tr.m === EYE_SQUINT)
                      this.lidTo = 0.64;
                  break;
              case TK_MOUTH:
                  this.mouthState = tr.m;
                  this.mouthOpen = clamp(this.xv(tr.a), 0, 1.5);
                  break;
              case TK_SPIN: {
                  // Turns a second: his facing flips each half turn, the first away from where he faced.
                  const turn = Math.floor(lt * Math.max(0, this.xv(tr.a)) * 2);
                  this.faceWant = turn % 2 === 0 ? -this.moSide : this.moSide;
                  this.lookX = NaN;
                  this.lookOut = 0;
                  break;
              }
              case TK_SHAKE:
                  this.shakeA = Math.max(0, this.xv(tr.a));
                  this.shakeF = this.xv(tr.b);
                  this.shakeP = tr.m;
                  break;
              case TK_ACT:
                  this.momentAct(tr.m, lt, h);
                  break;
              case TK_FACE: {
                  let fw = NaN;
                  if (tr.m === 0)
                      fw = 0;
                  else if (tr.m === 1 || tr.m === 2) {
                      if (this.peerX === this.peerX) {
                          const d = this.peerX > this.x[HEAD] ? 1 : -1;
                          fw = tr.m === 1 ? d : -d;
                      }
                  }
                  else
                      fw = tr.m === 3 ? -1 : tr.m === 4 ? 1 : tr.m === 5 ? this.moSide : -this.moSide;
                  if (fw === fw) {
                      this.faceWant = fw;
                      if (fw === 0) {
                          this.lookOut = 1;
                          this.lookX = NaN;
                      }
                  }
                  break;
              }
              case TK_PROP:
                  this.momentProp(tr, i);
                  break;
              case TK_EMIT:
                  if (lt >= this.moNext[i])
                      this.moNext[i] = lt + tr.every + (this.emit(tr, i) ? tr.pause : 0);
                  break;
              default: break;
          }
      }
      /** An arm track: a hand (or both, mirrored) to a point near an anchor, forward and down in bot heights. */
      momentArm(tr) {
          const S = this.S, f = this.faceSign, ax = this.xv(tr.a) * S, ay = this.xv(tr.b) * S, an = this.anchor(tr.m2);
          const ox = an[0], oy = an[1], rightFront = f > 0, hand = tr.m;
          if (hand === 4) {
              const fx = ox + f * ax, bx = ox - f * ax;
              this.armR = true;
              this.armL = true;
              this.armRx = rightFront ? fx : bx;
              this.armLx = rightFront ? bx : fx;
              this.armRy = oy + ay;
              this.armLy = oy + ay;
          }
          else {
              const right = hand === 3 || (hand === 0 && rightFront) || (hand === 1 && !rightFront);
              if (right) {
                  this.armR = true;
                  this.armRx = ox + f * ax;
                  this.armRy = oy + ay;
              }
              else {
                  this.armL = true;
                  this.armLx = ox + f * ax;
                  this.armLy = oy + ay;
              }
              if (tr.pop)
                  this.handOver |= right ? 2 : 1;
          }
          this.armK = this.xv(tr.c);
      }
      /** A look track: where his eyes (and head) go. Offsets are forward (the way he faced as it began) and down, in bot heights. */
      momentLook(tr, i, lt) {
          const S = this.S, sd = this.moSide, hx = this.x[HEAD], hy = this.y[HEAD];
          const ox = tr.a.code || tr.a.c === tr.a.c ? this.xv(tr.a) : NaN, oy = tr.b.code || tr.b.c === tr.b.c ? this.xv(tr.b) : NaN;
          this.lookOut = 0;
          switch (tr.m) {
              case LK_SCREEN:
                  this.lookOut = 1;
                  this.lookX = NaN;
                  return;
              case LK_PEER:
              case LK_AWAY:
                  if (this.peerX !== this.peerX) {
                      this.lookOut = 1;
                      this.lookX = NaN;
                      return;
                  }
                  this.lookX = tr.m === LK_PEER ? this.peerX : 2 * hx - this.peerX;
                  this.lookY = this.peerY;
                  break;
              case LK_POINT:
                  this.lookX = (ox === ox ? ox : 0.5) * this.w;
                  this.lookY = (oy === oy ? oy : 0.5) * this.floor;
                  return;
              case LK_AROUND:
                  if (lt >= this.moNext[i]) {
                      this.moNext[i] = lt + (0.6 + 0.8 * this.mrand()) / tr.n;
                      this.lookX = this.w * this.mrand();
                      this.lookY = this.floor * (0.1 + 0.8 * this.mrand());
                  }
                  return;
              case LK_DOWN:
                  this.lookX = hx + sd * S * 0.6;
                  this.lookY = this.floor + S * 2;
                  break;
              case LK_UP:
                  this.lookX = hx + sd * S * 0.4;
                  this.lookY = hy - S * 2.2;
                  break;
              case LK_AHEAD:
                  this.lookX = hx + sd * S * 3;
                  this.lookY = hy;
                  break;
              case LK_DROP:
              case LK_LAST: {
                  const q = tr.m === LK_DROP ? this.qMiss : this.qLast;
                  if (q >= 0 && this.qlife[q] > 0) {
                      this.lookX = this.qx[q];
                      this.lookY = this.qy[q];
                  }
                  else {
                      this.lookX = hx + sd * S;
                      this.lookY = this.floor;
                  }
                  break;
              }
              default: {
                  const hd = sd > 0 ? HAND_R : HAND_L;
                  this.lookX = this.x[hd];
                  this.lookY = this.y[hd];
                  break;
              }
          }
          if (ox === ox)
              this.lookX += sd * ox * S;
          if (oy === oy)
              this.lookY += oy * S;
      }
      /** One of today's acts, inside a recipe, for as long as its track lasts. */
      momentAct(a, lt, h) {
          switch (a) {
              case 0:
                  this.play(h);
                  break;
              case 1:
                  this.actT = lt;
                  this.waving();
                  break;
              case 2:
                  this.survey();
                  break;
              case 3:
                  this.reading();
                  break;
              case 4:
                  this.goalX = NaN;
                  this.sitWant = 1;
                  this.lidTo = 0.4;
                  this.idleLook(h, 0.4);
                  break;
              case 5:
                  this.thinking();
                  break;
              default:
                  this.actT = lt;
                  this.stretch();
                  break;
          }
      }
      /** A prop track: a part on him while it lasts (a slot of its own; it pops in, and out after). */
      momentProp(tr, i) {
          let s = this.moSlot[i];
          if (s < 0 || this.wtrack[s] !== i) {
              s = -1;
              for (let k = 0; k < WSLOTS; k++)
                  if (!this.wparts[k]) {
                      s = k;
                      break;
                  }
              if (s < 0)
                  for (let k = 0; k < WSLOTS; k++)
                      if (!this.wlive[k]) {
                          s = k;
                          break;
                      }
              if (s < 0)
                  return;
              this.moSlot[i] = s;
              this.wparts[s] = tr.part;
              this.wanc[s] = tr.m;
              this.wpaint[s] = tr.paint;
              this.wtrack[s] = i;
              this.wpop[s] = tr.pop ? 0 : 1;
              this.wpopV[s] = 0;
              this.wUsed = Math.max(1, this.wUsed);
          }
          this.wlive[s] = 1;
          this.wseen[s] = this.moStamp;
          this.wx[s] = this.xv(tr.a);
          this.wy[s] = this.xv(tr.b);
          this.wsc[s] = this.xv(tr.c);
          this.wrot[s] = this.xv(tr.d);
      }
      /** An instant track, once: a hop, a kick, a ripple, a glow, a sound, a word to the bots near him, an event, a burst. */
      momentFire(tr, i) {
          const S = this.S, f = this.faceSign;
          switch (tr.k) {
              case TK_HOP: {
                  const hh = Math.max(0.01, this.xv(tr.a)) * S, vy = -Math.sqrt(2 * this.g * hh), tf = (-2 * vy) / this.g;
                  this.jump((this.xv(tr.b) * S * this.moSide) / tf, vy);
                  break;
              }
              case TK_KICK: {
                  const vx = this.xv(tr.a) * S * f, vy = this.xv(tr.b) * S, p = tr.m, front = f > 0 ? HAND_R : HAND_L, back = f > 0 ? HAND_L : HAND_R;
                  for (let j = 0; j < NBOT; j++) {
                      const hit = p === 2 || (p === 0 && (j === HEAD || j >= ANT_A1)) || (p === 1 && (j === NECK || j === HIP)) ||
                          (p === 3 && (j === HAND_L || j === HAND_R || j === ELB_L || j === ELB_R)) || (p === 4 && (j === FOOT_L || j === FOOT_R)) ||
                          (p === 5 && j === front) || (p === 6 && j === back);
                      if (hit)
                          this.addV(j, vx, vy);
                  }
                  break;
              }
              case TK_FABRIC: {
                  const a = this.anchor(tr.m), ox = this.xv(tr.a) * S, oy = this.xv(tr.b) * S;
                  this.fabric.kick(a[0] + a[2] * ox + a[4] * oy, a[1] + a[3] * ox + a[5] * oy, this.xv(tr.c), Math.max(1, this.xv(tr.d) * S));
                  break;
              }
              case TK_GLOW:
                  this.glowV += this.xv(tr.a);
                  break;
              case TK_SOUND:
                  if (this.onSound)
                      this.onSound(tr.name);
                  break;
              case TK_OTHERS:
                  this.outPlay = tr.ref;
                  this.outN = tr.n;
                  this.outNear = tr.near;
                  break;
              case TK_EVENT:
                  this.moFireEvent(tr.ev);
                  break;
              case TK_BLINK:
                  this.blinkT = 0.13;
                  break;
              case TK_EMIT:
                  this.emit(tr, i);
                  break;
              default: break;
          }
      }
      /** An event fired: the tracks that follow it start (again) from now. */
      moFireEvent(e) {
          const m = this.mo;
          if (!m || e < 0)
              return;
          this.moEv[e] = this.moT;
          const tracks = this.moEnding ? m.end : m.tracks;
          for (let i = 0; i < tracks.length; i++)
              if (tracks[i].after === e) {
                  this.moFired[i] = 0;
                  this.moNext[i] = 0;
                  this.moThrow[i] = 0;
              }
      }
      /**
       * An anchor's frame now, into this.af: its point, then forward and down (unit vectors; forward is the way he faces).
       * The head's turn with his head, the body's with his body; hands, feet and the ground stand upright.
       */
      anchor(code) {
          const a = this.af, x = this.x, y = this.y, f = this.faceSign;
          if (code <= AN_MOUTH) {
              const ang = this.headAngle(), c = Math.cos(ang), s = Math.sin(ang);
              let ox = x[HEAD], oy = y[HEAD];
              if (code === AN_CROWN) {
                  const u = this.rH * this.av.headH;
                  ox += s * u;
                  oy -= c * u;
              }
              else if (code === AN_FACE) {
                  ox += c * this.ew + s * this.eu;
                  oy += s * this.ew - c * this.eu;
              }
              else if (code === AN_MOUTH) {
                  const mw = this.ew * 0.8, mu = this.av.mouthY * this.rH + this.eu * 0.25;
                  ox += c * mw + s * mu;
                  oy += s * mw - c * mu;
              }
              a[0] = ox;
              a[1] = oy;
              a[2] = c * f;
              a[3] = s * f;
              a[4] = -s;
              a[5] = c;
          }
          else if (code <= AN_HIP) {
              let ux = x[NECK] - x[HIP], uy = y[NECK] - y[HIP];
              const ul = Math.sqrt(ux * ux + uy * uy) + 1e-6;
              ux /= ul;
              uy /= ul;
              a[0] = code === AN_NECK ? x[NECK] : code === AN_HIP ? x[HIP] : (x[NECK] + x[HIP]) / 2;
              a[1] = code === AN_NECK ? y[NECK] : code === AN_HIP ? y[HIP] : (y[NECK] + y[HIP]) / 2;
              a[2] = -uy * f;
              a[3] = ux * f;
              a[4] = -ux;
              a[5] = -uy;
          }
          else {
              const p = code === AN_HAND_L ? HAND_L : code === AN_HAND_R ? HAND_R : code === AN_HAND_F ? (f > 0 ? HAND_R : HAND_L)
                  : code === AN_HAND_B ? (f > 0 ? HAND_L : HAND_R) : code === AN_FOOT_L ? FOOT_L : code === AN_FOOT_R ? FOOT_R : HIP;
              a[0] = x[p];
              a[1] = code === AN_GROUND ? this.floor : y[p];
              a[2] = f;
              a[3] = 0;
              a[4] = 0;
              a[5] = 1;
          }
          return a;
      }
      /** An emit track's burst (one throw). True: a miss was thrown (it will be dropped). */
      emit(tr, i) {
          const S = this.S, f = this.faceSign, k = this.moThrow[i];
          this.moThrow[i] = (k + 1) & 0xffff;
          let from = tr.m, aim = tr.m2;
          if (tr.alt && aim >= 0 && k & 1) {
              const q = from;
              from = aim;
              aim = q;
          }
          const a = this.anchor(from), ox = this.xv(tr.a) * S, oy = this.xv(tr.b) * S;
          const sx = a[0] + a[2] * ox + a[4] * oy, sy = a[1] + a[3] * ox + a[5] * oy;
          let tx = 0, ty = 0, missed = false;
          if (aim >= 0) {
              const b = this.anchor(aim);
              tx = b[0];
              ty = b[1];
          }
          for (let n = 0; n < tr.n; n++) {
              const q = this.qNext;
              this.qNext = (q + 1) % QCAP;
              this.qpart[q] = tr.parts ? tr.parts[(k * tr.n + n) % tr.parts.length] : tr.part;
              this.qpaint[q] = tr.paint === "$any" ? PALETTE[Math.floor(this.mrand() * PALETTE.length)] : tr.paint;
              let vx = this.xv(tr.c) * S * f, vy = this.xv(tr.d) * S, flags = tr.floor ? Q_FLOOR : 0, life = tr.life, px = sx, py = sy;
              if (tr.orbit > 0) {
                  flags |= Q_ORBIT;
                  this.qang[q] = (TAU * n) / tr.n + k * 0.9;
                  this.qorbR[q] = tr.orbit * S;
                  this.qorbW[q] = tr.orbitW;
                  this.qanc[q] = from;
                  vx = 0;
                  vy = 0;
              }
              else if (aim >= 0) {
                  // Thrown to the other hand: the arc that gets there in `flight`.
                  const T = tr.flight, G = this.g * tr.g;
                  vx = (tx - sx) / T;
                  vy = (ty - sy - 0.5 * G * T * T) / T;
                  flags |= Q_AIM;
                  if (tr.miss > 0 && this.mrand() < tr.miss) {
                      // A miss: a little long and high, past the hand; it lands, and (onMiss) he sees it.
                      vx *= 1.4;
                      vy *= 1.12;
                      flags |= Q_MISS | Q_FLOOR;
                      life = Math.max(life, 2.6);
                      missed = true;
                      if (tr.ev >= 0)
                          flags |= Q_EVENT;
                  }
              }
              if (tr.spread > 0 && !(flags & (Q_AIM | Q_ORBIT))) {
                  const ang = (this.mrand() - 0.5) * tr.spread, c = Math.cos(ang), s = Math.sin(ang), m = 1 + (this.mrand() - 0.5) * tr.spread * 0.4;
                  const rx = (vx * c - vy * s) * m, ry = (vx * s + vy * c) * m;
                  vx = rx;
                  vy = ry;
                  px += (this.mrand() - 0.5) * tr.spread * S * 0.08;
                  py += (this.mrand() - 0.5) * tr.spread * S * 0.08;
              }
              this.qx[q] = px;
              this.qy[q] = py;
              this.qvx[q] = vx;
              this.qvy[q] = vy;
              this.qlife[q] = life;
              this.qmax[q] = life;
              this.qt[q] = 0;
              this.qrot[q] = tr.spin > 0 ? (this.mrand() - 0.5) * 1.2 : 0;
              this.qspin[q] = tr.spin > 0 ? (this.mrand() - 0.5) * 2 * tr.spin : 0;
              this.qsize[q] = this.xv(tr.e);
              this.qgrow[q] = tr.grow;
              this.qg[q] = tr.g;
              this.qdrag[q] = tr.drag;
              this.qalpha[q] = tr.alpha;
              this.qflight[q] = tr.flight;
              this.qflags[q] = flags;
              this.qev[q] = tr.ev;
              this.qanc[q] = from;
              this.qLast = q;
          }
          this.qLive = Math.max(1, this.qLive);
          return missed;
      }
      /** The moment's particles (falling, rising, thrown, circling, bouncing) and its props' pop, one step. */
      thingsStep(h) {
          const S = this.S, fl = this.floor;
          let live = 0;
          for (let q = 0; q < QCAP; q++) {
              if (this.qlife[q] <= 0)
                  continue;
              this.qt[q] = this.qt[q] + h;
              this.qlife[q] = this.qlife[q] - h;
              if (this.qlife[q] <= 0)
                  continue;
              const fq = this.qflags[q];
              this.qrot[q] = this.qrot[q] + this.qspin[q] * h;
              if (fq & Q_ORBIT) {
                  this.qang[q] = this.qang[q] + this.qorbW[q] * h;
                  const a = this.anchor(this.qanc[q]), R = this.qorbR[q], an = this.qang[q];
                  this.qx[q] = a[0] + Math.cos(an) * R;
                  this.qy[q] = a[1] - S * 0.12 + Math.sin(an) * R * 0.32;
                  live++;
                  continue;
              }
              const dr = 1 / (1 + this.qdrag[q] * h);
              this.qvy[q] = (this.qvy[q] + this.g * this.qg[q] * h) * dr;
              this.qvx[q] = this.qvx[q] * dr;
              this.qx[q] = this.qx[q] + this.qvx[q] * h;
              this.qy[q] = this.qy[q] + this.qvy[q] * h;
              // Caught: the other hand has it.
              if (fq & Q_AIM && !(fq & Q_MISS) && this.qt[q] >= this.qflight[q]) {
                  this.qlife[q] = 0;
                  this.glowV += 0.6;
                  continue;
              }
              if (fq & Q_EVENT && this.qt[q] >= this.qflight[q]) {
                  this.qflags[q] = fq & ~Q_EVENT;
                  this.qMiss = q;
                  this.moFireEvent(this.qev[q]);
              }
              if (fq & Q_FLOOR) {
                  const r = S * 0.05 * this.qsize[q];
                  if (this.qy[q] > fl - r) {
                      this.qy[q] = fl - r;
                      if (this.qvy[q] > 0) {
                          if (this.qvy[q] > S * 2)
                              this.fabric.kick(this.qx[q], fl, Math.min(40, this.qvy[q] * 0.2), S);
                          this.qvy[q] = -this.qvy[q] * 0.42;
                      }
                      this.qvx[q] = this.qvx[q] * 0.8;
                      this.qspin[q] = this.qspin[q] * 0.7;
                  }
              }
              live++;
          }
          this.qLive = live;
          let used = 0;
          for (let s = 0; s < WSLOTS; s++) {
              if (!this.wparts[s])
                  continue;
              const to = this.wlive[s] ? 1 : 0;
              this.wpopV[s] = this.wpopV[s] + ((to - this.wpop[s]) * 520 - this.wpopV[s] * 19) * h;
              this.wpop[s] = this.wpop[s] + this.wpopV[s] * h;
              if (!to && this.wpop[s] < 0.03) {
                  this.wparts[s] = null;
                  this.wtrack[s] = -1;
                  continue;
              }
              used++;
          }
          this.wUsed = used;
      }
      /** A shake track: a quick back-and-forth force on his body, his head or all of him (not his feet). */
      shakeForces(live) {
          const w = TAU * this.shakeF, a = this.shakeA * this.S * w * w * Math.sin(w * this.t) * live, p = this.shakeP;
          for (let i = 0; i < NBOT; i++) {
              if (i === FOOT_L || i === FOOT_R)
                  continue;
              if (p === 1 ? i !== HEAD : p === 0 ? i === HEAD || i >= ANT_A1 : false)
                  continue;
              this.ax[i] += a;
          }
      }
      /** Reduce Motion in a moment: the pose its tracks hold at its `still` time (no hop, throw, walk or spin). */
      momentPose() {
          const m = this.mo, T = this.moT;
          this.goalX = NaN;
          this.crouch = 0;
          this.sitWant = 0;
          this.lean = 0;
          this.tilt = 0;
          this.armL = false;
          this.armR = false;
          this.armK = 0;
          this.lookOut = 1;
          this.lookX = NaN;
          this.lidTo = 0.08;
          this.faceWant = NaN;
          this.shakeA = 0;
          this.eyeState = EYE_REST;
          this.mouthState = MO_REST;
          this.mouthOpen = 1;
          this.moT = m.still;
          this.momentVars();
          this.posing = true;
          this.moStamp++;
          for (let i = 0; i < m.tracks.length; i++)
              this.momentTrack(m.tracks[i], i, STEP);
          this.posing = false;
          this.moT = T;
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
          const m = this.moment;
          const carry = this.stageCarry && m === "carry";
          this.act = carry ? A_CARRY : m === "settle" && this.kind !== "make" ? A_SIT : m !== "play" && m !== "think" && this.mood !== "needs" ? A_STAND
              : this.mood === "needs" ? A_NEEDS : this.mood === "idle" && this.kind !== "make" ? A_SIT : A_STAND;
          this.actT = 0;
          this.actDur = 1e9;
          this.cheerT = -1;
          if (carry) {
              // Carrying: standing with the bag over his shoulder, looking out.
              this.phase = this.delivered ? C_GONE : C_WALK;
              this.load = Math.max(this.load, 0.3);
              this.packBag(this.load);
              this.carryGrip(1);
              this.x[HAND_R] = this.armRx;
              this.y[HAND_R] = this.armRy;
              this.hangBag();
          }
          // In a moment: the pose it holds at its still time.
          const posed = !carry && this.mo !== null;
          for (let i = 0; i < 160; i++) {
              this.t += STEP;
              if (posed) {
                  this.momentPose();
                  this.sitTo(this.sitWant, STEP);
              }
              else {
                  this.goalX = NaN;
                  this.crouch = 0;
                  this.sitTo(this.act === A_SIT ? 1 : 0, STEP);
                  this.lookOut = 1;
                  this.lean = 0;
                  this.tilt = 0;
                  this.armL = this.armR = false;
                  if (carry)
                      this.carryGrip(1);
              }
              this.blinkAt = 9;
              if (!posed)
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
          this.qlife.fill(0);
          this.qLive = 0;
          for (let s = 0; s < WSLOTS; s++)
              if (this.wparts[s]) {
                  if (this.wlive[s]) {
                      this.wpop[s] = 1;
                      this.wpopV[s] = 0;
                  }
                  else
                      this.wparts[s] = null;
              }
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
          if (this.cloth > 0)
              this.fabric.draw(ctx, alpha * this.cloth);
          // On the floor, his toys are behind him; up in the air (a glyph, the plane), in front.
          this.drawProps(ctx, alpha, 0);
          if (this.kind === "make")
              this.drawDust(ctx, alpha);
          else
              this.drawBot(ctx, alpha, this.color);
          this.drawProps(ctx, alpha, 1);
          if (this.stageCarry && this.held === 0)
              this.drawCarryArms(ctx, alpha);
          this.drawSparks(ctx, alpha);
          // A moment's particles, over everything.
          if (this.qLive > 0)
              this.drawThings(ctx, alpha);
          ctx.globalAlpha = 1;
      }
      /** Carrying: the arm (heavy, both) that holds the bag, drawn over him and the bag, so the hold reads. */
      drawCarryArms(ctx, alpha) {
          const x = this.x, y = this.y, S = this.S, av = this.av, pb = paintOf(av.pBody, this.color);
          let ux = x[NECK] - x[HIP], uy = y[NECK] - y[HIP];
          const ul = Math.sqrt(ux * ux + uy * uy) + 1e-6;
          ux /= ul;
          uy /= ul;
          const wx = -uy, wy = ux, two = this.load >= 0.5;
          ctx.globalAlpha = alpha;
          ctx.strokeStyle = pb;
          ctx.fillStyle = pb;
          ctx.lineCap = "round";
          ctx.lineWidth = S * av.arm;
          ctx.beginPath();
          for (let s = two ? 0 : 1; s < 2; s++) {
              const side = s ? 1 : -1, elb = s ? ELB_R : ELB_L, hand = s ? HAND_R : HAND_L;
              ctx.moveTo(x[NECK] + wx * side * 0.11 * S - ux * 0.05 * S, y[NECK] + wy * side * 0.11 * S - uy * 0.05 * S);
              ctx.quadraticCurveTo(x[elb], y[elb], x[hand], y[hand]);
          }
          ctx.stroke();
          ctx.beginPath();
          for (let s = two ? 0 : 1; s < 2; s++) {
              const hand = s ? HAND_R : HAND_L;
              ctx.moveTo(x[hand] + S * 0.045 * av.handK, y[hand]);
              ctx.arc(x[hand], y[hand], S * 0.045 * av.handK, 0, TAU);
          }
          ctx.fill();
      }
      /**
       * Dots of the skin, in one path: from the skeleton (kinds a and b only), or where each loose dot is (free, all).
       * The head's are left out where his eyes are.
       */
      dots(ctx, free, ka, kb) {
          const k = this.skin, S = this.S, out = this.tmp, av = this.av;
          const rd = free ? S * 0.03 : S * av.dotR;
          const eyeR = this.rH * av.eyeR * this.eyeK + rd * 1.6, e2 = eyeR * eyeR, f = this.face >= 0 ? 1 : -1, gap = av.eyeGap * this.rH;
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
                  if (kind === 1 && av.eyes !== 4) {
                      const du = k.u[i] - this.eu, dw = k.w[i] * f - this.ew;
                      if (av.eyes === 0) {
                          if (du * du + dw * dw < e2)
                              continue;
                      }
                      else if (av.eyes === 3) {
                          if (Math.abs(du) < eyeR * 0.8 && Math.abs(dw) < gap + eyeR)
                              continue;
                      }
                      else if (du * du + (dw - gap) * (dw - gap) < e2 || du * du + (dw + gap) * (dw + gap) < e2)
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
      /** His eyes (or their moment's glyphs), his mouth when it shows, and the light on his antenna. */
      drawFace(ctx, alpha, col) {
          const av = this.av, x = this.x, y = this.y, S = this.S, r = this.rH;
          const ang = this.headAngle(), c = Math.cos(ang), s = Math.sin(ang);
          // head space to the screen: across (c, s), up (s, -c)
          const ew = this.ew, eu = this.eu, hx = x[HEAD], hy = y[HEAD];
          ctx.globalAlpha = alpha;
          if (av.eyes === 0) {
              this.drawEye(ctx, hx + c * ew + s * eu, hy + s * ew - c * eu, r * av.eyeR * this.eyeK, col, ang, c, s);
          }
          else if (av.eyes === 1 || av.eyes === 2) {
              for (let k = -1; k <= 1; k += 2) {
                  const w = ew + k * av.eyeGap * r;
                  const ex = hx + c * w + s * eu, ey = hy + s * w - c * eu, re = r * av.eyeR * this.eyeK;
                  if (av.eyes === 1)
                      this.drawEye(ctx, ex, ey, re, col, ang, c, s);
                  else
                      this.drawDotEye(ctx, ex, ey, re, col, c, s);
              }
          }
          else if (av.eyes === 3)
              this.drawVisor(ctx, hx, hy, col, c, s);
          if (this.mouthState !== MO_REST ? this.mouthState !== MO_NONE : av.mouth !== 0)
              this.drawMouth(ctx, alpha, col, c, s);
          // The light on an antenna's tip: brighter when something happens, and while he works.
          if (av.light < 0)
              return;
          const pl = paintOf(av.pLight, col);
          if (pl !== this.fillNow)
              ctx.fillStyle = pl;
          const g = clamp(this.glow, 0, 1.5);
          const tip = av.light ? ANT_B2 : ANT_A2, tipX = x[tip], tipY = y[tip];
          ctx.globalAlpha = alpha * (0.12 + 0.24 * g + (this.mood === "working" ? 0.1 : 0));
          ctx.beginPath();
          ctx.arc(tipX, tipY, S * (0.09 + 0.06 * g), 0, TAU);
          ctx.fill();
          ctx.globalAlpha = alpha;
          ctx.beginPath();
          ctx.arc(tipX, tipY, S * av.antTipR[av.light], 0, TAU);
          ctx.fill();
      }
      /** One great eye (or one of two) at (ex, ey), radius re: white, the pupil toward where he looks, the heavy lid. */
      drawEye(ctx, ex, ey, re, col, ang, c, s) {
          const av = this.av, r = this.rH, st = this.eyeState;
          const pe = paintOf(av.pEye, col), pp = paintOf(av.pPupil, col);
          if (st >= EYE_X) {
              this.eyeGlyph(ctx, ex, ey, re, pe, c, s);
              return;
          }
          ctx.fillStyle = pe;
          ctx.beginPath();
          ctx.arc(ex, ey, re, 0, TAU);
          ctx.fill();
          // The pupil, toward where he looks.
          ctx.fillStyle = pp;
          this.fillNow = pp;
          const pw = (this.ew - this.face * 0.22 * r) * 1.1, pu = (this.eu - av.eyeY * r) * 1.1;
          ctx.beginPath();
          ctx.arc(ex + c * pw + s * pu, ey + s * pw - c * pu, re * av.pupil, 0, TAU);
          ctx.fill();
          // The heavy lid: a chord across the top of the eye, as low as the lid is shut.
          if (this.lid > 0.02) {
              const pl = paintOf(av.pBody, col);
              if (pl !== pp) {
                  ctx.fillStyle = pl;
                  this.fillNow = pl;
              }
              const yc = -re + 2 * re * this.lid;
              const phi = Math.asin(clamp(yc / re, -1, 1));
              ctx.beginPath();
              ctx.arc(ex, ey, re * 1.06, Math.PI - phi + ang, TAU + phi + ang);
              ctx.closePath();
              ctx.fill();
              // Shut (a moment's "closed"): the lid's line, so he reads as asleep, not eyeless.
              if (st === EYE_CLOSED && this.lid > 0.8) {
                  ctx.strokeStyle = pe;
                  ctx.lineWidth = Math.max(re * 0.26, this.S * 0.016);
                  ctx.lineCap = "round";
                  ctx.beginPath();
                  this.hsMove(ctx, ex, ey, c, s, -re * 0.72, -re * 0.1);
                  this.hsQuad(ctx, ex, ey, c, s, 0, -re * 0.62, re * 0.72, -re * 0.1);
                  ctx.stroke();
              }
          }
      }
      /** A small solid eye (style "dots"): squashed as the lid closes. */
      drawDotEye(ctx, ex, ey, re, col, c, s) {
          const pe = paintOf(this.av.pEye, col);
          if (this.eyeState >= EYE_X) {
              this.eyeGlyph(ctx, ex, ey, re * 1.5, pe, c, s);
              return;
          }
          ctx.fillStyle = pe;
          this.fillNow = pe;
          ctx.beginPath();
          this.oval(ctx, ex, ey, re, Math.max(re * 0.14, re * (1 - 0.86 * this.lid)), c, s);
          ctx.fill();
      }
      /** A visor (style "visor"): a light band across his face, and a pupil gliding along it. */
      drawVisor(ctx, hx, hy, col, c, s) {
          const av = this.av, r = this.rH, re = r * av.eyeR * this.eyeK, hw = av.eyeGap * r + re;
          const w0 = this.ew * 0.6, u0 = this.eu, ex = hx + c * w0 + s * u0, ey = hy + s * w0 - c * u0;
          const pe = paintOf(av.pEye, col), pp = paintOf(av.pPupil, col);
          if (this.eyeState >= EYE_X) {
              for (let k = -1; k <= 1; k += 2)
                  this.eyeGlyph(ctx, ex + c * k * av.eyeGap * r, ey + s * k * av.eyeGap * r, re, pe, c, s);
              return;
          }
          const hh = Math.max(re * 0.18, re * (1 - 0.85 * this.lid));
          ctx.fillStyle = pe;
          ctx.beginPath();
          this.roundBox(ctx, ex, ey, hw, hh, Math.min(hw, hh) * 0.9, c, s);
          ctx.fill();
          ctx.fillStyle = pp;
          this.fillNow = pp;
          const pw = (this.ew - this.face * 0.22 * r) * 2.2, pu = (this.eu - av.eyeY * r) * 0.6, k = Math.min(hh * 0.8, re * av.pupil);
          ctx.beginPath();
          ctx.arc(ex + c * pw + s * pu, ey + s * pw - c * pu, k, 0, TAU);
          ctx.fill();
      }
      /** A moment's eye: an x, a happy arc, or a dizzy spiral, in the eye's paint. */
      eyeGlyph(ctx, ex, ey, re, pe, c, s) {
          const st = this.eyeState;
          ctx.strokeStyle = pe;
          ctx.lineWidth = Math.max(re * 0.34, this.S * 0.02);
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          ctx.beginPath();
          if (st === EYE_X) {
              const k = re * 0.7;
              this.hsMove(ctx, ex, ey, c, s, -k, k);
              this.hsLine(ctx, ex, ey, c, s, k, -k);
              this.hsMove(ctx, ex, ey, c, s, -k, -k);
              this.hsLine(ctx, ex, ey, c, s, k, k);
          }
          else if (st === EYE_HAPPY) {
              this.hsMove(ctx, ex, ey, c, s, -re * 0.85, -re * 0.3);
              this.hsQuad(ctx, ex, ey, c, s, 0, re * 1.05, re * 0.85, -re * 0.3);
          }
          else {
              const turn = this.t * 7;
              for (let j = 0; j <= 14; j++) {
                  const a = turn + j * 0.78, rr = re * (0.1 + 0.064 * j), w = Math.cos(a) * rr, u = Math.sin(a) * rr;
                  if (j === 0)
                      this.hsMove(ctx, ex, ey, c, s, w, u);
                  else
                      this.hsLine(ctx, ex, ey, c, s, w, u);
              }
          }
          ctx.stroke();
      }
      /** His mouth (his look's at rest, or the moment's), in the mouth's paint, below his eye. */
      drawMouth(ctx, alpha, col, c, s) {
          const av = this.av, r = this.rH, st0 = this.mouthState;
          const st = st0 !== MO_REST ? st0 : av.mouth === 1 ? MO_LINE : av.mouth === 2 ? MO_SMILE : av.mouth === 3 ? MO_O : MO_OPEN;
          const v = st0 !== MO_REST ? this.mouthOpen : 1;
          const mw = this.ew * 0.8, mu = av.mouthY * r + this.eu * 0.25;
          const mx = this.x[HEAD] + c * mw + s * mu, my = this.y[HEAD] + s * mw - c * mu;
          const hw = av.mouthW * r, pm = paintOf(av.pMouth, col);
          ctx.globalAlpha = alpha;
          if (st === MO_LINE || st === MO_SMILE || st === MO_WAVY) {
              ctx.strokeStyle = pm;
              ctx.lineWidth = Math.max(r * 0.15, this.S * 0.02);
              ctx.lineCap = "round";
              ctx.lineJoin = "round";
              ctx.beginPath();
              if (st === MO_LINE) {
                  this.hsMove(ctx, mx, my, c, s, -hw, 0);
                  this.hsLine(ctx, mx, my, c, s, hw, 0);
              }
              else if (st === MO_SMILE) {
                  this.hsMove(ctx, mx, my, c, s, -hw, hw * 0.3);
                  this.hsQuad(ctx, mx, my, c, s, 0, -hw * (0.6 + 0.6 * v), hw, hw * 0.3);
              }
              else {
                  this.hsMove(ctx, mx, my, c, s, -hw, 0);
                  for (let j = 1; j <= 4; j++)
                      this.hsLine(ctx, mx, my, c, s, -hw + (j * hw) / 2, (j % 2 ? 1 : -1) * hw * 0.32 * v);
              }
              ctx.stroke();
              return;
          }
          ctx.fillStyle = pm;
          this.fillNow = pm;
          ctx.beginPath();
          if (st === MO_OPEN)
              this.oval(ctx, mx, my, hw * 0.78, Math.max(hw * 0.12, hw * 0.55 * v), c, s);
          else if (st === MO_O) {
              const k = Math.max(0.35, v);
              this.oval(ctx, mx, my, hw * 0.6 * k, hw * 0.7 * k, c, s);
          }
          else {
              const d = hw * 1.25 * Math.max(0.2, v);
              this.hsMove(ctx, mx, my, c, s, -hw * 1.05, hw * 0.25);
              this.hsLine(ctx, mx, my, c, s, hw * 1.05, hw * 0.25);
              this.hsQuad(ctx, mx, my, c, s, hw * 0.95, -d * 1.4, 0, -d);
              this.hsQuad(ctx, mx, my, c, s, -hw * 0.95, -d * 1.4, -hw * 1.05, hw * 0.25);
              ctx.closePath();
          }
          ctx.fill();
      }
      /** Head space (w across, u up, from ox, oy; the head turned by c, s) to the screen: a move, a line, a curve. */
      hsMove(ctx, ox, oy, c, s, w, u) { ctx.moveTo(ox + c * w + s * u, oy + s * w - c * u); }
      hsLine(ctx, ox, oy, c, s, w, u) { ctx.lineTo(ox + c * w + s * u, oy + s * w - c * u); }
      hsQuad(ctx, ox, oy, c, s, cw, cu, w, u) {
          ctx.quadraticCurveTo(ox + c * cw + s * cu, oy + s * cw - c * cu, ox + c * w + s * u, oy + s * w - c * u);
      }
      /** An oval (rx across, ry up) in head space, as eight curves (the drawing vocabulary has no ellipse). */
      oval(ctx, ox, oy, rx, ry, c, s) {
          const k = 1 / Math.cos(Math.PI / 8);
          this.hsMove(ctx, ox, oy, c, s, rx, 0);
          for (let j = 1; j <= 8; j++) {
              const a = (j * TAU) / 8, am = a - Math.PI / 8;
              this.hsQuad(ctx, ox, oy, c, s, Math.cos(am) * rx * k, Math.sin(am) * ry * k, Math.cos(a) * rx, Math.sin(a) * ry);
          }
          ctx.closePath();
      }
      /** A box (half sizes hw across, hh up, corners rounded by rc) in head space. */
      roundBox(ctx, ox, oy, hw, hh, rc, c, s) {
          this.hsMove(ctx, ox, oy, c, s, -hw + rc, hh);
          this.hsLine(ctx, ox, oy, c, s, hw - rc, hh);
          this.hsQuad(ctx, ox, oy, c, s, hw, hh, hw, hh - rc);
          this.hsLine(ctx, ox, oy, c, s, hw, -hh + rc);
          this.hsQuad(ctx, ox, oy, c, s, hw, -hh, hw - rc, -hh);
          this.hsLine(ctx, ox, oy, c, s, -hw + rc, -hh);
          this.hsQuad(ctx, ox, oy, c, s, -hw, -hh, -hw, -hh + rc);
          this.hsLine(ctx, ox, oy, c, s, -hw, hh - rc);
          this.hsQuad(ctx, ox, oy, c, s, -hw, hh, -hw + rc, hh);
          ctx.closePath();
      }
      /** His ears (his look's), behind his head, in their paint. */
      drawEars(ctx, hx, hy, c, s) {
          const av = this.av, r = this.rH, er = av.earR * r, side = r * av.headW;
          ctx.beginPath();
          for (let k = -1; k <= 1; k += 2) {
              if (av.ears === 1) {
                  const w = k * side * 0.96, ox = hx + c * w + s * r * 0.05, oy = hy + s * w - c * r * 0.05;
                  ctx.moveTo(ox + er, oy);
                  ctx.arc(ox, oy, er, 0, TAU);
              }
              else if (av.ears === 2) {
                  this.roundBox(ctx, hx + c * k * (side + er * 0.3), hy + s * k * (side + er * 0.3), er * 0.45, er * 0.75, er * 0.2, c, s);
              }
              else {
                  const bw = k * side * 0.42, bu = r * av.headH * 0.8;
                  this.hsMove(ctx, hx, hy, c, s, bw - k * er * 0.55, bu);
                  this.hsLine(ctx, hx, hy, c, s, k * side * 0.7, r * av.headH + er);
                  this.hsLine(ctx, hx, hy, c, s, bw + k * er * 0.75, bu - er * 0.2);
                  ctx.closePath();
              }
          }
          ctx.fill();
      }
      /** What he wears (his look's), behind him or in front; in front, a moment's props too. */
      drawWear(ctx, alpha, col, back) {
          const list = this.av.wear;
          for (let i = 0; i < list.length; i++) {
              const w = list[i];
              if (w.back === back)
                  this.drawOn(ctx, w.part, w.on, w.x, w.y, w.scale, w.rot, w.paint, col, alpha);
          }
          if (back)
              return;
          for (let s = 0; s < WSLOTS; s++) {
              const p = this.wparts[s];
              if (p && this.wpop[s] > 0.01)
                  this.drawOn(ctx, p, this.wanc[s], this.wx[s], this.wy[s], this.wsc[s] * this.wpop[s], this.wrot[s], this.wpaint[s], col, alpha);
          }
      }
      /** A part on an anchor: offset forward and down (bot heights), scaled, turned. */
      drawOn(ctx, part, on, ox, oy, sc, rot, paint, col, alpha) {
          const a = this.anchor(on), S = this.S;
          const px = a[0] + (a[2] * ox + a[4] * oy) * S, py = a[1] + (a[3] * ox + a[5] * oy) * S;
          const c = Math.cos(rot), s = Math.sin(rot);
          drawPart(ctx, part, px, py, a[2] * c + a[4] * s, a[3] * c + a[5] * s, a[4] * c - a[2] * s, a[5] * c - a[3] * s, S * sc, col, paint, alpha);
      }
      /** A moment's particles: each its part, turned, grown and faded with its life. */
      drawThings(ctx, alpha) {
          const S = this.S, col = this.kind === "make" ? this.makeColor : this.color;
          for (let q = 0; q < QCAP; q++) {
              const l = this.qlife[q], p = this.qpart[q];
              if (l <= 0 || !p)
                  continue;
              const t = this.qt[q], k = clamp(l / 0.35, 0, 1) * clamp(t / 0.06, 0, 1);
              const g = this.qsize[q] * (1 + (this.qgrow[q] - 1) * clamp(t / this.qmax[q], 0, 1));
              const a = this.qrot[q], c = Math.cos(a), s = Math.sin(a);
              drawPart(ctx, p, this.qx[q], this.qy[q], c, s, -s, c, S * g, col, this.qpaint[q], alpha * this.qalpha[q] * k);
          }
      }
      /** The bot: his solid figure in his colour, perforated with light dots, his face, and what he wears (all his look's). */
      drawBot(ctx, alpha, col) {
          const av = this.av, x = this.x, y = this.y, S = this.S, r = this.rH;
          const f = this.face >= 0 ? 1 : -1;
          // The body's frame: up from the hips, and across.
          let ux = x[NECK] - x[HIP], uy = y[NECK] - y[HIP];
          const ul = Math.sqrt(ux * ux + uy * uy) + 1e-6;
          ux /= ul;
          uy /= ul;
          const wx = -uy, wy = ux;
          if (av.wearBack)
              this.drawWear(ctx, alpha, col, true);
          const pb = paintOf(av.pBody, col);
          ctx.globalAlpha = alpha;
          ctx.fillStyle = pb;
          ctx.strokeStyle = pb;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          // Arms (behind the body): shoulder, elbow, hand.
          ctx.lineWidth = S * av.arm;
          ctx.beginPath();
          for (let s = 0; s < 2; s++) {
              const side = s ? 1 : -1, elb = s ? ELB_R : ELB_L, hand = s ? HAND_R : HAND_L;
              const sx = x[NECK] + wx * side * 0.11 * S - ux * 0.05 * S, sy = y[NECK] + wy * side * 0.11 * S - uy * 0.05 * S;
              ctx.moveTo(sx, sy);
              ctx.quadraticCurveTo(x[elb], y[elb], x[hand], y[hand]);
          }
          ctx.stroke();
          // Legs and feet.
          ctx.lineWidth = S * av.leg;
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
          ctx.lineWidth = S * av.neck;
          ctx.beginPath();
          ctx.moveTo(x[NECK], y[NECK]);
          ctx.lineTo(x[HEAD], y[HEAD]);
          ctx.stroke();
          const ang = this.headAngle(), c = Math.cos(ang), sn = Math.sin(ang);
          if (av.antN > 0) {
              ctx.lineWidth = S * av.antW;
              ctx.beginPath();
              for (let s = 0; s < av.antN; s++) {
                  const j1 = s ? ANT_B1 : ANT_A1, j2 = s ? ANT_B2 : ANT_A2;
                  const bu = this.antU0[s], bw = this.antW0[s] * f;
                  ctx.moveTo(x[HEAD] + c * bw + sn * bu * 0.85, y[HEAD] + sn * bw - c * bu * 0.85);
                  ctx.lineTo(x[j1], y[j1]);
                  ctx.lineTo(x[j2], y[j2]);
              }
              ctx.stroke();
          }
          // The antennae's tips (a ball, a star), and his hands.
          ctx.beginPath();
          let first = true;
          for (let s = 0; s < av.antN; s++) {
              const tip = av.antTip[s], j2 = s ? ANT_B2 : ANT_A2, tr = S * av.antTipR[s], tx = x[j2], ty = y[j2];
              if (tip === 1) {
                  if (!first)
                      ctx.moveTo(tx + tr, ty);
                  ctx.arc(tx, ty, tr, 0, TAU);
                  first = false;
              }
              else if (tip === 3) {
                  for (let k = 0; k <= 10; k++) {
                      const a = -Math.PI / 2 + (k * Math.PI) / 5, rr = k % 2 ? tr * 0.45 : tr * 1.15;
                      if (k === 0)
                          ctx.moveTo(tx + Math.cos(a) * rr, ty + Math.sin(a) * rr);
                      else
                          ctx.lineTo(tx + Math.cos(a) * rr, ty + Math.sin(a) * rr);
                  }
                  ctx.closePath();
                  first = false;
              }
          }
          ctx.moveTo(x[HAND_L] + S * av.hand, y[HAND_L]);
          ctx.arc(x[HAND_L], y[HAND_L], S * av.hand, 0, TAU);
          ctx.moveTo(x[HAND_R] + S * av.hand, y[HAND_R]);
          ctx.arc(x[HAND_R], y[HAND_R], S * av.hand, 0, TAU);
          ctx.fill();
          // The body: a sack, wider at the bottom, its corners rounded.
          const tl = av.bodyTop * S, bl = av.bodyBottom * S, rr = av.bodyRound * S;
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
          // His ears, behind his head.
          if (av.ears) {
              const pe = paintOf(av.pEars, col);
              if (pe !== pb)
                  ctx.fillStyle = pe;
              this.drawEars(ctx, x[HEAD], y[HEAD], c, sn);
              if (pe !== pb)
                  ctx.fillStyle = pb;
          }
          // The head.
          ctx.beginPath();
          if (av.head === 0 && av.headW === 1 && av.headH === 1)
              ctx.arc(x[HEAD], y[HEAD], r, 0, TAU);
          else if (av.head === 2)
              this.roundBox(ctx, x[HEAD], y[HEAD], r * av.headW, r * av.headH, r * av.headRound * Math.min(av.headW, av.headH), c, sn);
          else
              this.oval(ctx, x[HEAD], y[HEAD], r * av.headW, r * av.headH, c, sn);
          ctx.fill();
          this.fillNow = pb;
          // The perforations: light dots through the head and the body.
          if (av.dots !== 2) {
              const pd = paintOf(av.pDots, col);
              ctx.fillStyle = pd;
              this.fillNow = pd;
              ctx.globalAlpha = alpha * av.dotA;
              this.dots(ctx, null, 1, 2);
          }
          this.drawFace(ctx, alpha, col);
          if (av.wearFront || this.wUsed > 0)
              this.drawWear(ctx, alpha, col, false);
          if (this.handOver)
              this.drawArmsOver(ctx, alpha, pb, this.handOver);
      }
      /**
       * A moment's hand at his face (1 the left, 2 the right): the forearm and hand drawn again, over his head, edged in
       * paper so a hand in his own colour reads on his face.
       */
      drawArmsOver(ctx, alpha, pb, which) {
          const x = this.x, y = this.y, S = this.S, av = this.av, edge = S * 0.018;
          ctx.globalAlpha = alpha;
          ctx.lineCap = "round";
          for (let pass = 0; pass < 2; pass++) {
              const col = pass ? pb : PAPER, grow = pass ? 0 : edge;
              ctx.strokeStyle = col;
              ctx.fillStyle = col;
              ctx.lineWidth = S * av.arm + 2 * grow;
              ctx.beginPath();
              for (let s = 0; s < 2; s++) {
                  if (!(which & (s ? 2 : 1)))
                      continue;
                  const elb = s ? ELB_R : ELB_L, hand = s ? HAND_R : HAND_L;
                  ctx.moveTo(x[elb], y[elb]);
                  ctx.lineTo(x[hand], y[hand]);
              }
              ctx.stroke();
              ctx.beginPath();
              for (let s = 0; s < 2; s++) {
                  if (!(which & (s ? 2 : 1)))
                      continue;
                  const hand = s ? HAND_R : HAND_L, r = S * av.hand * 1.2 + grow;
                  ctx.moveTo(x[hand] + r, y[hand]);
                  ctx.arc(x[hand], y[hand], r, 0, TAU);
              }
              ctx.fill();
          }
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
              // The pad in his hands is in front of him.
              const up = kind === P_PLANE || (kind === P_PAD && this.held === p) || ((kind === P_ZERO || kind === P_ONE || kind === P_BALL) && y[a] < this.floor - this.pr[p] * 2.2 - S * 0.12);
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
              else if (kind === P_PAD) {
                  this.drawPad(ctx, alpha * low, p);
              }
              else if (kind === P_BAG) {
                  this.drawBag(ctx, alpha * this.bagFade, p);
              }
          }
          // His pencil, and the hands on the pad, over it.
          if (layer === 1 && this.kind === "notes" && this.held >= 0)
              this.drawPencil(ctx, alpha);
      }
      /**
       * The bag: a sack in his colour hanging from its tie (narrow at the knot, round below, a flatter, wider bottom the
       * fuller it is), the tie's two ears over the knot, and a row of light stitches across it, more as it fills.
       */
      drawBag(ctx, alpha, p) {
          if (alpha <= 0.01)
              return;
          const S = this.S, a = this.p0[p], r = this.pr[p], x = this.x, y = this.y;
          const kx = x[a], ky = y[a], bx = x[a + 1], by = y[a + 1];
          let ux = bx - kx, uy = by - ky;
          const ul = Math.sqrt(ux * ux + uy * uy) + 1e-6;
          ux /= ul;
          uy /= ul;
          const vx = -uy, vy = ux;
          const full = clamp((r / S - CARRY.bagLight) / (CARRY.bagHeavy - CARRY.bagLight), 0, 1);
          const nw = S * 0.028, wide = r * (1 + 0.1 * full), low = r * (0.92 - 0.1 * full);
          const nx = kx + ux * S * 0.02, ny = ky + uy * S * 0.02;
          const mx = bx + ux * r * 0.18, my = by + uy * r * 0.18;
          const ex = bx + ux * low, ey = by + uy * low;
          const sx = bx - ux * r * 0.75, sy = by - uy * r * 0.75;
          ctx.fillStyle = this.color;
          ctx.strokeStyle = this.color;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          ctx.lineWidth = S * 0.035;
          // Fainter than he is (his things are), and the fuller, the deeper.
          ctx.beginPath();
          ctx.moveTo(nx - vx * nw, ny - vy * nw);
          ctx.quadraticCurveTo(sx - vx * wide * 1.1, sy - vy * wide * 1.1, mx - vx * wide, my - vy * wide);
          ctx.quadraticCurveTo(ex - vx * wide * (0.95 + 0.1 * full), ey - vy * wide * (0.95 + 0.1 * full), ex, ey);
          ctx.quadraticCurveTo(ex + vx * wide * (0.95 + 0.1 * full), ey + vy * wide * (0.95 + 0.1 * full), mx + vx * wide, my + vy * wide);
          ctx.quadraticCurveTo(sx + vx * wide * 1.1, sy + vy * wide * 1.1, nx + vx * nw, ny + vy * nw);
          ctx.closePath();
          ctx.globalAlpha = alpha * (0.34 + 0.3 * full);
          ctx.fill();
          ctx.globalAlpha = alpha * 0.9;
          ctx.stroke();
          // The tie's ears.
          ctx.beginPath();
          ctx.moveTo(kx + ux * S * 0.02, ky + uy * S * 0.02);
          ctx.lineTo(kx - ux * S * 0.045 - vx * S * 0.045, ky - uy * S * 0.045 - vy * S * 0.045);
          ctx.moveTo(kx + ux * S * 0.02, ky + uy * S * 0.02);
          ctx.lineTo(kx - ux * S * 0.035 + vx * S * 0.05, ky - uy * S * 0.035 + vy * S * 0.05);
          ctx.stroke();
          // The seam: a row of stitches across its middle, more as it fills.
          const k = 3 + Math.round(full * 2), rd = S * 0.017;
          ctx.globalAlpha = alpha * 0.8;
          ctx.beginPath();
          for (let j = 0; j < k; j++) {
              const t = (j / (k - 1) - 0.5) * 1.25 * wide, cx = bx + vx * t + ux * r * 0.05, cy = by + vy * t + uy * r * 0.05;
              ctx.moveTo(cx + rd, cy);
              ctx.arc(cx, cy, rd, 0, TAU);
          }
          ctx.fill();
      }
      /** A point on pad p's face, (u, v) of the way across and down it, into this.tmp. */
      padAt(p, u, v) {
          const a = this.p0[p], x = this.x, y = this.y, ox = x[a], oy = y[a];
          this.tmp[0] = ox + (x[a + 1] - ox) * u + (x[a + 3] - ox) * v;
          this.tmp[1] = oy + (y[a + 1] - oy) * u + (y[a + 3] - oy) * v;
          return this.tmp;
      }
      /** The pad: paper, its edge and binding in his colour, faint rules, and the lines he has written on this page. */
      drawPad(ctx, alpha, p) {
          const x = this.x, y = this.y, S = this.S, a = this.p0[p], t = this.tmp;
          ctx.globalAlpha = alpha;
          ctx.fillStyle = PAPER;
          ctx.beginPath();
          ctx.moveTo(x[a], y[a]);
          ctx.lineTo(x[a + 1], y[a + 1]);
          ctx.lineTo(x[a + 2], y[a + 2]);
          ctx.lineTo(x[a + 3], y[a + 3]);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = this.color;
          ctx.globalAlpha = 0.07 * alpha;
          ctx.fill();
          ctx.globalAlpha = 0.62 * alpha;
          ctx.lineWidth = S * 0.035;
          ctx.stroke();
          // The binding: three rings along the top.
          ctx.globalAlpha = 0.75 * alpha;
          ctx.beginPath();
          for (let k = 0; k < 3; k++) {
              this.padAt(p, 0.25 + 0.25 * k, 0);
              ctx.moveTo(t[0] + S * 0.028, t[1]);
              ctx.arc(t[0], t[1], S * 0.028, 0, TAU);
          }
          ctx.fill();
          // The rules, faint.
          ctx.globalAlpha = 0.14 * alpha;
          ctx.lineWidth = S * 0.018;
          ctx.beginPath();
          for (let j = 0; j < PAD_LINES; j++) {
              const v = 0.345 + 0.15 * j;
              this.padAt(p, 0.1, v);
              ctx.moveTo(t[0], t[1]);
              this.padAt(p, 0.9, v);
              ctx.lineTo(t[0], t[1]);
          }
          ctx.stroke();
          // What he has written: whole lines, and the one he is on as far as he has got.
          const done = this.pa[p], page = this.ptime[p];
          if (done <= 0)
              return;
          ctx.globalAlpha = 0.78 * alpha;
          ctx.lineWidth = S * 0.03;
          ctx.beginPath();
          for (let j = 0; j < PAD_LINES && j < done; j++) {
              const len = 0.55 + 0.4 * hash01(page * 7 + j), cur = Math.min(1, done - j);
              const v0 = 0.3 + 0.15 * j, u1 = 0.16 + 0.68 * len * cur;
              for (let k = 0; k <= 6; k++) {
                  this.padAt(p, 0.16 + ((u1 - 0.16) * k) / 6, v0 + (hash01(page * 31 + j * 5 + k) - 0.5) * 0.06);
                  if (k === 0)
                      ctx.moveTo(t[0], t[1]);
                  else
                      ctx.lineTo(t[0], t[1]);
              }
          }
          ctx.stroke();
      }
      /** The pencil in his writing hand (on the line he writes, or resting, point up), and both hands drawn over the pad. */
      drawPencil(ctx, alpha) {
          const S = this.S, f = this.face >= 0 ? 1 : -1, pen = this.penHand(), grip = this.padHand();
          const hx = this.x[pen], hy = this.y[pen];
          let dx = f * 0.35, dy = -1, len = S * 0.11;
          if (this.penX === this.penX) {
              dx = this.penX - hx;
              dy = this.penY - hy;
              len = clamp(Math.sqrt(dx * dx + dy * dy), S * 0.06, S * 0.13);
          }
          const dl = Math.sqrt(dx * dx + dy * dy) + 1e-6;
          ctx.strokeStyle = INK;
          ctx.lineCap = "round";
          ctx.globalAlpha = 0.72 * alpha;
          ctx.lineWidth = S * 0.032;
          ctx.beginPath();
          ctx.moveTo(hx - (dx / dl) * S * 0.03, hy - (dy / dl) * S * 0.03);
          ctx.lineTo(hx + (dx / dl) * len, hy + (dy / dl) * len);
          ctx.stroke();
          ctx.fillStyle = this.color;
          ctx.globalAlpha = alpha;
          ctx.beginPath();
          ctx.arc(hx, hy, S * 0.042, 0, TAU);
          ctx.moveTo(this.x[grip] + S * 0.042, this.y[grip]);
          ctx.arc(this.x[grip], this.y[grip], S * 0.042, 0, TAU);
          ctx.fill();
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
          ctx.strokeStyle = ctx.fillStyle;
          ctx.lineWidth = Math.max(1, S * 0.04);
          ctx.lineCap = "round";
          for (let i = 0; i < SPARKS; i++) {
              const l = this.slife[i];
              if (l <= 0)
                  continue;
              ctx.globalAlpha = alpha * clamp(l, 0, 1) * 0.7;
              if (this.shome[i] === S_PAGE) {
                  // A page: a small sheet tipped by its drift, two scribbled lines on it.
                  const ang = clamp(this.svx[i] / (S * 3), -0.7, 0.7), c = Math.cos(ang), s = Math.sin(ang);
                  const hw = this.padW * 0.45, hh = this.padH * 0.38, px = this.sx[i], py = this.sy[i];
                  const lift = py >= this.floor - S * 0.031 ? 0.25 : 1;
                  ctx.beginPath();
                  ctx.moveTo(px - c * hw + s * hh * lift, py - s * hw - c * hh * lift);
                  ctx.lineTo(px + c * hw + s * hh * lift, py + s * hw - c * hh * lift);
                  ctx.lineTo(px + c * hw - s * hh * lift, py + s * hw + c * hh * lift);
                  ctx.lineTo(px - c * hw - s * hh * lift, py - s * hw + c * hh * lift);
                  ctx.closePath();
                  ctx.globalAlpha = alpha * clamp(l, 0, 1) * 0.16;
                  ctx.fill();
                  ctx.globalAlpha = alpha * clamp(l, 0, 1) * 0.6;
                  ctx.stroke();
                  if (lift === 1) {
                      ctx.beginPath();
                      for (let k = 0; k < 2; k++) {
                          const v = (k ? 0.25 : -0.2) * hh, u0 = -0.6 * hw, u1 = (k ? 0.2 : 0.55) * hw;
                          ctx.moveTo(px + c * u0 - s * v, py + s * u0 + c * v);
                          ctx.lineTo(px + c * u1 - s * v, py + s * u1 + c * v);
                      }
                      ctx.stroke();
                  }
                  continue;
              }
              if (this.shome[i] === S_SWEAT) {
                  // A sweat drop: a small tear, its point the way it came from.
                  const px = this.sx[i], py = this.sy[i], rd = S * 0.03;
                  ctx.globalAlpha = alpha * clamp(l * 1.4, 0, 1) * 0.75;
                  ctx.beginPath();
                  ctx.moveTo(px, py - rd * 2.3);
                  ctx.quadraticCurveTo(px + rd * 1.1, py - rd * 0.4, px, py + rd);
                  ctx.quadraticCurveTo(px - rd * 1.1, py - rd * 0.4, px, py - rd * 2.3);
                  ctx.fill();
                  continue;
              }
              if (this.shome[i] === 1 && i % 2) {
                  // A short line along its way (what he reads: a line of code, a word).
                  const vx = this.svx[i], vy = this.svy[i], k = (S * 0.16) / (Math.sqrt(vx * vx + vy * vy) + 1e-6);
                  ctx.beginPath();
                  ctx.moveTo(this.sx[i], this.sy[i]);
                  ctx.lineTo(this.sx[i] - vx * k, this.sy[i] - vy * k);
                  ctx.stroke();
                  continue;
              }
              ctx.beginPath();
              ctx.arc(this.sx[i], this.sy[i], S * (0.035 + 0.02 * l), 0, TAU);
              ctx.fill();
          }
      }
  }
  // ===================================================================== the grid
  /**
   * The tiles of one grid, in one space (the grid's own coordinates), so that a tap on one makes every other bot turn
   * its head to it. Moments reach across it too: a bot's moment may ask the bots near him to play one (the others lean
   * away from a fart, look at a sneeze, come and high-five), each with him as its partner; and Home's rare idle
   * surprises (surprise()) are dealt from here, with the world's own random numbers.
   */
  class BotTilesWorld {
      constructor() {
          this.tiles = [];
          this.rx = [];
          this.ry = [];
          this.rw = [];
          this.rh = [];
          this.focused = -1;
          /** Idle surprises: the moments, how often a chance comes (s), the chance; the clock, its random numbers. */
          this.sList = [];
          this.sEvery = 0;
          this.sChance = 0;
          this.sT = 0;
          this.sRand = rng(0x51ed27);
          /** Tiles already asked in one dispatch (no allocation per moment). */
          this.asked = new Uint8Array(0);
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
          this.moments(dt);
      }
      settle(on = true) {
          for (const t of this.tiles)
              t.settle(on);
      }
      /**
       * Home's rare idle surprises: every `every` seconds, with `chance`, one bot at his own idle play (not tapped, not
       * busy, not Make a bot) plays one of `list` once. Empty `list`: none.
       */
      surprise(list, every, chance, seed = 1) {
          this.sList = list.filter((m) => m && m.ok);
          this.sEvery = Math.max(1, every || 0);
          this.sChance = clamp(chance || 0, 0, 1);
          this.sRand = rng((seed ^ 0x51ed27) >>> 0);
          this.sT = 0;
      }
      /** Where tile j's head is, in tile i's space, into out[0], out[1]. */
      headIn(i, j, out) {
          const t = this.tiles[j];
          out[0] = t.x[0] + this.rx[j] - this.rx[i];
          out[1] = t.y[0] + this.ry[j] - this.ry[i];
      }
      /** After a step: what moments asked of the others, where each bot's partner is now, and the idle surprises. */
      moments(dt) {
          const n = this.tiles.length;
          for (let i = 0; i < n; i++) {
              const t = this.tiles[i];
              if (t.outPlay) {
                  this.dispatch(i, t.outPlay, t.outN, t.outNear);
                  t.outPlay = null;
              }
          }
          for (let i = 0; i < n; i++) {
              const t = this.tiles[i];
              if (!t.mo)
                  continue;
              const j = t.partner;
              if (j >= 0 && j < n && j !== i && this.tiles[j].placed) {
                  this.headIn(i, j, t.tmp);
                  t.peerX = t.tmp[0];
                  t.peerY = t.tmp[1];
              }
              else {
                  t.peerX = NaN;
                  t.peerY = NaN;
              }
          }
          if (!this.sList.length || this.focused >= 0)
              return;
          this.sT += clamp(dt, 0, MAX_FRAME);
          if (this.sT < this.sEvery)
              return;
          this.sT = 0;
          if (this.sRand() >= this.sChance)
              return;
          let free = 0;
          for (const t of this.tiles)
              if (this.idle(t))
                  free++;
          if (!free)
              return;
          let k = Math.floor(this.sRand() * free);
          const m = this.sList[Math.floor(this.sRand() * this.sList.length)];
          for (const t of this.tiles)
              if (this.idle(t) && k-- === 0) {
                  t.playMoment(m, "once");
                  break;
              }
      }
      /** A bot free for a surprise: placed and moving, at his own idle play, nothing asked of him. */
      idle(t) {
          return t.placed && !t.still && !t.mo && t.kind !== "make" && t.mood === "idle" && t.moment === "play" && t.focusX !== t.focusX && t.cheerT < 0;
      }
      /** A moment asked the nearest `n` bots within `near` of tile i (his bot heights) to play `m`, with him as their partner. */
      dispatch(i, m, n, near) {
          const src = this.tiles[i], N = this.tiles.length, lim = near * src.S;
          if (this.asked.length < N)
              this.asked = new Uint8Array(N);
          this.asked.fill(0);
          const p = src.tmp;
          for (let got = 0; got < n; got++) {
              let best = -1, bd = lim;
              for (let j = 0; j < N; j++) {
                  const t = this.tiles[j];
                  if (j === i || this.asked[j] || !t.placed || t.still || t.kind === "make" || (t.mo && !t.mo.react) || t.focusX === t.focusX)
                      continue;
                  this.headIn(i, j, p);
                  const d = Math.hypot(p[0] - src.x[0], p[1] - src.y[0]);
                  if (d < bd) {
                      bd = d;
                      best = j;
                  }
              }
              if (best < 0)
                  break;
              this.asked[best] = 1;
              const t = this.tiles[best];
              if (!t.playMoment(m, "once", true))
                  continue;
              t.partner = i;
              this.headIn(best, i, t.tmp);
              t.peerX = t.tmp[0];
              t.peerY = t.tmp[1];
              if (src.partner < 0) {
                  src.partner = best;
                  this.headIn(i, best, p);
                  src.peerX = p[0];
                  src.peerY = p[1];
              }
          }
      }
  }
  /**
   * A grid's world as it is drawn (Home painted again, a return to it): its bots are kept across screens (by slug), so a
   * look left over from a tap, whose tile opened a screen and whose letting-go went with Home, is let go here, and
   * every bot goes back to its own play.
   */
  function gridWorld(tiles) {
      const w = new BotTilesWorld();
      for (const t of tiles)
          w.add(t);
      w.release();
      return w;
  }
  // ===================================================================== the living mark
  /** The Tailzu mark in its own 34 x 34 units: eight ring dots, then the two eyes (glyphs.ts MARK_DOTS on the server). */
  const MARK_DOTS = [
      [17, 4, 2], [26, 7, 2], [30, 16, 2], [27, 25, 2], [17, 30, 2], [7, 25, 2], [4, 16, 2], [8, 7, 2], [13, 15, 2.6], [21, 15, 2.6],
  ];
  /** Which ring dot lights for the first, second… working bot: spread around the ring. */
  const LIT_ORDER = [1, 4, 6, 2, 7, 3, 0, 5];
  /**
   * THE TAILZU MARK, ALIVE (Home's header: the LiveMark node). Physics like the tiles': each ring dot sits on a spring
   * at its place and drifts a little on its own; the two eyes are dots on stiffer springs that look toward the finger
   * or the cursor (`look`), swing with a scroll (`nudge`) and blink now and then; a ring dot lights in a bot's colour
   * while that bot works (`setLit`), breathing; a press squishes the whole mark (`press`). Units are the mark's own;
   * `size` scales it when drawn. Reduce Motion: `settle()`, the mark at rest, lit dots lit.
   */
  class LiveMark {
      constructor(seed = 1) {
          this.size = 34;
          this.x = new Float64Array(10);
          this.y = new Float64Array(10);
          this.vx = new Float64Array(10);
          this.vy = new Float64Array(10);
          this.ph = new Float64Array(10);
          /** Per ring dot: "" or the colour it is lit in. */
          this.lit = ["", "", "", "", "", "", "", ""];
          this.lookX = NaN;
          this.lookY = NaN;
          this.squish = 0;
          this.squishV = 0;
          this.blinkAt = 2.5;
          this.blinkT = 0;
          this.t = 0;
          this.acc = 0;
          this.still = false;
          this.rand = rng(seed);
          for (let i = 0; i < 10; i++) {
              this.x[i] = MARK_DOTS[i][0];
              this.y[i] = MARK_DOTS[i][1];
              this.ph[i] = this.rand() * TAU;
          }
      }
      /** The colours of the bots at work now (up to eight): each lights one ring dot. */
      setLit(colors) {
          for (let i = 0; i < 8; i++)
              this.lit[i] = "";
          colors.slice(0, 8).forEach((c, i) => { this.lit[LIT_ORDER[i]] = c; });
      }
      /** Look toward a point in the mark's units (it may be far outside the mark: a finger on the page). */
      look(x, y) { this.lookX = x; this.lookY = y; }
      lookAway() { this.lookX = NaN; this.lookY = NaN; }
      /** A scroll at v px/s (down: positive): the dots swing against it, the eyes most, and spring back. */
      nudge(v) {
          const k = clamp(v / 1400, -1.2, 1.2);
          for (let i = 0; i < 10; i++)
              this.vy[i] = this.vy[i] - k * (i >= 8 ? 30 : 12 + 4 * Math.sin(this.ph[i]));
      }
      /** A press: the mark squishes, and springs back. */
      press() { this.squishV += 11; }
      step(dt) {
          if (this.still)
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
          const t = (this.t += h);
          // Where the eyes go: toward what they look at (at most 1.7 units), else a slow wander.
          let ox = 0.5 * Math.sin(t * 0.37), oy = 0.3 * Math.sin(t * 0.53 + 1);
          if (this.lookX === this.lookX) {
              const dx = this.lookX - 17, dy = this.lookY - 15, d = Math.sqrt(dx * dx + dy * dy) + 1e-6, m = Math.min(1.7, d * 0.12);
              ox = (dx / d) * m;
              oy = (dy / d) * m;
          }
          for (let i = 0; i < 10; i++) {
              const eye = i >= 8, ph = this.ph[i];
              const tx = MARK_DOTS[i][0] + (eye ? ox : 0.45 * Math.sin(t * 0.8 + ph));
              const ty = MARK_DOTS[i][1] + (eye ? oy : 0.45 * Math.cos(t * 0.65 + ph * 1.3));
              const kk = eye ? 150 : 55, c = eye ? 14 : 6.5;
              this.vx[i] = this.vx[i] + ((tx - this.x[i]) * kk - this.vx[i] * c) * h;
              this.vy[i] = this.vy[i] + ((ty - this.y[i]) * kk - this.vy[i] * c) * h;
              this.x[i] = this.x[i] + this.vx[i] * h;
              this.y[i] = this.y[i] + this.vy[i] * h;
          }
          this.squishV += (-this.squish * 260 - this.squishV * 13) * h;
          this.squish += this.squishV * h;
          this.blinkAt -= h;
          if (this.blinkAt <= 0) {
              this.blinkT = 0.13;
              this.blinkAt = 2.2 + this.rand() * 4;
          }
          if (this.blinkT > 0)
              this.blinkT -= h;
      }
      /** Reduce Motion: at rest, nothing moves after it (until settle(false)). */
      settle(on = true) {
          this.still = on;
          if (!on)
              return;
          for (let i = 0; i < 10; i++) {
              this.x[i] = MARK_DOTS[i][0];
              this.y[i] = MARK_DOTS[i][1];
              this.vx[i] = 0;
              this.vy[i] = 0;
          }
          this.squish = 0;
          this.squishV = 0;
          this.blinkT = 0;
      }
      finite() {
          for (let i = 0; i < 10; i++)
              if (!Number.isFinite(this.x[i]) || !Number.isFinite(this.y[i]))
                  return false;
          return Number.isFinite(this.squish);
      }
      /** The mark at `size` px (the caller clips and places it). */
      draw(ctx, alpha = 1) {
          const s = this.size / 34, sq = clamp(this.squish, -0.6, 0.6), sx = (1 + sq * 0.16) * s, sy = (1 - sq * 0.16) * s;
          const px = (i) => 17 * s + (this.x[i] - 17) * sx, py = (i) => 17 * s + (this.y[i] - 17) * sy;
          // The ink dots, in one path; an eye mid-blink is a flattened dot.
          ctx.globalAlpha = alpha;
          ctx.fillStyle = INK;
          ctx.beginPath();
          for (let i = 0; i < 10; i++) {
              if (i < 8 && this.lit[i])
                  continue;
              const r = MARK_DOTS[i][2] * s, x = px(i), y = py(i);
              if (i >= 8 && this.blinkT > 0) {
                  const ry = r * 0.22;
                  ctx.moveTo(x - r, y);
                  ctx.quadraticCurveTo(x - r, y - ry, x, y - ry);
                  ctx.quadraticCurveTo(x + r, y - ry, x + r, y);
                  ctx.quadraticCurveTo(x + r, y + ry, x, y + ry);
                  ctx.quadraticCurveTo(x - r, y + ry, x - r, y);
              }
              else {
                  ctx.moveTo(x + r, y);
                  ctx.arc(x, y, r, 0, TAU);
              }
          }
          ctx.fill();
          // The lit dots: the bot's colour, and a soft breathing halo.
          for (let i = 0; i < 8; i++) {
              const c = this.lit[i];
              if (!c)
                  continue;
              const r = MARK_DOTS[i][2] * s, x = px(i), y = py(i), b = 0.5 + 0.5 * Math.sin(this.t * 2.6 + i);
              ctx.fillStyle = c;
              ctx.globalAlpha = alpha * (0.14 + 0.16 * b);
              ctx.beginPath();
              ctx.arc(x, y, r * (1.7 + 0.35 * b), 0, TAU);
              ctx.fill();
              ctx.globalAlpha = alpha;
              ctx.beginPath();
              ctx.arc(x, y, r * 1.08, 0, TAU);
              ctx.fill();
          }
          ctx.globalAlpha = 1;
      }
  }
  /**
   * When each word of a line that writes itself (the WriteOn node) comes, in ms from the start: dictation's uneven pace
   * (a word's length, a little jitter, a breath after a comma or a full stop). Same seed, same timing.
   */
  function writeOnTimes(words, seed = 1) {
      const r = rng(seed);
      const out = [];
      let t = 260;
      for (const w of words) {
          out.push(Math.round(t));
          t += 95 + Math.min(10, w.length) * 16 + r() * 90 + (/[,;:]$/.test(w) ? 170 : /[.?!]$/.test(w) ? 260 : 0);
      }
      return out;
  }
  return { CARRY, TAP, STEP, MAX_FRAME, PALETTE, INK, kindOf, rng, LOOKS_FORMAT, MOMENT_VARS, MOMENT_FUNCS, checkExpression, Part, ANCHORS, Wear, Avatar, BLIP, TRACK_FIELDS, TRACK_ENUMS, MOMENT_LIMITS, Moment, Looks, compileLooks, compileAvatar, Fabric, BotTile, BotTilesWorld, gridWorld, LiveMark, writeOnTimes };
});
