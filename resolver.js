// THE FREE ANSWER, ON THIS COMPUTER: "where's Export?" against the screen.
//
// Most of what people ask Ask is a name they can already read off the screen,
// said back. That needs a string match, not a model, as long as the match is
// unmistakable — and done here, it needs no server either: the ring can be up
// while they are still saying the word, and a question that matches is
// answered the moment they stop. So the bar is the server's, and high on both
// sides: the best label has to score 0.85 or more AND beat the next one by 0.2.
// Two buttons called "Save", or a label that is only roughly what they said,
// are exactly the cases where a wrong guess would point at the wrong thing,
// and those go to the server, which can see the regions and ask.
//
// A port of the server's own (tulmi src/agent/resolver.ts, and the fillers
// and show/do detection of src/agent/grammar.ts), with the same lists and the
// same thresholds, so a question gets the same answer on either side. Keep
// them in step: a change there is a change here.
//
// Also here: whether a question is about something only a picture shows ("explain
// this equation", "what does this chart show", "solve this", "what's this"),
// which no list of labels can answer.

/** The best label's score has to reach this… */
const ACCEPT_AT = 0.85;
/** …and beat the runner-up's by this much. */
const MARGIN = 0.2;
/** The names it answers to when none are given: its own, and the guide's. */
const NAMES = ["Tailzu", "Blip"];

const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));

// ---- what they said, without the padding ----------------------------------------

/** Lowercase words, the punctuation commands never need gone. Keeps what a
 *  chord or a channel is spelled with: "+", "#", "@", "'" and ".". */
function plainWords(s) {
  return str(s)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{M}\p{N}\s'#@+.-]/gu, " ")
    .replace(/(?<=\S)[.](?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const HEAD_FILLER = /^(?:u+m+|u+h+|uhm+|e+r+m*|h+m+|ok(?:ay)?|so|well|hey|hi|yo|alright|and|now|just|please|pls|kindly|actually)\b[\s,]*/;
const HEAD_ASK = /^(?:can you|could you|would you|will you|can u|could u|i want you to|i'd like you to|i need you to|go ahead and)\b\s*/;
const TAIL = /\s*\b(?:please|pls|thanks|thank you|for me|now|right now|quickly|okay|ok|again)$/;

/**
 * What they said with the padding gone, for matching: "Hey Tailzu, um, can
 * you scroll down please?" is "scroll down". `names` are the names it
 * answers to (its own, and the one they gave it).
 */
function commandText(said, names = NAMES) {
  let s = plainWords(said);
  const named = (Array.isArray(names) ? names : []).map((n) => plainWords(n)).filter(Boolean).map(escapeRe);
  const NAME = named.length ? new RegExp(`^(?:${named.join("|")})\\b[\\s,]*`) : null;
  for (let i = 0; i < 8; i++) {
    const before = s;
    s = s.replace(HEAD_FILLER, "").replace(HEAD_ASK, "");
    if (NAME) s = s.replace(NAME, "");
    s = s.replace(TAIL, "").trim();
    if (s === before) break;
  }
  return s;
}

/**
 * A question or a request to be shown, by its first words. Questions in
 * English open with the question; in Hinglish the question word comes late,
 * so those are found anywhere. A question mark after a sentence that does not
 * open as a polite request counts too. When in doubt this says "show", which
 * is the safe side: a show run never acts.
 */
const SHOW_OPENING = /^(?:where|how|what|whats|what's|why|which|who|whose|when|is there|are there|is it|is this|is that|does|do i|do you|did|can i|could i|should i|am i|show me|point|find|locate|explain|tell me|help me (?:find|understand)|i can'?t find|i cannot find|i don'?t see|i do not see|look for|wheres|where's|hows|how's)\b/;
const SHOW_ANYWHERE = /\b(?:kahan|kahaan|kaha|kidhar|kaise|kaisa|kyun|kyu|kaun sa|kaunsa)\b|कहाँ|कहां|किधर|कैसे|क्यों|कौन सा/u;
const POLITE_REQUEST = /^(?:\W*)(?:hey\s+\S+[\s,]+)?(?:please\s+)?(?:can|could|would|will) (?:you|u)\b/i;

function modeOf(said, names = NAMES) {
  const clean = commandText(said, names);
  if (SHOW_OPENING.test(clean) || SHOW_ANYWHERE.test(clean)) return "show";
  if (/\?\s*$/.test(str(said)) && !POLITE_REQUEST.test(str(said).trim())) return "show";
  return "do";
}

// ---- the label resolver -------------------------------------------------------

const POINT_ASK = /^(?:where(?:'s| is| are|s)?|where can i find|where do i find|point (?:at|to)|show me(?: where)?(?: the)?|find|locate|look for|help me find|i can'?t find|i cannot find)\s+(.+)$/;
const PRESS_ASK = /^(?:click on|click|press|tap on|tap|hit|select|choose|open)\s+(.+)$/;

/** Role words people say, and the roles they mean. */
const ROLE_WORDS = {
  button: ["button"], link: ["link"], tab: ["tab"], menu: ["menu", "menuitem"],
  option: ["menuitem", "item", "radio"], item: ["item", "menuitem", "row", "cell"],
  field: ["field", "area", "combo"], box: ["field", "area", "combo", "check"],
  checkbox: ["check"], toggle: ["switch", "check"], switch: ["switch", "check"],
  icon: ["button", "image", "link"], dropdown: ["combo", "menu"],
};
const hasRoleWord = (w) => Object.prototype.hasOwnProperty.call(ROLE_WORDS, w);

/**
 * What they asked of a named control, from the cleaned words: to be shown it
 * ("point") or to press it ("press"), the name they said ("export"), and the
 * kind of control they named, when they named one ("the export button").
 * Null when it is neither kind of ask.
 * @returns {{ verb: "point"|"press", target: string, roleHint: string|undefined }|null}
 */
function resolverAsk(clean) {
  let verb = null;
  let rest = "";
  const c = str(clean);
  let m = POINT_ASK.exec(c);
  if (m) { verb = "point"; rest = m[1]; }
  else if ((m = PRESS_ASK.exec(c))) { verb = "press"; rest = m[1]; }
  if (!verb) return null;
  let roleHint;
  let t = rest
    .replace(/\s+(?:is|are|located|at)$/, "")
    .replace(/\s+(?:on|in) (?:the|this) (?:screen|page|window|app)$/, "")
    .replace(/^(?:the|a|an|my|this|that)\s+/, "");
  const last = /\s(\w+)$/.exec(t);
  if (last && hasRoleWord(last[1])) { roleHint = last[1]; t = t.slice(0, last.index); }
  t = t.replace(/^(?:the|a|an|my|this|that)\s+/, "").trim();
  if (!t || t.split(" ").length > 6) return null;
  return { verb, target: t, roleHint };
}

/** Lowercase words without punctuation or accents, for comparing names. */
function nameWords(s) {
  return str(s).normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

const similarity = (a, b) => 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1);

/**
 * How well a label names what they said, 0..1: the better of the whole
 * strings' edit distance and their word overlap, where a word counts when it
 * is spelled within a letter or so ("exprot" for "export"). Speech gets
 * single words wrong far more often than it gets the order wrong.
 */
function labelScore(said, label) {
  const a = nameWords(said);
  const b = nameWords(label);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const aw = a.split(" ");
  const bw = b.split(" ");
  let matched = 0;
  const used = new Set();
  for (const w of aw) {
    let best = -1, bestSim = 0;
    bw.forEach((x, i) => {
      if (used.has(i)) return;
      const sim = w === x ? 1 : w.length >= 4 && x.length >= 4 ? similarity(w, x) : 0;
      if (sim > bestSim) { bestSim = sim; best = i; }
    });
    if (best >= 0 && bestSim >= 0.8) { used.add(best); matched += 1; }
  }
  const overlap = (2 * matched) / (aw.length + bw.length);
  return Math.max(overlap, similarity(a, b));
}

/** Roles a press is meant for. Static text and headings share their words
 *  with the button beside them, and are never what "click" means. */
const NOT_PRESSABLE = new Set(["text", "heading", "window"]);

/** A threshold from the caller (a knob), or the server's own. */
function bar(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * The one control their words name, or null when none does clearly enough.
 * Scores are lifted a little for the role they named and lowered for any
 * other; for a press, disabled controls and ones that are not pressed are
 * left out. `margin` is how far it beat the runner-up (its own score when
 * there was none).
 * @param {{ verb: string, target: string, roleHint?: string }} ask
 * @param {Array<{ id: string, role: string, label?: string, disabled?: boolean }>} elements
 * @param {{ score?: number, margin?: number }} [opts]  the bars, when not the server's
 * @returns {{ element: object, score: number, margin: number }|null}
 */
function resolve(ask, elements, opts) {
  if (!ask) return null;
  const o = opts || {};
  const acceptAt = bar(o.score, ACCEPT_AT);
  const margin = bar(o.margin, MARGIN);
  const roles = ask.roleHint && hasRoleWord(ask.roleHint) ? ROLE_WORDS[ask.roleHint] : [];
  const scored = [];
  for (const el of Array.isArray(elements) ? elements : []) {
    if (!el || typeof el !== "object" || !el.label) continue;
    if (ask.verb === "press" && (NOT_PRESSABLE.has(el.role) || el.disabled)) continue;
    let score = labelScore(ask.target, el.label);
    if (roles.length) score += roles.includes(el.role) ? 0.1 : -0.2;
    scored.push({ element: el, score: Math.min(1, score) });
  }
  scored.sort((x, y) => y.score - x.score);
  const [best, second] = scored;
  if (!best || best.score < acceptAt) return null;
  // A hair of slack: 1.0 against 0.8 is a clear margin, whatever the floats say.
  if (second && best.score - second.score < margin - 1e-9) return null;
  return { element: best.element, score: best.score, margin: second ? best.score - second.score : best.score };
}

/**
 * Their words against the screen, all in one: the element they named, how
 * sure, and what they want of it — "show" for a question about where it is,
 * "do" for an order to press it, null when the two disagree (a question mark
 * after "open export", or "where's export" said as an order), which is the
 * server's to sort out. Null when nothing is named clearly enough.
 *
 * The same rule as the server's: a question that asks where something is
 * matches only as "show", an order to press only as "do".
 *
 * @param {string} text  what they said (or have said so far)
 * @param {Array<{ id: string, role: string, label?: string }>} elements
 * @param {{ score?: number, margin?: number, names?: string[] }} [opts]
 * @returns {{ id: string, label: string, score: number, margin: number, intent: "show"|"do"|null }|null}
 */
function match(text, elements, opts) {
  const o = opts || {};
  const names = Array.isArray(o.names) ? o.names : NAMES;
  const said = str(text);
  if (!said.trim()) return null;
  const ask = resolverAsk(commandText(said, names));
  if (!ask) return null;
  const hit = resolve(ask, elements, o);
  if (!hit || typeof hit.element.id !== "string") return null;
  const mode = modeOf(said, names);
  const intent = ask.verb === "point" && mode === "show" ? "show" : ask.verb === "press" && mode === "do" ? "do" : null;
  return { id: hit.element.id, label: str(hit.element.label), score: hit.score, margin: hit.margin, intent };
}

// ---- a question about a picture -------------------------------------------------

// Things that are drawn rather than written: no label in an accessibility
// tree says what an equation, a chart or a photo shows.
const VISUAL_NOUNS = [
  "equations?", "formula[es]?", "integrals?", "derivatives?", "matri(?:x|ces)", "graphs?",
  // Not "figure out", which is no figure at all.
  "(?:bar |pie |line )?charts?", "plots?", "diagrams?", "figures?(?! out\\b)", "pictures?", "pics?", "images?",
  "photos?", "photographs?", "screenshots?", "drawings?", "sketch(?:es)?", "illustrations?",
  "infographics?", "flow ?charts?", "schematics?", "maps?", "memes?", "logos?", "icons?", "handwriting",
  "paintings?", "artworks?", "visuali[sz]ations?", "curves?", "histograms?", "geometry", "triangles?",
  "symbols?", "(?:maths?|geometry|physics|chemistry) (?:problem|question|sum)s?",
];
// …unless the noun is only naming a control: "the image button", "chart
// settings", "the map view".
const UI_AFTER = "(?:button|tab|menu|link|options?|settings?|field|box|toggle|switch|panel|tools?|toolbar|view|mode|type|format|editor|icon|bar|picker|size|file|folder|layer|style|filter)";
const VISUAL_NOUN = new RegExp(`\\b(?:${VISUAL_NOUNS.join("|")})\\b(?!\\s+${UI_AFTER}\\b)`);

// What is asked of a picture, besides an ordinary question.
const ABOUT_A_PICTURE = /^(?:describe|read|interpret|analy[sz]e|summari[sz]e|break down|walk me through|go through|transcribe|identify|translate|caption)\b|\b(?:samjhao|samjhaiye|samjha do|batao|bataiye)\b/;

// Working something out: only a picture of the sum says what it is.
const SOLVE = /\b(?:solve|integrate|differentiate|factori[sz]e|evaluate|calculate|compute|work (?:this|that|it) out|what(?:'s| is) the (?:answer|solution|value of|derivative|integral)|find (?:x|y|z|the (?:value|derivative|integral|area|slope|roots?|answer|solution)))\b/;

// "What's this?" and nothing more: the thing is whatever they are looking at.
const JUST_THIS = /^(?:(?:what(?:'s| is| are)|whats) (?:this|that|these|those|it|here|on (?:my|the) screen|in (?:this|the) (?:picture|image|photo))|what am i (?:looking at|seeing)|(?:what(?:'s| is)|whats) (?:going on|happening) (?:here|on (?:my|the) screen)|who(?:'s| is| are) (?:this|that|these|those)|what do you see|describe (?:this|that|it|what you see|the screen)|look at (?:this|that)|can you see (?:this|that)|yeh? (?:kya|kaun) (?:hai|he|h))$/;

// Finding, pressing or changing something: the tree's to answer, however
// pictorial its name ("where's the chart", "open the image").
const FIND_OR_ACT = /^(?:where|wheres|find|locate|look for|point|click|press|tap|hit|select|choose|open|close|go to|scroll|show me (?!what|how|why)|help me find|i can'?t find|i cannot find|i don'?t see|turn|switch|enable|disable|delete|remove|send|share|save|download|upload|copy|paste|insert|add|crop|resize|rotate|move|drag)\b/;
const FIND_THE_ANSWER = /^find (?:x|y|z|the (?:value|derivative|integral|area|slope|roots?|answer|solution))\b/;

// How to do something TO a picture in this app ("how do I insert an image",
// "can I crop this photo?", "is there a way to resize the chart"): a question
// about the app's controls, which the tree answers, not about what the
// picture shows. "How do I read this chart" and "how do I make sense of it"
// are still about the picture.
const HOW_TO_DO = /^(?:how (?:do|can|could|would|should|did) (?:i|you|we|one)|how to|can i|could i|should i|is (?:there|it possible) (?:a way )?to|what happens (?:if|when) i)\s+(?:\w+\s+)?(?:insert|add|make(?! sense)|create|draw|change|edit|crop|resize|rotate|flip|delete|remove|save|export|import|upload|download|attach|replace|copy|paste|move|hide|print|share|send|format|align|embed|rename|duplicate|update|put|turn|set)\b/;

/**
 * True when what they said asks about something only a picture of the screen
 * can answer: an equation, a chart, a diagram, a photo, a sum to solve, or
 * "what's this?" on its own. Wrong one way it costs a picture sent where the
 * text would have done (asked first, and shown on the card); wrong the other,
 * the server can still say it needs to look. So it is kept to the clear cases.
 */
function isVisualQuestion(text, names = NAMES) {
  const said = str(text);
  if (!said.trim()) return false;
  const clean = commandText(said, names);
  if (!clean) return false;
  if (FIND_OR_ACT.test(clean) && !FIND_THE_ANSWER.test(clean)) return false;
  if (JUST_THIS.test(clean) || SOLVE.test(clean)) return true;
  if (HOW_TO_DO.test(clean)) return false;
  if (!VISUAL_NOUN.test(clean)) return false;
  return modeOf(said, names) === "show" || ABOUT_A_PICTURE.test(clean);
}

module.exports = {
  match, isVisualQuestion,
  commandText, modeOf, plainWords, resolverAsk, resolve, labelScore, nameWords,
  ACCEPT_AT, MARGIN, NAMES,
};
