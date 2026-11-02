// The theme, labels and conditions: the server's colours and type, its words
// for a label, state lookups, visibility rules and a node's style as CSS.

function applyTheme(theme) {
  if (!theme || !theme.color) return;
  const c = theme.color, root = document.documentElement.style;
  const set = (k, v) => { if (v) root.setProperty(k, v); };
  set("--bg", c.bg); set("--card", c.card); set("--input", c.inputBg);
  set("--border", c.border); set("--text", c.text); set("--body", c.body);
  set("--muted", c.muted); set("--label", c.label); set("--danger", c.danger);
  // The accent was the one colour this window kept to itself — a literal in the
  // stylesheet — so the brand could be retuned on the phones and this stayed
  // the old amber, with nothing to show that it had.
  set("--accent", c.primary || c.accent);
}

/**
 * THE SERVER'S TYPOGRAPHY, HERE TOO.
 *
 * Every size, weight, tracking and colour in this window was written into this
 * file by hand, while the backend was already sending the whole system —
 * `theme.font.roles`, the same 50-odd roles the phones resolve. So the two
 * surfaces drifted by construction: retuning a heading on the phone did
 * nothing here, and nobody could see that from either side.
 *
 * A role resolves to CSS. `family: "display"` is a slot, not a face — the
 * phone maps it to a downloaded serif, and a window under a font-src 'self'
 * policy cannot fetch that, so it maps to the platform serif instead. Same
 * intent, whatever is installed.
 *
 * SCALE, because a phone column is 393pt and this one is 640. Sizes are
 * carried at a ratio rather than re-chosen, so the rhythm between them — the
 * thing that makes it read as one product — survives the change of surface.
 */
// The scale and the two stacks are knobs; read per call so a new bootstrap
// retunes the next paint.
//
// Escaped, because this lands in a double-quoted style attribute: a
// "Segoe UI" in there closed the attribute early and cut off everything
// role() wrote after it — including the node's own style, so every Text lost
// its margins and colours from the tree ("0words"). css() does the same.

function role(name, extra) {
  const theme = (BOOT && BOOT.theme) || {};
  const f = theme.font || {};
  const r = (f.roles && f.roles[name]) || null;
  if (!r) return extra || "";
  const c = theme.color || {};
  const out = [];
  const scale = K.num("desktop.type.scale", 1.08);
  const px = (v) => Math.round(v * scale * 10) / 10 + "px";
  if (r.size != null) out.push("font-size:" + px(r.size));
  if (r.weight) out.push("font-weight:" + r.weight);
  if (r.lineHeight != null) out.push("line-height:" + px(r.lineHeight));
  if (r.letterSpacing != null) out.push("letter-spacing:" + r.letterSpacing + "px");
  if (r.italic) out.push("font-style:italic");
  if (r.transform) out.push("text-transform:" + r.transform);
  if (r.align) out.push("text-align:" + r.align);
  if (r.color) out.push("color:" + (c[r.color] || r.color));
  out.push("font-family:" + (r.family === "display"
    ? K.str("desktop.font.serif", "Georgia,'Times New Roman',serif")
    : K.str("desktop.font.sans", "-apple-system,'Segoe UI',system-ui,sans-serif")));
  if (r.marginTop != null) out.push("margin-top:" + r.marginTop + "px");
  if (r.marginBottom != null) out.push("margin-bottom:" + r.marginBottom + "px");
  if (r.marginVertical != null) {
    out.push("margin-top:" + r.marginVertical + "px", "margin-bottom:" + r.marginVertical + "px");
  }
  return esc(out.join(";") + (extra ? ";" + extra : ""));
}

function label(v) {
  if (typeof v === "string" && v[0] === "@") {
    const k = v.slice(1);
    return (BOOT && BOOT.labels && BOOT.labels[k]) || k;
  }
  return v;
}

function tok(v) {
  if (typeof v !== "string" || v[0] !== "$") return v;
  let o = BOOT && BOOT.theme;
  for (const part of v.slice(1).split(".")) { if (o == null) return undefined; o = o[part]; }
  return o;
}

function stateAt(path) {
  let o = STATE;
  for (const part of String(path).replace(/^state\./, "").split(".")) {
    if (o == null) return undefined;
    o = o[part];
  }
  return o;
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v === true || v === "true" || (typeof v === "number" && v !== 0) || (typeof v === "string" && v.length > 0);
}

function lookup(ref) {
  if (typeof ref !== "string") return ref;
  if (ref.indexOf("state.") === 0) return stateAt(ref);
  if (ref.indexOf("flags.") === 0) return BOOT && BOOT.flags && BOOT.flags[ref.slice(6)];
  return stateAt(ref);
}

/**
 * The catalog's conditions — the same set the phones evaluate.
 *
 * A condition this window does not know is FALSE, not true: a node gated on
 * something unrecognised stays hidden rather than appearing for everybody. And
 * a malformed one (an operand missing) is false too, rather than a throw that
 * blanks the whole screen — the rule the phone renderer follows.
 */
function visible(c) {
  if (!c) return true;
  const flags = (BOOT && BOOT.flags) || {};
  const same = (a, b) => String(a) === String(b);
  try {
    // The tree the server sends this window is the iOS one (see capabilities),
    // and a condition can also name the desktop outright.
    if (c.platform) return c.platform === "ios" || c.platform === "desktop";
    if (c.flag) return truthy(flags[c.flag]);
    if (c.truthy) return truthy(lookup(c.truthy));
    if (c.falsy) return !truthy(lookup(c.falsy));
    if (c.eq) return same(lookup(c.eq[0]), c.eq[1]);
    if (c.neq) return !same(lookup(c.neq[0]), c.neq[1]);
    if (c.gt) return Number(lookup(c.gt[0])) > Number(c.gt[1]);
    if (c.gte) return Number(lookup(c.gte[0])) >= Number(c.gte[1]);
    if (c.lt) return Number(lookup(c.lt[0])) < Number(c.lt[1]);
    if (c.lte) return Number(lookup(c.lte[0])) <= Number(c.lte[1]);
    if (c.in) return Array.isArray(c.in[1]) && c.in[1].some((x) => same(x, lookup(c.in[0])));
    if (c.contains) {
      // An ARRAY is tested for membership, not for a substring of its joined
      // form — ["hinglish"] does not contain "hi". A string keeps substring
      // semantics.
      const v = lookup(c.contains[0]);
      return Array.isArray(v)
        ? v.some((x) => same(x, c.contains[1]))
        : String(v == null ? "" : v).indexOf(String(c.contains[1])) !== -1;
    }
    if (c.startsWith) return String(lookup(c.startsWith[0]) ?? "").indexOf(String(c.startsWith[1])) === 0;
    if (c.endsWith) {
      const v = String(lookup(c.endsWith[0]) ?? ""), end = String(c.endsWith[1]);
      return v.length >= end.length && v.slice(v.length - end.length) === end;
    }
    // Entitlement lives on the account, and the server already folds it into
    // the boot flags; there is no store on this machine to ask.
    if (c.entitled) return truthy(flags["quota.entitled"]) || truthy(flags["billing.entitled"]);
    if (c.not) return !visible(c.not);
    if (c.all) return c.all.every(visible);
    if (c.any) return c.any.some(visible);
  } catch {
    return false;
  }
  return false;
}

/** Style keys → CSS. The SDUI names come first, then the RN-flavoured aliases
 *  the newer screens author with; both are in the tree and both must resolve. */
// Properties that take a bare number in CSS. LINE-HEIGHT IS NOT ONE OF THEM
// here: CSS reads a bare line-height as a MULTIPLE of the font size, and the
// catalog writes it the way React Native does — in points. So `lineHeight: 15`
// on a 10.5px line became a 157px line box, and the consent notice under the
// sign-in pills had its two lines a third of a screen apart. Every screen that
// sets one was affected; it was only obvious where the text wrapped.
const NUMERIC_OK = /opacity|flex|flex-grow|flex-shrink|z-index|font-weight|aspect-ratio/;
const MAP = {
  direction: "flex-direction", align: "align-items", justify: "justify-content",
  radius: "border-radius", background: "background-color", gap: "gap",
};
const ALIGN = { start: "flex-start", end: "flex-end", center: "center", between: "space-between", around: "space-around", stretch: "stretch", baseline: "baseline" };

/**
 * REACT NATIVE SHORTHANDS THAT CSS HAS NEVER HEARD OF.
 *
 * `paddingHorizontal` became `padding-horizontal`, which every browser drops
 * without a word. The catalog writes these constantly — the paywall's rows,
 * the You tab's cards, the auth screen's margins — so the window had been
 * quietly rendering a large part of the app with no padding at all, and it
 * looked like a slightly cramped design rather than a bug.
 *
 * Each expands to the pair it means, written BEFORE the rest of the style so
 * an explicit `paddingLeft` alongside one still wins, exactly as it does on
 * the phones.
 */
const RN_PAIRS = {
  paddingHorizontal: ["padding-left", "padding-right"],
  paddingVertical: ["padding-top", "padding-bottom"],
  marginHorizontal: ["margin-left", "margin-right"],
  marginVertical: ["margin-top", "margin-bottom"],
};

/**
 * A STYLE VALUE THAT FOLLOWS STATE: `{<condition>, then, else}`.
 *
 * The phones resolve one on every redraw, and the onboarding leans on it (a
 * language chip's border and fill, the card the cleaned words land in). This
 * printed it as "[object Object]", which no browser reads, so the chip never
 * lit. The condition is the tree's own (visible()). An object that is not one
 * is no value, rather than a word in a style attribute.
 */
function styleValue(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
  if (!("then" in v)) return undefined;
  const cond = Object.assign({}, v);
  delete cond.then; delete cond.else;
  return visible(cond) ? v.then : v.else;
}

function css(st) {
  if (!st) return "";
  const out = [];
  // A border with a width and no style is no border in CSS; on the phones it
  // is a solid one. Said here for the onboarding, whose cards and chips lean
  // on it, and written first so an explicit borderStyle still wins. Nowhere
  // else: a screen drawn without borders for years does not grow them now.
  if (IN_STAGE || IN_KIT) {
    for (const k of Object.keys(st)) {
      const m = /^border(Top|Right|Bottom|Left)?Width$/.exec(k);
      if (m && Number(styleValue(st[k])) > 0) out.push("border" + (m[1] ? "-" + m[1].toLowerCase() : "") + "-style:solid");
    }
  }
  // The pairs first, so a specific side named alongside one overrides it.
  for (const k of Object.keys(RN_PAIRS)) {
    const v = tok(styleValue(st[k]));
    if (v == null) continue;
    const val = typeof v === "number" ? v + "px" : String(v);
    for (const prop of RN_PAIRS[k]) out.push(prop + ":" + val);
  }
  for (const k of Object.keys(st)) {
    if (RN_PAIRS[k]) continue;
    let v = tok(styleValue(st[k]));
    if (v == null) continue;
    let prop = MAP[k] || k.replace(/[A-Z]/g, (ch) => "-" + ch.toLowerCase());
    if (prop === "align-items" || prop === "justify-content" || prop === "align-self") v = ALIGN[v] || v;
    // The onboarding's two faces are Latin only; a line in Hindi or Tamil is
    // set in a face that has it, not in the browser's default serif.
    if (IN_STAGE && prop === "font-family") v = v + ",var(--f-ui),var(--f-deva)";
    if (typeof v === "number" && !NUMERIC_OK.test(prop)) v = v + "px";
    out.push(prop + ":" + v);
  }
  // Every caller puts this in a double-quoted style attribute, where a quote
  // in a value (a font name, a url) would end the attribute.
  return esc(out.join(";"));
}
