/**
 * BLIP'S CATALOG — his moves and poses as data the server sends, played here.
 *
 * The server keeps the catalog (TAILZU-BACKEND shared/bots/blip.json, pushed live with PUT /v1/admin/blip) and the bootstrap
 * says which version is current ("desktop.blip": { v, url }); the main process fetches a newer one, keeps it, and hands it to
 * every window with the knobs. This file turns it into what shared/blip.js plays:
 *
 *   gestures   name → (t, v) → a pose: each number is a number or an expression in the bots' motion language (the one the
 *              tiny bots' moments use: botTiles.js compileWith), over t (seconds into the move) and v (the voice, 0 to 1),
 *              after the move's own `let`s. A move is a `pose`, or `steps` (the first whose `until` (t below it) or `when`
 *              holds; one with neither is the rest), and a step may be `as` another move at the same t.
 *   lengths    how long the moves that end take (the rest loop)
 *   quirks     what he does at random while he waits; hover: what he does when the pointer is on him
 *   card       the poses he peeks over Ask's card in; ground: the ones he stands in (a name means "the same as that one")
 *
 * `macros` are small named formulas (io, boing…) spelled out where they are used, before anything is compiled.
 *
 * Nothing here runs code from the catalog: an expression is compiled to the motion language's own bytecode, which only
 * does arithmetic. A move that does not compile is left out (the rest of the catalog still loads); a catalog that brings no
 * usable move at all is refused, and the one before it stays.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.TailzuBlipCatalog = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const FORMAT = 1;
  /** The numbers a pose may set (shared/blip.js gesturePose), and the pairs and names. */
  const NUM = ["tilt", "brows", "headLift", "headSpin", "antSpin", "antLen", "lid", "sqx", "sqy", "spin", "hop", "bob", "glow", "mouthOpen", "antWob", "thumb", "point"];
  const PAIRS = ["ra", "la", "look"];
  const NAMES = { mouth: ["smile", "grin", "flat", "o"], eye: ["wide", "tiny", "spiral"] };
  const FLAGS = ["handsOver", "noBlink"];
  const CARD = ["rise", "tilt", "brows", "lid", "hands", "hop", "neck"];
  const GROUND = ["ra0", "ra1", "la0", "la1", "tilt", "brows", "lx", "ly", "thumb", "point", "hop", "grin"];
  const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
  const MAX_GESTURES = 200, MAX_LETS = 12, MAX_STEPS = 16, MAX_SRC = 400;

  const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
  const core = () => (root && root.TailzuBotTiles) || (typeof require === "function" ? require("../../botTiles.js") : null);

  /** Spell out the catalog's macros in `src`: name(a, b) becomes the macro's body with its parameters replaced. */
  function expand(src, macros) {
    let out = String(src);
    for (let pass = 0; pass < 8; pass++) {
      let changed = false;
      for (const name of Object.keys(macros)) {
        const [params, body] = macros[name];
        const re = new RegExp("\\b" + name + "\\(", "g");
        let m;
        while ((m = re.exec(out))) {
          // The arguments: up to the matching ")", split on the commas at the top level.
          let depth = 1, i = m.index + m[0].length, start = i;
          const args = [];
          for (; i < out.length && depth; i++) {
            const ch = out[i];
            if (ch === "(") depth++;
            else if (ch === ")") { depth--; if (!depth) args.push(out.slice(start, i)); }
            else if (ch === "," && depth === 1) { args.push(out.slice(start, i)); start = i + 1; }
          }
          if (depth) throw new Error(`unclosed ${name}(`);
          if (args.length !== params.length) throw new Error(`${name} takes ${params.length}`);
          let b = body;
          params.forEach((p, k) => { b = b.replace(new RegExp("\\b" + p + "\\b", "g"), "(" + args[k].trim() + ")"); });
          out = out.slice(0, m.index) + "(" + b + ")" + out.slice(i);
          re.lastIndex = 0;
          changed = true;
          if (out.length > 8000) throw new Error("too long");
        }
      }
      if (!changed) return out;
    }
    throw new Error("macros nest too deep");
  }

  function compileMacros(spec) {
    const macros = {};
    for (const [name, def] of Object.entries(spec || {})) {
      if (!NAME_RE.test(name) || !Array.isArray(def) || !Array.isArray(def[0]) || typeof def[1] !== "string") throw new Error(`macro ${name}`);
      if (!def[0].every((p) => NAME_RE.test(p))) throw new Error(`macro ${name}: its parameters`);
      macros[name] = [def[0], def[1]];
    }
    return macros;
  }

  /** One number: a constant, or an expression over `names` (filled in `vals` at play time). */
  function number(x, names, macros) {
    if (typeof x === "number" && Number.isFinite(x)) return () => x;
    if (typeof x !== "string" || !x.trim() || x.length > MAX_SRC) throw new Error("not a number or an expression");
    return core().compileWith(expand(x, macros), names);
  }
  /** A name (mouth, eye): a word it knows, nothing, or { if, then, else }. */
  function word(field, x, names, macros) {
    if (x === null || x === undefined) return () => undefined;
    if (typeof x === "string") {
      if (!NAMES[field].includes(x)) throw new Error(`${field}: ${x}`);
      return () => x;
    }
    if (x && typeof x === "object" && typeof x.if === "string") {
      const cond = number(x.if, names, macros), a = word(field, x.then, names, macros), b = word(field, x.else, names, macros);
      return (vals) => (cond(vals) ? a(vals) : b(vals));
    }
    throw new Error(`${field}: not a name`);
  }

  /** `let`: [name, expression] pairs, each able to read the ones before it. Returns the names after them, and their runners. */
  function lets(spec, names, macros) {
    if (spec === undefined) return { names, run: [] };
    if (!Array.isArray(spec) || spec.length > MAX_LETS) throw new Error("let: a short list of [name, expression]");
    const run = [];
    let ns = names.slice();
    for (const pair of spec) {
      if (!Array.isArray(pair) || !NAME_RE.test(pair[0]) || ns.includes(pair[0])) throw new Error("let: a new name and an expression");
      run.push({ at: ns.length, f: number(pair[1], ns, macros) });
      ns = ns.concat(pair[0]);
    }
    return { names: ns, run };
  }

  /** A pose: each field it sets, compiled; what it does not set is the default (shared/blip.js). */
  function pose(spec, names, macros) {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("pose: an object");
    const parts = [];
    for (const [k, x] of Object.entries(spec)) {
      if (NUM.includes(k)) { const f = number(x, names, macros); parts.push((o, vals) => { o[k] = f(vals); }); }
      else if (PAIRS.includes(k)) {
        if (!Array.isArray(x) || x.length !== 2) throw new Error(`${k}: a pair`);
        const a = number(x[0], names, macros), b = number(x[1], names, macros);
        parts.push((o, vals) => { o[k] = [a(vals), b(vals)]; });
      } else if (k === "legs") {
        if (!Array.isArray(x) || x.length !== 2) throw new Error("legs: two");
        const ls = x.map((l) => ({ th: number(l && l.th, names, macros), lift: number(l && l.lift, names, macros) }));
        parts.push((o, vals) => { o.legs = ls.map((l) => ({ th: l.th(vals), lift: l.lift(vals) })); });
      } else if (own(NAMES, k)) { const f = word(k, x, names, macros); parts.push((o, vals) => { o[k] = f(vals); }); }
      else if (FLAGS.includes(k)) { if (x !== true && x !== false) throw new Error(`${k}: true or false`); parts.push((o) => { o[k] = x; }); }
      else throw new Error(`pose: unknown ${k}`);
    }
    return (vals) => { const o = {}; for (const p of parts) p(o, vals); return o; };
  }

  /** One move, compiled to (t, v, moves) → pose. `moves` is the catalog's own, for a step `as` another move. */
  function gesture(name, spec, macros) {
    if (!spec || typeof spec !== "object") throw new Error("not an object");
    const top = lets(spec.let, ["t", "v"], macros);
    let body;
    if (spec.steps !== undefined) {
      if (!Array.isArray(spec.steps) || !spec.steps.length || spec.steps.length > MAX_STEPS) throw new Error("steps: a short list");
      body = spec.steps.map((st, i) => {
        if (!st || typeof st !== "object") throw new Error(`step ${i + 1}`);
        const own2 = lets(st.let, top.names, macros);
        const until = st.until === undefined ? null : Number(st.until);
        if (until !== null && !Number.isFinite(until)) throw new Error(`step ${i + 1}: until a number`);
        const when = st.when === undefined ? null : number(st.when, own2.names, macros);
        if (st.as !== undefined && (typeof st.as !== "string" || st.as === name)) throw new Error(`step ${i + 1}: as another move`);
        const p = st.as !== undefined ? null : pose(st.pose, own2.names, macros);
        return { lets: own2, n: own2.names.length, until, when, as: st.as, p };
      });
    } else {
      body = [{ lets: { names: top.names, run: [] }, n: top.names.length, until: null, when: null, as: undefined, p: pose(spec.pose, top.names, macros) }];
    }
    const width = Math.max(...body.map((b) => b.n));
    const vals = new Float64Array(width);
    return (t, v, moves, depth) => {
      vals.fill(0);
      vals[0] = t; vals[1] = v;
      for (const r of top.run) vals[r.at] = r.f(vals);
      for (const st of body) {
        if (st.until !== null && !(t < st.until)) continue;
        for (const r of st.lets.run) vals[r.at] = r.f(vals);
        if (st.when && !st.when(vals)) continue;
        if (st.as) return (depth || 0) < 4 && moves[st.as] ? moves[st.as](t, v, moves, (depth || 0) + 1) : {};
        return st.p(vals);
      }
      return {};
    };
  }

  /** A table of named poses: each one's numbers, or the name of another in the same table. */
  function table(spec, fields) {
    const out = {};
    for (const [name, x] of Object.entries(spec || {})) {
      if (!NAME_RE.test(name)) continue;
      if (typeof x === "string") continue;
      if (!x || typeof x !== "object") continue;
      const o = {};
      for (const f of fields) if (typeof x[f] === "number" && Number.isFinite(x[f])) o[f] = x[f];
      out[name] = o;
    }
    for (const [name, x] of Object.entries(spec || {})) if (typeof x === "string" && out[x]) out[name] = out[x];
    return out;
  }

  /**
   * The catalog, compiled: { v, gestures, lengths, quirks, hover, card, ground, groundGlow, errors }. Throws when it is not
   * one this build plays (another format, or not one move compiles).
   */
  function compile(spec) {
    if (!spec || typeof spec !== "object") throw new Error("not a catalog");
    if (spec.format !== undefined && spec.format !== FORMAT) throw new Error(`format ${spec.format}: this build plays ${FORMAT}`);
    if (!core() || typeof core().compileWith !== "function") throw new Error("no motion language here");
    const macros = compileMacros(spec.macros);
    const errors = [];
    const gestures = {}, lengths = {}, quirks = [], hover = [];
    const entries = Object.entries(spec.gestures || {}).slice(0, MAX_GESTURES);
    for (const [name, g] of entries) {
      if (!NAME_RE.test(name)) { errors.push(`${name}: not a name`); continue; }
      try {
        const f = gesture(name, g, macros);
        // Tried once, so a move that throws while it plays is left out now, not mid-frame.
        f(0.5, 0.5, gestures, 0);
        gestures[name] = f;
        if (typeof g.length === "number" && g.length > 0 && g.length < 60) lengths[name] = g.length;
        if (g.quirk === true) quirks.push(name);
        if (g.hover === true) hover.push(name);
      } catch (e) {
        errors.push(`${name}: ${(e && e.message) || e}`);
      }
    }
    if (!gestures.rest) throw new Error("no rest move" + (errors.length ? ` (${errors[0]})` : ""));
    return {
      v: Number(spec.v) || 0, gestures, lengths, quirks, hover,
      card: table(spec.card, CARD), ground: table(spec.ground, GROUND),
      groundGlow: Object.fromEntries(Object.entries(spec.groundGlow || {}).filter(([, x]) => typeof x === "number")),
      errors,
    };
  }

  return { FORMAT, compile, expand };
});
