// THE WHOLE PAGE, NOT ONLY THE PART ON SCREEN.
//
// An answer about "where you are" has to understand the whole page, document,
// thread or sheet, not only what the window shows. Two kinds of looking are
// kept apart: what is on screen now (the agent's snapshot, the only thing it
// ever acts on) and the whole thing being looked at (this file, read for
// understanding and never acted on).
//
//   tree    the helper's "page" (driver.page): the focused window's text from
//           its accessibility tree, the parts out of sight included, without
//           scrolling. Cheap; tried first.
//   scroll  only when the tree came back empty or thin and the question needs
//           the whole thing ("summarise this", "find X here"): for apps that
//           draw their text as pixels (Google Docs, some PDFs, Figma), the
//           window under the pointer is scrolled a screen at a time and each
//           screen read on this computer (screenRead.ocrWindow; no picture
//           leaves it), the overlap between screens dropped, down to the end
//           and then up to the top, within caps of screens, characters and
//           time; then scrolled back to where the person was, and checked.
//           Never while a dictation records, never in a sensitive app (nor a
//           private window while the server has them off), never when the
//           pointer is not over the window.
//
// What goes to the server is cut to a hard cap: the outline (the headings),
// then the part around where the person is, then the rest. The server picks
// what the question needs from that.

const K = require("../../knobs.js");
const frontApp = require("./frontApp.js");

const NONE = Object.freeze({ outline: [], text: "", where: "", source: "none", truncated: false });
/** One wheel call moves at most this many lines (the drivers clamp to it). */
const WHEEL_MAX = 40;

// ---- needsWhole -----------------------------------------------------------------

/** Words that ask about the whole thing, not only the part on screen: English,
 *  Hinglish (Hindi in Latin letters), and Hindi. */
const WHOLE = [
  /\b(?:summari[sz]e|summary|sum (?:it |this )?up|tl;?dr|gist|overview|recap|whole|entire|full|all of (?:it|this)|everything|page|document|doc|article|thread|spreadsheet|sheet|pdf|find|search|look for|locate|anywhere|mention(?:s|ed)?|where does it say)\b/i,
  /\b(?:poor[aie]|pur[ai]|saar[aie]|sab ?kuch|summary (?:do|de|dedo|batao|bata)|khoj(?:o|na)?|dhoon?d?h?(?:o|na)|dhun?d?h?(?:o|na)|kahan likha|is (?:page|doc|document|pdf|sheet) (?:me|mein|mai|par|pe))\b/i,
  /पूरा|पूरी|पूरे|सारा|सारी|सारे|सारांश|पेज|पृष्ठ|दस्तावेज|डॉक्यूमेंट|खोजो|खोजें|ढूंढो|ढूँढो|ढूंढें|सब कुछ/,
];

/** True when the words ask about the whole page, so the slower read a screen
 *  at a time may run when the tree has little. Free: words only. */
function needsWhole(words) {
  const s = typeof words === "string" ? words : "";
  return !!s.trim() && WHOLE.some((re) => re.test(s));
}

// ---- lines ------------------------------------------------------------------------

/** Lines as they are compared: case, spacing and stray marks aside. */
const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function splitLines(text) {
  return String(text || "").split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
}

/** How many lines the end of `above` and the start of `below` share. */
function overlap(above, below) {
  for (let k = Math.min(above.length, below.length); k > 0; k--) {
    let same = true;
    for (let i = 0; i < k && same; i++) same = norm(above[above.length - k + i]) === norm(below[i]);
    if (same) return k;
  }
  return 0;
}

/** Where `want` (the first screen) is from the screen now, in lines: 0 there,
 *  more than 0 when the view is above it (scroll down), less than 0 when below
 *  it (scroll up), null when the two cannot be matched. */
function offsetFrom(want, cur) {
  if (!want.length || !cur.length) return null;
  const w = want.map(norm);
  const c = cur.map(norm);
  if (w[0] === c[0]) return 0;
  const i = c.indexOf(w[0]);
  if (i > 0) return i;
  const j = w.indexOf(c[0]);
  if (j > 0) return -j;
  return null;
}

// A URL's query and fragment, as screen.js strips them: where reset links,
// session ids and one-time tokens live. The path is kept.
const URL_TAIL = /\b((?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s?#]*)[?#]\S*/gi;
const BARE_URL_TAIL = /\b((?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s?#]*)?)[?#]\S+/gi;
const stripUrls = (s) => s.replace(URL_TAIL, "$1").replace(BARE_URL_TAIL, "$1");

// ---- the read a screen at a time ------------------------------------------------

/**
 * The page read by scrolling the window a screen at a time and reading each
 * screen's picture. Returns { lines, whereLine, truncated, restored } or null
 * when nothing could be read. Scrolls back to where the person was before it
 * returns, whatever stopped it.
 */
async function scrollRead(d, info, limits) {
  const L = limits;
  const now = typeof d.now === "function" ? d.now : Date.now;
  const sleep = typeof d.sleep === "function" ? d.sleep : (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
  const dictating = () => { try { return !!(d.dictating && d.dictating()); } catch { return true; } };
  const read = async () => { try { return splitLines(await d.ocr(info)); } catch { return []; } };
  const wheel = async (dir, n) => { try { const r = await d.scroll(dir, n); return !!r && r.ok !== false; } catch { return false; } };
  const t0 = now();

  const first = await read();
  if (!first.length) return null;

  // The window's own lines (a toolbar above, a status bar below) are the same
  // on every screen: learnt from the first two screens that differ, and taken
  // off every screen.
  let headSet = null;
  let tailSet = null;
  const strip = (lines) => {
    if (!headSet) return lines.slice();
    let a = 0;
    let b = lines.length;
    while (a < b && headSet.has(norm(lines[a]))) a++;
    while (b > a && tailSet.has(norm(lines[b - 1]))) b--;
    return lines.slice(a, b);
  };
  let doc = first.slice();
  let start = 0; // where the first screen's first line is in doc
  function learn(a, b) {
    if (headSet) return;
    let p = 0;
    while (p < a.length && p < b.length && norm(a[p]) === norm(b[p])) p++;
    if (p >= Math.min(a.length, b.length)) return; // the same screen: nothing to learn
    let q = 0;
    while (q < a.length - p && q < b.length - p && norm(a[a.length - 1 - q]) === norm(b[b.length - 1 - q])) q++;
    headSet = new Set(a.slice(0, p).map(norm));
    tailSet = new Set(a.slice(a.length - q).map(norm));
    doc = strip(doc); // only the first screen is in it yet
  }

  /** New lines of `body` below the page so far; how many. */
  function below(body) {
    const k = overlap(doc, body);
    let fresh = body.slice(k);
    if (!k) {
      const seen = new Set(doc.slice(-body.length * 2).map(norm));
      fresh = body.filter((l) => !seen.has(norm(l)));
    }
    doc.push(...fresh);
    return fresh.length;
  }
  /** New lines of `body` above the page so far; how many. */
  function above(body) {
    const k = overlap(body, doc);
    let fresh = body.slice(0, body.length - k);
    if (!k) {
      const seen = new Set(doc.slice(0, body.length * 2).map(norm));
      fresh = body.filter((l) => !seen.has(norm(l)));
    }
    doc.unshift(...fresh);
    start += fresh.length;
    return fresh.length;
  }

  let pos = 0;      // wheel lines down from where the person was, as far as can be told
  let full = 0;     // lines of text one whole step moves
  let screens = 1;
  let capped = false;
  let stopped = false;
  const chars = () => doc.reduce((n, l) => n + l.length + 1, 0);

  async function phase(dir) {
    const sign = dir === "down" ? 1 : -1;
    let prev = first;
    for (;;) {
      if (screens >= L.maxScreens || chars() >= L.maxChars || now() - t0 >= L.maxMs) { capped = true; return; }
      if (dictating()) { stopped = true; return; }
      if (!(await wheel(dir, L.lines))) { stopped = true; return; }
      pos += sign * L.lines;
      await sleep(L.settleMs);
      const cur = await read();
      screens++;
      learn(prev, cur);
      const moved = dir === "down" ? below(strip(cur)) : above(strip(cur));
      if (moved === 0) { pos -= sign * L.lines; return; } // the end: that step moved nothing
      // A step that moved less than a whole one met the end part way.
      if (full && moved < full) pos -= sign * (L.lines - Math.round((L.lines * moved) / full));
      full = Math.max(full, moved);
      prev = cur;
    }
  }

  /** Back to the first screen: the wheel lines counted, then checked against
   *  that screen and put right a line or two at a time. True when it matches. */
  async function back() {
    if (pos === 0) return true;
    const dir = pos > 0 ? "up" : "down";
    for (let left = Math.abs(pos); left > 0; left -= WHEEL_MAX) await wheel(dir, Math.min(WHEEL_MAX, left));
    pos = 0;
    await sleep(L.settleMs);
    const want = strip(first);
    for (let i = 0; ; i++) {
      const off = offsetFrom(want, strip(await read()));
      if (off === 0) return true;
      if (off == null || i >= L.restoreTries) return false;
      const n = Math.max(1, Math.min(WHEEL_MAX, Math.round(Math.abs(off) * (full ? L.lines / full : 1))));
      await wheel(off > 0 ? "down" : "up", n);
      await sleep(L.settleMs);
    }
  }

  let restored = true;
  try {
    await phase("down");
    if (!capped && !stopped) {
      restored = await back();
      // Up from where they are only once back there: the overlap is matched
      // against the first screen.
      if (restored) await phase("up");
    }
  } finally {
    restored = (await back()) && restored;
  }
  return { lines: doc, whereLine: start, truncated: capped, restored, screens };
}

// ---- reduce -------------------------------------------------------------------------

/**
 * The page as the server takes it, within `cap` characters (outline and text
 * together): the outline first, then the start of the page, then outward from
 * where the person is, nearer lines first; what is left out is marked "…".
 * page: { lines, headings, whereLine, where, source, truncated }.
 */
function reducePage(page, cap) {
  const max = Math.max(500, Math.round(Number(cap) || 20000));
  const lines = (page.lines || []).map((l) => stripUrls(String(l))).filter(Boolean);
  const outline = [];
  let used = 0;
  const outlineMax = Math.min(K.num("desktop.page.outlineChars", 3000), Math.floor(max / 4));
  for (const h of page.headings || []) {
    const line = stripUrls("#".repeat(h.level) + " " + h.text);
    if (used + line.length + 1 > outlineMax) break;
    outline.push(line);
    used += line.length + 1;
  }
  const budget = max - used;
  const w = Math.max(0, Math.min(lines.length - 1, Number.isInteger(page.whereLine) ? page.whereLine : 0));
  const where = stripUrls(String(page.where || lines[w] || "")).slice(0, 200);
  const whole = lines.join("\n");
  if (whole.length <= budget) {
    return { outline, text: whole, where, source: page.source, truncated: !!page.truncated };
  }
  const keep = new Uint8Array(lines.length);
  let left = budget;
  const take = (i) => {
    if (keep[i]) return true;
    const n = lines[i].length + 2; // the line, its newline, room for a "…" before it
    if (n > left) return false;
    keep[i] = 1;
    left -= n;
    return true;
  };
  // The start: what the page is.
  let head = Math.min(K.num("desktop.page.headChars", 1500), Math.floor(budget / 5));
  for (let i = 0; i < lines.length && head >= lines[i].length + 2; i++) { head -= lines[i].length + 2; take(i); }
  // Then outward from where they are, a line below and a line above in turn.
  let lo = w - 1;
  let hi = w;
  while (lo >= 0 || hi < lines.length) {
    let more = false;
    if (hi < lines.length) { if (take(hi)) { hi++; more = true; } else hi = lines.length; }
    if (lo >= 0) { if (take(lo)) { lo--; more = true; } else lo = -1; }
    if (!more) break;
  }
  const out = [];
  let gap = false;
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) { gap = true; continue; }
    if (gap && out.length) out.push("…");
    out.push(lines[i]);
    gap = false;
  }
  if (gap) out.push("…");
  return { outline, text: out.join("\n").slice(0, budget), where, source: page.source, truncated: true };
}

// ---- readPage -------------------------------------------------------------------------

/** "private" or "sensitive" for a window that must not be read, by its
 *  title and app name; "" otherwise. A private window is read like any
 *  other unless the server has them off (frontApp.privateWindowsOk). */
function refusal(name, title) {
  if (title && frontApp.isPrivate(title) && !frontApp.privateWindowsOk()) return "private";
  if ((name && frontApp.looksSensitive(name)) || (title && frontApp.looksSensitive(title))) return "sensitive";
  return "";
}

/** The line of `lines` the person is at: by the helper's offset into its
 *  text, else by the line it named. */
function whereLineOf(tree, lines) {
  if (tree.whereOffset >= 0) {
    const before = tree.text.slice(0, tree.whereOffset);
    return splitLines(before).length - (/\n\s*$/.test(before) || !before ? 0 : 1);
  }
  const key = norm(tree.approxWhere).slice(0, 40);
  if (key) {
    const i = lines.findIndex((l) => norm(l).startsWith(key));
    if (i >= 0) return i;
  }
  return 0;
}

/**
 * The whole page in front, for understanding it.
 *
 * deps:
 *   front()            the window in front (frontApp.frontInfo): { private, sensitive, title } or null
 *   page(opts)         the helper's page read (driver.page)
 *   scroll(dir, lines) one wheel step under the pointer (driver.scroll(null, …))
 *   ocr(info)          the window's text read from its picture on this computer
 *   dictating()        true while a dictation records
 *   canScroll(tree)    whether a scroll would reach this window (the pointer over it);
 *                      without it, never
 *   now(), sleep(ms), log(line)   for the tests
 *
 * opts: { question, needWhole } — needWhole defaults to needsWhole(question).
 * Resolves { outline, text, where, source: "tree"|"scroll"|"none", truncated };
 * never rejects.
 */
async function readPage(deps, opts) {
  const d = deps || {};
  const o = opts || {};
  const log = (line) => { try { if (typeof d.log === "function") d.log(line); } catch { /* a logger must not stop a read */ } };
  const question = typeof o.question === "string" ? o.question : "";
  const whole = typeof o.needWhole === "boolean" ? o.needWhole : needsWhole(question);
  try {
    const info = typeof d.front === "function" ? await d.front() : null;
    if (frontApp.offLimits(info)) return { ...NONE };

    let tree = null;
    if (typeof d.page === "function") {
      const r = await d.page({ chars: K.num("desktop.page.treeChars", 40000), budgetMs: K.num("desktop.page.treeBudgetMs", 1200) });
      if (r && r.ok === true && typeof r.text === "string") {
        const why = refusal(r.app && r.app.name, r.window && r.window.title);
        if (why) { log(`page: not read (${why})`); return { ...NONE }; }
        tree = r;
      }
    }
    const treeLines = tree ? splitLines(tree.text) : [];
    const treeChars = treeLines.reduce((n, l) => n + l.length + 1, 0);
    let page = treeLines.length ? {
      lines: treeLines, headings: tree.headings || [], whereLine: whereLineOf(tree, treeLines),
      where: tree.approxWhere || "", source: "tree", truncated: !!tree.truncated,
    } : null;

    const thin = treeChars < K.num("desktop.page.minChars", 400);
    if (thin && whole && K.bool("desktop.page.scroll", true) && typeof d.scroll === "function" && typeof d.ocr === "function"
      && typeof d.canScroll === "function" && !(typeof d.dictating === "function" && d.dictating())) {
      if (await d.canScroll(tree)) {
        const got = await scrollRead(d, info, {
          lines: Math.max(1, Math.min(WHEEL_MAX, Math.round(K.num("desktop.page.scrollLines", 8)))),
          maxScreens: K.num("desktop.page.maxScreens", 12),
          maxChars: K.num("desktop.page.maxChars", 60000),
          maxMs: K.num("desktop.page.maxMs", 12000),
          settleMs: K.num("desktop.page.settleMs", 250),
          restoreTries: K.num("desktop.page.restoreTries", 3),
        });
        if (got) {
          log(`page: ${got.screens} screen(s), ${got.lines.length} lines${got.restored ? "" : ", not back where it was"}`);
          const n = got.lines.reduce((s, l) => s + l.length + 1, 0);
          if (n > treeChars) page = { lines: got.lines, headings: [], whereLine: got.whereLine, where: "", source: "scroll", truncated: got.truncated };
        }
      }
    }
    if (!page) return { ...NONE };
    return reducePage(page, K.num("desktop.page.sendChars", 20000));
  } catch (e) {
    log(`page: failed (${(e && e.message) || e})`);
    return { ...NONE };
  }
}

/**
 * The real dependencies, for main.js (talk mode) and ask.js: the driver's
 * page read and its scroll, screenRead's picture read, frontApp's flags.
 * `dictating()` says whether a dictation records now. A scroll goes to what
 * is under the pointer, so the read a screen at a time runs only when the
 * pointer is over the window the page came from.
 */
function pageDeps({ driver, dictating } = {}) {
  return {
    front: () => frontApp.frontInfo(),
    page: (o) => (driver && typeof driver.page === "function" ? driver.page(o) : Promise.resolve({ ok: false, error: "unsupported" })),
    scroll: (dir, lines) => driver.scroll(null, dir, lines),
    ocr: (info) => require("./screenRead.js").ocrWindow(info, {
      maxSide: K.num("desktop.page.ocrMaxSide", 1600), timeoutMs: K.num("desktop.page.ocrTimeoutMs", 3000),
    }),
    dictating: typeof dictating === "function" ? dictating : () => false,
    canScroll: (tree) => pointerOver(tree),
  };
}

/** Whether the pointer is over the page's window (its frame, in the driver's
 *  units: Windows' are physical pixels). */
function pointerOver(tree) {
  const f = tree && tree.window && tree.window.frame;
  if (!Array.isArray(f) || f.length !== 4) return false;
  try {
    const { screen } = require("electron");
    let p = screen.getCursorScreenPoint();
    if (tree.scale === "pixels" && typeof screen.dipToScreenPoint === "function") p = screen.dipToScreenPoint(p);
    return p.x >= f[0] && p.x < f[0] + f[2] && p.y >= f[1] && p.y < f[1] + f[3];
  } catch {
    return false;
  }
}

module.exports = { readPage, needsWhole, reducePage, pageDeps, splitLines, overlap, offsetFrom };
