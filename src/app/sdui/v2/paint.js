// Paint on any box (SPEC 2.7, B7): gradients, shadows, filters, blend modes and a real blur of what is behind.
//
// The phone turns these into React Native 0.85's own style keys (theme/paintCore.ts); here they turn into CSS. The
// clamps are the phone's numbers, so a box painted for one surface is painted the same on the other, and a server
// that forgets a limit is clamped on both. A value that cannot be read is dropped, never drawn half-way.

const V2_PAINT_LIMITS = {
  layers: 4, stops: 8, shadows: 4, shadowBlur: 80, shadowOffset: 100, shadowSpread: 50,
  filters: 4, blur: 100, strLen: 2048, filterStr: 256,
};
/** The filter functions both phones draw, and therefore the only ones a screen may ask for. */
const V2_FILTERS = ["brightness", "opacity"];
const V2_BLENDS = [
  "normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn",
  "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity",
];
const V2_PAINT_KEYS = ["backgroundImage", "boxShadow", "filter", "mixBlendMode", "blur"];

const v2Clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);
function v2Num(v) {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(String(v).replace(/px$/i, "")) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** A colour we will put in a stylesheet: hex, rgb(a), hsl(a), or a plain colour word. Never url() or var(). */
function v2Color(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > 64) return null;
  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s)) return s;
  if (/^(?:rgba?|hsla?)\(\s*[-0-9.%\s,/]+\)$/i.test(s)) return s;
  if (/^[a-z]{3,24}$/i.test(s)) return s.toLowerCase();
  return null;
}

/** Split on commas that are not inside brackets, so a colour keeps its own commas. */
function v2SplitTop(s) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function v2Stop(color, at) {
  const c = v2Color(color);
  if (!c) return null;
  if (at == null) return c;
  if (typeof at === "string" && /^-?\d+(\.\d+)?%$/.test(at.trim())) return c + " " + v2Clamp(parseFloat(at), 0, 100) + "%";
  const n = v2Num(at);
  return n == null ? c : c + " " + v2Clamp(n <= 1 ? n * 100 : n, 0, 100) + "%";
}

/** One gradient layer, as an object or as a CSS string the server wrote. */
function v2Gradient(layer) {
  if (typeof layer === "string") {
    const s = layer.trim();
    if (s.length > V2_PAINT_LIMITS.strLen) return null;
    const m = /^(linear|radial)-gradient\((.*)\)$/i.exec(s);
    if (!m) return null;
    const parts = v2SplitTop(m[2]);
    const kind = m[1].toLowerCase();
    const out = [];
    let i = 0;
    if (kind === "linear" && parts.length && (/^to\s/i.test(parts[0]) || /deg$/i.test(parts[0]))) { out.push(parts[0].toLowerCase()); i = 1; }
    if (kind === "radial" && parts.length && /^(circle|ellipse)/i.test(parts[0])) { out.push(parts[0].toLowerCase()); i = 1; }
    for (; i < parts.length && out.length <= V2_PAINT_LIMITS.stops; i++) {
      const bits = parts[i].trim().split(/\s+/);
      const stop = v2Stop(bits[0], bits[1]);
      if (!stop) return null;
      out.push(stop);
    }
    return out.length >= 2 ? kind + "-gradient(" + out.join(", ") + ")" : null;
  }
  if (!layer || typeof layer !== "object" || !Array.isArray(layer.stops)) return null;
  const kind = layer.kind === "radial" ? "radial" : "linear";
  const stops = [];
  for (const s of layer.stops.slice(0, V2_PAINT_LIMITS.stops)) {
    const made = s && typeof s === "object" ? v2Stop(s.color, s.at) : v2Stop(s, null);
    if (made) stops.push(made);
  }
  if (stops.length < 2) return null;
  const angle = v2Num(layer.angle);
  const head = kind === "linear" ? (angle == null ? "180deg" : v2Clamp(angle, -360, 360) + "deg") : "circle";
  return kind + "-gradient(" + head + ", " + stops.join(", ") + ")";
}

function v2BackgroundImage(v) {
  const layers = (Array.isArray(v) ? v : [v]).slice(0, V2_PAINT_LIMITS.layers).map(v2Gradient).filter(Boolean);
  return layers.length ? layers.join(", ") : null;
}

/** One shadow: "0 4 12 0 rgba(0,0,0,.2)", or the object form. */
function v2Shadow(s) {
  const L = V2_PAINT_LIMITS;
  if (typeof s === "string") {
    const bits = [];
    let depth = 0, cur = "";
    for (const ch of s.trim()) {
      if (ch === "(") depth++;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      if (/\s/.test(ch) && depth === 0) { if (cur) bits.push(cur); cur = ""; } else cur += ch;
    }
    if (cur) bits.push(cur);
    const inset = bits[0] === "inset" ? bits.shift() : "";
    const nums = [];
    while (nums.length < 4 && bits.length && v2Num(bits[0]) != null) nums.push(v2Num(bits.shift()));
    const color = v2Color(bits.shift()) || "rgba(0,0,0,0.2)";
    if (nums.length < 2) return null;
    return (inset ? "inset " : "") + v2Clamp(nums[0], -L.shadowOffset, L.shadowOffset) + "px " +
      v2Clamp(nums[1], -L.shadowOffset, L.shadowOffset) + "px " +
      v2Clamp(nums[2] || 0, 0, L.shadowBlur) + "px " +
      v2Clamp(nums[3] || 0, -L.shadowSpread, L.shadowSpread) + "px " + color;
  }
  if (!s || typeof s !== "object") return null;
  const x = v2Num(s.offsetX) || 0, y = v2Num(s.offsetY) || 0;
  const blur = v2Num(s.blurRadius) || 0, spread = v2Num(s.spreadDistance) || 0;
  const color = v2Color(s.color) || "rgba(0,0,0,0.2)";
  return (s.inset === true ? "inset " : "") + v2Clamp(x, -L.shadowOffset, L.shadowOffset) + "px " +
    v2Clamp(y, -L.shadowOffset, L.shadowOffset) + "px " + v2Clamp(blur, 0, L.shadowBlur) + "px " +
    v2Clamp(spread, -L.shadowSpread, L.shadowSpread) + "px " + color;
}

function v2BoxShadow(v) {
  const list = (Array.isArray(v) ? v : typeof v === "string" ? v2SplitTop(v) : [v])
    .slice(0, V2_PAINT_LIMITS.shadows).map(v2Shadow).filter(Boolean);
  return list.length ? list.join(", ") : null;
}

/** Only the functions both phones draw, each clamped, so one screen looks the same everywhere. */
function v2Filter(v) {
  const out = [];
  const take = (name, raw) => {
    if (out.length >= V2_PAINT_LIMITS.filters) return;
    if (V2_FILTERS.indexOf(name) === -1) return;
    const n = v2Num(raw);
    if (n == null) return;
    out.push(name + "(" + v2Clamp(n, 0, 10) + ")");
  };
  if (typeof v === "string") {
    if (v.length > V2_PAINT_LIMITS.filterStr) return null;
    for (const m of v.matchAll(/([a-z]+)\(\s*([-0-9.%]+)\s*\)/gi)) take(m[1].toLowerCase(), m[2].replace("%", "") / (m[2].indexOf("%") === -1 ? 1 : 100));
  } else if (Array.isArray(v)) {
    for (const f of v) if (f && typeof f === "object") for (const name of Object.keys(f)) take(name, f[name]);
  } else if (v && typeof v === "object") {
    for (const name of Object.keys(v)) take(name, v[name]);
  }
  return out.length ? out.join(" ") : null;
}

/**
 * A style with its paint keys turned into CSS the window can set straight on the box.
 *
 * `blur` is the odd one: there is no such CSS property, so it becomes a backdrop filter, which is the same thing
 * the phone's expo-blur draws — the box blurs what is BEHIND it, not itself.
 */
function v2Paint(style) {
  if (!style || typeof style !== "object") return style;
  let touched = false;
  for (const key of V2_PAINT_KEYS) if (key in style) { touched = true; break; }
  if (!touched) return style;
  const out = Object.assign({}, style);
  for (const key of V2_PAINT_KEYS) delete out[key];
  const bg = "backgroundImage" in style ? v2BackgroundImage(style.backgroundImage) : null;
  if (bg) out.backgroundImage = bg;
  const shadow = "boxShadow" in style ? v2BoxShadow(style.boxShadow) : null;
  if (shadow) out.boxShadow = shadow;
  const filter = "filter" in style ? v2Filter(style.filter) : null;
  if (filter) out.filter = filter;
  const blend = typeof style.mixBlendMode === "string" && V2_BLENDS.indexOf(style.mixBlendMode) !== -1 ? style.mixBlendMode : null;
  if (blend) out.mixBlendMode = blend;
  if ("blur" in style) {
    const raw = style.blur && typeof style.blur === "object" ? style.blur.intensity : style.blur;
    const n = v2Num(raw);
    // The phone's intensity runs 0..100 over about a 30 px blur; the same scale, so the two look alike.
    if (n != null && n > 0) out.backdropFilter = "blur(" + Math.round(v2Clamp(n, 0, V2_PAINT_LIMITS.blur) * 0.3 * 10) / 10 + "px)";
  }
  return out;
}
