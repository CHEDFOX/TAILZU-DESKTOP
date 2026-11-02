// How risky an action is, worked out on this computer as well as by the
// server; the higher of the two decides whether it asks first.

const { str, squash, elementsOf, focusedOf, words, BROWSERS } = require("./helpers.js");

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
 * @param {{ startApp?: string|string[], said?: string, trusted?: boolean }} [ctx]  the app(s) the
 *        run began in (the snapshot's own app when not given), everything
 *        the person said in the run (nothing, when not given), and whether
 *        they asked for this task in so many words (the brain's task or send)
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

  // ASKED FOR ALREADY: a task or a message the person gave in so many words
  // (the one key's brain said task or send, and nothing in it moves money or
  // deletes). Its ordinary steps (the Enter that sends what they asked to
  // send, a press on a web page, opening the app the task is in) are what
  // they asked for, and are not asked about again. Words on the target, the
  // chords that close, quit or delete, and anything copied off the screen
  // still are.
  const asked = c.trusted === true;
  if (kind === "key") {
    const chord = parseChord(action.keys || action.text);
    risk = maxRisk(risk, chordRisk(chord));
    if (chord.key === "enter" && looksLikeComposer(focused) && !asked) risk = maxRisk(risk, "confirm");
    if (!takesText(focused) && (isPrintable(chord) || chord.key === "delete" || chord.key === "backspace")) {
      risk = maxRisk(risk, "confirm");
    }
  }

  if (kind === "type" && !takesText(focused)) risk = maxRisk(risk, "confirm");

  if (kind === "press" && !asked && BROWSERS.test(squash(snapshot && snapshot.app && snapshot.app.name))) {
    risk = maxRisk(risk, "confirm");
  }

  if (kind === "open" && !asked) {
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

module.exports = { maxRisk, appWords, sameApp, classifyRisk };
