// TAILZU ASK: THE RUN ON THIS COMPUTER.
//
// Alt twice, a sentence about the app in front ("where's export?", "turn on
// captions", "open #design and tell them the mockups are ready"), and Blip
// points at the thing, explains it, or does a small job. The server is a
// stateless planner that answers one step at a time; everything that has to be
// trusted lives here:
//
//   the screen  read as an accessibility tree (driver.js) into a short list of
//               elements. Roles, labels, short values and a coarse region tag
//               leave this computer; frames, pixels and window titles do not.
//               The server answers with element ids and the frames are looked
//               up here, in a map that belongs to the snapshot it was sent.
//   the risk    the server sends one with every action, and this file works it
//               out again and takes the higher. A model talked into calling
//               "Send" free does not get to send anything without a yes.
//   the loop    post a step, hand its events to the guide as they stream in,
//               run at most one action, let the app settle, read the screen
//               again, say what changed, and go round — until the server says
//               done, or a stop: too many steps, too long, the same thing twice
//               to no effect, Esc.
//
// The screen is read twice at Alt twice, while they are still speaking: the
// tree, and a look at the window (driver.look) — its picture, and the text in
// it read by the system's own OCR, each line with its place. The lines join
// the tree as elements of their own (o1, o2…), so a label drawn on a canvas
// or a web page with no accessibility can still be named and pointed at. Then
// three ways to answer, cheapest first:
//
//   instant     "where's Export?" matched here, against the labels and the
//               lines (resolver.js): the ring, "Here's Export.", done, with no
//               request at all. The ring is up, tentatively, while they are
//               still saying it (preview).
//   picture     a question about something drawn ("explain this equation",
//               "what does this chart show"): ONE cropped picture of it goes
//               with the question, only with their permission for this app,
//               and the card says it went. Never from a private window or a
//               sensitive app; the window's picture is checked like its tree.
//   text        everything else, as before; with the live caption's words
//               as the utterance when there are some, so the server has
//               nothing to transcribe.
//
// The answer may draw while it explains, the way a teacher uses a pen: a
// circle on part of a diagram, an arrow from a label to what it names, the
// places to click numbered in order. A mark names what it is on the way a
// point does, by an id of this screen, or, on a run that sent a picture, by
// a place in that picture (0–1000 across and down it). Both are turned into
// screen positions here, from frames and the picture's own region that never
// left this computer, and nothing new goes back. Marks belong to the screen
// they were drawn on, so they are cleared before anything changes it.
//
// Pure logic with every dependency injected (the driver, the guide window, the
// network, the clipboard paste, the microphone, the clock, the picture's crop
// and its permission), so a whole run can be played in a test without
// Electron, a screen or a server.

const crypto = require("crypto");
const frontApp = require("./frontApp.js");
const resolver = require("./resolver.js");

/** The server takes this many elements and answers 413 above it. */
const MAX_ELEMENTS = 250;
/** The server also measures the screen as its prompt carries it, a line an
 *  element, and answers 413 for the whole step above AGENT_SCREEN_MAX_CHARS
 *  (24,000 by default). A page of text read off the window line by line fills
 *  the element list with lines of 80 characters and goes past that, so the
 *  lines are only added while the screen stays this far inside it: such a
 *  page goes with its first lines rather than not at all. */
const SCREEN_CHARS = 20000;
/** History the server takes, oldest first. Older turns fall off the front. */
const MAX_HISTORY = 16;
/** A run that has not finished in this long is stopped: a loop that keeps
 *  "almost" getting there costs a request a step and holds the guide up. */
const RUN_DEADLINE_MS = 60000;
/** The driver resolves within the timeout it is given, so a little more than
 *  that here only ever catches a driver that broke its promise. */
const SNAPSHOT_GRACE_MS = 250;
/** How far one SCROLL goes, in lines. The protocol carries only a direction. */
const SCROLL_LINES = 5;
/** A finished answer's card waits for its voice to finish before its doneMs
 *  starts, but never longer than this: a voice that never says it has
 *  finished does not hold the card up for good. */
const SPEECH_MAX_MS = 180000;
/** The server takes a picture up to this size (AGENT_IMAGE_MAX_BYTES) and
 *  answers 413 above it; a crop that big is not sent at all. */
const MAX_PICTURE_BYTES = 2000000;
/** "The largest image" on screen has to be at least this big to be the
 *  picture: smaller is an icon or an avatar, and the window says more. */
const MIN_PICTURE = [120, 80];
/** The least a picture of one element is, in the look's own pixels, on each
 *  side: an icon on a big window, in a look brought down to fit, is a few
 *  pixels there, too small to crop (ask.js crop wants 8) or to make anything
 *  of. Its frame is grown about its middle to this. */
const MIN_CROP_PX = 32;
/** A place in the picture is 0 to this, across it and down it. */
const PICTURE_UNITS = 1000;
/** A box, circle, underline or highlight at a place in the picture rather
 *  than around something: it goes around this much of the picture's shorter
 *  side (in thousandths), centred on the place. Big enough to see, small
 *  enough to say which spot. */
const POINT_MARK = 40;
/** A mark's label, as the server cuts it. */
const LABEL_MAX = 48;
/** A path's points, as the server allows them. */
const PATH_MAX = 32;
const DRAW_KINDS = new Set(["box", "circle", "underline", "highlight", "arrow", "number", "label", "path"]);
/** The kinds drawn around (or under) a frame. */
const FRAMED = new Set(["box", "circle", "underline", "highlight"]);

const TERMINAL = new Set(["action", "ask", "done", "error", "look", "approve"]);
const ACTION_KINDS = new Set(["press", "set", "type", "key", "scroll", "focus", "open"]);
/** Actions that mean nothing without an element. */
const NEEDS_ID = new Set(["press", "set", "focus"]);
const SCROLL_DIRS = new Set(["up", "down", "left", "right"]);

// What the guide says when the run stops on this side. Short, because they
// appear in a card beside a one-eyed character, and plain, because they are
// what someone reads when something did NOT happen.
const TEXT = {
  private: "Ask doesn't look at private windows.",
  sensitive: "Ask doesn't look at this app.",
  declined: "Okay, I left it.",
  steps: "I stopped there: that was taking too many steps.",
  deadline: "I stopped there: that was taking too long.",
  stuck: "That didn't change anything, so I stopped.",
  loop: "I was going round in circles, so I stopped.",
  blocked: "I'll stop here: I don't look at this app.",
  blockedPrivate: "I'll stop here: I don't look at private windows.",
  network: "Couldn't reach Tailzu.",
  incomplete: "The answer was cut off. Try again?",
  failed: "Something went wrong.",
  signIn: "Sign in to Tailzu to use Ask.",
  needLook: "I'd have to see the picture to answer that, and I can't look at it here.",
  // A Mac that has not let Tailzu see the screen (Screen Recording), with a
  // button on the card to that page of System Settings (guide offer).
  needScreen: "I'd have to see the picture to answer that, and this Mac hasn't let Tailzu see the screen. Turn on Tailzu in System Settings, Privacy & Security, Screen Recording.",
  looking: "Looking",
  pictureSent: "1 picture sent",
};

// ---- the server's "open" event ---------------------------------------------------

/** Longest link the server's `open` event may carry: a mail draft or a message, not a download. */
const OPEN_URL_MAX = 8000;
/** The only parts of a mailto: link that are an email. `attach` and the like are not. */
const MAILTO_FIELDS = new Set(["to", "cc", "bcc", "subject", "body"]);

/**
 * The https hand-offs an `open` may carry, each a site's own link to write a
 * message, share, search or set a route for the person to finish there: its
 * exact host and the path it is under. A path ending in / is a prefix; any
 * other is that path or one below it (/search and /search/x, never /searchx).
 * Maps links are only Google's documented form (api=1). Phone-only links
 * (upi:, tel:, sms:) are never here: the server keeps them for the phone.
 */
const OPEN_LINKS = [
  { host: "mail.google.com", path: "/mail/" },             // Gmail compose
  { host: "wa.me", path: "/" },                            // WhatsApp chat or share
  { host: "api.whatsapp.com", path: "/send" },
  { host: "t.me", path: "/share/url" },                    // Telegram share (a t.me/<username> chat is below)
  { host: "www.google.com", path: "/maps/dir", query: ["api", "1"] },
  { host: "www.google.com", path: "/maps/search", query: ["api", "1"] },
  { host: "m.uber.com", path: "/ul" },
  { host: "www.amazon.in", path: "/s" },
  { host: "www.flipkart.com", path: "/search" },
  { host: "www.youtube.com", path: "/results" },
  { host: "music.youtube.com", path: "/search" },
  { host: "open.spotify.com", path: "/search" },
  { host: "www.threads.net", path: "/intent/post" },
  { host: "www.threads.com", path: "/intent/post" },
  { host: "www.booking.com", path: "/searchresults.html" },
];
/** A Telegram username as a t.me path: a letter, then letters, digits or _, 4 to 32 in all. */
const TELEGRAM_USER = /^\/([A-Za-z][A-Za-z0-9_]{3,31})\/?$/;
/** t.me's own pages, which are no one's username: they join, log in, pay or set a proxy. */
const TELEGRAM_PAGES = new Set([
  "share", "proxy", "socks", "joinchat", "login", "confirmphone", "setlanguage", "addstickers", "addemoji",
  "addtheme", "addlist", "invoice", "giftcode", "boost", "contact", "premium", "stars", "nft",
]);

const under = (pathname, path) => path.endsWith("/") ? pathname.startsWith(path) : pathname === path || pathname.startsWith(path + "/");

/** A t.me/<username> link: that chat, with at most a message written in (`text`), and nothing it does by itself. */
function telegramChat(u) {
  const m = TELEGRAM_USER.exec(u.pathname);
  if (!m || TELEGRAM_PAGES.has(m[1].toLowerCase())) return false;
  for (const k of u.searchParams.keys()) if (k !== "text") return false;
  return true;
}

/**
 * The link the server's `open` event may open on this computer, or null.
 * An https hand-off in OPEN_LINKS (exact host and path, no credentials or
 * port), a t.me/<username> chat, or a mailto: link carrying only mail fields.
 * Anything else, whatever the server says, is dropped, so an `open` can write
 * a message, a search or a route for the person to finish, and can never
 * launch a program, a file, a payment, a call or any other site.
 */
function safeOpenUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > OPEN_URL_MAX) return null;
  if (/[\u0000-\u0020\u007f]/.test(raw)) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol === "https:") {
    if (u.username || u.password || u.port) return null;
    const link = OPEN_LINKS.find((l) => l.host === u.hostname && under(u.pathname, l.path)
      && (!l.query || u.searchParams.get(l.query[0]) === l.query[1]));
    return link || (u.hostname === "t.me" && telegramChat(u)) ? u.href : null;
  }
  if (u.protocol === "mailto:") {
    for (const k of u.searchParams.keys()) if (!MAILTO_FIELDS.has(k.toLowerCase())) return null;
    return u.pathname ? u.href : null;
  }
  return null;
}

// ---- the server's confirm card ------------------------------------------------

/** The only routes a confirm card's button may call: a task's yes or no. */
const TASK_ROUTE = /^\/v1\/tasks\/([A-Za-z0-9_-]{1,64})\/(approve|deny)$/;
const isTaskRoute = (path) => TASK_ROUTE.test(str(path));
const CARD_BUTTONS = ["approve", "edit", "deny"];

/**
 * The card of an `approve` event, kept to what the guide may draw and the
 * routes it may call: the server's words (cut to what a card holds), and for
 * each button the one route it names, which must be this task's own approve
 * or deny. Null when it has no card, no way to say yes or no, or a route that
 * is not that: nothing is then asked, and nothing is called.
 */
function approvalOf(ev) {
  const c = ev && ev.card;
  if (!c || typeof c !== "object") return null;
  const taskId = str(ev.taskId);
  const buttons = [];
  for (const b of Array.isArray(c.buttons) ? c.buttons : []) {
    if (!b || typeof b !== "object" || !CARD_BUTTONS.includes(b.id) || buttons.some((x) => x.id === b.id)) continue;
    const label = clip(squash(b.label), 40);
    const call = b.call && typeof b.call === "object" ? b.call : {};
    const m = TASK_ROUTE.exec(str(call.path));
    if (!label || call.method !== "POST" || !m || m[1] !== taskId) continue;
    // The yes names its approval; no other body goes anywhere.
    const approvalId = call.body && typeof call.body === "object" ? str(call.body.approvalId) : "";
    if ((m[2] === "approve") !== (b.id === "approve")) continue;
    buttons.push({ id: b.id, label, call: { method: "POST", path: m[0], body: approvalId ? { approvalId: clip(approvalId, 64) } : {} }, then: b.then === "listen" });
  }
  const yes = buttons.find((b) => b.id === "approve");
  const no = buttons.find((b) => b.id === "deny");
  const preview = clip(squash(c.preview), 400);
  if (!yes || !no || !preview) return null;
  const after = c.after && typeof c.after === "object" ? c.after : {};
  const w = (v, n) => clip(squash(v), n);
  return {
    title: w(c.title, 80), app: w(c.app, 60), label: w(c.label, 60), preview, note: w(c.note, 200),
    buttons,
    after: { done: w(after.done, 60), left: w(after.left, 120), failed: w(after.failed, 120), change: w(after.change, 120) },
  };
}

// ---- small helpers ----------------------------------------------------------

const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const squash = (v) => str(v).replace(/\s+/g, " ").trim();
/** Cut to n characters, with an ellipsis that says it was cut. */
function clip(v, n) {
  const s = str(v);
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s;
}
const errText = (e) => clip(squash((e && e.message) || e || "error"), 120);

function isFrame(f) {
  return Array.isArray(f) && f.length === 4 && f.every((n) => typeof n === "number" && Number.isFinite(n));
}

function elementsOf(snapshot) {
  return snapshot && snapshot.ok !== false && Array.isArray(snapshot.elements)
    ? snapshot.elements.filter((e) => e && typeof e === "object")
    : [];
}
/** The accessibility tree's elements, without the lines read off a picture. */
const treeOf = (snapshot) => elementsOf(snapshot).filter((e) => e.ocr !== true);

/** The element with keyboard focus: the one the snapshot names, or the first
 *  one that says so itself. */
function focusedOf(snapshot) {
  const els = elementsOf(snapshot);
  if (snapshot && snapshot.focused) {
    const named = els.find((e) => e.id === snapshot.focused);
    if (named) return named;
  }
  return els.find((e) => e.focused === true) || null;
}

/** A promise that settles with `fallback` if `p` takes longer than `ms`. */
function within(p, ms, fallback) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), Math.max(0, ms)); });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** Any of these, as whole words, in any script: "send" but not "sender",
 *  "post" but not "postpone", "order" but not "ordered list". A letter or
 *  digit on either side means it is part of another word. */
const words = (list) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${list.join("|")})(?![\\p{L}\\p{N}])`, "iu");

/** Apps whose controls are web pages: a page's author writes its
 *  accessibility labels, and they can say anything. */
const BROWSERS = words(["chrome", "chromium", "safari", "edge", "msedge", "firefox", "arc", "brave", "opera", "vivaldi"]);
/** …and the apps built on one (Electron, webviews). Their text boxes are
 *  React or Quill components that only hear typing, not a value set from
 *  outside: a SET there leaves the message empty, or it snaps back. */
const WEB_APPS = words([
  "chrome", "chromium", "safari", "edge", "msedge", "firefox", "arc", "brave", "opera", "vivaldi",
  "slack", "discord", "notion", "whatsapp", "teams", "code", "visual\\s+studio\\s+code", "figma", "linear",
  "obsidian", "electron",
]);

// ---- the screen, as it leaves this computer ---------------------------------

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

// ---- the window's picture -----------------------------------------------------

const areaOf = (f) => Math.max(0, f[2]) * Math.max(0, f[3]);

/** The part two frames share, or null when they do not. */
function intersect(a, b) {
  if (!isFrame(a) || !isFrame(b)) return null;
  const x = Math.max(a[0], b[0]);
  const y = Math.max(a[1], b[1]);
  const r = Math.min(a[0] + a[2], b[0] + b[2]);
  const btm = Math.min(a[1] + a[3], b[1] + b[3]);
  return r > x && btm > y ? [x, y, r - x, btm - y] : null;
}
const overlaps = (a, b) => !!intersect(a, b);
const contains = (f, p) => !!p && p.x >= f[0] && p.x <= f[0] + f[2] && p.y >= f[1] && p.y <= f[1] + f[3];

/** The look and the tree describe the same window: their frames are the same
 *  rectangle, give or take a border (a Windows frame's invisible edge, a
 *  shadow). Not the same, and the focus moved between the two reads: the
 *  lines would be placed in, and the picture taken of, another window.
 *  Every maximized window on a display has the same frame, so the titles
 *  are compared too when both reads have one (one may be the other cut
 *  short). */
function sameWindow(snap, look) {
  const ta = squash(titleOf(snap)).toLowerCase();
  const tb = squash(str(look && look.window && look.window.title).slice(0, 200)).toLowerCase();
  if (ta && tb && !ta.startsWith(tb) && !tb.startsWith(ta)) return false;
  const a = snap && snap.window && snap.window.frame;
  const b = look && look.window && look.window.frame;
  if (!isFrame(a) || !isFrame(b)) return !isFrame(a);
  const both = intersect(a, b);
  const union = areaOf(a) + areaOf(b) - (both ? areaOf(both) : 0);
  return !!both && union > 0 && areaOf(both) / union >= 0.8;
}

/** Text as two readings of the same words compare: case and spaces do not
 *  count, nor which dash or quote mark it was read with (OCR reads an em
 *  dash in a title as a hyphen, a curly quote as a straight one). */
const textKey = (s) => squash(s).replace(/\s+/g, "").toLowerCase()
  .replace(/[\u2010-\u2015\u2212]/g, "-").replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'").replace(/[\u201c-\u201f\u2033]/g, "\"");
const sameText = (a, b) => textKey(a) === textKey(b);
/** A line of OCR over a tree element that scores this much against its label
 *  (resolver.labelScore) is that label read again, a letter misread or a mark
 *  beside it ("Exp0rt", "Export..." for "Export…", "Name:"). Left in, the two
 *  tie for any question that names it, and nothing is pointed at. The
 *  resolver's own bar for a word spelled within a letter. */
const READ_AGAIN = 0.8;

const isAddressBar = (e) => (e.role === "field" || e.role === "combo") && ADDRESS_BAR.test(squash(e.label));

/** The window's title as both reads have it, compared the way OCR text is. */
const titleKeys = (snap, look) => [titleOf(snap), str(look && look.window && look.window.title)]
  .map((t) => textKey(squash(t).slice(0, 200)))
  .filter(Boolean);

/** A line of OCR that is the window's title. A title the window shows cut
 *  short ("Q3 budget — Confid…", or "..." as OCR reads an ellipsis) is part
 *  of it; a line that runs the title together with the toolbar beside it
 *  ("AutoSave Q3 budget.xlsx - Excel Search") still carries it. */
function isTitleLine(text, titles) {
  const key = textKey(text);
  if (!key) return false;
  const cut = key.replace(/(?:…|\.{2,})$/, "");
  return titles.some((t) => t === key || (cut.length >= 8 && t.includes(cut)) || (t.length >= 8 && key.includes(t)));
}

/**
 * The look's OCR lines as elements o1…oN (role "text", the line as label, its
 * frame, ocr: true), to go after the tree's. Left out:
 *
 *   a line that says what a tree element over it already says — the button's
 *   own label, read twice, as near as OCR reads it (READ_AGAIN);
 *   anything over a password field, which may be showing the password, and
 *   over an address bar, the URL whose value the tree keeps to itself;
 *   the window's title, which never leaves this computer, however it is read.
 */
function ocrElements(snap, look) {
  if (!look || look.ok !== true || !Array.isArray(look.lines)) return [];
  const tree = treeOf(snap).filter((e) => isFrame(e.frame));
  const guarded = tree.filter((e) => e.secure === true || isAddressBar(e)).map((e) => e.frame);
  const titles = titleKeys(snap, look);
  const out = [];
  for (const line of look.lines) {
    if (!line || !isFrame(line.frame) || line.frame[2] <= 0 || line.frame[3] <= 0) continue;
    const text = clip(squash(line.text), 120);
    if (!text) continue;
    if (isTitleLine(text, titles)) continue;
    if (guarded.some((f) => overlaps(f, line.frame))) continue;
    if (tree.some((e) => e.label && overlaps(e.frame, line.frame)
      && (sameText(e.label, text) || resolver.labelScore(text, e.label) >= READ_AGAIN))) continue;
    out.push({ id: "o" + (out.length + 1), role: "text", label: text, frame: line.frame.slice(), ocr: true });
  }
  return out;
}

// Containers that can hold a picture the tree has no word for: a canvas, a
// chart drawn in a cell, a diagram in a web page's region.
const PICTURE_HOLDERS = new Set(["group", "area", "cell"]);

/**
 * The part of the window the question is about, as { frame, region }:
 *
 *   the image (or a big, wordless group, area or cell) under the pointer —
 *   "what's this?" said while pointing at it; the smallest, if they nest;
 *   else the largest image on screen, if it is at least MIN_PICTURE;
 *   else the whole window.
 *
 * Frames are kept to the window's, which is all the picture has, below its
 * own chrome (chromeBottom): the title and the page's address never leave as
 * text, and do not leave drawn in a picture either. An element too small to
 * see in the look's picture is grown about its middle to MIN_CROP_PX of it
 * (within the same bounds): cropped as it was, an icon on a 4K window was
 * nothing, and the whole window used to go in its place.
 */
function pictureRegion(screen, look, pointer) {
  const whole = look.window.frame;
  const top = chromeBottom(screen, look);
  const below = [whole[0], top, whole[2], whole[1] + whole[3] - top];
  // A window that is all chrome (a toolbar, a title bar) has nothing below
  // it worth a picture; what there is goes as it is.
  const win = below[3] >= MIN_PICTURE[1] ? below : whole;
  const im = look.image;
  const per = (n, of) => (typeof n === "number" && n > 0 ? Math.ceil(MIN_CROP_PX * of / n) : 0);
  const least = im ? [per(im.width, whole[2]), per(im.height, whole[3])] : [0, 0];
  const element = (f) => ({ frame: grownTo(f, least, win), region: "element" });
  const tree = treeOf(screen).filter((e) => isFrame(e.frame));
  const big = (f) => f[2] >= MIN_PICTURE[0] && f[3] >= MIN_PICTURE[1];
  const wordless = (e) => !squash(e.label) && !squash(e.value);
  if (pointer) {
    const under = [];
    for (const e of tree) {
      const f = intersect(e.frame, win);
      if (!f || !contains(f, pointer)) continue;
      // A sliver is not a picture of anything; an icon is, just.
      if (e.role === "image" ? f[2] >= 16 && f[3] >= 16 : PICTURE_HOLDERS.has(e.role) && wordless(e) && big(f)) under.push(f);
    }
    under.sort((x, y) => areaOf(x) - areaOf(y));
    if (under.length) return element(under[0]);
  }
  const images = tree.filter((e) => e.role === "image").map((e) => intersect(e.frame, win)).filter((f) => f && big(f));
  images.sort((x, y) => areaOf(y) - areaOf(x));
  if (images.length) return element(images[0]);
  return { frame: win.slice(), region: "window" };
}

/** `f` grown about its middle to at least `least` [w, h], kept inside `box`
 *  (never bigger than it); `f` itself when it is that big already. */
function grownTo(f, least, box) {
  const w = Math.min(Math.max(f[2], least[0]), box[2]);
  const h = Math.min(Math.max(f[3], least[1]), box[3]);
  if (w <= f[2] && h <= f[3]) return f;
  const fit = (mid, size, lo, span) => Math.min(Math.max(Math.round(mid - size / 2), lo), lo + span - size);
  return [
    w > f[2] ? fit(f[0] + f[2] / 2, w, box[0], box[2]) : f[0],
    h > f[3] ? fit(f[1] + f[3] / 2, h, box[1], box[3]) : f[1],
    Math.max(w, f[2]), Math.max(h, f[3]),
  ];
}

/**
 * How far down the window its own chrome goes: the title bar, a browser's
 * tabs and its address bar, where the window's title and the page's whole
 * address are drawn. The bottom of the lowest of these in the window's top
 * quarter: an address bar in the tree; an OCR line that reads as the title;
 * where the helper says the title is (`titleFrames`: the Windows helper drops
 * the title's lines before they get here, so this side cannot read them);
 * and, with no address bar in the tree to go by (a screen read off the
 * picture alone, a browser whose bar the walk missed), an OCR line that
 * reads as an address. The window's top when there is none of them.
 */
function chromeBottom(screen, look) {
  const win = look.window.frame;
  const limit = win[1] + win[3] / 4;
  let bottom = win[1];
  const chrome = (f) => {
    if (!isFrame(f) || f[1] >= limit) return false;
    bottom = Math.max(bottom, f[1] + f[3]);
    return true;
  };
  let bar = false;
  for (const e of treeOf(screen)) if (isFrame(e.frame) && isAddressBar(e) && chrome(e.frame)) bar = true;
  for (const f of Array.isArray(look.titleFrames) ? look.titleFrames : []) chrome(f);
  const titles = titleKeys(screen, look);
  for (const line of Array.isArray(look.lines) ? look.lines : []) {
    if (!line || !isFrame(line.frame)) continue;
    if (isTitleLine(line.text, titles) || (!bar && URL_LINE.test(squash(line.text)))) chrome(line.frame);
  }
  return Math.min(bottom, win[1] + win[3]);
}

const hasBytes = (d) => !!(d && (d.length > 0 || d.size > 0 || d.byteLength > 0));
const byteSize = (d) => (d ? (typeof d.size === "number" ? d.size : typeof d.byteLength === "number" ? d.byteLength : d.length || 0) : 0);

// ---- marks on the screen ------------------------------------------------------

const isPair = (p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number" && Number.isFinite(n));
const round2 = (v) => Math.round(v * 100) / 100;
const clampTo = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** A place in the picture (picture units) as a point on the screen (driver
 *  units), through the frame of the region the picture was cropped from:
 *  X = fx + x/1000·fw. Kept inside that region, whatever number came. */
function picturePoint(p, region) {
  const u = (v) => clampTo(v, 0, PICTURE_UNITS) / PICTURE_UNITS;
  return [round2(region[0] + u(p[0]) * region[2]), round2(region[1] + u(p[1]) * region[3])];
}

/** A box in the picture as a frame on the screen, cut to the region; null
 *  when nothing of it is left inside. */
function pictureBox(b, region) {
  const [x0, y0] = picturePoint([b[0], b[1]], region);
  const [x1, y1] = picturePoint([b[0] + Math.max(0, b[2]), b[1] + Math.max(0, b[3])], region);
  return x1 > x0 && y1 > y0 ? [x0, y0, round2(x1 - x0), round2(y1 - y0)] : null;
}

/** A small square frame centred on a point, for a mark that goes around a
 *  frame but was given a place. */
function aroundPoint(pt, region) {
  const size = Math.max(8, (POINT_MARK / PICTURE_UNITS) * Math.min(region[2], region[3]));
  return [round2(pt[0] - size / 2), round2(pt[1] - size / 2), round2(size), round2(size)];
}

/** One spot of a mark: `{ frame }` for an element of this screen or a box in
 *  the picture, `{ point }` for a place in it, or null when it cannot be
 *  placed: an id not on this screen, or a picture spot with no picture. */
function spotOf(spot, frames, region) {
  if (!spot || typeof spot !== "object") return null;
  if (typeof spot.id === "string") {
    const f = frames && typeof frames.get === "function" ? frames.get(spot.id) : null;
    return isFrame(f) ? { frame: f.slice() } : null;
  }
  if (!region) return null;
  if (isPair(spot.pt)) return { point: picturePoint(spot.pt, region) };
  if (isFrame(spot.box)) {
    const f = pictureBox(spot.box, region);
    return f ? { frame: f } : null;
  }
  return null;
}

/** A mark's label as the guide draws it: one line, no control characters.
 *  Only words: anything else in `text` would be drawn as "[object Object]". */
const markLabel = (v) => (typeof v === "string" ? clip(squash(v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")), LABEL_MAX) : "");
const sameGeometry = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * The server's draw event as the guide's mark, in driver units (the guide's
 * side turns them into its own): `{ kind, frame | from/to | at | points,
 * closed?, n?, text? }`. Frames are [x, y, w, h], points [x, y].
 *
 *   an id       the element's frame, from this screen's map (lines read off
 *               the window included); an id not on it drops the mark
 *   a picture   `pt` and `box` are 0–1000 of `region`, the frame of the
 *   spot        picture this run sent, and are kept inside it; with no
 *               picture sent, the mark is dropped
 *
 * A box, circle, underline or highlight given a place rather than a thing
 * goes around a small square there. A number or a label given a place is
 * drawn `at` it. Null for a mark that cannot be drawn as it was meant: a
 * circle somewhere near is worse than none.
 */
function resolveMark(ev, frames, region) {
  if (!ev || typeof ev !== "object" || !DRAW_KINDS.has(ev.kind)) return null;
  const pic = isFrame(region) && region[2] > 0 && region[3] > 0 ? region : null;
  const kind = ev.kind;
  const mark = { kind };
  if (kind === "path") {
    const pts = ev.points;
    if (!pic || !Array.isArray(pts) || pts.length < 2 || pts.length > PATH_MAX || !pts.every(isPair)) return null;
    mark.points = pts.map((p) => picturePoint(p, pic));
    if (ev.closed === true) mark.closed = true;
  } else if (kind === "arrow") {
    const from = spotOf(ev.from, frames, pic);
    const to = spotOf(ev.to, frames, pic);
    if (!from || !to) return null;
    mark.from = from.frame || from.point;
    mark.to = to.frame || to.point;
    // Two ids for the same place (a button and the line of text read off
    // it), or two picture places the clamp has made one: an arrow with no
    // length has no direction to draw its head in.
    if (sameGeometry(mark.from, mark.to)) return null;
  } else {
    const at = spotOf(ev.target, frames, pic);
    if (!at) return null;
    if (at.frame) mark.frame = at.frame;
    else if (FRAMED.has(kind)) mark.frame = aroundPoint(at.point, pic);
    else mark.at = at.point;
    if (kind === "number") {
      if (!Number.isInteger(ev.n) || ev.n < 1 || ev.n > 9) return null;
      mark.n = ev.n;
    }
  }
  const text = markLabel(ev.text);
  if (text) mark.text = text;
  else if (kind === "label") return null;
  return mark;
}

// ---- what changed after an action -------------------------------------------

const keyOf = (e) => str(e.role) + "\u0001" + squash(e.label).toLowerCase();
const printable = (e) => e && e.role !== "window" && squash(e.label) ? `"${clip(squash(e.label), 30)}"` : "";

function sameFrame(a, b) {
  if (!isFrame(a) || !isFrame(b)) return !isFrame(a) && !isFrame(b);
  return a.every((v, i) => Math.abs(v - b[i]) <= 2);
}

/**
 * One short line for the history's `note`: what the action did to the
 * screen, so the next step plans from what happened rather than from what was
 * meant to. Elements are matched by role and label, not id — ids are
 * renumbered on every walk. "nochange" when nothing differs; that word is
 * also what stops a run that keeps pressing the same thing to no effect.
 */
function describeChange(before, after) {
  if (!before || before.ok !== true || !after || after.ok !== true) return "couldn't read the screen";
  const parts = [];
  const appA = before.app || {};
  const appB = after.app || {};
  if (str(appA.name) !== str(appB.name) || (appA.pid && appB.pid && appA.pid !== appB.pid)) {
    parts.push(appB.name ? `switched to ${clip(squash(appB.name), 40)}` : "app changed");
  } else if (!before.window !== !after.window) {
    parts.push(after.window ? "a window opened" : "the window closed");
  } else if (before.window && after.window && !sameFrame(before.window.frame, after.window.frame)) {
    parts.push("window changed");
  }

  const fa = focusedOf(before);
  const fb = focusedOf(after);
  if (fb && (!fa || keyOf(fa) !== keyOf(fb))) {
    const name = printable(fb);
    parts.push(name ? `focus moved to ${name}` : "focus moved");
  }

  // The tree only: the lines read off the first screen's picture are not read
  // again after an action, so they would all count as gone.
  const a = treeOf(before);
  const b = treeOf(after);
  const byKeyA = new Map();
  for (const e of a) {
    const k = keyOf(e);
    if (!byKeyA.has(k)) byKeyA.set(k, []);
    byKeyA.get(k).push(e);
  }
  const used = new Map();
  const named = [];
  const changes = [];
  let added = 0;
  for (const e of b) {
    const k = keyOf(e);
    const n = used.get(k) || 0;
    used.set(k, n + 1);
    const was = (byKeyA.get(k) || [])[n];
    if (!was) {
      added++;
      const name = printable(e);
      if (name && named.length < 3) named.push(name);
      continue;
    }
    // The same element, still there: did its state move?
    const name = printable(e) || `the ${str(e.role) || "element"}`;
    if (typeof e.checked === "boolean" && e.checked !== was.checked) changes.push(`${name} turned ${e.checked ? "on" : "off"}`);
    else if (e.selected === true && was.selected !== true) changes.push(`${name} selected`);
    else if (!e.secure && str(e.value) !== str(was.value)) changes.push(`${name} changed`);
    else if (!!e.disabled !== !!was.disabled) changes.push(`${name} ${e.disabled ? "disabled" : "enabled"}`);
  }
  let gone = 0;
  for (const [k, list] of byKeyA) gone += Math.max(0, list.length - (used.get(k) || 0));

  if (added) parts.push(`${added} new element${added === 1 ? "" : "s"}${named.length ? " like " + named.join(", ") : ""}`);
  if (gone) parts.push(`${gone} element${gone === 1 ? "" : "s"} gone`);
  parts.push(...changes.slice(0, 2));
  return parts.length ? clip(parts.join("; "), 200) : "nochange";
}

/** Null when keyboard focus is where it was in `before` (the same app, and
 *  an element of the same role and label, or none in both); otherwise the
 *  note that says where it went. */
function focusMoved(before, now) {
  if (!now || now.ok !== true) return "couldn't read the focus";
  const appA = squash(before && before.ok === true && before.app && before.app.name);
  const appB = squash(now.app && now.app.name);
  if (appA && appB && appA !== appB) return `switched to ${clip(appB, 40)}`;
  const fa = before && before.ok === true ? focusedOf(before) : null;
  const fb = focusedOf(now);
  if (!fa && !fb) return null;
  if (fa && fb && keyOf(fa) === keyOf(fb)) return null;
  const name = printable(fb);
  return name ? `focus moved to ${name}` : fb ? "focus moved" : "focus was lost";
}

/** True when `now` has keyboard focus on `target` (an element of `before`):
 *  the same app, and a focused element of the same role and label. Ids are
 *  renumbered on every walk, so the id cannot be compared. */
function focusLandedOn(target, before, now) {
  if (!target || !now || now.ok !== true) return false;
  const appA = squash(before && before.ok === true && before.app && before.app.name);
  const appB = squash(now.app && now.app.name);
  if (appA && appB && appA !== appB) return false;
  const f = focusedOf(now);
  return !!f && keyOf(f) === keyOf(target);
}

/** The window's title, for the checks on this computer only. It is never put
 *  in a request, a history note or a log line. "" when the helper gave none. */
const titleOf = (snapshot) => str(snapshot && snapshot.window && snapshot.window.title).slice(0, 200);

// ---- risk -------------------------------------------------------------------

const RANK = { free: 0, confirm: 1, always: 2 };
const NAMES = ["free", "confirm", "always"];
/** A risk the protocol does not know is treated as needing a yes, not as
 *  free: a mistake in the server should cost a click, not a sent message. */
const rankOf = (r) => (r == null || r === "" ? 0 : r in RANK ? RANK[r] : 1);
/** The higher of two risks. Risk only ever goes up. */
function maxRisk(a, b) { return NAMES[Math.max(rankOf(a), rankOf(b))]; }

// The same lists as the server's (§2.5), with the spellings an app actually
// uses for them: "Logout", "Sign-out", "Don't Save" (the close-without-saving
// button in every mac document dialog), "Empty Recycle Bin".
const CONFIRM_WORDS = words([
  "send", "post", "submit", "reply[\\s-]*all", "share", "invite", "publish", "merge", "deploy",
  "sign[\\s-]*out", "log[\\s-]*out", "uninstall", "close\\s+without\\s+saving", "don[’']?t\\s+save",
]);
const ALWAYS_WORDS = words([
  "delete", "remove", "erase", "empty\\s+(?:the\\s+)?(?:trash|bin|recycle\\s+bin)", "pay", "buy", "purchase",
  "order", "check-?out", "transfer", "subscribe", "cancel\\s+(?:my\\s+|your\\s+|the\\s+)?subscription",
]);

function keywordRisk(text) {
  const t = str(text);
  if (!t) return "free";
  if (ALWAYS_WORDS.test(t)) return "always";
  if (CONFIRM_WORDS.test(t)) return "confirm";
  return "free";
}

// A field you write messages in, by its label. Enter there is Send.
const COMPOSER = words([
  "messages?", "repl(?:y|ies)", "chats?", "comments?", "compose", "post", "tweet", "respond", "dm",
  "what[’']?s\\s+happening", "(?:write|type|send)\\s+(?:a|an|something|your)",
]);
// …unless it is a box you look things up in, where Enter is Search.
const NOT_COMPOSER = words(["search", "find", "filter", "jump\\s+to", "go\\s+to", "address", "url"]);

function looksLikeComposer(el) {
  if (!el || (el.role !== "field" && el.role !== "area")) return false;
  const label = squash(el.label);
  return COMPOSER.test(label) && !NOT_COMPOSER.test(label);
}

/** Somewhere keystrokes become text. Anywhere else they are the app's
 *  shortcuts: in Gmail "#" deletes the open conversation and "e" archives it.
 *  A combo box takes typing too (an editable one is a field with a list). */
const takesText = (el) => !!el && (el.role === "field" || el.role === "area" || el.role === "combo");

const MODS = { cmd: "cmd", command: "cmd", meta: "cmd", super: "cmd", win: "cmd", ctrl: "ctrl", control: "ctrl", alt: "alt", option: "alt", opt: "alt", shift: "shift" };
/** "Ctrl+Shift+T" → { key: "t", mods: Set{"ctrl","shift"} }. */
function parseChord(chord) {
  const parts = squash(chord).toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
  const key = parts.length ? parts[parts.length - 1] : "";
  const mods = new Set(parts.slice(0, -1).map((m) => MODS[m] || m));
  return { key: key === "return" ? "enter" : key, mods };
}

/**
 * The chords that do something hard to take back whatever has focus:
 *   Cmd/Ctrl+Enter      send, in nearly every app that writes messages
 *   Cmd/Ctrl+W          close the tab or window, and what was typed in it
 *   Cmd+Q, Alt+F4       quit the app
 *   Cmd/Shift/Ctrl+Del  move to the trash, or delete for good, in a file list
 */
function chordRisk(c) {
  const cmdOrCtrl = c.mods.has("cmd") || c.mods.has("ctrl");
  if (c.key === "enter" && cmdOrCtrl) return "confirm";
  if (c.key === "w" && cmdOrCtrl) return "confirm";
  if (c.key === "q" && cmdOrCtrl) return "confirm";
  if (c.key === "f4" && c.mods.has("alt")) return "confirm";
  if ((c.key === "delete" || c.key === "backspace") && (cmdOrCtrl || c.mods.has("shift"))) return "confirm";
  return "free";
}

/** A key that types a character, or would if a text box had focus: one
 *  character, or space (which also presses a focused button), with no
 *  modifier but Shift. */
function isPrintable(c) {
  if ([...c.mods].some((m) => m !== "shift")) return false;
  return [...c.key].length === 1 || c.key === "space";
}

/** An app's name as a set of words, so "Chrome" and "Google Chrome",
 *  "Teams" and "Microsoft Teams", are the same app. */
function appWords(name) {
  return squash(name).toLowerCase().replace(/\.(?:app|exe)$/, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}
function sameApp(name, others) {
  const a = appWords(name);
  if (!a.length) return false;
  return others.some((o) => {
    const b = appWords(o);
    if (!b.length) return false;
    return a.every((w) => b.includes(w)) || b.every((w) => a.includes(w));
  });
}

/** The shortest run of copied characters that counts as copying. An email
 *  address, an account number, a reset link: twelve covers them without
 *  catching the words any reply shares with the message it answers. */
const COPY_MIN = 12;
/** Static text carries its words in its label, not a value, on both
 *  platforms — and that is where a code or an address on screen would be. */
const TEXT_ROLES = new Set(["text", "cell", "item", "row", "heading"]);

function grams(text) {
  const out = [];
  for (let i = 0; i + COPY_MIN <= text.length; i++) {
    const g = text.slice(i, i + COPY_MIN);
    // A run of dots or spaces is not a copy of anything.
    if ((g.match(/[\p{L}\p{N}]/gu) || []).length >= 6) out.push(g);
  }
  return out;
}

// One-time codes are four to eight digits, often shown in groups ("482 913"),
// and far too short for the twelve-character rule. Email addresses are the
// other thing a page would most like typed somewhere it can read.
const CODE = /(?<!\d)\d(?:[ -]?\d){3,7}(?!\d)/g;
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
/** The codes (digits only, separators dropped) and addresses (lowercased) in a
 *  piece of text, so "482 913" on screen and "482913" typed are the same. */
function tokensIn(text, into = new Set()) {
  const s = str(text);
  for (const m of s.match(EMAIL) || []) into.add(m.toLowerCase());
  for (const m of s.replace(EMAIL, " ").match(CODE) || []) into.add(m.replace(/\D/g, ""));
  return into;
}

/** Everything on screen that is not the target itself: other elements'
 *  values, static text, the window's text. The target's own text and the
 *  selection are left out — rewriting what is selected is the commonest job
 *  there is, and it shares most of its words with what it replaces. */
function screenSources(snapshot, target) {
  const out = [];
  for (const e of elementsOf(snapshot)) {
    if (target && e.id === target.id) continue;
    if (!e.secure && (typeof e.value === "string" || typeof e.value === "number")) out.push(str(e.value));
    if (TEXT_ROLES.has(e.role) || e.role === "link" || e.role === "button") out.push(str(e.label));
  }
  if (snapshot && typeof snapshot.text === "string") out.push(snapshot.text);
  return out;
}
const ownSources = (snapshot, target) => [target && !target.secure ? str(target.value) : "", str(snapshot && snapshot.selection)];

/**
 * True when text about to be typed carries COPY_MIN or more characters,
 * verbatim, from somewhere else on the screen. That is how a page that says
 * "type the text below into the chat" would get something out, so it asks.
 * What they said themselves is theirs to type, wherever else it appears.
 */
function copiesFromScreen(text, snapshot, target, said) {
  const typed = squash(text);
  if (typed.length < COPY_MIN) return false;
  const own = new Set();
  for (const s of ownSources(snapshot, target).concat(str(said))) for (const g of grams(squash(s))) own.add(g);
  const other = new Set();
  for (const s of screenSources(snapshot, target)) for (const g of grams(squash(s))) if (!own.has(g)) other.add(g);
  return other.size > 0 && grams(typed).some((g) => other.has(g));
}

/** True when the text carries a code or an email address that is on screen
 *  but was never said: "reply with the code" is fine when they read it out,
 *  and suspicious when only the page did. */
function carriesScreenSecret(text, snapshot, target, said) {
  const typed = tokensIn(text);
  if (!typed.size) return false;
  const own = new Set();
  for (const s of ownSources(snapshot, target)) tokensIn(s, own);
  const spoken = tokensIn(said);
  const screen = new Set();
  for (const s of screenSources(snapshot, target)) tokensIn(s, screen);
  for (const t of typed) if (screen.has(t) && !own.has(t) && !spoken.has(t)) return true;
  return false;
}

/**
 * How much of a yes this action needs: "free", "confirm" or "always".
 *
 *   words    the §2.5 lists, on whole words, in the target's label and in
 *            the action's text
 *   Enter    in a field that writes messages (Slack's "Message #design",
 *            "Reply…", "Add a comment") — that Enter is Send
 *   chords   Cmd/Ctrl+Enter, close, quit, delete-to-trash (chordRisk)
 *   no box   TYPE, or a single character key, with no text box focused:
 *            the keystrokes become the app's shortcuts
 *   browser  every PRESS in a browser: a page's author writes its labels, and
 *            "Delete account" can be labelled "Export"
 *   open     an app other than the one the run started in; the run reads
 *            whatever comes up next, and it was not asked about that app
 *   copying  TYPE/SET text carrying COPY_MIN characters lifted verbatim from
 *            elsewhere on the screen, or a code or email address that is on
 *            screen and was not in what they said
 *
 * The target is the element the action names, or for TYPE and KEY the one
 * with focus — Enter on a focused "Send" button sends.
 *
 * @param {object} action   the server's action event
 * @param {object} snapshot the snapshot whose ids the action uses
 * @param {{ startApp?: string|string[], said?: string }} [ctx]  the app(s) the
 *        run began in (the snapshot's own app when not given) and everything
 *        the person said in the run (nothing, when not given)
 */
function classifyRisk(action, snapshot, ctx) {
  if (!action || typeof action !== "object") return "free";
  const c = ctx || {};
  const kind = action.kind;
  const els = elementsOf(snapshot);
  const focused = focusedOf(snapshot);
  const named = action.id != null ? els.find((e) => e.id === String(action.id)) || null : null;
  const target = named || (kind === "type" || kind === "key" ? focused : null);
  let risk = "free";
  for (const t of [target && target.label, action.text]) risk = maxRisk(risk, keywordRisk(t));

  if (kind === "key") {
    const chord = parseChord(action.keys || action.text);
    risk = maxRisk(risk, chordRisk(chord));
    if (chord.key === "enter" && looksLikeComposer(focused)) risk = maxRisk(risk, "confirm");
    if (!takesText(focused) && (isPrintable(chord) || chord.key === "delete" || chord.key === "backspace")) {
      risk = maxRisk(risk, "confirm");
    }
  }

  if (kind === "type" && !takesText(focused)) risk = maxRisk(risk, "confirm");

  if (kind === "press" && BROWSERS.test(squash(snapshot && snapshot.app && snapshot.app.name))) {
    risk = maxRisk(risk, "confirm");
  }

  if (kind === "open") {
    const given = c.startApp != null ? [].concat(c.startApp) : [snapshot && snapshot.app && snapshot.app.name];
    const starts = given.filter((s) => typeof s === "string" && s.trim());
    if (!sameApp(action.app || action.text, starts)) risk = maxRisk(risk, "confirm");
  }

  if (kind === "type" || kind === "set") {
    if (copiesFromScreen(action.text, snapshot, target, c.said) || carriesScreenSecret(action.text, snapshot, target, c.said)) {
      risk = maxRisk(risk, "confirm");
    }
  }
  return risk;
}

// ---- the action, in words ---------------------------------------------------

/** The action line for the history, in the server's own line protocol. */
function actionLine(a) {
  const id = str(a.id);
  switch (a.kind) {
    case "press": return `PRESS ${id}`;
    case "set": return `SET ${id} | ${clip(squash(a.text), 80)}`;
    case "type": return `TYPE ${clip(squash(a.text), 80)}`;
    case "key": return `KEY ${squash(a.keys || a.text)}`;
    case "scroll": return `SCROLL ${squash(a.dir) || "down"}${id ? " " + id : ""}`;
    case "focus": return `FOCUS ${id}`;
    case "open": return `OPEN ${clip(squash(a.app || a.text), 60)}`;
    default: return clip(str(a.kind).toUpperCase(), 20);
  }
}

const prettyKeys = (k) => squash(k).split("+").map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p)).join("+");
const quoted = (el) => (el && el.role !== "window" && squash(el.label) ? `“${clip(squash(el.label), 60)}”` : "");

/** What an action is, for spotting the run doing it again: its kind and the
 *  role and label of what it acts on (ids are renumbered every walk), plus
 *  the keys, text, direction or app that make it this action and not
 *  another. */
function fingerprint(a, target) {
  const who = target ? `${str(target.role)}:${squash(target.label).toLowerCase()}` : "";
  switch (a.kind) {
    case "key": return `key|${who}|${squash(a.keys || a.text).toLowerCase()}`;
    case "type": return `type|${who}|${squash(a.text)}`;
    case "scroll": return `scroll|${who}|${squash(a.dir).toLowerCase() || "down"}`;
    case "open": return `open|${appWords(a.app || a.text).join(" ")}`;
    default: return `${a.kind}|${who}`;
  }
}

/** The sentence a risky action is confirmed with: the server's, which knows
 *  what is being sent where, or one made here when only this side thought it
 *  needed asking. */
function confirmText(a, target) {
  const given = squash(a.confirm);
  if (given) return clip(given, 240);
  const name = quoted(target);
  const text = clip(squash(a.text), 80);
  switch (a.kind) {
    case "press": return name ? `Press ${name}?` : "Press it?";
    case "set": return `Put “${text}” in ${name || "the field"}?`;
    case "type": return `Type “${text}”?`;
    case "key": return `Press ${prettyKeys(a.keys || a.text)}${name ? ` in ${name}` : ""}?`;
    case "open": return `Open ${clip(squash(a.app || a.text), 60)}?`;
    case "scroll": return `Scroll ${squash(a.dir) || "down"}?`;
    case "focus": return name ? `Go to ${name}?` : "Go there?";
    default: return "Go ahead?";
  }
}

/** What the guide shows while the action runs. */
function acting(a, target) {
  const name = quoted(target);
  switch (a.kind) {
    case "press": return name ? `Pressing ${name}` : "Pressing";
    case "set": return name ? `Filling in ${name}` : "Filling it in";
    case "type": return "Typing";
    case "key": return `Pressing ${prettyKeys(a.keys || a.text)}`;
    case "scroll": return `Scrolling ${squash(a.dir) || "down"}`;
    case "focus": return name ? `Going to ${name}` : "Going there";
    case "open": return `Opening ${clip(squash(a.app || a.text), 60)}`;
    default: return "Working";
  }
}

// ---- the run ----------------------------------------------------------------

const ABORTED = Symbol("aborted");

/** An async iterator over whatever post() gave back: an async iterable (a
 *  stream of events), or a plain array (handy for a fixed answer). */
function iteratorOf(source) {
  if (source && typeof source[Symbol.asyncIterator] === "function") return source[Symbol.asyncIterator]();
  if (source && typeof source[Symbol.iterator] === "function") {
    const it = source[Symbol.iterator]();
    return { next: async () => it.next(), return: async () => (it.return ? it.return() : { done: true }) };
  }
  return null;
}

/** Stop reading a stream. Not awaited: a generator stuck inside an await only
 *  finishes returning when that await does, and nothing here waits on it. */
function close(it) {
  try {
    const r = it && typeof it.return === "function" ? it.return() : null;
    if (r && typeof r.then === "function") r.then(null, () => {});
  } catch { /* already finished */ }
}

const hasAudio = (a) => !!(a && a.data && (a.data.length > 0 || a.data.size > 0 || a.data.byteLength > 0));

/** A press's answers that do not mean "nothing happened": the driver gave up
 *  waiting while the helper still ran it, the helper died part way, or the
 *  app took it and was slow to say so (an ok with pending or slow set). */
const UNSURE_PRESS = new Set(["timeout", "pending", "slow", "dead", "helper_exited"]);
function pressMayHaveHappened(r) {
  if (!r || typeof r !== "object") return false;
  if (r.ok === true) return r.pending === true || r.slow === true;
  return UNSURE_PRESS.has(str(r.error));
}

/**
 * @param {object} deps
 * @param {object} deps.driver   the §1 driver API
 * @param {object} deps.guide    { show, state, heard, say, point, unpoint, steps, confirm, approve?, hide, error, badge, draw?, clear?, offer? }:
 *        approve(card) shows the server's confirm card for a connected app and resolves
 *        "approve", "edit", "deny", or "" for no answer (confirmMs, or the card taken away);
 *        a guide without it cannot ask, and nothing is called
 *        point(frame, caption?, { tentative: true }?) and say(text, { speak, rate, locale?, append? });
 *        draw(mark) with a mark from resolveMark (driver units), clear() to take the marks away.
 *        draw and clear are called only when the guide has them: one without them draws nothing.
 *        offer("screenSettings"): a button on the finished card to the Mac's Screen Recording
 *        settings, after TEXT.needScreen; a guide without it says the words alone
 * @param {(req: object, audio: object|null, signal: AbortSignal, image?: {mime: string, data: Buffer}|null) => AsyncIterable<object>|Promise<AsyncIterable<object>>} deps.post
 *        `image` only on the step that carries the picture
 * @param {(route: { method: "POST", path: string, body: object }) => Promise<{ status: number, body: object|null }>} [deps.call]
 *        the confirm card's button: the server route it names (a task's approve or deny), with
 *        the account's token. Status 0 when it could not be reached. Without it nothing is called.
 * @param {() => string} [deps.approveElsewhere]  the words for an approval that arrived with no card
 *        to ask it on (it is then left waiting, to be answered in Tasks)
 * @param {(url: string) => boolean|void|Promise<boolean|void>} [deps.open]  the server's `open` event
 *        (a hand-off: an email, a message, a search or a route): a link already checked by
 *        safeOpenUrl, to open in the person's browser or mail app. Resolves false (or throws)
 *        when it could not, and the fallback is tried. Without it an `open` does nothing.
 * @param {(text: string) => Promise<void>} deps.paste
 * @param {() => Promise<{mime: string, data: Buffer}|null>} deps.listen
 * @param {(name: string, fallback: any) => any} [deps.knob]
 * @param {"mac"|"win"} [deps.platform]
 * @param {() => number} [deps.now]
 * @param {(line: string) => void} [deps.log]
 * @param {(appName: string) => boolean} [deps.sensitive]  defaults to frontApp.looksSensitive
 * @param {string|(() => string)} [deps.language]
 * @param {(look: object, frame: number[]) => {mime: string, data: Buffer, frame?: number[]}|Promise<{mime: string, data: Buffer, frame?: number[]}|null>|null} [deps.crop]
 *        the part of the look's picture under `frame` (driver units), as a
 *        file, with the part of the window it really shows (`frame`) when that
 *        is not quite what was asked for. Without it there is no picture path.
 * @param {(app: string) => "never"|"ask"|"always"|Promise<string>} [deps.pictures]
 *        whether pictures of this app may go. Without it there is no picture path.
 * @param {(app: string, about: { region: "element"|"window" }) => Promise<"once"|"always"|"no">} [deps.permit]
 *        the guide's permission card, told whether the picture is one image or
 *        the whole window (ringed on screen while it asks). Without it, "ask" is no.
 * @param {string[]|(() => string[])} [deps.names]  the names it answers to, taken
 *        off the front of a question (its own, the guide's, their nickname for it)
 * @param {() => Promise<void>} [deps.afterSpeech]  settles once everything the guide
 *        has been given to say so far has been said. A finished run's card stays up
 *        for it, and doneMs after. Without it, doneMs from the moment the run ends.
 */
function createAgent(deps) {
  const d = deps || {};
  const driver = d.driver || {};
  const guide = d.guide || {};
  const knob = typeof d.knob === "function" ? d.knob : (_name, fallback) => fallback;
  const now = typeof d.now === "function" ? d.now : Date.now;
  const platform = d.platform === "win" || d.platform === "mac" ? d.platform : process.platform === "win32" ? "win" : "mac";
  const sensitive = typeof d.sensitive === "function" ? d.sensitive : frontApp.looksSensitive;
  // The picture path needs both the crop and the per-app policy; with
  // either missing, no picture is taken with the look, let alone sent.
  const canPicture = typeof d.crop === "function" && typeof d.pictures === "function";

  function log(line) { try { if (typeof d.log === "function") d.log(line); } catch { /* a logger must not stop a run */ } }
  function num(name, fallback) {
    let v;
    try { v = knob(name, fallback); } catch { v = fallback; }
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
  }
  function bool(name, fallback) {
    let v;
    try { v = knob(name, fallback); } catch { v = fallback; }
    return typeof v === "boolean" ? v : fallback;
  }

  function language() {
    try { return str(typeof d.language === "function" ? d.language() : d.language); } catch { return ""; }
  }
  function isSensitive(name) {
    try { return !!sensitive(name); } catch { return false; }
  }
  function names() {
    try {
      const n = typeof d.names === "function" ? d.names() : d.names;
      const list = Array.isArray(n) ? n.filter((s) => typeof s === "string" && s.trim()) : [];
      return list.length ? list : resolver.NAMES;
    } catch { return resolver.NAMES; }
  }
  /** Their words against a screen, with this computer's bars. */
  function matchOn(text, screen) {
    // A window's label is its title: never something to point at, and never
    // on the server's list either.
    const els = elementsOf(screen).filter((e) => e.role !== "window");
    return resolver.match(text, els, {
      score: num("desktop.agent.matchScore", 0.85),
      margin: num("desktop.agent.matchMargin", 0.2),
      names: names(),
    });
  }

  /** The run in progress, or null. Everything a run does checks it is still
   *  this one, so a run that was cancelled or has finished can never touch
   *  the guide again, whatever arrives late on its stream. */
  let current = null;
  let seq = 0;
  let hideTimer = null;
  /** Which scheduled hide may still happen: a new question, or a cancel,
   *  moves it on, and a hide still waiting for the last answer's voice
   *  then never comes. */
  let hideGen = 0;

  const alive = (run) => !!run && current === run && !run.over;

  /** A guide call, fire-and-forget. The guide is another window in another
   *  process; one that throws, or answers with a rejection, is logged and
   *  the run goes on. */
  function callGuide(method, args) {
    const fn = guide && guide[method];
    if (typeof fn !== "function") return;
    try {
      const r = fn.apply(guide, args || []);
      if (r && typeof r.then === "function") r.then(null, (e) => log(`agent: guide.${method} failed: ${errText(e)}`));
    } catch (e) {
      log(`agent: guide.${method} threw: ${errText(e)}`);
    }
  }
  function tell(run, method, ...args) { if (alive(run)) callGuide(method, args); }

  /** Whatever `p` gives, or ABORTED the moment the run is cancelled. */
  const race = (run, p) => Promise.race([p, run.aborted]);

  /** The card goes doneMs after the answer has been said. A long answer comes
   *  a sentence at a time and takes far longer to say than doneMs, and the
   *  hide stops the voice where it is: timed from the end of the stream, it
   *  cut off most of what was written, and the card with it. */
  function scheduleHide() {
    unscheduleHide();
    const gen = hideGen;
    const arm = () => {
      if (gen !== hideGen || current) return;
      hideTimer = setTimeout(() => { hideTimer = null; if (!current) callGuide("hide"); }, Math.max(0, num("desktop.agent.doneMs", 9000)));
      // A timer that only tidies the screen need not keep a process alive.
      if (hideTimer && typeof hideTimer.unref === "function") hideTimer.unref();
    };
    if (typeof d.afterSpeech !== "function") { arm(); return; }
    let said;
    try { said = d.afterSpeech(); } catch (e) { log(`agent: afterSpeech threw: ${errText(e)}`); }
    let cap = null;
    new Promise((resolve) => {
      cap = setTimeout(resolve, SPEECH_MAX_MS);
      if (typeof cap.unref === "function") cap.unref();
      Promise.resolve(said).then(resolve, resolve);
    }).then(() => { clearTimeout(cap); arm(); });
  }
  function unscheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = null;
    hideGen++;
  }

  /**
   * The run is over. `how`: "done" (the card says `text`, if any), "error"
   * (the card shows `text` as an error), "quiet" (hide now, nothing to say).
   * Done and error stay on screen for doneMs.
   */
  function finish(run, how, text) {
    if (!alive(run)) return;
    // A tentative ring is a guess at an answer that is not coming now (the
    // look showed a private window after preview drew it off the tree, the
    // request failed): it does not stay up beside the card.
    if (run.tentative) { run.tentative = false; tell(run, "unpoint"); }
    if (how === "done") {
      if (text) tell(run, "state", "done", text); else tell(run, "state", "done");
    } else if (how === "error") {
      tell(run, "error", text || TEXT.failed);
    }
    run.over = true;
    current = null;
    clearTimeout(run.deadlineTimer);
    // Whatever is still in flight for this run — a stream, a fetch — is
    // dropped, not left to finish into nothing.
    try { run.controller.abort(); } catch { /* already */ }
    if (how === "quiet") callGuide("hide"); else scheduleHide();
    log(`agent ${run.tag}: ${how}${how === "done" && run.stop ? ` (${run.stop})` : ""} after ${run.step + 1} step(s)`);
  }
  function stop(run, why) {
    if (!alive(run)) return;
    run.stop = why;
    finish(run, "done", TEXT[why]);
  }

  /** Read the screen. Always settles, with a Snapshot or { ok:false, error }. */
  function takeSnapshot() {
    const timeoutMs = num("desktop.agent.snapshotTimeoutMs", 1500);
    const max = Math.max(1, Math.min(MAX_ELEMENTS, num("desktop.agent.maxElements", 250)));
    const asked = Promise.resolve().then(() => driver.snapshot({ max, timeoutMs }));
    return within(asked, timeoutMs + SNAPSHOT_GRACE_MS, { ok: false, error: "timeout" }).then(
      (s) => (s && s.ok === true && Array.isArray(s.elements) ? s : { ok: false, error: str((s && s.error) || "no snapshot") }),
      (e) => ({ ok: false, error: errText(e) }),
    );
  }

  /** True when this app's pictures are set never to go, as far as can be
   *  told at once: a policy still to come is not a never yet. One that throws
   *  is, as it is in picturePolicy(). */
  function picturesNever(run) {
    if (!canPicture) return true;
    try {
      const p = d.pictures(appLabel(run));
      if (p && typeof p.then === "function") { p.then(null, () => {}); return false; }
      return p === "never";
    } catch { return true; }
  }

  /** Look at the window: its picture, and its text read by the system's OCR.
   *  Always settles, with a look or { ok:false, error }. The picture itself
   *  is only asked for when one could go: there is a way to send it, and
   *  this app's pictures are not set never to go. A full-window picture of
   *  their mail is not taken, sent over the pipe and kept for the run to no
   *  purpose. When it is, it is at the window's own size: the crop cuts a
   *  small part out of it, and a 4K window brought down to 1600 first sends
   *  an equation at a fraction of its pixels. */
  function takeLook(run) {
    if (!bool("desktop.agent.look", true)) return Promise.resolve({ ok: false, error: "off" });
    if (typeof driver.look !== "function") return Promise.resolve({ ok: false, error: "unsupported" });
    const timeoutMs = num("desktop.agent.lookTimeoutMs", 2500);
    const opts = { budgetMs: num("desktop.agent.lookBudgetMs", 1500), timeoutMs, ocr: true, image: !picturesNever(run) };
    if (opts.image) opts.maxSide = num("desktop.agent.lookMaxSide", 4096);
    const asked = Promise.resolve().then(() => driver.look(opts));
    return within(asked, timeoutMs + SNAPSHOT_GRACE_MS, { ok: false, error: "timeout" }).then(
      (l) => (l && l.ok === true && l.window && isFrame(l.window.frame) ? l : { ok: false, error: str((l && l.error) || "no look") }),
      (e) => ({ ok: false, error: errText(e) }),
    );
  }

  /** Make `snap` the screen the next request describes, with its own id maps.
   *  A failed read leaves an empty screen, not the last one: ids from an old
   *  walk would point at whatever has moved there since. */
  function adopt(run, snap) {
    if (!snap || snap.ok !== true) {
      log(`agent ${run.tag}: screen not read (${(snap && snap.error) || "no snapshot"}); asking without it`);
      run.snapshot = { ok: false, error: (snap && snap.error) || "no snapshot", elements: [] };
    } else {
      if (snap.linesOnly) log(`agent ${run.tag}: tree not read; using the text read off the window`);
      run.snapshot = snap;
      if (!run.firstApp && snap.app && snap.app.name) run.firstApp = str(snap.app.name);
    }
    run.frames = frameMap(run.snapshot);
    run.byId = new Map(elementsOf(run.snapshot).filter((e) => typeof e.id === "string").map((e) => [e.id, e]));
  }

  /** adopt(), unless the screen is now a private window or a sensitive app's
   *  — an OPEN, a link, a tab or a key of theirs landed in a bank, a password
   *  manager or an incognito window. The check at begin saw only the window
   *  that was in front then; a browser's app name stays "Google Chrome" on
   *  every site, so the window's title is checked here too, on every screen
   *  the run takes in. Nothing of a refused screen is sent: the run ends
   *  here. False when it did. */
  function adoptChecked(run, snap) {
    const why = refusal(snap);
    if (why) { refuseScreen(run, why); return false; }
    adopt(run, snap);
    return true;
  }

  /** The run ends on a screen it must not read: nothing of it is kept. */
  function refuseScreen(run, why) {
    log(`agent ${run.tag}: the front window is ${why === "private" ? "a private one" : "a sensitive app's"}; stopping`);
    run.snapshot = { ok: false, error: why, elements: [] };
    run.frames = new Map();
    run.byId = new Map();
    run.look = null;
    run.stop = why === "private" ? "private" : "blocked";
    finish(run, "done", why === "private" ? TEXT.blockedPrivate : TEXT.blocked);
  }

  /** refusal() for a look: its window's title, with the tree's app name when
   *  there is one. The picture is of a window too, and a private one's
   *  picture is no more to be read than its tree. */
  function lookRefusal(look, snap) {
    if (!look || look.ok !== true) return "";
    const title = str(look.window && look.window.title).slice(0, 200);
    if (!title) return "";
    const name = snap && snap.ok === true && snap.app && snap.app.name ? str(snap.app.name) : "";
    if (frontApp.isPrivate(title)) return "private";
    if (isSensitive(squash(name + " " + title)) || isSensitive(title)) return "sensitive";
    return "";
  }

  /**
   * The first screen of a run, from the two reads begun at Alt twice: the
   * tree with the look's lines after it, and the look itself (for its
   * picture) — or `why` it must not be read at all. Either read may be
   * missing or failed; the other is still used. A look of some other window
   * than the tree's is dropped whole, lines and picture. `quiet` for
   * preview's reading of it, which the run's own reading logs after.
   * @returns {{ why?: string, screen?: object, look?: object|null }}
   */
  function firstScreen(run, snap, look, quiet) {
    const s = snap && snap.ok === true && Array.isArray(snap.elements) ? snap : null;
    const l = look && look.ok === true && look.window && isFrame(look.window.frame) ? look : null;
    const why = (s && refusal(s)) || (l && lookRefusal(l, s)) || "";
    if (why) return { why };
    let usable = l;
    if (l && s && !sameWindow(s, l)) {
      if (!quiet) log(`agent ${run.tag}: the look saw another window than the tree; not using it`);
      usable = null;
    } else if (l && s && s.scale && l.scale && s.scale !== l.scale) {
      if (!quiet) log(`agent ${run.tag}: the look and the tree are in different units; not using the look`);
      usable = null;
    }
    const lines = usable ? ocrElements(s, usable) : [];
    if (s) return { screen: lines.length ? Object.assign({}, s, { elements: elementsOf(s).concat(lines) }) : s, look: usable };
    // No tree (it timed out, the app has none to speak of): the lines alone
    // are still a screen to point at, in the look's window.
    if (lines.length) {
      return {
        screen: {
          ok: true, app: null, window: { frame: usable.window.frame.slice(), title: str(usable.window.title).slice(0, 200) },
          focused: null, selection: "", scale: usable.scale, elements: lines, truncated: false, ms: 0, linesOnly: true,
        },
        look: usable,
      };
    }
    return { screen: snap || { ok: false, error: "no snapshot" }, look: usable };
  }

  /** The screen that preview() matches against: what of the two reads has
   *  arrived, checked like the run's first screen. Null until the tree has
   *  answered, and for a screen that must not be read. */
  function previewScreen(run) {
    if (!run.snapSeen) return null;
    const c = run.previewCache;
    if (c && c.snap === run.snapSeen && c.look === run.lookSeen) return c.screen;
    const first = firstScreen(run, run.snapSeen, run.lookSeen, true);
    const screen = first.why || !first.screen || first.screen.ok !== true ? null : { snapshot: first.screen, frames: frameMap(first.screen) };
    run.previewCache = { snap: run.snapSeen, look: run.lookSeen, screen };
    return screen;
  }

  /** "private" or "sensitive" when this screen must not be read or acted
   *  in, by the app's name and the window's title; "" otherwise. */
  function refusal(snap) {
    if (!snap || snap.ok !== true) return "";
    const name = snap.app && snap.app.name ? str(snap.app.name) : "";
    const title = titleOf(snap);
    if (title && frontApp.isPrivate(title)) return "private";
    if ((name && isSensitive(name)) || (title && isSensitive(squash(name + " " + title)))) return "sensitive";
    return "";
  }

  /** The apps this run counts as "where it started": the short label it was
   *  begun with ("Gmail") and the app the first walk found ("Google Chrome"). */
  const startApps = (run) => [run.app, run.firstApp].filter(Boolean);

  /** The front app's short label, as dictation sends it. After an OPEN moved
   *  the run to another app, that app's own name. */
  function appLabel(run) {
    const s = run.snapshot;
    const name = s && s.ok === true && s.app ? str(s.app.name) : "";
    if (name && run.firstApp && !sameApp(name, [run.firstApp])) return clip(squash(name), 60);
    return clip(squash(run.app || name), 60);
  }

  function buildRequest(run, input) {
    const snap = run.snapshot;
    // The window's text counts against the same budget as the elements.
    const text = snap.ok === true && typeof snap.text === "string" && snap.text.trim() ? stripUrls(snap.text).slice(0, 4000) : "";
    const screen = { elements: toRequestElements(snap, Math.min(MAX_ELEMENTS, num("desktop.agent.maxElements", 250)), SCREEN_CHARS - text.length) };
    const focused = focusedOf(snap);
    // The field's kind in dictation's own words (frontApp.kindOf), so the
    // server reads it the same way on both routes. Never a password's.
    const kind = focused ? frontApp.kindOf(focused.role, focused.secure ? "secure" : "", focused.label) : null;
    // A browser selects the whole URL when its address bar takes focus (a
    // click, Cmd+L), so the selection there is the page's address with its
    // reset tokens and session ids: the very thing toRequestElements keeps
    // off the wire. Nor does any other selection go with a URL's query or
    // fragment in it. It cannot be stripped instead: a rewrite pastes its
    // answer over the whole selection, and a stripped copy would put the
    // link back broken.
    const addressBar = !!focused && (kind === "url" || ((focused.role === "field" || focused.role === "combo") && ADDRESS_BAR.test(squash(focused.label))));
    if (snap.ok === true && typeof snap.selection === "string" && snap.selection && snap.selection.length <= 8000
      && !(focused && focused.secure) && !addressBar && !HAS_URL_TAIL.test(snap.selection)) {
      screen.selection = snap.selection;
    }
    if (focused) {
      if (kind && kind !== "password") {
        screen.field = { kind };
        const label = clip(squash(focused.label), 80);
        if (label) screen.field.label = label;
      }
    }
    if (text) screen.text = text;
    const req = { runId: run.id, step: run.step, platform, app: appLabel(run), screen, tzOffsetMinutes: -new Date().getTimezoneOffset() };
    // With audio, the audio is the words (step 0, or the reply to an ASK).
    // Without, the run's goal goes again: the server keeps nothing between
    // steps, so every step says what the run is for.
    if (!input.audio) {
      const utterance = clip(squash(input.utterance || run.goal), 1000);
      if (utterance) req.utterance = utterance;
    }
    // Which part of the window the picture with this step is: one image on
    // it, or all of it. Where it is stays here, like every other frame.
    if (input.image && input.picture) req.picture = { region: input.picture.region === "element" ? "element" : "window" };
    const lang = language();
    if (lang) req.language = lang;
    if (run.history.length) req.history = run.history.slice(-MAX_HISTORY).map((h) => Object.assign({}, h));
    return req;
  }

  function pushHistory(run, turn) {
    const t = {};
    for (const k of ["said", "did", "result", "note"]) if (turn[k]) t[k] = turn[k];
    if (t.said) t.said = clip(t.said, 1000);
    if (t.did) t.did = clip(t.did, 200);
    if (t.note) t.note = clip(t.note, 200);
    run.history.push(t);
    while (run.history.length > MAX_HISTORY) run.history.shift();
  }

  function showPlan(run) {
    if (!run.plan) return;
    tell(run, "steps", run.plan.map((text, i) => ({ text, state: i < run.planDone ? "done" : i === run.planDone ? "active" : "todo" })));
  }

  const sayOpts = (locale, append) => {
    const o = { speak: bool("desktop.agent.speak", true), rate: num("desktop.agent.voiceRate", 1.04) };
    if (locale) o.locale = locale;
    if (append) o.append = true;
    return o;
  };

  /** The marks drawn on this screen go, when there are any: the screen is
   *  about to change under them, or a new answer is about to draw its own. */
  function clearMarks(run) {
    if (!run.marks) return;
    run.marks = 0;
    tell(run, "clear");
  }

  /** The server's draw event, placed on this screen and handed to the guide,
   *  or dropped when it cannot be placed. A clear takes them all away. */
  function drawMark(run, ev) {
    if (!bool("desktop.agent.draw", true)) return;
    if (ev.kind === "clear") { clearMarks(run); return; }
    const mark = resolveMark(ev, run.frames, run.pictureFrame);
    if (!mark) {
      log(`agent ${run.tag}: a ${clip(squash(ev.kind), 12) || "mark"} dropped: not on this screen`);
      return;
    }
    // The answer is showing where it means with its own pen: the guess at
    // it (preview's, or the picture's pulsing "Looking" ring round the very
    // thing being drawn on) goes, as it does for the answer's own ring.
    dropTentative(run);
    run.marks += 1;
    tell(run, "draw", mark);
  }

  /** A tentative ring from preview() or the picture path, put away once the
   *  answer it stood in for has come without one of its own. */
  function dropTentative(run) {
    if (!run.tentative) return;
    run.tentative = false;
    run.previewKey = "";
    tell(run, "unpoint");
  }

  /** The events before the terminal one: shown as they arrive. */
  function onEvent(run, ev) {
    switch (ev.t) {
      case "heard": {
        const text = squash(ev.text);
        if (!run.mode && (ev.mode === "show" || ev.mode === "do")) run.mode = ev.mode;
        if (run.fresh && text) run.said = text;
        if (run.step === 0 && text && !run.goal) run.goal = clip(text, 1000);
        if (text && text !== run.lastHeard) { run.lastHeard = text; tell(run, "heard", text); }
        break;
      }
      case "say": {
        // A long answer comes a sentence at a time: each one after the first
        // is added to the card (and to what is said aloud), not put in its place.
        const text = squash(ev.text);
        if (!text) break;
        run.says += 1;
        tell(run, "say", clip(text, 240), sayOpts(typeof ev.locale === "string" ? ev.locale : "", ev.append === true));
        break;
      }
      case "point": {
        const frame = run.frames.get(str(ev.id));
        if (!frame) { log(`agent ${run.tag}: point at ${clip(str(ev.id), 12)} skipped: not on this screen`); break; }
        // The answer's own ring takes the place of a tentative one.
        run.tentative = false;
        const caption = squash(ev.caption);
        if (caption) tell(run, "point", frame, clip(caption, 120)); else tell(run, "point", frame);
        break;
      }
      case "draw":
        drawMark(run, ev);
        break;
      case "steps": {
        const items = (Array.isArray(ev.items) ? ev.items : []).map((s) => clip(squash(s), 120)).filter(Boolean).slice(0, 6);
        if (!items.length) break;
        // The same plan again (the model repeats it each step) keeps its
        // progress; a new one starts over.
        const same = run.plan && run.plan.length === items.length && run.plan.every((s, i) => s === items[i]);
        if (!same) { run.plan = items; run.planDone = 0; }
        showPlan(run);
        break;
      }
      case "open":
        openLink(run, ev);
        break;
      default: break;   // a newer server's event this build does not know
    }
  }

  /** The server's `open` (a hand-off, such as an email written in Gmail): the link, or its fallback, handed to main to open. At most once a run. */
  function openLink(run, ev) {
    if (run.opened) return;
    const links = [safeOpenUrl(ev.url), safeOpenUrl(ev.fallback)].filter(Boolean);
    if (!links.length) { log(`agent ${run.tag}: open skipped: not a link this app opens`); return; }
    if (typeof d.open !== "function") return;
    run.opened = true;
    void (async () => {
      for (const link of links) {
        try { if ((await d.open(link)) !== false) return; } catch (e) { log(`agent ${run.tag}: open failed: ${errText(e)}`); }
      }
    })();
  }

  /** A yes or no from the person, within confirmMs. Silence is no. So is a
   *  guide that cannot ask, or one that throws: only a real yes acts. */
  async function confirm(run, text, risk) {
    const fn = guide && guide.confirm;
    if (typeof fn !== "function") return false;
    const asked = Promise.resolve().then(() => fn.call(guide, text, risk)).then((v) => v === true, (e) => {
      log(`agent ${run.tag}: guide.confirm failed: ${errText(e)}`);
      return false;
    });
    const answer = await race(run, within(asked, num("desktop.agent.confirmMs", 30000), false));
    return answer === true;
  }

  async function drive(method, ...args) {
    const fn = driver && driver[method];
    if (typeof fn !== "function") return { ok: false, error: "unsupported" };
    try {
      const r = await fn.apply(driver, args);
      return r && typeof r === "object" ? r : { ok: false, error: "no answer" };
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
  }

  /** Through the clipboard, like dictation: it replaces a selection, it does
   *  not care what keyboard layout is on, and a web app hears it as typing.
   *  Main's paste, untouched — in particular the clipboard is NOT put back
   *  afterwards: a restore on a timer can land in the middle of the next
   *  paste and put whatever was there before (often a password) into the
   *  message instead. */
  async function pasteText(text) {
    if (typeof d.paste !== "function") return { ok: false, error: "unsupported" };
    try { await d.paste(text); return { ok: true, how: "paste" }; } catch (e) { return { ok: false, error: errText(e) }; }
  }

  /** The front app is a browser, or built on one. */
  function webApp(run) {
    const s = run.snapshot;
    const name = s && s.ok === true && s.app && s.app.name ? str(s.app.name) : run.firstApp || run.app;
    return WEB_APPS.test(squash(name));
  }

  /** SET the way a person would: click into the field, select all of it, and
   *  paste over it. Each step only if the one before worked — a select-all
   *  with focus somewhere else selects the whole page, and a paste after it
   *  replaces the wrong thing. */
  async function pasteInto(run, id, text) {
    const target = run.byId.get(id) || null;
    const before = run.snapshot;
    const focus = await drive("focus", id);
    if (focus.ok !== true) return { ok: false, error: focus.error || "couldn't focus it" };
    if (!alive(run)) return { ok: false, error: "cancelled" };
    // A focus the app said yes to is not always a focus that moved: a web
    // page's wrapper takes the request and keeps nothing, an app answers late.
    // So the screen is read again, and the keys go only when the focused
    // element is the field this step names — otherwise Cmd+A selects a whole
    // document and the paste or Backspace replaces it.
    // A browser moves focus a moment after it says yes (the page takes it and
    // reports back on its next frame), so a first read that still shows the
    // old focus waits a little and looks once more before giving up.
    for (let look = 0; ; look++) {
      if (look) {
        await race(run, sleep(Math.min(150, num("desktop.agent.settleMs", 450))));
        if (!alive(run)) return { ok: false, error: "cancelled" };
      }
      const seen = await race(run, takeSnapshot());
      if (!alive(run)) return { ok: false, error: "cancelled" };
      if (!seen || seen.ok !== true) return { ok: false, error: "couldn't read the focus" };
      // Nothing is typed into a private window or a sensitive app either; the
      // read after the step ends the run there.
      if (refusal(seen)) return { ok: false, error: "not this window" };
      if (focusLandedOn(target, before, seen)) break;
      if (look >= 1) return { ok: false, error: "focus didn't move" };
    }
    const all = await drive("key", platform === "mac" ? "cmd+a" : "ctrl+a");
    if (all.ok !== true) return { ok: false, error: all.error || "couldn't select it" };
    if (!alive(run)) return { ok: false, error: "cancelled" };
    // Emptying a field: there is nothing to paste, so delete what is selected.
    if (!text) return drive("key", "backspace");
    return pasteText(text);
  }

  async function perform(run, a) {
    const id = a.id != null ? str(a.id) : null;
    switch (a.kind) {
      case "press": {
        const pressed = await drive("press", id);
        // A press that timed out, is still running (it opened something
        // modal) or that the app was slow to answer may well have happened:
        // the helper does the work whether or not anyone still waits for it.
        // A click on top of it would press twice — a toggle flips back, Add
        // adds two. So no click: the step counts as failed, and the screen
        // read next says what it did.
        if (pressMayHaveHappened(pressed)) {
          const how = pressed.ok === true ? (pressed.pending === true ? "pending" : "slow") : clip(str(pressed.error), 40);
          log(`agent ${run.tag}: press ${id} came back ${how}; not clicking on top of it`);
          return { ok: false, error: how, maybe: true };
        }
        if (pressed.ok === true) return pressed;
        // Plenty of controls have no press action to call (custom web
        // widgets, canvas apps); a real click at their centre still works.
        log(`agent ${run.tag}: press ${id} failed (${clip(str(pressed.error), 40)}); clicking instead`);
        const clicked = await drive("click", id);
        return clicked.ok === true ? { ok: true, how: "click" } : { ok: false, error: clicked.error || pressed.error };
      }
      case "set": {
        const text = str(a.text);
        if (webApp(run)) return pasteInto(run, id, text);
        const set = await drive("setValue", id, text);
        if (set.ok === true) return set;
        log(`agent ${run.tag}: set ${id} failed (${clip(str(set.error), 40)}); pasting instead`);
        return pasteInto(run, id, text);
      }
      case "type": {
        const text = str(a.text);
        if (!text) return { ok: false, error: "nothing to type" };
        return pasteText(text);
      }
      case "key": {
        const keys = squash(a.keys || a.text);
        return keys ? drive("key", keys) : { ok: false, error: "no keys" };
      }
      case "scroll": {
        const dir = squash(a.dir).toLowerCase() || "down";
        if (!SCROLL_DIRS.has(dir)) return { ok: false, error: "bad direction" };
        return drive("scroll", id, dir, Math.max(1, num("desktop.agent.scrollLines", 5)));
      }
      case "focus": return drive("focus", id);
      case "open": {
        const app = squash(a.app || a.text);
        return app ? drive("open", app) : { ok: false, error: "no app" };
      }
      default: return { ok: false, error: "unknown action" };
    }
  }

  /** Everything the person said in this run, for the risk check that asks
   *  whether a code being typed came from them or from the page. */
  const saidSoFar = (run) => [run.goal, ...run.history.map((h) => h.said), run.said].filter(Boolean).join("\n");

  /** The step's action: checked, confirmed if it needs it, run, and looked
   *  at afterwards. The next input, or null when the run ended here. */
  async function act(run, a) {
    if (run.mode === "show") {
      // The server never sends one in a show run; this is the second lock.
      log(`agent ${run.tag}: refused a ${clip(str(a.kind), 12)} in a show run`);
      finish(run, "done");
      return null;
    }
    if (!ACTION_KINDS.has(a.kind)) {
      log(`agent ${run.tag}: unknown action ${clip(str(a.kind), 12)}`);
      finish(run, "error", TEXT.failed);
      return null;
    }
    const did = actionLine(a);
    const verb = did.split(" ")[0];
    const said = run.said || undefined;
    const el = a.id != null ? run.byId.get(str(a.id)) || null : null;
    if ((NEEDS_ID.has(a.kind) || a.id != null) && !el) {
      // Only ids from the snapshot this step was sent with can be acted on:
      // anything else could be an element nobody has looked at.
      log(`agent ${run.tag}: ${verb} names no element on this screen`);
      pushHistory(run, { said, did, result: "failed", note: "no such element on screen" });
      return {};
    }
    if (el && el.ocr === true) {
      // A line read off the window's picture is something to point at, not
      // a control: the driver has no element behind it to press, focus or
      // fill, and a click at a guess is not what was asked for.
      log(`agent ${run.tag}: ${verb} names a line of text read off the screen`);
      pushHistory(run, { said, did, result: "failed", note: `${clip(str(a.id), 12)} is text read off the screen, not a control` });
      return {};
    }
    const planned = focusedOf(run.snapshot);
    const target = el || (a.kind === "type" || a.kind === "key" ? planned : null);
    const frame = target ? run.frames.get(target.id) || null : null;

    // THE SAME THING A THIRD TIME is a loop, whatever the screen did: A, B, A,
    // B is two buttons undoing each other, and a scroll on a page with a
    // clock or a typing indicator "changes" every time. Checked before the
    // yes, so nobody is asked to approve a step that will not run.
    const print = fingerprint(a, target);
    if ((run.seen.get(print) || 0) >= 2) {
      log(`agent ${run.tag}: ${verb} on the same target a third time; stopping`);
      stop(run, "loop");
      return null;
    }

    const mine = classifyRisk(a, run.snapshot, { startApp: startApps(run), said: saidSoFar(run) });
    const risk = maxRisk(maxRisk(a.risk, mine), bool("desktop.agent.confirmAll", false) ? "confirm" : "free");

    if (frame) tell(run, "point", frame);
    if (risk !== "free") {
      log(`agent ${run.tag}: ${verb} needs a yes (${risk}; server said ${clip(str(a.risk), 10) || "nothing"})`);
      const yes = await confirm(run, confirmText(a, target), risk);
      if (!alive(run)) return null;
      if (!yes) {
        pushHistory(run, { said, did, result: "declined" });
        if (frame) tell(run, "unpoint");
        finish(run, "done", TEXT.declined);
        return null;
      }
    }

    // KEYS GO WHEREVER FOCUS IS NOW, not where it was when the step was
    // planned. A click while the guide was asking, a notification taking
    // focus, a dialog opening: the keystrokes would land somewhere nobody
    // chose. So the focus is read again first, and a key or a paste only
    // goes ahead into the same element (role and label) it was planned for.
    if (a.kind === "key" || a.kind === "type") {
      const nowSnap = await race(run, takeSnapshot());
      if (!alive(run)) return null;
      // The same field in a window that is now private (one of theirs opened
      // while the guide was asking) is still not one to type in.
      if (refusal(nowSnap)) {
        if (frame) tell(run, "unpoint");
        adoptChecked(run, nowSnap);
        return null;
      }
      const moved = focusMoved(run.snapshot, nowSnap);
      if (moved) {
        log(`agent ${run.tag}: ${verb} not sent: focus moved since the step was planned`);
        if (frame) tell(run, "unpoint");
        if (!adoptChecked(run, nowSnap)) return null;
        pushHistory(run, { said, did, result: "failed", note: moved });
        return {};
      }
    }

    // The marks were drawn on the screen this is about to change, and would
    // be left pointing at whatever moves there next. The ring on the target
    // stays; the next step's answer draws on the screen it finds.
    clearMarks(run);
    run.seen.set(print, (run.seen.get(print) || 0) + 1);
    tell(run, "state", "acting", acting(a, target));
    // From here the screen may change, and the picture taken at Alt twice
    // shows one that may no longer be there.
    run.acted = true;
    const r = await race(run, perform(run, a));
    if (!alive(run)) return null;
    // Give the app a moment to redraw before reading it again: a menu takes
    // a frame or two to open, a dialog longer.
    await race(run, sleep(num("desktop.agent.settleMs", 450)));
    if (!alive(run)) return null;
    if (frame) tell(run, "unpoint");

    const before = run.snapshot;
    const after = await race(run, takeSnapshot());
    if (!alive(run)) return null;
    if (!adoptChecked(run, after)) return null;

    const ok = !!r && r.ok === true;
    let note;
    if (ok) note = describeChange(before, after);
    else if (r && r.maybe === true) {
      // Not a failure the model should simply try again: what did change, if
      // anything, goes with it.
      const change = describeChange(before, after);
      note = clip("press may have happened" + (change && change !== "nochange" ? "; " + change : ""), 200);
    } else note = clip("failed" + (r && r.error ? ": " + squash(r.error) : ""), 200);
    const result = !ok ? "failed" : note === "nochange" ? "nochange" : "ok";
    const prev = run.history[run.history.length - 1];
    pushHistory(run, { said, did, result, note });
    log(`agent ${run.tag}: step ${run.step} ${verb} → ${result}`);
    if (ok && run.plan) { run.planDone = Math.min(run.planDone + 1, run.plan.length - 1); showPlan(run); }
    if (result === "nochange" && prev && prev.did === did && prev.result === "nochange") {
      stop(run, "stuck");
      return null;
    }
    return {};
  }

  /** The server's yes-or-no before it does something in a connected app. */
  async function approve(run, ev) {
    const card = approvalOf(ev);
    const showCard = guide && guide.approve;
    if (!card || typeof showCard !== "function" || typeof d.call !== "function") {
      log(`agent ${run.tag}: an approval with no card to ask it on`);
      // Its words are a label (ask.js), asked for here and never written here.
      let words = "";
      try { words = clip(squash(typeof d.approveElsewhere === "function" ? d.approveElsewhere() : ""), 240); } catch { /* none */ }
      finish(run, "done", words || undefined);
      return null;
    }
    // The person's time on the card is theirs, not the run's: the deadline
    // does not tick while it is up, and starts again if the run goes on.
    clearTimeout(run.deadlineTimer);
    run.deadline = Infinity;
    const asked = Promise.resolve().then(() => showCard.call(guide, card)).then((v) => (CARD_BUTTONS.includes(v) ? v : ""), (e) => {
      log(`agent ${run.tag}: guide.approve failed: ${errText(e)}`);
      return "";
    });
    const answer = await race(run, within(asked, num("desktop.agent.confirmMs", 30000), ""));
    if (!alive(run) || answer === ABORTED) return null;
    // No answer leaves it waiting, where Tasks can still say yes within the hour.
    if (!answer) { log(`agent ${run.tag}: approval unanswered`); finish(run, "done", card.after.left || undefined); return null; }
    const button = card.buttons.find((b) => b.id === answer);
    log(`agent ${run.tag}: approval ${answer}`);
    if (answer === "approve") tell(run, "state", "acting");
    const r = await race(run, within(
      Promise.resolve().then(() => d.call(button.call)).then((v) => (v && typeof v === "object" ? v : { status: 0, body: null }), (e) => {
        log(`agent ${run.tag}: approval call failed: ${errText(e)}`);
        return { status: 0, body: null };
      }),
      num("desktop.agent.approveCallMs", 25000), { status: 0, body: null },
    ));
    if (!alive(run) || r === ABORTED) return null;
    const body = r.body && typeof r.body === "object" ? r.body : {};
    const said = (v) => clip(squash(v), 240);
    if (r.status === 0) { finish(run, "error", TEXT.network); return null; }
    if (answer === "approve") {
      if (r.status === 200 && body.ok === true) {
        // The card's own "Done", and nothing of the app's answer (its ids,
        // links and raw words are for the server, not for the person).
        finish(run, "done", said(card.after.done) || undefined);
      } else {
        const why = r.status === 200 && body.error && typeof body.error === "object" ? body.error.message : body.message;
        finish(run, "error", said([r.status === 200 ? card.after.failed : "", why].filter(Boolean).join(" ")) || TEXT.failed);
      }
      return null;
    }
    // A no that arrives after the task has moved on (409) is still a no.
    if (r.status !== 200 && r.status !== 409) { finish(run, "error", said(body.message) || TEXT.failed); return null; }
    if (answer === "deny") { finish(run, "done", card.after.left || undefined); return null; }
    // Edit: this one is left, and what to change is asked for out loud.
    pushHistory(run, { said: run.said, did: "EDIT", result: "declined", note: card.preview });
    const again = num("desktop.agent.deadlineMs", 60000);
    run.deadline = now() + again;
    run.deadlineTimer = setTimeout(() => stop(run, "deadline"), again);
    return ask(run, { text: card.after.change });
  }

  async function ask(run, ev) {
    const question = clip(squash(ev.text), 240);
    pushHistory(run, { said: run.said, did: "ASK", note: question });
    if (question) tell(run, "say", question, sayOpts(""));
    tell(run, "state", "listening");
    let audio = null;
    try {
      if (typeof d.listen === "function") audio = await race(run, Promise.resolve().then(() => d.listen()));
    } catch (e) {
      log(`agent ${run.tag}: listen failed: ${errText(e)}`);
    }
    if (!alive(run)) return null;
    if (!hasAudio(audio)) { log(`agent ${run.tag}: no reply`); finish(run, "quiet"); return null; }
    return { audio };
  }

  /** One request and its stream. The next input, or null when the run ended. */
  async function step(run, input) {
    // Each answer draws on the screen it finds. What the last one drew and
    // nothing has cleared (an ASK's numbered choices, once they have picked
    // one; the marks of a step whose action never ran) goes before the next
    // is asked for: left up, the same mark is drawn again on top of itself.
    clearMarks(run);
    if (run.step > 0) tell(run, "state", "thinking");
    run.says = 0;
    const audio = input.audio || null;
    const image = input.image || null;
    run.fresh = !!audio || !!input.utterance;
    run.said = input.utterance ? clip(squash(input.utterance), 1000) : "";
    const req = buildRequest(run, input);
    if (image) {
      run.pictureSent = true;
      // Where the picture is, for the answer's marks in it. Never sent.
      run.pictureFrame = isFrame(input.pictureFrame) ? input.pictureFrame.slice() : null;
    }
    log(`agent ${run.tag}: step ${run.step} (${audio ? "audio" : "text"}${image ? " + picture" : ""}, ${req.screen.elements.length} elements)`);

    let source;
    try {
      source = d.post(req, audio, run.controller.signal, image);
      if (source && typeof source.then === "function") source = await race(run, source);
    } catch (e) {
      if (!alive(run)) return null;
      log(`agent ${run.tag}: post failed: ${errText(e)}`);
      finish(run, "error", TEXT.network);
      return null;
    }
    if (!alive(run)) return null;
    const it = iteratorOf(source);
    if (!it) { finish(run, "error", TEXT.failed); return null; }

    let terminal = null;
    try {
      for (;;) {
        const r = await race(run, it.next());
        if (!alive(run) || r === ABORTED) return null;
        if (!r || r.done) break;
        const ev = r.value;
        if (!ev || typeof ev !== "object" || typeof ev.t !== "string") continue;
        if (TERMINAL.has(ev.t)) { terminal = ev; break; }
        onEvent(run, ev);
      }
    } catch (e) {
      if (!alive(run)) return null;
      log(`agent ${run.tag}: stream broke: ${errText(e)}`);
      terminal = { t: "error", code: "network", message: TEXT.network };
    } finally {
      // Exactly one terminal event ends a stream; anything after it is not
      // read, and the connection is let go.
      close(it);
    }

    // The answer is in. A tentative ring it did not replace was a guess
    // (preview's, or the picture's "Looking"), and goes now.
    dropTentative(run);
    if (!terminal) {
      log(`agent ${run.tag}: stream ended with no answer`);
      finish(run, "error", TEXT.incomplete);
      return null;
    }
    switch (terminal.t) {
      case "look":
        return lookAgain(run, input);
      case "done": {
        if (run.plan) { run.planDone = run.plan.length; showPlan(run); }
        // DONE's words are the card's whole text, in place of what it said;
        // after an answer said a sentence at a time, they come after it
        // instead. Words with no letter or digit in them ("DONE.") are none.
        const text = clip(squash(terminal.text), 240);
        const words = /[\p{L}\p{N}]/u.test(text) ? text : "";
        if (words && run.says) { tell(run, "say", words, sayOpts("", true)); finish(run, "done"); } else finish(run, "done", words);
        return null;
      }
      case "error":
        log(`agent ${run.tag}: server error ${clip(str(terminal.code), 40)}`);
        finish(run, "error", clip(squash(terminal.message), 240) || TEXT.failed);
        return null;
      case "ask":
        return ask(run, terminal);
      case "approve":
        return approve(run, terminal);
      default:
        return act(run, terminal);
    }
  }

  // ---- the picture path -------------------------------------------------------

  /** Whether pictures of this run's app may go: "never", "always" or "ask"
   *  (anything else is asked about too). "never" with no way to send one. */
  async function picturePolicy(run) {
    if (!canPicture) return "never";
    let policy;
    try {
      policy = await race(run, Promise.resolve().then(() => d.pictures(appLabel(run))));
    } catch (e) {
      log(`agent ${run.tag}: pictures() failed: ${errText(e)}`);
      return "never";
    }
    return policy === "never" || policy === "always" ? policy : "ask";
  }

  /** The person's say for this app, on the guide's permission card: once,
   *  always, or no. Asked at most once a run, and a card nobody answers
   *  within confirmMs is a no, as a confirm is. While the card asks, what
   *  would go is ringed on the screen, and the card is told whether it is
   *  one image or the whole window: "this part of the screen" is a part they
   *  can see. A no takes the ring away with it. */
  async function askPermission(run, pic) {
    if (run.permit) return run.permit !== "no";
    if (typeof d.permit !== "function") return false;
    ringPicture(run, pic);
    const region = pic.picture.region;
    const asked = Promise.resolve().then(() => d.permit(appLabel(run), { region })).then((v) => v, (e) => {
      log(`agent ${run.tag}: permit() failed: ${errText(e)}`);
      return "no";
    });
    const answer = await race(run, within(asked, num("desktop.agent.confirmMs", 30000), "no"));
    if (!alive(run)) return false;
    run.permit = answer === "once" || answer === "always" ? answer : "no";
    log(`agent ${run.tag}: picture ${run.permit === "no" ? "not allowed" : `allowed (${run.permit})`}`);
    if (run.permit === "no") dropTentative(run);
    return run.permit !== "no";
  }

  /** The part of the window a picture is of, ringed lightly as "Looking":
   *  once, from when the card asks about it (or, with no card to ask, when it
   *  goes) until the answer comes. */
  function ringPicture(run, pic) {
    if (pic.ringed) return;
    pic.ringed = true;
    run.previewKey = "";
    run.tentative = true;
    tell(run, "point", pic.frame, TEXT.looking, { tentative: true });
  }

  /** The part of the look's picture the question is about, cropped here:
   *  { image, picture, frame }, or null when there is none to send. Only the
   *  picture taken at Alt twice, and only while the screen is still the one
   *  it shows (nothing has been done to it). */
  async function cropPicture(run) {
    const look = run.look;
    if (!canPicture || !look || !look.image || run.acted) return null;
    const { frame, region } = pictureRegion(run.snapshot, look, run.pointer);
    let file;
    try {
      file = await race(run, Promise.resolve().then(() => d.crop(look, frame)));
    } catch (e) {
      log(`agent ${run.tag}: crop failed: ${errText(e)}`);
      return null;
    }
    if (!alive(run)) return null;
    // Only the three types the server takes: another would go labelled as a
    // JPEG (pictureFile) and be answered about as noise.
    if (!file || typeof file !== "object" || !hasBytes(file.data) || !/^image\/(?:jpe?g|png|webp)\b/i.test(str(file.mime))) {
      log(`agent ${run.tag}: crop gave no picture`);
      return null;
    }
    if (byteSize(file.data) > MAX_PICTURE_BYTES) {
      log(`agent ${run.tag}: the picture is too big to send (${byteSize(file.data)} bytes)`);
      return null;
    }
    // Where the picture really is: what the crop really cut (the region kept
    // to the window, in whole pixels of the picture), and the answer's places
    // in the picture are places in what was sent. A region too small to crop
    // is no picture at all (pictureRegion grows one to MIN_CROP_PX first).
    const shows = isFrame(file.frame) && file.frame[2] > 0 && file.frame[3] > 0 ? file.frame.slice() : frame;
    return { image: { mime: str(file.mime).toLowerCase(), data: file.data }, picture: { region }, frame: shows };
  }

  /** The picture for this step, if the person's policy and answer allow it:
   *  the crop is made first (nothing leaves this computer for it), so a card
   *  asking to send it never comes up for a picture there is not. */
  async function allowedPicture(run) {
    const policy = await picturePolicy(run);
    if (!alive(run) || policy === "never") return null;
    const pic = await cropPicture(run);
    if (!pic || !alive(run)) return null;
    if (policy === "ask" && !(await askPermission(run, pic))) return null;
    return alive(run) ? pic : null;
  }

  /** What is being looked at, on the screen and on the card, and the step
   *  input that sends it. */
  function withPicture(run, pic, input) {
    ringPicture(run, pic);
    tell(run, "badge", TEXT.pictureSent);
    return Object.assign({}, input, { image: pic.image, picture: pic.picture, pictureFrame: pic.frame });
  }

  /**
   * The text path's answer was LOOK: it needs to see the picture. The same
   * step goes again with it — once a run, with the same permission as ever,
   * and only while the picture still shows the screen. Otherwise the card
   * says it can't, and the run ends.
   */
  async function lookAgain(run, input) {
    log(`agent ${run.tag}: the answer needs the picture`);
    const pic = !run.pictureSent && !run.acted && run.look && run.look.image ? await allowedPicture(run) : null;
    if (!alive(run)) return null;
    if (!pic) {
      // No look at all because the Mac has not let Tailzu see the screen:
      // said so, with the way to it, rather than a "can't" they cannot act
      // on. The helper never asks for the permission itself (tzax.swift).
      // Not for an app whose pictures are set never to go.
      const noScreen = !run.look && !!run.lookSeen && run.lookSeen.error === "no_screen_permission" && !picturesNever(run);
      tell(run, "say", noScreen ? TEXT.needScreen : TEXT.needLook, sayOpts(""));
      if (noScreen) {
        log(`agent ${run.tag}: no Screen Recording permission`);
        tell(run, "offer", "screenSettings");
      }
      finish(run, "done");
      return null;
    }
    // The answer comes again, from the picture, with marks of its own; what
    // the text answer drew goes first.
    clearMarks(run);
    // The words of this step (the server heard them already), so they are
    // not transcribed twice; the recording again only when there are none.
    const words = run.said || run.goal;
    const again = words ? { utterance: words } : { audio: input.audio || null, utterance: input.utterance };
    return Object.assign(withPicture(run, pic, again), { sameStep: true });
  }

  // ---- the first step -------------------------------------------------------------

  /** "Where's Export?" answered here: the ring on it, "Here's Export.", and
   *  done — no request at all. False when its frame is gone. */
  function instant(run, text, m) {
    const frame = run.frames.get(m.id);
    if (!frame) return false;
    const label = squash(m.label);
    run.goal = text;
    run.mode = "show";
    tell(run, "heard", text);
    tell(run, "say", clip(`Here's ${label.replace(/[\s.…:]+$/u, "")}.`, 240), sayOpts(""));
    run.tentative = false;
    tell(run, "point", frame, clip(label, 120));
    log(`agent ${run.tag}: instant (${clip(m.id, 12)}, score ${m.score.toFixed(2)}, margin ${m.margin.toFixed(2)})`);
    finish(run, "done");
    return true;
  }

  /**
   * Step 0's input, by the three paths, cheapest first: answered here
   * (instant; null, the run is over), a picture with the question, or the
   * words — the live caption's when there are some, else the recording.
   *
   * Only the stream's final caption is the question. One it had not finished
   * (`final` false: its last words were still to come when it was stopped)
   * may be missing the end ("where is the save" of "…save as") and its
   * question mark with it, so nothing that cannot be taken back is done on
   * it: no instant answer, no picture. The recording goes instead, and is
   * heard whole; only with no recording do those words go.
   */
  async function firstInput(run, first) {
    if (first.utterance) return { utterance: first.utterance };
    const text = first.text || "";
    const audio = first.audio || null;
    const final = first.final === true;
    if (text && final && bool("desktop.agent.instant", true)) {
      const m = matchOn(text, run.snapshot);
      if (m && m.intent === "show" && instant(run, text, m)) return null;
    }
    // Only a question with words: a recording nobody has transcribed yet
    // cannot say whether it is about a picture, and no picture goes on a guess.
    if (text && final && run.look && run.look.image && resolver.isVisualQuestion(text, names())) {
      const pic = await allowedPicture(run);
      if (!alive(run)) return null;
      if (pic) {
        run.goal = text;
        return withPicture(run, pic, { utterance: text });
      }
    }
    if (text && (!audio || (final && bool("desktop.agent.useStreamText", true)))) {
      run.goal = text;
      return { utterance: text };
    }
    return audio ? { audio } : null;
  }

  async function loop(run, first) {
    run.started = true;
    tell(run, "state", "thinking");
    const deadlineMs = num("desktop.agent.deadlineMs", 60000);
    run.deadline = now() + deadlineMs;
    // Checked between steps on the injected clock, and enforced by a timer
    // as well, for a stream that hangs without ever closing.
    // (Not unref'd: for a stream that hangs, it is the one thing left that
    // will wake the run. Every way a run ends clears it.)
    run.deadlineTimer = setTimeout(() => stop(run, "deadline"), deadlineMs);
    try {
      // The screen was being read, both ways, while they spoke; the first
      // step waits for it (never past each read's own timeout). A failed read
      // still asks — "what does this error mean?" can be answered from the
      // words alone. Both are checked before anything of them is used: a
      // private window's picture is as private as its tree.
      const got = await race(run, Promise.all([run.snapPromise, run.lookPromise]));
      if (!alive(run) || got === ABORTED) return;
      const [snap, look] = got;
      const screen = firstScreen(run, snap, look);
      if (screen.why) { refuseScreen(run, screen.why); return; }
      adopt(run, screen.screen);
      run.look = screen.look || null;
      if (look && look.ok !== true && look.error !== "off" && look.error !== "unsupported") {
        log(`agent ${run.tag}: no look (${clip(squash(look.error), 40)})`);
      }
      let input = await firstInput(run, first);
      if (!alive(run)) return;
      if (!input) { finish(run, "quiet"); return; }
      const maxSteps = Math.max(1, num("desktop.agent.maxSteps", 8));
      while (alive(run)) {
        if (run.step >= maxSteps) { stop(run, "steps"); return; }
        if (now() >= run.deadline) { stop(run, "deadline"); return; }
        const next = await step(run, input);
        if (!next || !alive(run)) return;
        input = next;
        // The same step again, with the picture it asked for.
        if (!next.sameStep) run.step++;
      }
    } catch (e) {
      log(`agent ${run.tag}: run failed: ${errText(e)}`);
      finish(run, "error", TEXT.failed);
    }
  }

  /**
   * Alt twice. Refused outright for a private window or a sensitive app —
   * nothing is read. Otherwise the guide starts listening and the screen is
   * read at the same time, while they are still speaking: the tree, and a
   * look at the window (its text and its picture), in parallel.
   * @param {{ app?: string, privateField?: boolean, sensitive?: boolean, pointer?: { x: number, y: number } }} [opts]
   *        `pointer` in the driver's units (Windows: physical pixels)
   * @returns {boolean} whether a run began
   */
  function begin(opts) {
    const o = opts || {};
    if (current) cancel("restart");
    // The last answer's card, still up (still being said, or in its doneMs),
    // is this question's now: nothing of the last run puts it away.
    unscheduleHide();
    // The last answer's marks may still be up beside its card: this question
    // starts on a clean screen, refused or not.
    callGuide("clear");
    if (o.privateField || o.sensitive) {
      log(`agent: refused (${o.privateField ? "private window" : "sensitive app"})`);
      callGuide("error", [o.privateField ? TEXT.private : TEXT.sensitive]);
      scheduleHide();
      return false;
    }
    const p = o.pointer;
    const pointer = p && typeof p.x === "number" && typeof p.y === "number" && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null;
    const controller = new AbortController();
    const id = crypto.randomUUID().replace(/-/g, "");
    const run = {
      token: ++seq, id, tag: id.slice(0, 8), controller,
      aborted: new Promise((resolve) => controller.signal.addEventListener("abort", () => resolve(ABORTED), { once: true })),
      over: false, started: false, stop: "",
      app: clip(squash(o.app), 60), firstApp: "",
      snapshot: { ok: false, error: "not read yet", elements: [] }, frames: new Map(), byId: new Map(),
      mode: null, step: 0, history: [], goal: "", said: "", fresh: false, lastHeard: "", seen: new Map(),
      plan: null, planDone: 0, deadline: 0, deadlineTimer: null, snapPromise: null, lookPromise: null,
      pointer, look: null, snapSeen: null, lookSeen: null, previewCache: null, previewKey: "", tentative: false,
      acted: false, pictureSent: false, permit: "", pictureFrame: null, marks: 0, says: 0,
    };
    current = run;
    callGuide("show", ["listening", { app: run.app }]);
    // Kept as they arrive, for preview(), which cannot wait for them.
    run.snapPromise = takeSnapshot().then((s) => { run.snapSeen = s; return s; });
    run.lookPromise = takeLook(run).then((l) => { run.lookSeen = l; return l; });
    log(`agent ${run.tag}: begun`);
    return true;
  }

  /**
   * The live caption so far, while they are still speaking. A question or an
   * order that already names one thing on screen clearly puts a tentative
   * ring on it — moved when the target changes, put away when the words stop
   * naming one. Never acts, and never reads anything itself: only what the
   * reads begun at Alt twice have brought back, checked as the run's first
   * screen will be.
   */
  function preview(text) {
    const run = current;
    if (!run || run.started || run.over) return;
    if (!bool("desktop.agent.instant", true)) return;
    const screen = previewScreen(run);
    const words = clip(squash(text), 1000);
    const m = screen && words ? matchOn(words, screen.snapshot) : null;
    const frame = m && (m.intent === "show" || m.intent === "do") ? screen.frames.get(m.id) || null : null;
    const key = frame ? `${m.id}@${frame.join(",")}` : "";
    if (key === run.previewKey) return;
    run.previewKey = key;
    if (!frame) {
      if (run.tentative) { run.tentative = false; tell(run, "unpoint"); }
      return;
    }
    run.tentative = true;
    tell(run, "point", frame, clip(squash(m.label), 120), { tentative: true });
  }

  /**
   * They stopped speaking: step 0. `audio` is the recording; `opts.text` the
   * live caption's transcript of it (may be empty), `opts.final` whether that
   * is the stream's final text or only what it had so far. Resolves when the
   * run is over (nothing waits on it in main; the tests do).
   */
  function heard(audio, opts) {
    const run = current;
    if (!run || run.started) { log("agent: heard with no run waiting for it"); return Promise.resolve(); }
    const o = opts || {};
    const text = clip(squash(o.text), 1000);
    const clipIn = hasAudio(audio) ? audio : null;
    if (!clipIn && !text) { finish(run, "quiet"); return Promise.resolve(); }
    if (text) log(`agent ${run.tag}: heard with ${o.final === true ? "the final" : "a partial"} caption`);
    return loop(run, { audio: clipIn, text, final: o.final === true });
  }

  /** The same, with typed words instead of a recording. */
  function typed(text) {
    const run = current;
    if (!run || run.started) { log("agent: typed with no run waiting for it"); return Promise.resolve(); }
    const words = clip(squash(text), 1000);
    if (!words) { finish(run, "quiet"); return Promise.resolve(); }
    run.goal = words;
    return loop(run, { utterance: words });
  }

  /** Esc, the card's ×, Alt twice while running — whatever the integrator
   *  wires to it. Only ever called on purpose: the key hook cannot tell this
   *  run's own synthetic keys and clicks from the person's, so "they started
   *  typing" is not a signal this file listens for. The run stops where it
   *  is, its request is aborted and the guide goes away. */
  function cancel(reason) {
    unscheduleHide();
    const run = current;
    if (!run) { callGuide("hide"); return false; }
    run.over = true;
    current = null;
    clearTimeout(run.deadlineTimer);
    try { run.controller.abort(); } catch { /* already */ }
    log(`agent ${run.tag}: cancelled (${clip(squash(reason) || "cancel", 30)})`);
    callGuide("hide");
    return true;
  }

  function active() { return !!current; }

  return { begin, heard, typed, preview, cancel, active };
}

// ---- the network ------------------------------------------------------------

/** One line of the stream, or null for a blank or broken one. A line that is
 *  not an event is skipped rather than ending the run: a proxy's keep-alive,
 *  a stray newline, half a line the server never finished. */
function parseLine(line) {
  const s = line.trim();
  if (!s || s[0] !== "{") return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) && typeof v.t === "string" ? v : null;
  } catch {
    return null;
  }
}

/** No line of this protocol comes near this; a "line" this long with no
 *  newline is not one, and is dropped rather than held in memory. */
const MAX_LINE = 1 << 20;

/**
 * The events in an NDJSON body, as they arrive. Takes a fetch Response's body
 * (a web ReadableStream of bytes) or any async iterable of bytes or strings.
 * A chunk can end anywhere — mid-line, mid-character — so bytes are decoded
 * as a stream and lines are only cut at a newline. Errors from the stream
 * itself (a dropped connection, an abort) are thrown to the reader.
 */
async function* readEvents(body) {
  if (!body) return;
  const decoder = new TextDecoder();
  let buf = "";
  function* lines(chunk, last) {
    buf += typeof chunk === "string" ? chunk : chunk ? decoder.decode(chunk, { stream: !last }) : decoder.decode();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const ev = parseLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (ev) yield ev;
    }
    if (last) {
      const ev = parseLine(buf);
      buf = "";
      if (ev) yield ev;
    } else if (buf.length > MAX_LINE) {
      buf = "";
    }
  }
  if (typeof body.getReader === "function") {
    const reader = body.getReader();
    let finished = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { finished = true; break; }
        yield* lines(value, false);
      }
      yield* lines(null, true);
    } finally {
      // Stopped early — a terminal event, a cancelled run: let the
      // connection go rather than read a body nobody wants.
      if (!finished) { try { reader.cancel().then(null, () => {}); } catch { /* gone */ } }
    }
    return;
  }
  if (typeof body[Symbol.asyncIterator] === "function") {
    for await (const chunk of body) yield* lines(chunk, false);
    yield* lines(null, true);
  }
}

/** The recording's file name and type, by its CONTAINER, which is what the
 *  server decodes by (the extension first). Opus is a codec that rides in
 *  either: the recorder's "audio/webm;codecs=opus" is a WebM file, and named
 *  .ogg it fails the server's speech measurement and goes to speech-to-text
 *  as the wrong format. A bare "audio/opus" is an Ogg Opus file. */
function audioFile(mime) {
  const m = str(mime).toLowerCase();
  if (/webm/.test(m)) return { name: "ask.webm", type: "audio/webm" };
  if (/ogg/.test(m) || /^audio\/opus\b/.test(m)) return { name: "ask.ogg", type: "audio/ogg" };
  if (/wav|wave/.test(m)) return { name: "ask.wav", type: "audio/wav" };
  if (/mp4|m4a|aac/.test(m)) return { name: "ask.m4a", type: "audio/mp4" };
  return { name: "ask.webm", type: "audio/webm" };
}

/** The picture's file name and type: the three the server takes, by the
 *  crop's own type. A JPEG unless it says otherwise. */
function pictureFile(mime) {
  const m = str(mime).toLowerCase();
  if (/png/.test(m)) return { name: "picture.png", type: "image/png" };
  if (/webp/.test(m)) return { name: "picture.webp", type: "image/webp" };
  return { name: "picture.jpg", type: "image/jpeg" };
}

const STATUS_TEXT = {
  400: "Ask couldn't read that request.",
  401: TEXT.signIn,
  413: "There's too much on this screen to read.",
  429: "Too many asks. Try again in a moment.",
};

/**
 * The `post` dependency, over fetch: POST {baseUrl}/v1/agent, answered as a
 * stream of events.
 *
 *   audio   multipart, a `request` field (the step as JSON) and the recording
 *           as `audio` — the request first, so the server has it before the
 *           file. Without audio, plain JSON.
 *   image   the picture path's one picture, as an `image` part after them
 *           (picture.jpg, .png or .webp by its type): multipart too, with or
 *           without audio. A JSON body never carries a picture.
 *   401     the token is spent whatever its expiry said; renewed once
 *           (token(true)) and the step sent again.
 *   errors  a refusal before streaming (400/401/413/429…) arrives as JSON;
 *           it becomes one { t:"error" } event, so the run handles every
 *           failure in one place. So does a request that never got there.
 *           An aborted one ends quietly: the run that made it is gone.
 *
 * @param {{ baseUrl: string|(() => string), token: (renew: boolean) => Promise<string|null>, fetch?: Function, path?: string }} opts
 */
function makePost(opts) {
  const o = opts || {};
  const fetchFn = o.fetch || globalThis.fetch;
  const path = o.path || "/v1/agent";
  async function tokenFor(renew) {
    try { return str(typeof o.token === "function" ? await o.token(renew) : o.token) || null; } catch { return null; }
  }
  return async function* post(request, audio, signal, image) {
    const base = str(typeof o.baseUrl === "function" ? o.baseUrl() : o.baseUrl).replace(/\/+$/, "");
    const withAudio = !!(audio && audio.data);
    const withImage = !!(image && hasBytes(image.data));
    const send = async (tok) => {
      const headers = { Accept: "application/x-ndjson" };
      if (tok) headers.Authorization = "Bearer " + tok;
      let body;
      if (withAudio || withImage) {
        body = new FormData();
        body.append("request", JSON.stringify(request));
        if (withAudio) {
          const given = typeof Blob !== "undefined" && audio.data instanceof Blob ? audio.data : null;
          const file = audioFile(audio.mime || (given && given.type));
          // Wrapped again (no copy) so the part's type is the plain container's,
          // agreeing with its name.
          const blob = new Blob([audio.data], { type: file.type });
          body.append("audio", blob, file.name);
        }
        if (withImage) {
          const given = typeof Blob !== "undefined" && image.data instanceof Blob ? image.data : null;
          const file = pictureFile(image.mime || (given && given.type));
          body.append("image", new Blob([image.data], { type: file.type }), file.name);
        }
      } else {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(request);
      }
      return fetchFn(base + path, { method: "POST", headers, body, signal });
    };

    let res;
    try {
      const first = await tokenFor(false);
      res = await send(first);
      if (res.status === 401) {
        const renewed = await tokenFor(true);
        if (renewed) {
          try { if (res.body && typeof res.body.cancel === "function") res.body.cancel().then(null, () => {}); } catch { /* gone */ }
          res = await send(renewed);
        }
      }
    } catch (e) {
      if (signal && signal.aborted) return;
      yield { t: "error", code: "network", message: TEXT.network };
      return;
    }

    if (res.status !== 200) {
      let code = "http_" + res.status;
      let message = "";
      try {
        const j = await res.json();
        if (j && typeof j.code === "string" && j.code) code = j.code;
        else if (j && typeof j.error === "string" && j.error) code = j.error;
        if (j && typeof j.message === "string") message = j.message;
      } catch { /* not JSON: the status says enough */ }
      // A 401 that survived a renewal means signed out; the server's words
      // for it ("Missing or invalid token") are not for a person.
      if (res.status === 401 || !message) message = STATUS_TEXT[res.status] || TEXT.failed;
      yield { t: "error", code, message: clip(squash(message), 240) };
      return;
    }

    try {
      yield* readEvents(res.body);
    } catch (e) {
      if (signal && signal.aborted) return;
      yield { t: "error", code: "network", message: TEXT.network };
    }
  };
}

module.exports = {
  createAgent, safeOpenUrl, approvalOf, isTaskRoute, classifyRisk, maxRisk, regionOf, toRequestElements, frameMap, describeChange,
  ocrElements, pictureRegion, resolveMark, readEvents, makePost,
  MAX_ELEMENTS, MAX_HISTORY, RUN_DEADLINE_MS, MAX_PICTURE_BYTES, SCREEN_CHARS, TEXT,
};
