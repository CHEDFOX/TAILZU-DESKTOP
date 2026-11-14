// What a screen MEANS, worked out with the kernel: `$` values, `$t` text with holes, `Use` and `Slot`, and the
// scope they read ({ state, device, local, item, index, args, ui }).
//
// THE RULE THAT MATTERS: only the two object shapes are ever evaluated. A bare string is data, whoever wrote it —
// a note's title, a calendar invite from a stranger — and is drawn as the characters it holds (SPEC 2.2).

/** How deep inside one props object we look for a `$` or a `$t`. Deeper than this is data. */
const V2_DEEP = 8;
/** Compiled props, by their source text, for the screen that is up. */
let V2_CACHE = new Map();
/** Where the row being drawn comes from: a List or an Each sets these while it draws one row. */
let V2_ROW = null;

/** The clock and the locale the formats read. */
function v2Env() {
  const d = typeof v2Facts === "function" ? v2Facts() : null;
  return {
    locale: (d && d.locale) || (typeof navigator !== "undefined" && navigator.language) || "en-US",
    now: Date.now(),
    timeZone: "",
    intl: typeof Intl !== "undefined",
  };
}

/** Everything an expression may read. `item` and `index` are there only inside a list row or a template. */
function v2Scope(extra) {
  const s = {
    state: typeof STATE === "object" && STATE ? STATE : {},
    device: typeof v2Facts === "function" ? v2Facts() : {},
    local: typeof v2LocalAll === "function" ? v2LocalAll() : {},
    ui: V2.ui,
    args: {},
    env: v2Env(),
  };
  if (V2_ROW) { s.item = V2_ROW.item; s.index = V2_ROW.index; }
  if (extra) for (const k of Object.keys(extra)) s[k] = extra[k];
  return s;
}

/** Note what was refused, for the handshake's `sdui.bad` (at most a few, and never a person's own words). */
function v2Bad(what) {
  if (V2.bad.length < 8 && V2.bad.indexOf(what) === -1) V2.bad.push(what);
}

/** Compile one prop shape once per screen. `encode` is for path fields, whose holes are URL-encoded. */
function v2Compile(v, encode) {
  const k = v2Kernel();
  if (!k) return null;
  const key = (encode ? "p|" : "v|") + (k.isValueBinding(v) ? "$|" + v.$ : "t|" + v.$t);
  let got = V2_CACHE.get(key);
  if (got === undefined) {
    try { got = k.compileProp(v, encode ? { encode: true } : undefined); }
    catch (e) { got = null; v2Bad("expr:" + (e && e.kind ? e.kind : "bad")); }
    V2_CACHE.set(key, got);
  }
  return got;
}

/**
 * One prop, resolved. Anything that is not a `$` or a `$t` comes straight back.
 *
 * A refused expression leaves `undefined` behind — the node then draws without that prop, which is what "degrade,
 * never throw" means here — and the whole screen stops evaluating once it has spent its operations for this paint.
 */
function v2Value(v, scope, encode) {
  const k = v2Kernel();
  if (!k || !k.isEvaluable(v)) return v;
  const prop = v2Compile(v, encode);
  if (!prop) return undefined;
  V2.ops += prop.ops || 1;
  if (V2.ops > k.LIMITS.opsPerChange) { v2Bad("expr:budget"); return undefined; }
  const r = k.runProp ? (() => { try { return { ok: true, value: k.runProp(prop, scope || v2Scope()) }; } catch (e) { return { ok: false, e }; } })() : { ok: false };
  if (!r.ok) { v2Bad("expr:run"); return undefined; }
  return r.value;
}

/** A props or style object with every `$` and `$t` inside it resolved. Node trees and actions are left alone. */
function v2Deep(v, scope, depth) {
  const k = v2Kernel();
  if (!k || depth > V2_DEEP) return v;
  if (k.isEvaluable(v)) return v2Value(v, scope);
  if (Array.isArray(v)) {
    let same = true;
    const out = v.map((x) => { const r = v2Deep(x, scope, depth + 1); if (r !== x) same = false; return r; });
    return same ? v : out;
  }
  if (v && typeof v === "object") {
    // A node tree inside a prop (a list's row, a hint's card) is drawn later, in its own scope.
    if (typeof v.type === "string") return v;
    let same = true;
    const out = {};
    for (const key of Object.keys(v)) {
      const r = v2Deep(v[key], scope, depth + 1);
      if (r !== v[key]) same = false;
      out[key] = r;
    }
    return same ? v : out;
  }
  return v;
}

/**
 * A value that may go into a style attribute. A `$` in a style can read the store, and the store holds people's
 * own words: one that carries a `;`, a brace or a url() would be more CSS (a box over the whole window, a picture
 * fetched from anywhere), not a value. Such a value is dropped, as any value that cannot be read is.
 */
const V2_CSS_BAD = /[;{}<>\\@!]|(?:url|image|image-set|cross-fade|element|src|expression)\s*\(/i;
function v2CssSafe(v) {
  if (typeof v !== "string") return v;
  if (v.length > 512 || V2_CSS_BAD.test(v)) { v2Bad("style:value"); return undefined; }
  return v;
}

/**
 * True when an expression made any part of this style value.
 *
 * Not only `color: { $: … }`. theme.js's styleValue() also picks between the two sides of a `{ then, else }` style
 * value, and the paint keys take layers and lists — so an expression one level down ends up in the same attribute,
 * and is held to the same rule.
 */
function v2CssFromExpr(v, depth) {
  const k = v2Kernel();
  if (!k || depth > V2_DEEP) return false;
  if (k.isEvaluable(v)) return true;
  if (Array.isArray(v)) return v.some((x) => v2CssFromExpr(x, depth + 1));
  if (v && typeof v === "object" && typeof v.type !== "string") {
    for (const key of Object.keys(v)) if (v2CssFromExpr(v[key], depth + 1)) return true;
  }
  return false;
}

/** True when every string inside a resolved style value is a value, and not more CSS. */
function v2CssClean(v, depth) {
  if (typeof v === "string") return v2CssSafe(v) === v;
  if (depth > V2_DEEP || !v || typeof v !== "object") return true;
  if (Array.isArray(v)) return v.every((x) => v2CssClean(x, depth + 1));
  for (const key of Object.keys(v)) if (!v2CssClean(v[key], depth + 1)) return false;
  return true;
}

/** A style after its expressions ran: every value an expression made is checked; what the server wrote is not. */
function v2CssValues(raw, resolved) {
  const k = v2Kernel();
  if (!k || resolved === raw || !resolved || typeof resolved !== "object") return resolved;
  let out = resolved;
  for (const key of Object.keys(raw)) {
    if (!v2CssFromExpr(raw[key], 0) || v2CssClean(resolved[key], 0)) continue;
    if (out === resolved) out = Object.assign({}, resolved);
    delete out[key];
  }
  return out;
}

/** A `{ expr }` condition. Anything else is not ours — the tree's own conditions stay with visible(). */
function v2Cond(c, scope) {
  const k = v2Kernel();
  if (!k || !k.isExprCondition(c)) return null;
  const v = v2Value({ $: c.expr }, scope);
  return v === undefined ? false : !!v;
}

/**
 * Carry a template's arguments down the tree it expanded to.
 *
 * Expansion leaves the frames on the node that was made, not on its children, and this renderer draws each node on
 * its own with no memory of the one above it. So the frames are spread over the subtree once, here: a node inherits
 * what every template around it passed, outermost first, and slot content steps back past the frames it was written
 * outside of.
 */
function v2Spread(tree, inherited) {
  const k = v2Kernel();
  if (!k || !tree || typeof tree !== "object") return tree;
  if (Array.isArray(tree)) return tree.map((t) => v2Spread(t, inherited));
  const up = typeof tree[k.ARGS_UP_KEY] === "number" ? tree[k.ARGS_UP_KEY] : 0;
  const base = up > 0 ? inherited.slice(0, Math.max(0, inherited.length - up)) : inherited;
  const own = Array.isArray(tree[k.ARGS_KEY]) ? tree[k.ARGS_KEY] : [];
  const full = base.concat(own);
  if (full.length) tree[k.ARGS_KEY] = full;
  if (Array.isArray(tree.children)) tree.children = tree.children.map((c) => v2Spread(c, full));
  return tree;
}

/**
 * The arguments in scope for a node that came out of a template.
 *
 * Expansion leaves the frames on the node, outermost first, holding the values exactly as the caller wrote them —
 * so each frame is resolved in the scope of the one outside it, and the innermost is what `args.*` means here.
 */
function v2Args(node, scope) {
  const k = v2Kernel();
  if (!k) return {};
  const frames = node[k.ARGS_KEY];
  if (!Array.isArray(frames) || !frames.length) return {};
  let args = {};
  for (const frame of frames) {
    const at = Object.assign({}, scope, { args });
    const made = {};
    if (frame && typeof frame === "object") for (const key of Object.keys(frame)) made[key] = v2Deep(frame[key], at, 1);
    args = made;
  }
  return args;
}

/** The screen is going: every block forgets what belonged to it. */
function v2Gone() {
  if (typeof v2RulesLeave === "function") v2RulesLeave();
  if (typeof v2DataLeave === "function") v2DataLeave();
  if (typeof v2ListLeave === "function") v2ListLeave();
  if (typeof v2MediaLeave === "function") v2MediaLeave();
  if (typeof v2ShellLeave === "function") v2ShellLeave();
  // Leaving the screen hangs up: a microphone is never left open behind a page nobody is looking at.
  if (typeof v2CallLeaveScreen === "function") v2CallLeaveScreen();
  if (typeof v2MarksLeave === "function") v2MarksLeave();
}

/** A new paint of a new screen: forget what the last one compiled, and look at what this one needs. */
function v2Frame(screen) {
  const k = v2Kernel();
  v2PaintStart();
  const missing = v2MissingFor(screen);
  const needs = v2Needs(screen);
  const fresh = V2.screenId !== (screen.screenId || "");
  if (fresh) {
    V2_CACHE = new Map();
    V2.bad = [];
    V2.ui = {};
    v2Gone();
  }
  V2.screenId = screen.screenId || "";
  V2.needs = needs;
  V2.missing = missing;
  V2.defs = screen.defs && typeof screen.defs === "object" ? screen.defs : null;
  V2.on = needs.length > 0 && missing.length === 0 && !!k;
  V2.ops = 0;
  if (V2.on && V2.defs && k) {
    const errors = k.checkDefs(V2.defs);
    if (errors.length) { v2Bad("defs:" + errors.length); V2.defs = null; }
  }
  if (V2.on && typeof v2DeviceStart === "function" && v2Has("device")) v2DeviceStart();
  // The wiring runs once the markup this paint is about to make has landed in the page.
  if (!V2.pending) {
    V2.pending = true;
    Promise.resolve().then(() => { V2.pending = false; try { v2After(); } catch { /* a block never takes the screen down */ } });
  }
}

/**
 * The hook nodes.js calls for every node (and first for the screen's root).
 *
 * Gives back the node to draw, with its props resolved, or a string that IS the markup for it — the "update X0"
 * card when the screen needs blocks this build has not got, and nothing for a node an expression hid.
 */
function v2Prepare(n) {
  const k = v2Kernel();
  const screen = typeof CURRENT_SCREEN !== "undefined" ? CURRENT_SCREEN : null;
  // A screen drawn from `blocks` (no root) never states what it needs, and must not inherit what the screen before
  // it was given: it is drawn exactly as it always was. v2Frame() never runs for it, so the screen it replaces is
  // put down here instead — its loops stopped, the listeners its paint left on the window taken off, its lists,
  // subscriptions and overlays forgotten. Nothing on this screen would ever do it for them.
  if (screen && !screen.root) {
    if (V2.on || V2.needs.length || V2.missing.length || V2.screenId) {
      V2.on = false;
      V2.missing = [];
      V2.needs = [];
      V2.screenId = "";
      v2PaintStart();
      v2Gone();
    }
    return n;
  }
  if (screen && n === screen.root) v2Frame(screen);
  if (V2.missing.length && screen && n === screen.root) {
    return screen.fallback && typeof screen.fallback === "object" ? node(screen.fallback) : v2GateHtml(V2.missing);
  }
  if (!V2.on || !k) return n;
  let it = n;
  // A `Use` is the template it names, with its arguments carried on what it expanded to.
  if (it.type === "Use" || it.type === "Slot") {
    if (!v2Has("defs")) return it.fallback ? node(it.fallback) : "";
    let made = null;
    try { made = v2Spread(k.expandTree(it, V2.defs || {}).node, Array.isArray(it[k.ARGS_KEY]) ? it[k.ARGS_KEY] : []); }
    catch (e) { v2Bad("defs:expand"); made = null; }
    if (!made || typeof made !== "object") return it.fallback ? node(it.fallback) : "";
    it = made;
  }
  const expr = v2Has("expr");
  // Only a node that came out of a template has arguments to work out, so nothing else pays for them.
  const scope = expr ? (Array.isArray(it[k.ARGS_KEY]) ? v2Scope({ args: v2Args(it, v2Scope()) }) : v2Scope()) : null;
  // A condition written as an expression. The tree's own shapes stay with visible(), which nodes.js asks next.
  if (expr && k.isExprCondition(it.visibleIf)) {
    if (!v2Cond(it.visibleIf, scope)) return it.fallback ? node(it.fallback) : "";
    it = Object.assign({}, it);
    delete it.visibleIf;
  }
  let props = expr && it.props ? v2Deep(it.props, scope, 1) : it.props;
  let style = expr && it.style ? v2CssValues(it.style, v2Deep(it.style, scope, 1)) : it.style;
  // Paint keys (gradients, shadows, filters, blend, blur) become CSS here, so css() in theme.js only ever sees
  // values it can write straight into the style attribute.
  if (style && v2Has("paint")) style = v2Paint(style);
  // `bind` written as an expression is a VALUE, not a path: it lands on the prop of the same name, which is where
  // the rest of this renderer looks for it. A bare string in `bind` keeps its old meaning (a dot path).
  let bound = null;
  if (expr && it.bind && typeof it.bind === "object") {
    for (const key of Object.keys(it.bind)) {
      if (!k.isEvaluable(it.bind[key])) continue;
      if (!bound) bound = {};
      bound[key] = v2Value(it.bind[key], scope);
    }
  }
  if (bound) {
    props = Object.assign({}, props || {}, bound);
    const rest = {};
    for (const key of Object.keys(it.bind)) if (!(key in bound)) rest[key] = it.bind[key];
    const made = Object.assign({}, it, { props, bind: rest });
    if (style !== it.style) made.style = style;
    return made;
  }
  if (props === it.props && style === it.style) return it;
  const out = Object.assign({}, it);
  if (props !== it.props) out.props = props;
  if (style !== it.style) out.style = style;
  return out;
}

/** Draw one row of a list or an Each with `item` and `index` in scope. */
function v2WithRow(item, index, draw) {
  const was = V2_ROW;
  V2_ROW = { item, index };
  try { return draw(); } finally { V2_ROW = was; }
}
