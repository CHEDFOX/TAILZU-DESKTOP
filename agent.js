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
// Pure logic with every dependency injected (the driver, the guide window, the
// network, the clipboard paste, the microphone, the clock), so a whole run can
// be played in a test without Electron, a screen or a server.

const crypto = require("crypto");
const frontApp = require("./frontApp.js");

/** The server takes this many elements and answers 413 above it. */
const MAX_ELEMENTS = 250;
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

const TERMINAL = new Set(["action", "ask", "done", "error"]);
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
  network: "Couldn't reach Tailzu.",
  incomplete: "The answer was cut off. Try again?",
  failed: "Something went wrong.",
  signIn: "Sign in to Tailzu to use Ask.",
};

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

/**
 * The snapshot's elements as the server takes them: id, role, label, short
 * value, region and the state flags — and nothing that says where on the
 * screen they are (no frame, ever). A password field keeps its place in the
 * list, so the model can say "type it there", but never a value. A window's
 * label is its title, which is exactly what must not leave, so a window goes
 * without one. An address bar goes without its value — the whole URL of the
 * page, logged-in links and all — and every other URL loses its query.
 */
function toRequestElements(snapshot, max = MAX_ELEMENTS) {
  const cap = Math.max(0, Math.min(MAX_ELEMENTS, Number.isFinite(max) ? Math.floor(max) : MAX_ELEMENTS));
  const win = snapshot && snapshot.window && snapshot.window.frame;
  const focusedId = snapshot && snapshot.focused;
  const seen = new Set();
  const out = [];
  for (const e of elementsOf(snapshot)) {
    if (out.length >= cap) break;
    const id = str(e.id);
    if (!/^e\d+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
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
    out.push(el);
  }
  return out;
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

  const a = elementsOf(before);
  const b = elementsOf(after);
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

/**
 * @param {object} deps
 * @param {object} deps.driver   the §1 driver API
 * @param {object} deps.guide    { show, state, heard, say, point, unpoint, steps, confirm, hide, error }
 * @param {(req: object, audio: object|null, signal: AbortSignal) => AsyncIterable<object>|Promise<AsyncIterable<object>>} deps.post
 * @param {(text: string) => Promise<void>} deps.paste
 * @param {() => Promise<{mime: string, data: Buffer}|null>} deps.listen
 * @param {(name: string, fallback: any) => any} [deps.knob]
 * @param {"mac"|"win"} [deps.platform]
 * @param {() => number} [deps.now]
 * @param {(line: string) => void} [deps.log]
 * @param {(appName: string) => boolean} [deps.sensitive]  defaults to frontApp.looksSensitive
 * @param {string|(() => string)} [deps.language]
 */
function createAgent(deps) {
  const d = deps || {};
  const driver = d.driver || {};
  const guide = d.guide || {};
  const knob = typeof d.knob === "function" ? d.knob : (_name, fallback) => fallback;
  const now = typeof d.now === "function" ? d.now : Date.now;
  const platform = d.platform === "win" || d.platform === "mac" ? d.platform : process.platform === "win32" ? "win" : "mac";
  const sensitive = typeof d.sensitive === "function" ? d.sensitive : frontApp.looksSensitive;

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

  /** The run in progress, or null. Everything a run does checks it is still
   *  this one, so a run that was cancelled or has finished can never touch
   *  the guide again, whatever arrives late on its stream. */
  let current = null;
  let seq = 0;
  let hideTimer = null;

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

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { hideTimer = null; if (!current) callGuide("hide"); }, Math.max(0, num("desktop.agent.doneMs", 9000)));
    // A timer that only tidies the screen need not keep a process alive.
    if (hideTimer && typeof hideTimer.unref === "function") hideTimer.unref();
  }

  /**
   * The run is over. `how`: "done" (the card says `text`, if any), "error"
   * (the card shows `text` as an error), "quiet" (hide now, nothing to say).
   * Done and error stay on screen for doneMs.
   */
  function finish(run, how, text) {
    if (!alive(run)) return;
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

  /** Make `snap` the screen the next request describes, with its own id maps.
   *  A failed read leaves an empty screen, not the last one: ids from an old
   *  walk would point at whatever has moved there since. */
  function adopt(run, snap) {
    if (!snap || snap.ok !== true) {
      log(`agent ${run.tag}: screen not read (${(snap && snap.error) || "no snapshot"}); asking without it`);
      run.snapshot = { ok: false, error: (snap && snap.error) || "no snapshot", elements: [] };
    } else {
      run.snapshot = snap;
      if (!run.firstApp && snap.app && snap.app.name) run.firstApp = str(snap.app.name);
    }
    run.frames = frameMap(run.snapshot);
    run.byId = new Map(elementsOf(run.snapshot).filter((e) => typeof e.id === "string").map((e) => [e.id, e]));
  }

  /** adopt(), unless the screen is now a sensitive app's — an OPEN, a link
   *  or a click of theirs landed in a bank or a password manager. Nothing of
   *  it is sent: the run ends here. False when it did. */
  function adoptChecked(run, snap) {
    if (snap && snap.ok === true && snap.app && snap.app.name && isSensitive(snap.app.name)) {
      log(`agent ${run.tag}: the front app is a sensitive one; stopping`);
      run.snapshot = { ok: false, error: "sensitive", elements: [] };
      run.frames = new Map();
      run.byId = new Map();
      finish(run, "done", TEXT.blocked);
      return false;
    }
    adopt(run, snap);
    return true;
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
    const screen = { elements: toRequestElements(snap, Math.min(MAX_ELEMENTS, num("desktop.agent.maxElements", 250))) };
    const focused = focusedOf(snap);
    if (snap.ok === true && typeof snap.selection === "string" && snap.selection && snap.selection.length <= 8000 && !(focused && focused.secure)) {
      screen.selection = snap.selection;
    }
    if (focused) {
      // The field's kind in dictation's own words (frontApp.kindOf), so the
      // server reads it the same way on both routes. Never a password's.
      const kind = frontApp.kindOf(focused.role, focused.secure ? "secure" : "", focused.label);
      if (kind && kind !== "password") {
        screen.field = { kind };
        const label = clip(squash(focused.label), 80);
        if (label) screen.field.label = label;
      }
    }
    if (snap.ok === true && typeof snap.text === "string" && snap.text.trim()) screen.text = stripUrls(snap.text).slice(0, 4000);
    const req = { runId: run.id, step: run.step, platform, app: appLabel(run), screen, tzOffsetMinutes: -new Date().getTimezoneOffset() };
    // With audio, the audio is the words (step 0, or the reply to an ASK).
    // Without, the run's goal goes again: the server keeps nothing between
    // steps, so every step says what the run is for.
    if (!input.audio) {
      const utterance = clip(squash(input.utterance || run.goal), 1000);
      if (utterance) req.utterance = utterance;
    }
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

  const sayOpts = (locale) => {
    const o = { speak: bool("desktop.agent.speak", true), rate: num("desktop.agent.voiceRate", 1.04) };
    if (locale) o.locale = locale;
    return o;
  };

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
        const text = squash(ev.text);
        if (text) tell(run, "say", clip(text, 240), sayOpts(typeof ev.locale === "string" ? ev.locale : ""));
        break;
      }
      case "point": {
        const frame = run.frames.get(str(ev.id));
        if (!frame) { log(`agent ${run.tag}: point at ${clip(str(ev.id), 12)} skipped: not on this screen`); break; }
        const caption = squash(ev.caption);
        if (caption) tell(run, "point", frame, clip(caption, 120)); else tell(run, "point", frame);
        break;
      }
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
      default: break;   // a newer server's event this build does not know
    }
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
    const focus = await drive("focus", id);
    if (focus.ok !== true) return { ok: false, error: focus.error || "couldn't focus it" };
    if (!alive(run)) return { ok: false, error: "cancelled" };
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
      const moved = focusMoved(run.snapshot, nowSnap);
      if (moved) {
        log(`agent ${run.tag}: ${verb} not sent: focus moved since the step was planned`);
        if (frame) tell(run, "unpoint");
        if (!adoptChecked(run, nowSnap)) return null;
        pushHistory(run, { said, did, result: "failed", note: moved });
        return {};
      }
    }

    run.seen.set(print, (run.seen.get(print) || 0) + 1);
    tell(run, "state", "acting", acting(a, target));
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
    const note = ok ? describeChange(before, after) : clip("failed" + (r && r.error ? ": " + squash(r.error) : ""), 200);
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
    if (run.step > 0) tell(run, "state", "thinking");
    const audio = input.audio || null;
    run.fresh = !!audio || !!input.utterance;
    run.said = input.utterance ? clip(squash(input.utterance), 1000) : "";
    const req = buildRequest(run, input);
    log(`agent ${run.tag}: step ${run.step} (${audio ? "audio" : "text"}, ${req.screen.elements.length} elements)`);

    let source;
    try {
      source = d.post(req, audio, run.controller.signal);
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

    if (!terminal) {
      log(`agent ${run.tag}: stream ended with no answer`);
      finish(run, "error", TEXT.incomplete);
      return null;
    }
    switch (terminal.t) {
      case "done":
        if (run.plan) { run.planDone = run.plan.length; showPlan(run); }
        finish(run, "done", clip(squash(terminal.text), 240));
        return null;
      case "error":
        log(`agent ${run.tag}: server error ${clip(str(terminal.code), 40)}`);
        finish(run, "error", clip(squash(terminal.message), 240) || TEXT.failed);
        return null;
      case "ask":
        return ask(run, terminal);
      default:
        return act(run, terminal);
    }
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
      // The screen was being read while they spoke; the first step waits for
      // it (never past its own timeout). A failed read still asks — "what
      // does this error mean?" can be answered from the words alone.
      const snap = await race(run, run.snapPromise);
      if (!alive(run)) return;
      if (!adoptChecked(run, snap)) return;
      let input = first;
      const maxSteps = Math.max(1, num("desktop.agent.maxSteps", 8));
      while (alive(run)) {
        if (run.step >= maxSteps) { stop(run, "steps"); return; }
        if (now() >= run.deadline) { stop(run, "deadline"); return; }
        const next = await step(run, input);
        if (!next || !alive(run)) return;
        input = next;
        run.step++;
      }
    } catch (e) {
      log(`agent ${run.tag}: run failed: ${errText(e)}`);
      finish(run, "error", TEXT.failed);
    }
  }

  /**
   * Alt twice. Refused outright for a private window or a sensitive app —
   * nothing is read. Otherwise the guide starts listening and the screen is
   * read at the same time, while they are still speaking.
   * @param {{ app?: string, privateField?: boolean, sensitive?: boolean }} [opts]
   * @returns {boolean} whether a run began
   */
  function begin(opts) {
    const o = opts || {};
    if (current) cancel("restart");
    clearTimeout(hideTimer);
    hideTimer = null;
    if (o.privateField || o.sensitive) {
      log(`agent: refused (${o.privateField ? "private window" : "sensitive app"})`);
      callGuide("error", [o.privateField ? TEXT.private : TEXT.sensitive]);
      scheduleHide();
      return false;
    }
    const controller = new AbortController();
    const id = crypto.randomUUID().replace(/-/g, "");
    const run = {
      token: ++seq, id, tag: id.slice(0, 8), controller,
      aborted: new Promise((resolve) => controller.signal.addEventListener("abort", () => resolve(ABORTED), { once: true })),
      over: false, started: false, stop: "",
      app: clip(squash(o.app), 60), firstApp: "",
      snapshot: { ok: false, error: "not read yet", elements: [] }, frames: new Map(), byId: new Map(),
      mode: null, step: 0, history: [], goal: "", said: "", fresh: false, lastHeard: "", seen: new Map(),
      plan: null, planDone: 0, deadline: 0, deadlineTimer: null, snapPromise: null,
    };
    current = run;
    callGuide("show", ["listening", { app: run.app }]);
    run.snapPromise = takeSnapshot();
    log(`agent ${run.tag}: begun`);
    return true;
  }

  /** The recording finished: step 0 with that audio. Resolves when the run
   *  is over (nothing waits on it in main; the tests do). */
  function heard(audio) {
    const run = current;
    if (!run || run.started) { log("agent: heard with no run waiting for it"); return Promise.resolve(); }
    if (!hasAudio(audio)) { finish(run, "quiet"); return Promise.resolve(); }
    return loop(run, { audio });
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
    clearTimeout(hideTimer);
    hideTimer = null;
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

  return { begin, heard, typed, cancel, active };
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

function audioName(mime) {
  const m = str(mime).toLowerCase();
  if (/ogg|opus/.test(m)) return "ask.ogg";
  if (/wav|wave/.test(m)) return "ask.wav";
  if (/mp4|m4a|aac/.test(m)) return "ask.m4a";
  return "ask.webm";
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
  return async function* post(request, audio, signal) {
    const base = str(typeof o.baseUrl === "function" ? o.baseUrl() : o.baseUrl).replace(/\/+$/, "");
    const send = async (tok) => {
      const headers = { Accept: "application/x-ndjson" };
      if (tok) headers.Authorization = "Bearer " + tok;
      let body;
      if (audio && audio.data) {
        body = new FormData();
        body.append("request", JSON.stringify(request));
        const blob = typeof Blob !== "undefined" && audio.data instanceof Blob
          ? audio.data
          : new Blob([audio.data], { type: str(audio.mime) || "audio/webm" });
        body.append("audio", blob, audioName(audio.mime || blob.type));
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
  createAgent, classifyRisk, maxRisk, regionOf, toRequestElements, frameMap, describeChange,
  readEvents, makePost,
  MAX_ELEMENTS, MAX_HISTORY, RUN_DEADLINE_MS, TEXT,
};
