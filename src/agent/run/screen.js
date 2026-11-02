// The screen as it leaves this computer: the elements the server is sent, each
// with a coarse region instead of its frame, and no URL's query or fragment.

const { str, squash, clip, isFrame, elementsOf } = require("./helpers.js");

/** The server takes this many elements and answers 413 above it. */
const MAX_ELEMENTS = 250;
/** The server also measures the screen as its prompt carries it, a line an
 *  element, and answers 413 for the whole step above AGENT_SCREEN_MAX_CHARS
 *  (24,000 by default). A page of text read off the window line by line fills
 *  the element list with lines of 80 characters and goes past that, so the
 *  lines are only added while the screen stays this far inside it: such a
 *  page goes with its first lines rather than not at all. */
const SCREEN_CHARS = 20000;

const GRID = [["tl", "t", "tr"], ["l", "c", "r"], ["bl", "b", "br"]];

/**
 * Where in the window an element is, in thirds, from the centre of its frame:
 * "tl" "t" "tr" / "l" "c" "r" / "bl" "b" "br". This is all the model ever
 * learns about position — enough for "the button at the top right", never a
 * coordinate. Something outside the window (a mac menu bar item sits above
 * it) counts as the nearest edge. Undefined when either frame is missing.
 */
function regionOf(frame, windowFrame) {
  if (!isFrame(frame) || !isFrame(windowFrame)) return undefined;
  const [wx, wy, ww, wh] = windowFrame;
  if (ww <= 0 || wh <= 0) return undefined;
  const cx = frame[0] + frame[2] / 2;
  const cy = frame[1] + frame[3] / 2;
  const third = (v, start, size) => {
    const t = Math.floor(((v - start) / size) * 3);
    return t < 0 ? 0 : t > 2 ? 2 : t;
  };
  return GRID[third(cy, wy, wh)][third(cx, wx, ww)];
}

/** id → frame for one snapshot. Ids are only good for the snapshot they came
 *  from, so each snapshot gets its own map and the last one replaces it. */
function frameMap(snapshot) {
  const map = new Map();
  for (const e of elementsOf(snapshot)) if (typeof e.id === "string" && isFrame(e.frame)) map.set(e.id, e.frame);
  return map;
}

// A browser's address bar, by its label in each browser ("Address and search
// bar", "Search with Google or enter address", Safari's "Smart Search Field").
const ADDRESS_BAR = /\b(?:address(?:\s+and\s+search)?\s+bar|address\s+and\s+search|search\s+or\s+(?:type|enter)|(?:type|enter)\s+(?:an?\s+|web\s+)?(?:address|url)|smart\s+search|url|location\s+bar)\b|^address$/i;
// A URL's query and fragment: where reset links, session ids and one-time
// tokens live. The path is kept; it says which page, and that is enough.
const URL_TAIL = /\b((?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s?#]*)[?#]\S*/gi;
const stripUrls = (s) => s.replace(URL_TAIL, "$1");
// The same test as a yes or no: some URL in the text has a query or a
// fragment. Used where stripping is not an option (the selection).
const HAS_URL_TAIL = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s?#]*[?#]\S/i;
// A line read off the screen has its URLs as they are drawn, and a browser
// draws its address bar's with no scheme ("mail.google.com/mail/u/0?tok=…"),
// which URL_TAIL does not see: a host name with a dot, then a query.
const BARE_URL_TAIL = /\b((?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s?#]*)?)[?#]\S+/gi;
const stripLineUrls = (s) => stripUrls(s).replace(BARE_URL_TAIL, "$1");
// A line read off the screen with an address in it, as a browser's bar draws
// one: with a scheme, from www., or a host name with a dot and then a path, a
// query or a fragment ("mail.google.com/mail/u/0?tok=…").
const URL_LINE = /\b(?:[a-z][a-z0-9+.-]*:\/\/\S|www\.\S|(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?[/?#])/i;

/**
 * The snapshot's elements as the server takes them: id, role, label, short
 * value, region and the state flags — and nothing that says where on the
 * screen they are (no frame, ever). A password field keeps its place in the
 * list, so the model can say "type it there", but never a value. A window's
 * label is its title, which is exactly what must not leave, so a window goes
 * without one. An address bar goes without its value — the whole URL of the
 * page, logged-in links and all — and every other URL loses its query.
 *
 * A line read off the window's picture (an `o` id) goes as text: its words
 * and its region, nothing else. The tree's elements come first, so on a
 * screen with more than the cap it is the lines that are left out; and the
 * lines stop once the screen would measure more than `chars` (SCREEN_CHARS)
 * as the server counts it. The tree is never cut for that.
 */
function toRequestElements(snapshot, max = MAX_ELEMENTS, chars = SCREEN_CHARS) {
  const cap = Math.max(0, Math.min(MAX_ELEMENTS, Number.isFinite(max) ? Math.floor(max) : MAX_ELEMENTS));
  const budget = Number.isFinite(chars) ? chars : SCREEN_CHARS;
  const win = snapshot && snapshot.window && snapshot.window.frame;
  const focusedId = snapshot && snapshot.focused;
  const seen = new Set();
  const out = [];
  let used = 0;
  let linesFull = false;
  for (const e of elementsOf(snapshot)) {
    if (out.length >= cap) break;
    const id = str(e.id);
    if (!/^[eo]\d+$/.test(id) || seen.has(id)) continue;
    // An o id is only ever a line this file made; one on anything else is not.
    if ((id[0] === "o") !== (e.ocr === true)) continue;
    seen.add(id);
    if (e.ocr === true) {
      if (linesFull) continue;
      const label = clip(stripLineUrls(squash(e.label)), 80);
      if (!label) continue;
      const el = { id, role: "text", label };
      const region = regionOf(e.frame, win);
      if (region) el.region = region;
      // The lines come top to bottom; the first that does not fit ends them,
      // so what goes is the top of the page, not a scatter of short lines.
      if (used + promptChars(el) > budget) { linesFull = true; continue; }
      used += promptChars(el);
      out.push(el);
      continue;
    }
    const role = clip(squash(e.role), 20) || "text";
    const el = { id, role };
    const label = role === "window" ? "" : clip(stripUrls(squash(e.label)), 80);
    if (label) el.label = label;
    const addressBar = (role === "field" || role === "combo") && ADDRESS_BAR.test(squash(e.label));
    if (!e.secure && !addressBar && (typeof e.value === "string" || typeof e.value === "number")) {
      const value = clip(stripUrls(squash(e.value)), 120);
      if (value) el.value = value;
    }
    const region = regionOf(e.frame, win);
    if (region) el.region = region;
    if (e.focused === true || id === focusedId) el.focused = true;
    if (e.disabled === true) el.disabled = true;
    if (e.selected === true) el.selected = true;
    if (typeof e.checked === "boolean") el.checked = e.checked;
    used += promptChars(el);
    out.push(el);
  }
  return out;
}

/** An element's length in the server's prompt: its line there
 *  (`e12 button "Search" @t ="…" focused`) and the line break after it,
 *  which is what AGENT_SCREEN_MAX_CHARS counts. */
function promptChars(el) {
  let n = el.id.length + 1 + el.role.length + 1;
  if (el.label) n += el.label.length + 3;
  if (el.region) n += el.region.length + 2;
  if (el.value) n += el.value.length + 4;
  if (el.focused) n += 8;
  if (el.disabled) n += 9;
  if (el.selected) n += 9;
  if (el.checked === true) n += 8;
  if (el.checked === false) n += 10;
  return n;
}

module.exports = { MAX_ELEMENTS, SCREEN_CHARS, regionOf, frameMap, ADDRESS_BAR, stripUrls, HAS_URL_TAIL, URL_LINE, toRequestElements };
