// GENERATED: do not edit. The screen kernel: expressions, formats, templates, rules, limits and paths.
// Source: TAILZU-FRONTEND/app/src/sdui/kernel/; regenerate with `node src/sdui/kernel/genKernel.mjs` there.
// limits.ts sha256 0c95980b0a8278dcd537470d537ab32027a360673c7a599a9a4be67cdd870a24
// blocks.ts sha256 effce3c5ce8618170a1a7d76d966fbabd3c52be42e615e4edd7ee4944583cf14
// paths.ts sha256 d93249b80fcef3f6b0bd12a8130210ad5bd936d1a5ccb2c55694dcb3438aeae1
// coreGrammar.ts sha256 da975175d31b7fae75a323fe081da3d4f9dbbc3f9488a4a186be4092741a82fe
// format.ts sha256 0df4bdcb8e5abfc43fb88567aa7881339b4a31b2122e2ade6fcf59538d4ac174
// expr.ts sha256 1b07f37f4971a3856c95348c4fb6f8b41e4edefe27a4aad3280afcfada543385
// text.ts sha256 1327d4f359cbdc9b31731450afe442a65339bae2e69bfa4715ed2c678c007d30
// defs.ts sha256 0f483c84ac2a7c53426f530688e51b46841efa00f94f8e7f2a8238cb123af03d
// rules.ts sha256 97a79a2facd1ab5dfa7da45e6cb46e5b58f58530ecb7153a64c3d28d76ca575c
// body sha256 1e57780ac60948dc288201337d43fe1e256ba7ea86d7dc1a9739c3a3747204b9
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.TailzuKernel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  /**
   * THE LIMITS ON SERVER DATA (pure SPEC 5.1), in one table.
   *
   * The device enforces these; the server lints the same numbers out of the generated copy of this kernel, so there is
   * one set of numbers and not two that drift. Every number is a starting value, meant to be tuned from measurements:
   * change it here and both sides move together on the next generate.
   *
   * Nothing in this file knows about React, the store or the network. It is a table and three small helpers.
   */
  /** Every limit, by the name the rest of the kernel asks for. Frozen: a screen must never be able to raise one. */
  const LIMITS = Object.freeze({
      /** A whole screen, as it arrives. */
      screenBytes: 512 * 1024,
      /** Nodes after templates are expanded. */
      nodes: 2500,
      /** How deep a tree may nest. */
      depth: 48,
      /**
       * Steps one expansion may take. A `Use` and a `Slot` draw nothing, so they cost no node — which means a screen
       * could fan out through them for ever while `nodes` stays at 0. This counts every step instead, so the work is
       * bounded even when the drawing is not.
       */
      expandSteps: 10000,
      /** One string prop, and the longest text an expression may build. */
      stringBytes: 8 * 1024,
      /** One expression's source text. */
      exprChars: 400,
      /** Compiled operations in one expression (counted while compiling, so running it is bounded). */
      exprOps: 256,
      /** Expressions in one screen. */
      exprPerScreen: 600,
      /** Operations across every expression run for one change of the store. */
      opsPerChange: 20000,
      /** Holes in one `$t` text. Derived from exprOps: each hole costs at least one op. */
      textHoles: 64,
      /** Template definitions in one screen. */
      defs: 32,
      /** How deep `Use` may nest. */
      defsDepth: 6,
      /** Nodes in one list-item template, after expansion. */
      defsNodes: 200,
      /** Rules on one screen (its own and its nodes'). */
      rules: 32,
      /** Timers (`every`, `after`) on one screen. */
      timers: 4,
      /** The shortest `every`, and the shortest while the node is visible and the app is in front. */
      everyMs: 1000,
      everyVisibleMs: 250,
      /**
       * The longest a timer may wait: a day. `setTimeout` on Node and on Chromium takes a 32-bit delay, and a longer
       * one fires AT ONCE, which turns a far-off `after` into a wake-tick-wake spin. A screen that wants tomorrow asks
       * the server again.
       */
      timerMaxMs: 24 * 60 * 60 * 1000,
      /** How often any rule may fire. */
      firesPerSecond: 10,
      /** How deep one action may chain into another. */
      actionDepth: 16,
      /** One page of a list, and how many rows are held at once. */
      pageItems: 100,
      listItems: 2000,
      /** Live gestures on one screen. */
      gestures: 12,
      /** Animated nodes at once, keys in one animated value, and shared moves running together. */
      motionNodes: 64,
      keyframes: 64,
      sharedMoves: 2,
      /** Images: https only, and these sizes. */
      imagePx: 4096,
      imageBytes: 8 * 1024 * 1024,
      /** A state path: `a.b.c`, this many segments and characters. */
      pathSegments: 12,
      pathChars: 128,
      /** One screen's store. */
      storeBytes: 2 * 1024 * 1024,
      /** Everything kept on this phone by `local.set`. */
      localBytes: 256 * 1024,
      /** Live topics on one screen, one message, and how often merges may land. */
      topics: 4,
      topicMessageBytes: 64 * 1024,
      mergesPerSecond: 20,
  });
  /**
   * How many bytes a string takes as UTF-8. Limits are in bytes, because that is what a payload costs; `s.length`
   * would let an emoji-heavy string through at four times the size.
   */
  function byteLen(s) {
      let n = 0;
      for (let i = 0; i < s.length; i += 1) {
          const c = s.charCodeAt(i);
          if (c < 0x80)
              n += 1;
          else if (c < 0x800)
              n += 2;
          else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
              const d = s.charCodeAt(i + 1);
              if (d >= 0xdc00 && d <= 0xdfff) {
                  n += 4;
                  i += 1;
                  continue;
              }
              n += 3;
          }
          else
              n += 3;
      }
      return n;
  }
  /** True when a string is inside the per-prop limit. */
  function stringFits(s) {
      return byteLen(s) <= LIMITS.stringBytes;
  }
  /** The shortest `every` a rule may ask for, given where it sits. */
  function everyFloorMs(whileVisible, foreground) {
      return whileVisible && foreground ? LIMITS.everyVisibleMs : LIMITS.everyMs;
  }

  /**
   * THE CLOSED LIST OF BUILDING BLOCKS, and the vocabulary number (pure SPEC 2.0, principle 2).
   *
   * A client says `vocab: 2` (it has this kernel) and then names the blocks it actually has. The blocks arrive over
   * several updates, so one number could never say which of them a phone holds. The names are closed here: a server
   * that asks for a name this list does not know is asking for something no build will ever have, and that is an
   * error, not a missing feature.
   *
   * A screen states the blocks it needs. Every block is OFF for a screen that does not name it.
   */
  /** The vocabulary this kernel speaks. Vocab 1 is the old fixed node list, with no expressions. */
  const VOCAB = 2;
  /** Every block name there is. In the order of SPEC 2.1: expressions first, the shell last. */
  const BLOCKS = Object.freeze([
      "expr",
      "defs",
      "rules",
      "device",
      "local",
      "paint",
      "motion",
      "gesture",
      "list",
      "input",
      "media",
      "data",
      "shell",
  ]);
  const BLOCK_SET = new Set(BLOCKS);
  /**
   * Names that are planned but belong to another spec, so a server asking for one is early, not wrong. `scene` is the
   * standalone drawing node, which arrives with the animation spec's format 3. It is not in BLOCKS until it ships.
   */
  const LATER_BLOCKS = Object.freeze(["scene"]);
  /** True when the name is a block this kernel knows. */
  function isBlock(name) {
      return typeof name === "string" && BLOCK_SET.has(name);
  }
  /** The names in a list that no build will ever declare, so the server can be told it asked for nonsense. */
  function unknownBlocks(names) {
      const bad = [];
      for (const n of names) {
          if (isBlock(n))
              continue;
          const s = typeof n === "string" ? n : String(n);
          if (!bad.includes(s))
              bad.push(s);
      }
      return bad;
  }
  /** The blocks a screen needs that this client did not declare. Empty means it can be drawn. */
  function missingBlocks(declared, needed) {
      const have = new Set(declared.filter(isBlock));
      const out = [];
      for (const n of needed) {
          const s = typeof n === "string" ? n : String(n);
          if (!have.has(s) && !out.includes(s))
              out.push(s);
      }
      return out;
  }
  /** True when every block the screen needs is one this client declared. */
  function canDraw(declared, needed) {
      return missingBlocks(declared, needed).length === 0;
  }

  /**
   * PATHS THE SERVER MAY NAME, checked here so the device and the server agree (pure SPEC 5.1, 2.2, 2.9).
   *
   * Three kinds of path arrive from the server and none of them is trusted:
   *
   *   • a state path (`setState.path`, a gesture's `into`, `subscribe.into`, `progressInto`) — plain segments only,
   *     never `__proto__`, `constructor` or `prototype`, which is the rule `state.ts:setPath` already enforces;
   *   • a `local` key — the same shape, in its own namespace, and never something that looks like a secret;
   *   • a network path (`callEndpoint.path`, `page.endpoint`, `subscribe.topic`) — relative, under `/v1/`, on our own
   *     API origin, with every filled value encoded.
   *
   * Every check returns a short reason instead of throwing, because the caller (renderer or lint) wants to report it.
   */
  /** Keys that would reach every object in the app if a path were walked blindly. */
  const DANGEROUS = new Set(["__proto__", "constructor", "prototype"]);
  /** A segment of a path: letters, digits, `_` and `-`. An array index is just digits. */
  const SEGMENT = /^[A-Za-z0-9_-]+$/;
  /** Empty when the state path is fine; otherwise the reason it is refused. */
  function statePathError(path) {
      if (typeof path !== "string" || path.length === 0)
          return "a path must be a non-empty string";
      if (path.length > LIMITS.pathChars)
          return `a path is at most ${LIMITS.pathChars} characters`;
      const parts = path.split(".");
      if (parts.length > LIMITS.pathSegments)
          return `a path is at most ${LIMITS.pathSegments} segments`;
      for (const p of parts) {
          if (p.length === 0)
              return "a path has an empty segment";
          if (DANGEROUS.has(p))
              return `"${p}" is not a name a path may use`;
          if (!SEGMENT.test(p))
              return `"${p}" is not a plain name (letters, digits, _ and - only)`;
      }
      return "";
  }
  /** True when a state path is one the device will write. */
  function statePathOk(path) {
      return statePathError(path) === "";
  }
  /** The words that make a name look like a secret. `local` is a drawer for hints and drafts, not for these. */
  const SECRET_WORDS = new Set([
      "token", "secret", "password", "passwd", "pwd", "auth", "jwt", "bearer", "credential", "credentials", "cred",
      "apikey", "accesskey", "privatekey", "session", "cookie", "otp", "pin", "passcode", "signature", "refresh",
  ]);
  /** The words in a name: `lastOtpSentAt` is last, otp, sent, at; `api_key` is api, key. */
  function words(name) {
      return name
          .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
          .split(/[^A-Za-z0-9]+/)
          .filter(Boolean)
          .map((w) => w.toLowerCase());
  }
  /** True when a name reads like a secret (`authToken`, `api_key`, `session`). Two words joined count too. */
  function looksLikeSecret(name) {
      const w = words(name);
      for (let i = 0; i < w.length; i += 1) {
          if (SECRET_WORDS.has(w[i]))
              return true;
          if (i + 1 < w.length && SECRET_WORDS.has(w[i] + w[i + 1]))
              return true;
      }
      return false;
  }
  /** Empty when the `local` key is fine; otherwise why it is refused. */
  function localKeyError(key) {
      const shape = statePathError(key);
      if (shape)
          return shape;
      const k = key;
      if (looksLikeSecret(k))
          return `"${k}" reads like a secret; local is for hints, drafts and last choices`;
      return "";
  }
  /** True when a `local` key may be written on this phone. */
  function localKeyOk(key) {
      return localKeyError(key) === "";
  }
  /** A scheme at the front: `http:`, `tulmi:`, `javascript:`. */
  const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
  /**
   * A dot, a slash or a backslash, however it is spelled. `%2e`, `%2f` and `%5c` are not decoration: the URL rules
   * every client here follows (WHATWG in the window, OkHttp on Android, Foundation on iOS) resolve `.%2e`, `%2e.`
   * and `%2e%2e` as `..`, so `/v1/.%2e/admin` leaves `/v1/` and lands on `/admin`. The climbing checks run on the
   * decoded text, never on the text as written.
   */
  function decodeDots(s) {
      if (!s.includes("%"))
          return s;
      return s.replace(/%2e/gi, ".").replace(/%2f/gi, "/").replace(/%5c/gi, "\\");
  }
  /**
   * Empty when the network path is fine; otherwise why it is refused. The path is already filled (holes encoded):
   * this is the last gate before it is joined to our API origin.
   *
   * The climbing checks (`..`, `//`, a backslash) are measured on the PATH, the part before `?` or `#`. Only that
   * part decides which endpoint is reached, and a search box holds ordinary words: `?q=wait...` or a pasted URL
   * must not cost the person their request (SPEC 2.2, and `encodeHole` keeps a filled value out of the path part
   * by encoding its dots as well as its slashes).
   */
  function networkPathError(path) {
      if (typeof path !== "string" || path.length === 0)
          return "a path must be a non-empty string";
      if (byteLen(path) > 2048)
          return "a path is at most 2048 bytes";
      if (SCHEME.test(path))
          return "a path is relative to our API, so it carries no scheme";
      if (path.startsWith("//"))
          return "a path is relative to our API, so it names no host";
      if (!path.startsWith("/v1/"))
          return "a path starts with /v1/";
      if (path.includes("\\"))
          return "a path never contains a backslash";
      const cut = path.search(/[?#]/);
      const head = decodeDots(cut === -1 ? path : path.slice(0, cut));
      if (head.includes("//"))
          return 'a path never contains "//"';
      if (head.includes(".."))
          return 'a path never contains ".."';
      if (head.includes("\\"))
          return "a path never contains a backslash";
      for (let i = 0; i < path.length; i += 1) {
          const c = path.charCodeAt(i);
          if (c < 0x21 || c === 0x7f)
              return "a path never contains a space or a control character";
      }
      return "";
  }
  /** True when a filled network path may be called. */
  function networkPathOk(path) {
      return networkPathError(path) === "";
  }
  /**
   * One filled value inside a path, encoded. `actions.ts` already does this for `$state.` tokens; every hole in a
   * `$t` path goes through the same door, so a note id of `../admin` cannot climb out of its place.
   *
   * `encodeURIComponent` leaves a dot alone, so the dot is encoded here too (`%2E`). A filled value then cannot
   * spell a dot segment at all, and words with dots in them — "wait..." typed into a search box — ride through a
   * query without the whole call being refused.
   */
  function encodeHole(value) {
      if (value === null || value === undefined)
          return "";
      if (typeof value === "number")
          return Number.isFinite(value) ? encodeURIComponent(String(value)) : "0";
      if (typeof value === "boolean")
          return value ? "true" : "false";
      if (typeof value === "string")
          return encodeURIComponent(value).replace(/\./g, "%2E");
      return "";
  }
  /**
   * True when `changed` and `dep` touch each other: the same path, one inside the other, or a dependency that ended
   * in `.*` because the screen indexed it with an expression. Used for re-rendering only what changed.
   */
  function pathsTouch(dep, changed) {
      if (dep.endsWith(".*")) {
          const base = dep.slice(0, -2);
          return changed === base || changed.startsWith(base + ".") || base.startsWith(changed + ".");
      }
      return dep === changed || dep.startsWith(changed + ".") || changed.startsWith(dep + ".");
  }

  /**
   * THE NUMERIC GRAMMAR, COPIED FROM THE BOT TILES' CORE (pure SPEC 2.0, principle 1).
   *
   * The bot's animation language and a screen's expressions have to agree about what a number means: the same
   * precedence, the same functions, the same "anything not finite is 0". `src/botTiles/core.ts` is self-contained and
   * frozen by its own sha chain, so the kernel does not import it — it keeps a copy of its numeric grammar here,
   * between the markers below, and `tools/ci/marked-regions.mjs` (pair CoreExprGrammar, lang TS) diffs the two byte
   * for byte. Nothing between the markers may be edited here: change core.ts and copy it across in one commit.
   *
   * This copy is what the kernel tests its own evaluator against (expr.test.ts): a number expression means the same
   * thing in a moment and on a screen, or one of the two is wrong.
   *
   * Two helpers the copied region reads sit outside it, byte-identical to core.ts's own, because they are declared
   * elsewhere in that file.
   */
  /** A full turn, as core.ts has it. */
  const TAU = Math.PI * 2;
  /** A number in [0, 1) from n: the same n, the same number (core.ts's own, used by the `hash` function). */
  const hash01 = (n) => {
      const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
      return s - Math.floor(s);
  };
  // BEGIN CoreExprGrammar
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
  /** Expression text into bytecode (a constant when it reads no name). Throws on anything it does not know. `names` are the
   *  names it may read, in the order their values are handed to it: a moment's (MOMENT_VARS), or a caller's own. */
  function xcompile(src, names = MOMENT_VARS) {
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
              const vi = names.indexOf(k.v);
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
  /** The names a screen expression may hand the numeric engine. A screen has no moment, so it names its own. */
  function compileNumeric(src, names) {
      return xcompile(src, names ?? MOMENT_VARS);
  }
  /** Run a compiled number. `vars` holds one value per name, in the order they were compiled with. */
  function runNumeric(x, vars) {
      return x.code ? xrun(x.code, vars) : x.c;
  }
  /** Empty when the source compiles in the numeric grammar; otherwise the reason it does not. */
  function numericError(src, names) {
      try {
          xcompile(src, names ?? MOMENT_VARS);
          return "";
      }
      catch (e) {
          return e.message;
      }
  }

  /**
   * THE FORMATTING HELPERS a screen may call (pure SPEC 2.2, the `fmt.*` functions).
   *
   * These are the only way a screen turns a number or a time into words, so "3 of 5 done", "2 min ago" and a call's
   * running clock are server data and not another app build. Everything here is a plain function over plain values
   * plus an environment (the locale, what time it is now, which zone) — no clock of its own, so a test can pin it.
   *
   * Times are MILLISECONDS everywhere in this kernel, to match `now()` and the rule timers. A time may also arrive as
   * an ISO string, which is what the server sends.
   *
   * `Intl` is used when the build has it, and every call falls back to plain English, because a formatter throwing
   * would take a screen down for a label.
   */
  /** A quiet environment for tests and for anything that only needs a number formatted. */
  const PLAIN_ENV = Object.freeze({ locale: "en-US", now: 0, timeZone: "UTC", intl: true });
  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;
  /** Anything not a finite number becomes 0, as everywhere else in the kernel. */
  function finite(n) {
      return typeof n === "number" && Number.isFinite(n) ? n : 0;
  }
  /** A time as milliseconds: a number stays, an ISO string is parsed, anything else is null. */
  function millisOf(v) {
      if (typeof v === "number")
          return Number.isFinite(v) ? v : null;
      if (typeof v === "string" && v.length > 0) {
          const t = Date.parse(v);
          return Number.isNaN(t) ? null : t;
      }
      return null;
  }
  /** True when this build can format with `Intl` and the environment allows it. */
  function useIntl(env) {
      return env.intl !== false && typeof Intl !== "undefined";
  }
  /**
   * Built `Intl` objects, kept by what was asked for. Building one costs about twenty microseconds and formatting
   * with it costs well under one, so a hundred-row list on a one-second tick would spend most of its time in
   * constructors. A build that lacks a formatter is remembered as `null`, so a missing `RelativeTimeFormat` is not
   * thrown and caught on every label.
   *
   * Bounded: a phone has one locale, so a handful of entries covers everything. Past the bound the whole thing is
   * dropped rather than half-kept, which is one line and cannot leak.
   */
  const FORMATTERS = new Map();
  const FORMATTERS_MAX = 32;
  function cachedFormat(kind, locale, opts, make) {
      const key = `${kind}|${locale}|${opts === undefined ? "" : JSON.stringify(opts)}`;
      const had = FORMATTERS.get(key);
      if (had !== undefined)
          return had;
      let made = null;
      try {
          made = make();
      }
      catch {
          made = null;
      }
      if (FORMATTERS.size >= FORMATTERS_MAX)
          FORMATTERS.clear();
      FORMATTERS.set(key, made);
      return made;
  }
  /** Thousands separators by hand, for a build with no `Intl`. */
  function groupPlain(s) {
      const neg = s.startsWith("-");
      const body = neg ? s.slice(1) : s;
      const dot = body.indexOf(".");
      const whole = dot === -1 ? body : body.slice(0, dot);
      const rest = dot === -1 ? "" : body.slice(dot);
      let out = "";
      for (let i = 0; i < whole.length; i += 1) {
          if (i > 0 && (whole.length - i) % 3 === 0)
              out += ",";
          out += whole[i];
      }
      return (neg ? "-" : "") + out + rest;
  }
  /** A number with its grouping. `digits` fixes the decimals when it is given. */
  function fmtNumber(value, digits, env = PLAIN_ENV) {
      const n = finite(value);
      const d = digits === undefined || digits === null ? null : Math.max(0, Math.min(8, Math.round(finite(digits))));
      if (useIntl(env)) {
          const opts = d === null ? {} : { minimumFractionDigits: d, maximumFractionDigits: d };
          const f = cachedFormat("number", env.locale, opts, () => new Intl.NumberFormat(env.locale, opts));
          if (f) {
              try {
                  return f.format(n);
              }
              catch {
                  // falls through to the plain path
              }
          }
      }
      return groupPlain(d === null ? String(n) : n.toFixed(d));
  }
  /** An amount of money. The code is a currency code such as "INR"; an unknown one is simply put in front. */
  function fmtCurrency(value, code, env = PLAIN_ENV) {
      const n = finite(value);
      const c = typeof code === "string" && /^[A-Za-z]{3}$/.test(code) ? code.toUpperCase() : "";
      if (c && useIntl(env)) {
          const opts = { style: "currency", currency: c };
          const f = cachedFormat("currency", env.locale, opts, () => new Intl.NumberFormat(env.locale, opts));
          if (f) {
              try {
                  return f.format(n);
              }
              catch {
                  // falls through to the plain path
              }
          }
      }
      const body = fmtNumber(n, 2, { ...env, intl: false });
      return c ? `${c} ${body}` : body;
  }
  /**
   * One of two words by the count. `#` in either word becomes the number: `fmt.plural(n, "# note", "# notes")`.
   * `Intl.PluralRules` picks between them where a language disagrees with English about 0 or 1.
   */
  function fmtPlural(count, one, other, env = PLAIN_ENV) {
      const n = finite(count);
      const a = typeof one === "string" ? one : "";
      const b = typeof other === "string" ? other : "";
      let pick = Math.abs(n) === 1 ? a : b;
      if (useIntl(env)) {
          const f = cachedFormat("plural", env.locale, undefined, () => new Intl.PluralRules(env.locale));
          if (f) {
              try {
                  pick = f.select(n) === "one" ? a : b;
              }
              catch {
                  // keeps the English choice
              }
          }
      }
      return pick.includes("#") ? pick.split("#").join(fmtNumber(n, undefined, env)) : pick;
  }
  /** The unit a gap is best said in, and how many of it. */
  function relUnit(ms) {
      const a = Math.abs(ms);
      if (a < MINUTE)
          return { unit: "second", n: Math.round(ms / SECOND) };
      if (a < HOUR)
          return { unit: "minute", n: Math.round(ms / MINUTE) };
      if (a < DAY)
          return { unit: "hour", n: Math.round(ms / HOUR) };
      if (a < WEEK)
          return { unit: "day", n: Math.round(ms / DAY) };
      if (a < 30 * DAY)
          return { unit: "week", n: Math.round(ms / WEEK) };
      if (a < 365 * DAY)
          return { unit: "month", n: Math.round(ms / (30 * DAY)) };
      return { unit: "year", n: Math.round(ms / (365 * DAY)) };
  }
  const SHORT_UNIT = { second: "s", minute: "min", hour: "h", day: "d", week: "w", month: "mo", year: "y" };
  /** "just now", "5 min ago", "in 2 h". `when` is a time, not a gap. */
  function fmtRelative(when, env = PLAIN_ENV) {
      const t = millisOf(when);
      if (t === null)
          return "";
      const gap = t - env.now;
      if (Math.abs(gap) < 45 * SECOND)
          return "just now";
      const { unit, n } = relUnit(gap);
      if (useIntl(env)) {
          const opts = { numeric: "auto" };
          const f = cachedFormat("relative", env.locale, opts, () => new Intl.RelativeTimeFormat(env.locale, opts));
          if (f) {
              try {
                  return f.format(n, unit);
              }
              catch {
                  // falls through to the plain path
              }
          }
      }
      const short = `${Math.abs(n)} ${SHORT_UNIT[unit]}`;
      return gap < 0 ? `${short} ago` : `in ${short}`;
  }
  /** Two digits, for the plain clock. */
  function two(n) {
      return n < 10 ? `0${n}` : String(n);
  }
  /** A date, a time, or both. `style` is "date", "time" or "datetime" (the default). */
  function fmtDatetime(when, style, env = PLAIN_ENV) {
      const t = millisOf(when);
      if (t === null)
          return "";
      const s = style === "date" || style === "time" ? style : "datetime";
      if (useIntl(env)) {
          const opts = {};
          if (env.timeZone)
              opts.timeZone = env.timeZone;
          if (s !== "time") {
              opts.year = "numeric";
              opts.month = "short";
              opts.day = "numeric";
          }
          if (s !== "date") {
              opts.hour = "numeric";
              opts.minute = "2-digit";
          }
          const f = cachedFormat("datetime", env.locale, opts, () => new Intl.DateTimeFormat(env.locale, opts));
          if (f) {
              try {
                  return f.format(new Date(t));
              }
              catch {
                  // falls through to the plain path
              }
          }
      }
      const d = new Date(t);
      const date = `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
      const time = `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
      return s === "date" ? date : s === "time" ? time : `${date} ${time}`;
  }
  /** A length of time as a clock: "0:09", "4:05", "1:02:03". Milliseconds in, and never negative. */
  function fmtDuration(ms) {
      const total = Math.max(0, Math.floor(finite(ms) / SECOND));
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
  }
  /** How long since something started, as a clock. This is the call screen's running time. */
  function fmtElapsed(startedAt, env = PLAIN_ENV) {
      const t = millisOf(startedAt);
      if (t === null)
          return fmtDuration(0);
      return fmtDuration(env.now - t);
  }

  /**
   * THE EXPRESSION LANGUAGE (pure SPEC 2.2, B1), closed on purpose.
   *
   * A screen may say `{ "$": "state.busy ? 0.4 : 1" }` and the device works it out. That is the whole point of the
   * pure renderer, and it is also the one place where server data comes closest to being code — so the language is
   * closed, and this file is the only thing that runs it:
   *
   *   • no loops, no user-defined functions, no assignment, no regular expressions, no I/O, no `eval`;
   *   • a fixed set of names (`state`, `device`, `local`, `item`, `index`, `args`, `ui`) and a fixed set of functions;
   *   • a cost known at COMPILE time: an expression is refused above `LIMITS.exprOps`, so running it is bounded
   *     before it ever runs once;
   *   • anything not finite becomes 0, the same rule the bot tiles' numeric engine follows (coreGrammar.ts);
   *   • `__proto__`, `constructor` and `prototype` are not reachable, and a function found on an object is never
   *     returned, let alone called.
   *
   * While compiling, the paths an expression reads are written down (`deps`), so the renderer can re-render one node
   * when one value changes instead of the screen on every write.
   */
  /** Something the server sent is wrong. `code` says which rule it broke, for the report the device sends back. */
  class KernelError extends Error {
      constructor(code, message) {
          super(message);
          this.name = "KernelError";
          this.code = code;
      }
  }
  /** An expression that reads the clock depends on this, so the renderer knows it must tick. */
  const TIME_DEP = "@time";
  /** The roots an expression may start from. Everything else is a function name or nothing at all. */
  const ROOTS = ["state", "device", "local", "item", "index", "args", "ui"];
  const ROOT_SET = new Set(ROOTS);
  /** Keys no path may reach, however it is spelled. */
  const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
  // ---- values
  /** One step of a path, with every door to the prototype chain shut. Functions are never handed back. */
  function pick(base, key) {
      if (base === null || base === undefined)
          return undefined;
      let k;
      if (typeof key === "number")
          k = Number.isFinite(key) ? String(Math.trunc(key)) : "";
      else if (typeof key === "string")
          k = key;
      else if (typeof key === "boolean")
          k = String(key);
      else
          return undefined;
      if (k === "" || BLOCKED_KEYS.has(k))
          return undefined;
      if (typeof base === "string") {
          if (k === "length")
              return base.length;
          const i = Number(k);
          return Number.isInteger(i) && i >= 0 && i < base.length ? base[i] : undefined;
      }
      if (Array.isArray(base)) {
          if (k === "length")
              return base.length;
          const i = Number(k);
          return Number.isInteger(i) && i >= 0 && i < base.length ? base[i] : undefined;
      }
      if (typeof base !== "object")
          return undefined;
      if (!Object.prototype.hasOwnProperty.call(base, k))
          return undefined;
      const v = base[k];
      return typeof v === "function" ? undefined : v;
  }
  /** A value as a number: a boolean counts, anything else that is not a finite number is 0. */
  function num(v) {
      if (typeof v === "number")
          return Number.isFinite(v) ? v : 0;
      if (typeof v === "boolean")
          return v ? 1 : 0;
      return 0;
  }
  /**
   * A value as text, for `+` and for a `$t` hole. An object or a list becomes "", never "[object Object]": a screen
   * that meant to show a name and got a row should show nothing, not debug output.
   */
  function toText(v) {
      if (v === null || v === undefined)
          return "";
      if (typeof v === "string")
          return v;
      if (typeof v === "number")
          return Number.isFinite(v) ? String(v) : "0";
      if (typeof v === "boolean")
          return v ? "true" : "false";
      return "";
  }
  /**
   * Strings a screen builds have the same ceiling as strings it sends. Every expression's RESULT goes through this
   * (see `compileExpr`), so the ceiling holds whichever function made the string — `upper`, `slice`, `t` or a `+`.
   *
   * Counting bytes walks the string, and this runs on every re-render, so the two cheap bounds come first: a code
   * unit is one to three UTF-8 bytes, which settles almost every real string without counting.
   */
  function capText(s) {
      if (s.length * 3 <= LIMITS.stringBytes)
          return s;
      if (s.length > LIMITS.stringBytes || byteLen(s) > LIMITS.stringBytes) {
          throw new KernelError("string", `an expression built a string over ${LIMITS.stringBytes} bytes`);
      }
      return s;
  }
  /** Equality: null and undefined are the same nothing, numbers compare as numbers, everything else is strict. */
  function eq(a, b) {
      if (a === null || a === undefined)
          return b === null || b === undefined;
      if (b === null || b === undefined)
          return false;
      if (typeof a === "number" || typeof b === "number") {
          if (typeof a === "number" && typeof b === "number")
              return num(a) === num(b);
          return false;
      }
      return a === b;
  }
  /** Less-than and friends: text against text reads as text, everything else as numbers. */
  function cmp(a, b) {
      if (typeof a === "string" && typeof b === "string")
          return a < b ? -1 : a > b ? 1 : 0;
      const x = num(a), y = num(b);
      return x < y ? -1 : x > y ? 1 : 0;
  }
  /** JavaScript's own truthiness, so `state.name && state.name` reads the way the server author expects. */
  function truthy(v) {
      return !!v;
  }
  const fmtEnv = (s) => s.env ?? PLAIN_ENV;
  /** A list, or nothing. Strings are not lists here: `count` handles both, the rest want rows. */
  function rows(v) {
      return Array.isArray(v) ? v : [];
  }
  const FUNCS = {
      // math
      min: { min: 1, max: 8, call: (a) => a.reduce((m, v) => Math.min(m, num(v)), num(a[0])) },
      max: { min: 1, max: 8, call: (a) => a.reduce((m, v) => Math.max(m, num(v)), num(a[0])) },
      clamp: { min: 3, max: 3, call: (a) => { const v = num(a[0]), lo = num(a[1]), hi = num(a[2]); return v < lo ? lo : v > hi ? hi : v; } },
      round: { min: 1, max: 2, call: (a) => { const d = Math.max(0, Math.min(8, Math.trunc(num(a[1])))); const p = Math.pow(10, d); const r = Math.round(num(a[0]) * p) / p; return Number.isFinite(r) ? r : 0; } },
      floor: { min: 1, max: 1, call: (a) => Math.floor(num(a[0])) },
      ceil: { min: 1, max: 1, call: (a) => Math.ceil(num(a[0])) },
      abs: { min: 1, max: 1, call: (a) => Math.abs(num(a[0])) },
      sqrt: { min: 1, max: 1, call: (a) => { const v = num(a[0]); return v < 0 ? 0 : Math.sqrt(v); } },
      sin: { min: 1, max: 1, call: (a) => Math.sin(num(a[0])) },
      cos: { min: 1, max: 1, call: (a) => Math.cos(num(a[0])) },
      atan2: { min: 2, max: 2, call: (a) => Math.atan2(num(a[0]), num(a[1])) },
      // text
      len: { min: 1, max: 1, call: (a) => (typeof a[0] === "string" ? a[0].length : Array.isArray(a[0]) ? a[0].length : 0) },
      upper: { min: 1, max: 1, call: (a) => toText(a[0]).toUpperCase() },
      lower: { min: 1, max: 1, call: (a) => toText(a[0]).toLowerCase() },
      trim: { min: 1, max: 1, call: (a) => toText(a[0]).trim() },
      slice: {
          min: 2, max: 3,
          call: (a) => {
              const from = Math.trunc(num(a[1]));
              const to = a[2] === undefined ? undefined : Math.trunc(num(a[2]));
              if (Array.isArray(a[0]))
                  return a[0].slice(from, to);
              return toText(a[0]).slice(from, to);
          },
      },
      contains: {
          min: 2, max: 2,
          call: (a) => (Array.isArray(a[0]) ? a[0].some((v) => eq(v, a[1])) : toText(a[0]).includes(toText(a[1]))),
      },
      startsWith: { min: 2, max: 2, call: (a) => toText(a[0]).startsWith(toText(a[1])) },
      endsWith: { min: 2, max: 2, call: (a) => toText(a[0]).endsWith(toText(a[1])) },
      replace: {
          min: 3, max: 3,
          call: (a) => {
              const subject = toText(a[0]);
              const find = toText(a[1]);
              if (find === "")
                  return subject;
              const with_ = toText(a[2]);
              // How long the answer would be, worked out before it is built: 8 KB of needles in 8 KB of hay would
              // otherwise allocate tens of megabytes and only then be refused.
              let hits = 0;
              for (let at = subject.indexOf(find); at !== -1; at = subject.indexOf(find, at + find.length))
                  hits += 1;
              const grown = subject.length + hits * (with_.length - find.length);
              if (grown > LIMITS.stringBytes) {
                  throw new KernelError("string", `an expression built a string over ${LIMITS.stringBytes} bytes`);
              }
              return capText(subject.split(find).join(with_));
          },
      },
      pad: {
          min: 2, max: 3,
          call: (a) => {
              const s = toText(a[0]);
              const want = Math.max(0, Math.min(256, Math.trunc(num(a[1]))));
              const ch = (a[2] === undefined ? " " : toText(a[2]).slice(0, 1)) || " ";
              return s.length >= want ? s : ch.repeat(want - s.length) + s;
          },
      },
      // lists
      count: {
          min: 1, max: 1,
          call: (a) => {
              const v = a[0];
              if (Array.isArray(v))
                  return v.length;
              if (typeof v === "string")
                  return v.length;
              if (v && typeof v === "object")
                  return Object.keys(v).length;
              return 0;
          },
      },
      first: { min: 1, max: 1, call: (a) => rows(a[0])[0] },
      last: { min: 1, max: 1, call: (a) => { const r = rows(a[0]); return r[r.length - 1]; } },
      join: { min: 1, max: 2, call: (a) => capText(rows(a[0]).map(toText).join(a[1] === undefined ? ", " : toText(a[1]))) },
      includes: { min: 2, max: 2, call: (a) => rows(a[0]).some((v) => eq(v, a[1])) },
      // copy from the catalog. Whatever comes back is data: it is never looked at for holes again.
      t: {
          min: 1, max: 2,
          call: (a, s) => {
              const key = toText(a[0]);
              const vars = a[1] && typeof a[1] === "object" && !Array.isArray(a[1]) ? a[1] : undefined;
              return s.text ? toText(s.text(key, vars)) : key;
          },
      },
      // time
      now: { min: 0, max: 0, time: true, call: (_a, s) => fmtEnv(s).now },
      since: {
          min: 1, max: 1, time: true,
          call: (a, s) => {
              const t = typeof a[0] === "number" ? a[0] : Date.parse(toText(a[0]));
              return Number.isFinite(t) ? fmtEnv(s).now - t : 0;
          },
      },
      // formats (the `fmt.` names, spelled out here with a dot so the parser can find them)
      "fmt.number": { min: 1, max: 2, call: (a, s) => fmtNumber(a[0], a[1], fmtEnv(s)) },
      "fmt.currency": { min: 2, max: 2, call: (a, s) => fmtCurrency(a[0], a[1], fmtEnv(s)) },
      "fmt.plural": { min: 3, max: 3, call: (a, s) => fmtPlural(a[0], a[1], a[2], fmtEnv(s)) },
      "fmt.relative": { min: 1, max: 1, time: true, call: (a, s) => fmtRelative(a[0], fmtEnv(s)) },
      "fmt.datetime": { min: 1, max: 2, call: (a, s) => fmtDatetime(a[0], a[1], fmtEnv(s)) },
      "fmt.duration": { min: 1, max: 1, call: (a) => fmtDuration(a[0]) },
      "fmt.elapsed": { min: 1, max: 1, time: true, call: (a, s) => fmtElapsed(a[0], fmtEnv(s)) },
  };
  /** Every function name a screen may call, for lint messages and for the server's builders. */
  const FUNCTION_NAMES = Object.freeze(Object.keys(FUNCS).sort());
  /** Constants, which are names rather than calls. */
  const CONSTS = { pi: Math.PI, true: true, false: false, null: null };
  // ---- tokens
  const T_NUM = 0, T_STR = 1, T_NAME = 2, T_OP = 3;
  /** Longest first, so `??` is never read as two `?`. */
  const OPS2 = ["**", "??", "?.", "==", "!=", "<=", ">=", "&&", "||"];
  const OPS1 = "+-*/%<>!?:.()[],";
  function lex(src) {
      const out = [];
      for (let i = 0; i < src.length;) {
          const c = src[i];
          if (c === " " || c === "\t" || c === "\n" || c === "\r") {
              i += 1;
              continue;
          }
          if (c >= "0" && c <= "9") {
              let j = i;
              while (j < src.length && src[j] >= "0" && src[j] <= "9")
                  j += 1;
              if (src[j] === ".") {
                  j += 1;
                  while (j < src.length && src[j] >= "0" && src[j] <= "9")
                      j += 1;
              }
              // An exponent, as the bot engine's grammar has it: 1e5, 2.5e-3.
              if (src[j] === "e" || src[j] === "E") {
                  let k = j + 1;
                  if (src[k] === "+" || src[k] === "-")
                      k += 1;
                  if (src[k] >= "0" && src[k] <= "9") {
                      j = k;
                      while (j < src.length && src[j] >= "0" && src[j] <= "9")
                          j += 1;
                  }
              }
              out.push({ t: T_NUM, v: "", n: parseFloat(src.slice(i, j)) });
              i = j;
              continue;
          }
          if (c === '"' || c === "'") {
              let j = i + 1, s = "";
              for (;;) {
                  if (j >= src.length)
                      throw new KernelError("expr", "a string is not closed");
                  const d = src[j];
                  if (d === "\\") {
                      const e = src[j + 1];
                      if (e === undefined)
                          throw new KernelError("expr", "a string is not closed");
                      s += e === "n" ? "\n" : e === "t" ? "\t" : e;
                      j += 2;
                      continue;
                  }
                  if (d === c) {
                      j += 1;
                      break;
                  }
                  s += d;
                  j += 1;
              }
              out.push({ t: T_STR, v: s, n: 0 });
              i = j;
              continue;
          }
          if (/[A-Za-z_]/.test(c)) {
              let j = i + 1;
              while (j < src.length && /[A-Za-z0-9_]/.test(src[j]))
                  j += 1;
              out.push({ t: T_NAME, v: src.slice(i, j), n: 0 });
              i = j;
              continue;
          }
          const two = src.slice(i, i + 2);
          if (OPS2.includes(two)) {
              out.push({ t: T_OP, v: two, n: 0 });
              i += 2;
              continue;
          }
          if (OPS1.includes(c)) {
              out.push({ t: T_OP, v: c, n: 0 });
              i += 1;
              continue;
          }
          throw new KernelError("expr", `an expression cannot contain "${c}"`);
      }
      return out;
  }
  class Parser {
      constructor(toks, maxOps) {
          this.at = 0;
          this.ops = 0;
          this.deps = [];
          this.toks = toks;
          this.maxOps = maxOps;
      }
      /** Every node costs one. The cap is checked here, so an expression is refused before it ever runs. */
      op() {
          this.ops += 1;
          if (this.ops > this.maxOps)
              throw new KernelError("expr", `an expression is at most ${this.maxOps} operations`);
      }
      dep(path) {
          if (!this.deps.includes(path))
              this.deps.push(path);
      }
      peek() {
          return this.toks[this.at];
      }
      isOp(v) {
          const k = this.toks[this.at];
          return !!k && k.t === T_OP && k.v === v;
      }
      take(v) {
          if (!this.isOp(v))
              throw new KernelError("expr", `expected "${v}"`);
          this.at += 1;
      }
      // precedence, loosest first
      ternary() {
          const cond = this.nullish();
          if (!this.isOp("?"))
              return cond;
          this.at += 1;
          const yes = this.ternary();
          this.take(":");
          const no = this.ternary();
          this.op();
          return { run: (s) => (truthy(cond.run(s)) ? yes.run(s) : no.run(s)), path: null };
      }
      nullish() {
          let left = this.or();
          while (this.isOp("??")) {
              this.at += 1;
              const right = this.or();
              const a = left;
              this.op();
              left = { run: (s) => { const v = a.run(s); return v === null || v === undefined ? right.run(s) : v; }, path: null };
          }
          return left;
      }
      or() {
          let left = this.and();
          while (this.isOp("||")) {
              this.at += 1;
              const right = this.and();
              const a = left;
              this.op();
              left = { run: (s) => { const v = a.run(s); return truthy(v) ? v : right.run(s); }, path: null };
          }
          return left;
      }
      and() {
          let left = this.equality();
          while (this.isOp("&&")) {
              this.at += 1;
              const right = this.equality();
              const a = left;
              this.op();
              left = { run: (s) => { const v = a.run(s); return truthy(v) ? right.run(s) : v; }, path: null };
          }
          return left;
      }
      equality() {
          let left = this.relational();
          while (this.isOp("==") || this.isOp("!=")) {
              const o = this.toks[this.at].v;
              this.at += 1;
              const right = this.relational();
              const a = left;
              this.op();
              left = { run: (s) => (o === "==" ? eq(a.run(s), right.run(s)) : !eq(a.run(s), right.run(s))), path: null };
          }
          return left;
      }
      relational() {
          let left = this.additive();
          while (this.isOp("<") || this.isOp("<=") || this.isOp(">") || this.isOp(">=")) {
              const o = this.toks[this.at].v;
              this.at += 1;
              const right = this.additive();
              const a = left;
              this.op();
              left = {
                  run: (s) => {
                      const c = cmp(a.run(s), right.run(s));
                      return o === "<" ? c < 0 : o === "<=" ? c <= 0 : o === ">" ? c > 0 : c >= 0;
                  },
                  path: null,
              };
          }
          return left;
      }
      additive() {
          let left = this.multiplicative();
          while (this.isOp("+") || this.isOp("-")) {
              const o = this.toks[this.at].v;
              this.at += 1;
              const right = this.multiplicative();
              const a = left;
              this.op();
              left = {
                  run: (s) => {
                      const x = a.run(s), y = right.run(s);
                      if (o === "-")
                          return finite(num(x) - num(y));
                      if (typeof x === "string" || typeof y === "string")
                          return capText(toText(x) + toText(y));
                      return finite(num(x) + num(y));
                  },
                  path: null,
              };
          }
          return left;
      }
      multiplicative() {
          let left = this.unary();
          while (this.isOp("*") || this.isOp("/") || this.isOp("%")) {
              const o = this.toks[this.at].v;
              this.at += 1;
              const right = this.unary();
              const a = left;
              this.op();
              left = {
                  run: (s) => {
                      const x = num(a.run(s)), y = num(right.run(s));
                      if (o === "*")
                          return finite(x * y);
                      if (y === 0)
                          return 0;
                      return finite(o === "/" ? x / y : x - Math.floor(x / y) * y);
                  },
                  path: null,
              };
          }
          return left;
      }
      unary() {
          if (this.isOp("!")) {
              this.at += 1;
              const v = this.unary();
              this.op();
              return { run: (s) => !truthy(v.run(s)), path: null };
          }
          if (this.isOp("-")) {
              this.at += 1;
              const v = this.unary();
              this.op();
              return { run: (s) => finite(-num(v.run(s))), path: null };
          }
          return this.power();
      }
      /** `**` binds tighter than a leading minus, so `-2 ** 2` is -(2 ** 2). */
      power() {
          const base = this.postfix(this.primary());
          if (!this.isOp("**"))
              return base;
          this.at += 1;
          const exp = this.unary();
          this.op();
          return { run: (s) => finite(Math.pow(num(base.run(s)), num(exp.run(s)))), path: null };
      }
      /** `.name`, `?.name` and `[…]`, keeping the path while every step is written out. */
      postfix(start) {
          let cur = start;
          for (;;) {
              if (this.isOp(".") || this.isOp("?.")) {
                  const safe = this.toks[this.at].v === "?.";
                  this.at += 1;
                  const k = this.peek();
                  if (!k || k.t !== T_NAME)
                      throw new KernelError("expr", "a name must follow a dot");
                  this.at += 1;
                  const key = k.v;
                  const base = cur;
                  this.op();
                  const path = base.path === null ? null : `${base.path}.${key}`;
                  cur = {
                      run: (s) => {
                          const b = base.run(s);
                          if (safe && (b === null || b === undefined))
                              return undefined;
                          return pick(b, key);
                      },
                      path,
                  };
                  continue;
              }
              if (this.isOp("[")) {
                  this.at += 1;
                  const key = this.ternary();
                  this.take("]");
                  const base = cur;
                  this.op();
                  if (base.path !== null)
                      this.dep(`${base.path}.*`);
                  cur = { run: (s) => pick(base.run(s), key.run(s)), path: null };
                  continue;
              }
              break;
          }
          if (cur.path !== null)
              this.dep(cur.path);
          return cur;
      }
      /** The arguments of a call, between the brackets. */
      args(name, spec) {
          this.take("(");
          const out = [];
          if (!this.isOp(")")) {
              out.push(this.ternary());
              while (this.isOp(",")) {
                  this.at += 1;
                  out.push(this.ternary());
              }
          }
          this.take(")");
          if (out.length < spec.min || out.length > spec.max) {
              const want = spec.min === spec.max ? `${spec.min}` : `${spec.min} to ${spec.max}`;
              throw new KernelError("expr", `${name} takes ${want} arguments`);
          }
          return out;
      }
      call(name) {
          const spec = FUNCS[name];
          const parts = this.args(name, spec);
          this.op();
          if (spec.time)
              this.dep(TIME_DEP);
          return {
              run: (s) => {
                  const vals = [];
                  for (const p of parts)
                      vals.push(p.run(s));
                  return spec.call(vals, s);
              },
              path: null,
          };
      }
      primary() {
          const k = this.peek();
          if (!k)
              throw new KernelError("expr", "an expression ends too early");
          if (k.t === T_NUM) {
              this.at += 1;
              this.op();
              const n = Number.isFinite(k.n) ? k.n : 0;
              return { run: () => n, path: null };
          }
          if (k.t === T_STR) {
              this.at += 1;
              this.op();
              const v = k.v;
              return { run: () => v, path: null };
          }
          if (k.t === T_OP && k.v === "(") {
              this.at += 1;
              const inner = this.ternary();
              this.take(")");
              return { run: inner.run, path: null };
          }
          if (k.t !== T_NAME)
              throw new KernelError("expr", `an expression cannot start with "${k.v}"`);
          this.at += 1;
          const name = k.v;
          // fmt.something(…): one name with a dot in it, so `fmt` is not a value of its own.
          if (name === "fmt" && this.isOp(".")) {
              const after = this.toks[this.at + 1];
              const full = after && after.t === T_NAME ? `fmt.${after.v}` : "fmt";
              if (!Object.prototype.hasOwnProperty.call(FUNCS, full)) {
                  throw new KernelError("expr", `there is no ${full}`);
              }
              this.at += 2;
              return this.call(full);
          }
          if (this.isOp("(")) {
              if (!Object.prototype.hasOwnProperty.call(FUNCS, name))
                  throw new KernelError("expr", `there is no function ${name}`);
              return this.call(name);
          }
          if (Object.prototype.hasOwnProperty.call(CONSTS, name)) {
              this.op();
              const v = CONSTS[name];
              return { run: () => v, path: null };
          }
          if (!ROOT_SET.has(name))
              throw new KernelError("expr", `there is no name ${name}`);
          this.op();
          if (name === "index")
              return { run: (s) => (typeof s.index === "number" ? s.index : 0), path: "index" };
          const root = name;
          return { run: (s) => s[root], path: root };
      }
  }
  /** How costly an expression is allowed to be. A caller may ask for less, never for more. */
  function opCap(maxOps) {
      const want = typeof maxOps === "number" && Number.isFinite(maxOps) ? Math.trunc(maxOps) : LIMITS.exprOps;
      return Math.max(1, Math.min(LIMITS.exprOps, want));
  }
  /**
   * Compile one expression. Throws KernelError when the source is not in the language or costs too much; the caller
   * reports that and leaves the screen's `else` value in place.
   */
  function compileExpr(src, opts) {
      if (typeof src !== "string")
          throw new KernelError("expr", "an expression must be a string");
      if (src.length > LIMITS.exprChars)
          throw new KernelError("expr", `an expression is at most ${LIMITS.exprChars} characters`);
      if (src.trim() === "")
          throw new KernelError("expr", "an expression is empty");
      const p = new Parser(lex(src), opCap(opts?.maxOps));
      const piece = p.ternary();
      if (p.at < p.toks.length)
          throw new KernelError("expr", `an expression has something left over: "${p.toks[p.at].v}"`);
      const deps = Object.freeze(p.deps.slice().sort());
      // One door for the 8 KB ceiling. `+`, `join` and `replace` cap as they build, because they are the ones that can
      // build something enormous out of small pieces; `upper`, `slice`, `t` and the `fmt.*` helpers simply hand back a
      // long value they were given, and this is where that is refused.
      const inner = piece.run;
      const run = (s) => {
          const v = inner(s);
          return typeof v === "string" ? capText(v) : v;
      };
      return { src, ops: p.ops, deps, run };
  }
  /** Compile without throwing: for lint, which wants every reason at once. */
  function tryCompileExpr(src, opts) {
      try {
          return { ok: true, expr: compileExpr(src, opts) };
      }
      catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
  }
  /** Run without throwing. A broken value is `bad`, and the renderer keeps what was drawn before. */
  function runExpr(expr, scope) {
      try {
          return { ok: true, value: expr.run(scope) };
      }
      catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
  }
  /** True when a change at `changed` can change what these dependencies read. */
  function dependsOn(deps, changed) {
      for (const d of deps) {
          if (d === TIME_DEP)
              continue;
          if (pathsTouch(d, changed))
              return true;
      }
      return false;
  }
  /** True when these dependencies include the clock, so the node has to be re-drawn as time passes. */
  function readsTime(deps) {
      return deps.includes(TIME_DEP);
  }

  /**
   * TEXT WITH HOLES, AND VALUES (pure SPEC 2.2, B1): the only two shapes that are ever evaluated.
   *
   *   { "$t": "{{ count(state.done) }} of {{ count(state.items) }} done" }   text with holes
   *   { "$": "state.busy ? 0.4 : 1" }                                       one value
   *
   * Everything else is data. **A bare string is never looked at for `{{ }}`**, because the server puts people's own
   * words into string props — a note's title, a calendar invite from a stranger — and a title reading
   * `{{ state.token }}` must draw as those characters and nothing else. A value that arrives through the store, a
   * `bind`, a list row or an endpoint is data too: it is never parsed a second time.
   *
   * Holes in a path field are URL-encoded on the way out (`encode: true`), which is what `actions.ts` already does
   * for `$state.` tokens. Display text is not encoded.
   */
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  /** True for the text-with-holes shape, and only for it. */
  function isTextTemplate(v) {
      return !!v && typeof v === "object" && !Array.isArray(v) && has(v, "$t") && typeof v.$t === "string";
  }
  /** True for the one-value shape, and only for it. */
  function isValueBinding(v) {
      return !!v && typeof v === "object" && !Array.isArray(v) && has(v, "$") && typeof v.$ === "string";
  }
  /** True when this value is one the kernel evaluates at all. Anything else is drawn as it came. */
  function isEvaluable(v) {
      return isTextTemplate(v) || isValueBinding(v);
  }
  /** Cut `"a {{ x }} b"` into ["a ", " b"] and ["x"]. An unclosed hole is refused, not drawn. */
  function cut(src) {
      const literals = [];
      const sources = [];
      let at = 0;
      for (;;) {
          const open = src.indexOf("{{", at);
          if (open === -1)
              break;
          const close = src.indexOf("}}", open + 2);
          if (close === -1)
              throw new KernelError("text", 'a hole is opened with "{{" and never closed');
          const inner = src.slice(open + 2, close);
          if (inner.includes("{{"))
              throw new KernelError("text", "a hole cannot hold another hole");
          literals.push(src.slice(at, open));
          sources.push(inner.trim());
          at = close + 2;
          if (sources.length > LIMITS.textHoles)
              throw new KernelError("text", `a text has at most ${LIMITS.textHoles} holes`);
      }
      literals.push(src.slice(at));
      return { literals, sources };
  }
  /**
   * Compile text with holes. `encode` is for path fields: every filled value is URL-encoded, so an id of `../admin`
   * cannot climb out of the path it was put in.
   */
  function compileText(src, opts) {
      if (typeof src !== "string")
          throw new KernelError("text", "a $t must be a string");
      if (byteLen(src) > LIMITS.stringBytes)
          throw new KernelError("text", `a $t is at most ${LIMITS.stringBytes} bytes`);
      const { literals, sources } = cut(src);
      const holes = [];
      const deps = [];
      let ops = 0;
      for (const s of sources) {
          const left = LIMITS.exprOps - ops;
          if (left <= 0)
              throw new KernelError("text", `a text is at most ${LIMITS.exprOps} operations in all`);
          const c = compileExpr(s, { maxOps: left });
          ops += c.ops;
          holes.push(c);
          for (const d of c.deps)
              if (!deps.includes(d))
                  deps.push(d);
      }
      const encode = opts?.encode === true;
      const frozenLiterals = Object.freeze(literals.slice());
      const frozenHoles = Object.freeze(holes.slice());
      return {
          src,
          ops,
          deps: Object.freeze(deps.sort()),
          literals: frozenLiterals,
          holes: frozenHoles,
          run(scope) {
              let out = frozenLiterals[0] ?? "";
              for (let i = 0; i < frozenHoles.length; i += 1) {
                  const v = frozenHoles[i].run(scope);
                  out += encode ? encodeHole(v) : toText(v);
                  out += frozenLiterals[i + 1] ?? "";
                  if (byteLen(out) > LIMITS.stringBytes) {
                      throw new KernelError("string", `a text grew past ${LIMITS.stringBytes} bytes`);
                  }
              }
              return out;
          },
      };
  }
  const NO_DEPS = Object.freeze([]);
  /**
   * Look at one prop. Only the two shapes compile; everything else comes straight back as a constant, which is how
   * user text stays user text.
   */
  function compileProp(v, opts) {
      if (isValueBinding(v)) {
          const expr = compileExpr(v.$);
          return { kind: "value", expr, deps: expr.deps, ops: expr.ops };
      }
      if (isTextTemplate(v)) {
          const text = compileText(v.$t, opts);
          return { kind: "text", text, deps: text.deps, ops: text.ops };
      }
      return { kind: "constant", value: v, deps: NO_DEPS, ops: 0 };
  }
  /** Work out a compiled prop. A constant is itself; the other two run. */
  function runProp(prop, scope) {
      if (prop.kind === "constant")
          return prop.value;
      if (prop.kind === "value")
          return prop.expr.run(scope);
      return prop.text.run(scope);
  }
  /** True for the `{ expr }` condition shape. */
  function isExprCondition(v) {
      return !!v && typeof v === "object" && !Array.isArray(v) && has(v, "expr") && typeof v.expr === "string";
  }
  /** Compile a condition. What it gives back is read as true or false, nothing else. */
  function compileCondition(v) {
      if (!isExprCondition(v))
          throw new KernelError("expr", "a condition is { expr: \"…\" }");
      return compileExpr(v.expr);
  }
  /**
   * A warning, not a refusal: a bare string that holds `{{` is probably a forgotten `$t`. It can also be a person's
   * own words, which is why this never refuses anything (SPEC 2.2, "Server side").
   */
  function looksLikeForgottenTemplate(v) {
      return typeof v === "string" && v.includes("{{") && v.includes("}}");
  }

  /**
   * TEMPLATES: `Use`, `Slot` and a screen's own definitions (pure SPEC 2.3, B2).
   *
   * A screen may define a shape once and draw it many times — which is what a list row is. Definitions live inside
   * the screen that uses them; there is no catalog to fetch and nothing to keep in sync.
   *
   *   "defs": { "bot.row": { "params": ["bot"], "root": { … { "type": "Slot", "name": "trail" } … } } }
   *   { "type": "Use", "def": "bot.row", "args": { "bot": { "$": "item" } }, "slots": { "trail": { … } } }
   *
   * Expansion here is structural only: it copies trees, puts slot contents in their places, and leaves two markers
   * for the renderer. Values are never evaluated here, so this file stays pure and cheap.
   *
   * THE TWO MARKERS, which are the whole contract with the renderer:
   *
   *   `$args`   a LIST of argument frames, outermost first. The renderer works the first one out in the scope it
   *             already has, binds the result as `args`, works the next one out in THAT scope, and so on. A list,
   *             not one object, because a template whose root is itself a `Use` has two sets of arguments: the
   *             outer caller's, and the inner ones the template wrote in terms of them.
   *   `$argsUp` how many argument frames to step back past before reading this node. Slot contents are written by
   *             the CALLER but end up sitting inside the template they were given to, so without this they would
   *             read the template's `args` instead of the caller's. The renderer drops this many frames first, and
   *             then applies the node's own `$args`.
   *
   * The rules, all refused at compile: no recursion, direct or indirect; at most `LIMITS.defsDepth` deep; at most
   * `LIMITS.defs` definitions; at most `LIMITS.defsNodes` nodes in one item template; and at most
   * `LIMITS.expandSteps` steps of work, because `Use` and `Slot` draw nothing and so cost no nodes.
   */
  /** The marker an expanded template root carries: the argument frames, outermost first. */
  const ARGS_KEY = "$args";
  /** The marker slot content carries: how many argument frames to step back past before reading it. */
  const ARGS_UP_KEY = "$argsUp";
  /**
   * Everything a `Use` may say. A `Use` leaves nothing of itself behind — what it expands to is the template's own
   * root — so a `visibleIf`, an `id` or a `style` written on it would simply disappear, and a condition that
   * disappears is a node that always shows. The author is told instead. `fallback` is allowed because it is for the
   * case where the template is missing, which never reaches an expanded tree.
   */
  const USE_KEYS = new Set(["type", "def", "args", "slots", "fallback"]);
  const owns = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  /** A plain node object, as a screen sends it. */
  function isNode(v) {
      return !!v && typeof v === "object" && !Array.isArray(v);
  }
  /** The children of a node, as a list. */
  function childrenOf(node) {
      const c = node.children;
      return Array.isArray(c) ? c : [];
  }
  function note(found, problem) {
      if (!found.problems.includes(problem))
          found.problems.push(problem);
  }
  /**
   * Walk a definition's tree: every `Use` by the name it calls, and every way the tree is already wrong. The depth
   * is capped, because this runs on data the server sent and a tree six thousand deep would otherwise overflow the
   * stack of the publish gate rather than be reported by it.
   */
  function scanTree(tree, depth, found) {
      if (depth > LIMITS.depth) {
          note(found, `nests more than ${LIMITS.depth} deep`);
          return;
      }
      if (Array.isArray(tree)) {
          for (const t of tree)
              scanTree(t, depth + 1, found);
          return;
      }
      if (!isNode(tree))
          return;
      if (tree.type === "Use") {
          if (typeof tree.def === "string" && tree.def) {
              if (!found.uses.includes(tree.def))
                  found.uses.push(tree.def);
          }
          else {
              note(found, "has a Use that names no template");
          }
          for (const k of Object.keys(tree)) {
              if (USE_KEYS.has(k))
                  continue;
              note(found, `has a Use carrying "${k}", which expansion would drop; put it on the template or on a node around the Use`);
          }
      }
      for (const c of childrenOf(tree))
          scanTree(c, depth + 1, found);
      const slots = tree.slots;
      if (isNode(slots))
          for (const k of Object.keys(slots))
              scanTree(slots[k], depth + 1, found);
  }
  /**
   * Everything wrong with a screen's definitions, as plain sentences. Empty means they are fine. Lint wants them all
   * at once, so this collects rather than throws — including for the hostile shapes (a definition called
   * `__proto__`, a tree nested thousands deep), which must be reported by the publish gate, not crash it.
   */
  function checkDefs(defs) {
      const errors = [];
      if (defs === undefined || defs === null)
          return errors;
      if (!isNode(defs))
          return ["defs must be an object of definitions"];
      const names = Object.keys(defs);
      if (names.length > LIMITS.defs)
          errors.push(`a screen has at most ${LIMITS.defs} definitions`);
      // Maps, not plain objects: `graph["__proto__"] = []` on an object goes nowhere, and the walk below would then
      // follow a definition that is never marked as visited and recurse until the stack gives out.
      const graph = new Map();
      const known = new Set(names);
      for (const name of names) {
          graph.set(name, []);
          const shape = statePathError(name);
          if (shape) {
              errors.push(`the definition name "${name}" is not a plain name: ${shape}`);
              continue;
          }
          const d = defs[name];
          if (!isNode(d) || !owns(d, "root")) {
              errors.push(`the definition "${name}" has no root`);
              continue;
          }
          const spec = d;
          if (spec.params !== undefined && !Array.isArray(spec.params))
              errors.push(`the definition "${name}" has params that are not a list`);
          const found = { uses: [], problems: [] };
          scanTree(spec.root, 1, found);
          for (const p of found.problems)
              errors.push(`the definition "${name}" ${p}`);
          for (const u of found.uses)
              if (!known.has(u))
                  errors.push(`the definition "${name}" uses "${u}", which this screen does not define`);
          graph.set(name, found.uses.filter((u) => known.has(u)));
      }
      // A cycle means a screen that draws forever. Walk each name, keeping the path, and name the loop we find.
      const state = new Map();
      const path = [];
      const walk = (name) => {
          const was = state.get(name);
          if (was === 2)
              return;
          if (was === 1) {
              const from = path.indexOf(name);
              errors.push(`the definitions ${[...path.slice(from), name].join(" → ")} use each other in a circle`);
              return;
          }
          state.set(name, 1);
          path.push(name);
          for (const next of graph.get(name) ?? [])
              walk(next);
          path.pop();
          state.set(name, 2);
      };
      for (const name of names)
          walk(name);
      return errors;
  }
  const EMPTY_FRAME = { slots: {}, parent: null, argDepth: 0 };
  /**
   * Copy a node, with its children already expanded. The other props are carried over as they are: nothing here
   * changes a value, and two rows drawn from one template may share the prop objects they were given, because
   * nothing in the renderer writes to them.
   */
  function rebuild(node, children) {
      const out = {};
      for (const k of Object.keys(node)) {
          if (k === "__proto__" || k === "constructor" || k === "prototype")
              continue;
          out[k] = node[k];
      }
      if (children)
          out.children = children;
      return out;
  }
  /** Mark slot content: it reads the scope of the place it was WRITTEN, which is `up` argument frames back. */
  function markUp(made, up) {
      if (Array.isArray(made))
          return made.map((m) => markUp(m, up));
      if (!isNode(made))
          return made;
      // Content handed on through a second slot steps back past both hops.
      const had = typeof made[ARGS_UP_KEY] === "number" ? made[ARGS_UP_KEY] : 0;
      return { ...made, [ARGS_UP_KEY]: had + up };
  }
  /** Put a `Use`'s arguments on what it expanded to, keeping any the template itself wrote. */
  function withArgs(made, args) {
      if (Array.isArray(made))
          return made.map((m) => withArgs(m, args));
      if (!isNode(made))
          return made;
      const up = typeof made[ARGS_UP_KEY] === "number" ? made[ARGS_UP_KEY] : 0;
      if (up > 0) {
          // This is slot content the caller wrote, so it reads the caller's `args`: this frame is one of the ones it
          // steps back past, and putting the frame here simply cancels one of those steps.
          const out = { ...made };
          if (up === 1)
              delete out[ARGS_UP_KEY];
          else
              out[ARGS_UP_KEY] = up - 1;
          return out;
      }
      const had = made[ARGS_KEY];
      return { ...made, [ARGS_KEY]: Array.isArray(had) ? [args, ...had] : [args] };
  }
  /** Expand one node. Gives back one node, a list of nodes (a slot that held several), or null. */
  function expandOne(node, frame, useDepth, depth, w, argDepth) {
      w.steps += 1;
      if (w.steps > LIMITS.expandSteps) {
          throw new KernelError("defs", `expanding a screen takes at most ${LIMITS.expandSteps} steps`);
      }
      if (depth > w.maxDepth)
          throw new KernelError("defs", `a screen nests at most ${w.maxDepth} deep`);
      if (Array.isArray(node)) {
          const out = [];
          for (const c of node)
              pushExpanded(out, expandOne(c, frame, useDepth, depth, w, argDepth));
          return out;
      }
      if (!isNode(node))
          return node;
      if (node.type === "Slot") {
          const name = typeof node.name === "string" && node.name ? node.name : "default";
          const given = owns(frame.slots, name) ? frame.slots[name] : undefined;
          if (given === undefined || given === null) {
              // Nothing was given, so the slot's own children are its default, in this same frame and this same scope.
              const kids = childrenOf(node);
              if (kids.length === 0)
                  return null;
              const out = [];
              for (const c of kids)
                  pushExpanded(out, expandOne(c, frame, useDepth, depth, w, argDepth));
              return out;
          }
          // Slot contents were written by the caller, so they are expanded in the caller's frame and read the caller's
          // arguments — however deep inside this template they land.
          const up = argDepth - frame.argDepth;
          const made = expandOne(given, frame.parent ?? EMPTY_FRAME, useDepth, depth, w, frame.argDepth);
          return up > 0 ? markUp(made, up) : made;
      }
      if (node.type === "Use") {
          for (const k of Object.keys(node)) {
              if (USE_KEYS.has(k))
                  continue;
              throw new KernelError("defs", `a Use carries "${k}", which expansion would drop; put it on the template or on a node around the Use`);
          }
          const name = typeof node.def === "string" ? node.def : "";
          if (!name || !owns(w.defs, name))
              throw new KernelError("defs", `there is no template named "${name}"`);
          if (useDepth + 1 > LIMITS.defsDepth)
              throw new KernelError("defs", `templates nest at most ${LIMITS.defsDepth} deep`);
          const slots = isNode(node.slots) ? node.slots : {};
          const inner = { slots, parent: frame, argDepth };
          const args = isNode(node.args) ? node.args : undefined;
          const made = expandOne(w.defs[name].root, inner, useDepth + 1, depth, w, args === undefined ? argDepth : argDepth + 1);
          if (made === null || made === undefined)
              return null;
          if (args === undefined)
              return made;
          return withArgs(made, args);
      }
      w.nodes += 1;
      if (w.nodes > w.maxNodes)
          throw new KernelError("defs", `a screen draws at most ${w.maxNodes} nodes`);
      if (depth > w.deepest)
          w.deepest = depth;
      const kids = childrenOf(node);
      if (kids.length === 0)
          return rebuild(node, null);
      const out = [];
      for (const c of kids)
          pushExpanded(out, expandOne(c, frame, useDepth, depth + 1, w, argDepth));
      return rebuild(node, out);
  }
  /** A slot can give back several nodes, so a child list is flattened as it is built. */
  function pushExpanded(out, made) {
      if (made === null || made === undefined)
          return;
      if (Array.isArray(made)) {
          for (const m of made)
              pushExpanded(out, m);
          return;
      }
      out.push(made);
  }
  /**
   * Expand a tree. `maxNodes` is the screen's ceiling by default; a list-item template passes
   * `LIMITS.defsNodes` instead, because that tree is drawn once per row.
   */
  function expandTree(root, defs, opts) {
      const w = {
          defs: defs ?? {},
          maxNodes: Math.max(1, Math.min(LIMITS.nodes, opts?.maxNodes ?? LIMITS.nodes)),
          maxDepth: Math.max(1, Math.min(LIMITS.depth, opts?.maxDepth ?? LIMITS.depth)),
          nodes: 0,
          deepest: 0,
          steps: 0,
      };
      // The same refusal the publish gate makes, so the device and the server never disagree about a definition's name.
      for (const name of Object.keys(w.defs)) {
          if (statePathError(name))
              throw new KernelError("defs", `"${name}" is not a name a template may have`);
      }
      const node = expandOne(root, EMPTY_FRAME, 0, 1, w, 0);
      return { node: Array.isArray(node) ? (node[0] ?? null) : node, nodes: w.nodes, depth: w.deepest, steps: w.steps };
  }
  /** Expand a list-item template, under the smaller ceiling a row has to live inside. */
  function expandItem(root, defs) {
      return expandTree(root, defs, { maxNodes: LIMITS.defsNodes });
  }

  /**
   * RULES AND TIMERS AS DATA (pure SPEC 2.4, B3).
   *
   *   { "id": "kb",    "when": { "expr": "device.keyboard.enabled" }, "do": …, "once": true }
   *   { "id": "tick",  "every": 1000, "whileVisible": true, "do": … }
   *   { "id": "nudge", "after": 8000, "do": … }
   *
   * This replaces the `visibleIf + onAppear` trick, the Countdown component and every polling screen. A state
   * machine needs no new idea either: a state is a path in the store, and a transition is a rule.
   *
   * The machine here is pure. It holds no timer of its own: the renderer calls `tick(scope, now)` and is told what
   * fired and when to come back (`nextWakeAt`). That is the whole scheduler interface, which means the timing can be
   * tested by passing times in, and nothing runs in the background.
   *
   * The caps come from SPEC 5.1: at most 32 rules, 4 timers, `every` no faster than a second (a quarter second only
   * while the node is visible and the app is in front), no longer than a day, and no more than 10 fires a second
   * whatever the data says.
   *
   * A `when` that reads the clock (`now()`, `since()`, `fmt.elapsed`) becomes true with nothing written to the
   * store, so it asks to be woken each second until it fires. Everything else waits for a store change.
   */
  const whole = (v, fallback) => typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : fallback;
  /**
   * Compile a screen's (or a node's) rules. Bad rules are dropped with a reason, so one wrong rule never costs the
   * screen the other thirty-one. `foreground` only changes how fast `every` is allowed to be.
   */
  function compileRules(list, opts) {
      const errors = [];
      const rules = [];
      if (list === undefined || list === null)
          return { rules, errors };
      if (!Array.isArray(list))
          return { rules, errors: ["rules must be a list"] };
      const foreground = opts?.foreground !== false;
      const seen = new Set();
      let timers = 0;
      for (const raw of list) {
          if (rules.length >= LIMITS.rules) {
              errors.push(`a screen has at most ${LIMITS.rules} rules; the rest were dropped`);
              break;
          }
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
              errors.push("a rule must be an object");
              continue;
          }
          const spec = raw;
          const id = typeof spec.id === "string" && spec.id ? spec.id : "";
          if (!id) {
              errors.push("a rule has no id");
              continue;
          }
          if (seen.has(id)) {
              errors.push(`two rules are called "${id}"`);
              continue;
          }
          if (!("do" in spec) || spec.do === undefined || spec.do === null) {
              errors.push(`the rule "${id}" does nothing`);
              continue;
          }
          const whileVisible = spec.whileVisible === true;
          const hasWhen = spec.when !== undefined && spec.when !== null;
          const hasEvery = spec.every !== undefined && spec.every !== null;
          const hasAfter = spec.after !== undefined && spec.after !== null;
          const kinds = (hasWhen ? 1 : 0) + (hasEvery ? 1 : 0) + (hasAfter ? 1 : 0);
          if (kinds === 0) {
              errors.push(`the rule "${id}" says neither when, every nor after`);
              continue;
          }
          if (kinds > 1) {
              errors.push(`the rule "${id}" is a when, an every or an after, not two of them`);
              continue;
          }
          if (hasWhen) {
              if (!isExprCondition(spec.when)) {
                  errors.push(`the rule "${id}" has a when that is not { expr: "…" }`);
                  continue;
              }
              const c = tryCompileExpr(spec.when.expr);
              if (!c.ok) {
                  errors.push(`the rule "${id}": ${c.error}`);
                  continue;
              }
              const asked = Math.max(0, whole(spec.debounceMs, 0));
              if (asked > LIMITS.timerMaxMs) {
                  errors.push(`the rule "${id}" waits ${asked} ms before firing; the longest is ${LIMITS.timerMaxMs} ms`);
                  continue;
              }
              seen.add(id);
              rules.push({
                  id, kind: "when", when: c.expr, every: 0, after: 0, do: spec.do,
                  once: spec.once === true, debounceMs: asked, whileVisible, watchesClock: readsTime(c.expr.deps),
              });
              continue;
          }
          if (timers >= LIMITS.timers) {
              errors.push(`a screen has at most ${LIMITS.timers} timers; "${id}" was dropped`);
              continue;
          }
          if (hasEvery) {
              const floor = everyFloorMs(whileVisible, foreground);
              const asked = whole(spec.every, 0);
              if (asked < floor) {
                  errors.push(`the rule "${id}" asks for every ${asked} ms; the shortest here is ${floor} ms`);
                  continue;
              }
              if (asked > LIMITS.timerMaxMs) {
                  errors.push(`the rule "${id}" asks for every ${asked} ms; the longest is ${LIMITS.timerMaxMs} ms`);
                  continue;
              }
              timers += 1;
              seen.add(id);
              rules.push({ id, kind: "every", when: null, every: asked, after: 0, do: spec.do, once: spec.once === true, debounceMs: 0, whileVisible, watchesClock: false });
              continue;
          }
          const after = whole(spec.after, -1);
          if (after < 0) {
              errors.push(`the rule "${id}" has an after that is not a number of milliseconds`);
              continue;
          }
          // A timer longer than a day is refused rather than clamped: `setTimeout` takes a 32-bit delay and fires a
          // longer one AT ONCE, so a far-off `after` would spin instead of waiting (SPEC 5.1, LIMITS.timerMaxMs).
          if (after > LIMITS.timerMaxMs) {
              errors.push(`the rule "${id}" waits ${after} ms; the longest is ${LIMITS.timerMaxMs} ms`);
              continue;
          }
          timers += 1;
          seen.add(id);
          rules.push({ id, kind: "after", when: null, every: 0, after, do: spec.do, once: true, debounceMs: 0, whileVisible, watchesClock: false });
      }
      return { rules, errors };
  }
  /**
   * The live state of one screen's rules. Pure: it is driven by `tick`, and it keeps its own small record of what
   * has fired, what is armed and when each timer started.
   */
  class RuleMachine {
      constructor(rules, opts) {
          this.window = [];
          this.rules = rules;
          this.visible = opts?.visible !== false;
          const now = opts?.now ?? 0;
          this.states = rules.map(() => ({ was: false, armedAt: null, fires: 0, startedAt: now, lastAt: now }));
      }
      /**
       * A node went off or back on screen. Timers that are only live while visible start again from here, so a screen
       * that was away for an hour does not fire sixty missed ticks at once.
       */
      setVisible(visible, now) {
          if (visible === this.visible)
              return;
          this.visible = visible;
          if (!visible)
              return;
          for (let i = 0; i < this.rules.length; i += 1) {
              if (!this.rules[i].whileVisible)
                  continue;
              this.states[i].startedAt = now;
              this.states[i].lastAt = now;
              this.states[i].armedAt = null;
              this.states[i].was = false;
          }
      }
      /** True when a rule is live right now. */
      live(rule) {
          return this.visible || !rule.whileVisible;
      }
      /** The ten-a-second cap, over a sliding second. */
      allow(now) {
          while (this.window.length > 0 && now - this.window[0] >= 1000)
              this.window.shift();
          if (this.window.length >= LIMITS.firesPerSecond)
              return false;
          this.window.push(now);
          return true;
      }
      /**
       * Work out what fires at `now`, in this scope. Call it on a store change and whenever `nextWakeAt` came round;
       * calling it more often than that is allowed and changes nothing.
       */
      tick(scope, now) {
          const fired = [];
          let throttled = 0;
          let next = null;
          // Never ask for a wake further off than a timer may be: a host that turns this into a `setTimeout` delay has
          // only 32 bits for it, and a longer one fires straight away.
          const latest = now + LIMITS.timerMaxMs;
          const wake = (at) => {
              const when = at > latest ? latest : at;
              if (next === null || when < next)
                  next = when;
          };
          // A clock that moved backwards (the device's own, or a zone change) must not park the ten-a-second window.
          while (this.window.length > 0 && this.window[this.window.length - 1] > now)
              this.window.pop();
          for (let i = 0; i < this.rules.length; i += 1) {
              const rule = this.rules[i];
              const st = this.states[i];
              // The same backward jump would otherwise leave every timer waiting out the size of the jump.
              if (st.startedAt > now)
                  st.startedAt = now;
              if (st.lastAt > now)
                  st.lastAt = now;
              if (st.armedAt !== null && st.armedAt > now + rule.debounceMs)
                  st.armedAt = now + rule.debounceMs;
              if (!this.live(rule)) {
                  st.was = false;
                  st.armedAt = null;
                  continue;
              }
              if (rule.once && st.fires > 0)
                  continue;
              if (rule.kind === "when") {
                  // A condition built on `now()`, `since()` or `fmt.elapsed` becomes true by itself, with nothing written
                  // to the store to wake anyone. It is re-checked each second, which is the floor an `every` has anyway.
                  if (rule.watchesClock)
                      wake(now + LIMITS.everyMs);
                  let is = false;
                  try {
                      is = !!rule.when.run(scope);
                  }
                  catch {
                      is = false;
                  }
                  if (!is) {
                      st.was = false;
                      st.armedAt = null;
                      continue;
                  }
                  if (!st.was) {
                      st.was = true;
                      st.armedAt = now + rule.debounceMs;
                  }
                  // Armed at nothing while it is still true means this edge has already fired: a condition that stays true
                  // is not a second change.
                  if (st.armedAt === null)
                      continue;
                  if (now < st.armedAt) {
                      wake(st.armedAt);
                      continue;
                  }
                  if (this.allow(now)) {
                      st.armedAt = null;
                      st.fires += 1;
                      fired.push({ id: rule.id, do: rule.do });
                  }
                  else {
                      throttled += 1;
                      wake(now + 100);
                  }
                  continue;
              }
              if (rule.kind === "after") {
                  const due = st.startedAt + rule.after;
                  if (now < due) {
                      wake(due);
                      continue;
                  }
                  if (this.allow(now)) {
                      st.fires += 1;
                      fired.push({ id: rule.id, do: rule.do });
                  }
                  else {
                      throttled += 1;
                      wake(now + 100);
                  }
                  continue;
              }
              // every: one fire per tick at most, and the next one is a whole period after this one.
              const since = now - st.lastAt;
              if (since < rule.every) {
                  wake(st.lastAt + rule.every);
                  continue;
              }
              if (this.allow(now)) {
                  st.fires += 1;
                  st.lastAt = now;
                  fired.push({ id: rule.id, do: rule.do });
                  wake(now + rule.every);
              }
              else {
                  throttled += 1;
                  wake(now + 100);
              }
          }
          return { fired, nextWakeAt: next, throttled };
      }
      /** How many times a rule has fired. For tests and for the report the device sends back. */
      fireCount(id) {
          const i = this.rules.findIndex((r) => r.id === id);
          return i === -1 ? 0 : this.states[i].fires;
      }
  }
  /** Run one tick and tell the host when to come back. The renderer's loop in one line. */
  function driveRules(machine, host, scope) {
      const t = machine.tick(scope, host.now());
      host.wake(t.nextWakeAt);
      return t;
  }
  /** The paths every `when` in this set reads, so a store change can be matched against them. */
  function ruleDeps(rules) {
      const out = [];
      for (const r of rules) {
          if (!r.when)
              continue;
          for (const d of r.when.deps)
              if (!out.includes(d))
                  out.push(d);
      }
      return out.sort();
  }
  return { LIMITS, byteLen, stringFits, everyFloorMs, VOCAB, BLOCKS, LATER_BLOCKS, isBlock, unknownBlocks, missingBlocks, canDraw, statePathError, statePathOk, looksLikeSecret, localKeyError, localKeyOk, networkPathError, networkPathOk, encodeHole, pathsTouch, MOMENT_VARS, MOMENT_FUNCS, compileNumeric, runNumeric, numericError, PLAIN_ENV, finite, millisOf, fmtNumber, fmtCurrency, fmtPlural, fmtRelative, fmtDatetime, fmtDuration, fmtElapsed, KernelError, TIME_DEP, pick, toText, FUNCTION_NAMES, compileExpr, tryCompileExpr, runExpr, dependsOn, readsTime, isTextTemplate, isValueBinding, isEvaluable, compileText, compileProp, runProp, isExprCondition, compileCondition, looksLikeForgottenTemplate, ARGS_KEY, ARGS_UP_KEY, checkDefs, expandTree, expandItem, compileRules, RuleMachine, driveRules, ruleDeps };
});
