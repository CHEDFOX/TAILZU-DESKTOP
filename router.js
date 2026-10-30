// WHERE THE WORDS GO when the person lets go of the one key (oneKey.js).
//
// One key, so one gesture for everything: typing, asking about the screen,
// meeting notes and a task for a bot. What was said, and where it was said,
// decide which. Only cheap signals are read here, all of them local: is a
// text box in focus (frontApp.focusedField), is text selected in it, does the
// sentence address Tailzu by name, is it a notes command, a question, a
// command, a task for a bot. Nothing here waits for anything or asks the
// network: routing.js asks the backend's own "who answers" only when this
// says "unclear", and never when the words are going to be typed.
//
//   route(input)      the decision when the person has stopped
//   firstLook(input)  on the session's first words: "type" (paste them as
//                     they come, as dictation always has) or "hold" (keep
//                     them until the stop, when route() decides)
//
// input:
//   heard     what the recogniser heard (the raw transcript), or
//   text      the written words, when there is no transcript
//   field     undefined: not known (not read on this system; treated as a
//             text box, which is what dictation always assumed)
//             null: no text box has focus
//             { selection?: string }: a text box has focus
//   ours      Tailzu's own window is in front: always typed
//   names     the names it answers to (Tailzu, Blip, theirs for it)
//   askOn     Ask is available on this computer
//   notesOn   meeting notes are running
//   bots      [{ slug, name }] the person's bots, beside the built-ins
//
// A route: { to, message, alt, close, slug?, named?, why }
//   to       type | rewrite | ask | notesStart | notesStop | bot | unclear
//   message  what to hand on (the name it was addressed by taken off)
//   alt      the one alternative the pill offers: ask | type | bot | null
//   close    a close call: the pill says what it did even when it typed
//   slug     the bot: the one they named (named: true), or only a guess,
//            which the backend's own pick overrules
//
// THE LISTS ARE THE SERVER'S (desktop.router.*, from its experience/appLists.ts):
// the ways the recogniser hears a name, the greetings, the notes commands, the
// question and command words, the screen's nouns, the writing instructions, the
// built-in bots and the task rules. They come with the bootstrap, which is
// cached, so routing stays local, synchronous and offline. The lists in LISTS
// are today's, and only the fallback until the server's have come; a list the
// server sends empty, or with nothing usable in it, keeps its fallback.
"use strict";

const knobs = require("./knobs.js");

/** Lower case, no punctuation, single spaces; letters and marks of every
 *  alphabet kept (Devanagari's virama and nukta are marks). Apostrophes go
 *  without a space, so "what's" is "whats". */
function norm(s) {
  return String(s == null ? "" : s).normalize("NFC").toLowerCase()
    .replace(/[’'`ʼ]/g, "")
    .replace(/[^\p{L}\p{M}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ").trim();
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** One alternation of phrases, longest first so "start taking" wins over "start". */
const alt = (list) => list.slice().sort((a, b) => b.length - a.length).map(esc).join("|");

// ---- today's lists: the fallback ---------------------------------------------------
const DAYS = "day|week|weekend|morning|afternoon|evening|night|saturday|sunday|monday|tuesday|wednesday|thursday|friday|tomorrow|today|schedule|calendar|month";
const LISTS = {
  // "X0, what's this error?", "hey Blip …", "Jarvis kya hai yeh", "… ex zero?"
  // The recogniser does not always spell the name: the ways it hears it go too.
  heardAs: [
    { name: "x0", heard: ["x0", "xo", "x o", "x 0", "x zero", "x oh", "ex zero", "ex oh", "ex o", "exo", "ex 0", "eks zero", "eks o", "zo",
      "zero bot", "x0 bot", "xo bot", "x o bot", "x 0 bot", "x zero bot", "ex zero bot", "ex oh bot", "x0bot", "xobot",
      "एक्स ज़ीरो", "एक्स जीरो", "एक्स ओ", "एक्सो", "एक्स0"] },
    // Its old name, so a habit keeps working.
    { name: "tailzu", heard: ["tailzu", "tail zu", "tailzoo", "tail zoo", "tell zu", "tell zoo", "telzu", "tel zu", "taylzu", "tailsu", "tailzoo", "टेलज़ू", "टेलजू", "टेल्ज़ू", "टेल ज़ू"] },
    { name: "blip", heard: ["blip", "blipp", "ब्लिप"] },
  ],
  // Ways of hearing a name that are ordinary words too: "love you, xo" signs a
  // message off. They are the name at the start of what was said, never at the end.
  frontOnly: ["xo", "x o", "zo"],
  greetings: ["hey", "hi", "hello", "ok", "okay", "o", "oye", "oi", "arre", "are", "arey", "suno", "listen", "yo",
    "हे", "अरे", "सुनो", "ओ", "ओके", "हाय", "हेलो"],
  // Meeting notes: the whole sentence is the command ("take notes", "stop
  // meeting notes", "notes lo", "नोट्स बंद करो"), give or take a please.
  notesPre: ["please", "pls", "plz", "can you", "could you", "will you", "would you", "kindly", "zara", "jara", "ab", "now",
    "lets", "let us", "go ahead and", "ok", "okay", "अब", "ज़रा", "जरा", "प्लीज़", "प्लीज"],
  notesSuffix: ["please", "pls", "plz", "now", "for me", "na", "abhi", "ab", "jaldi", "yaar", "ji", "thanks", "thank you",
    "for this meeting", "of this meeting", "for the meeting", "of the meeting", "for this call", "of this call", "for the call",
    "of the call", "now please", "ना", "अभी", "जल्दी", "प्लीज़", "प्लीज", "जी"],
  notesStart: ["take", "taking", "start", "start taking", "begin", "begin taking", "record", "start recording", "turn on", "switch on", "keep"],
  notesStartHi: ["on", "start", "shuru", "lo", "le lo", "lelo", "lena", "lena shuru karo", "lena shuru kar do", "lijiye", "lijie", "banao",
    "bana lo", "banana shuru karo", "shuru karo", "shuru kar do", "start karo", "start kar do", "chalu karo", "chalu kar do", "on karo",
    "on kar do", "likho", "likhna shuru karo"],
  notesStartDeva: ["लो", "ले लो", "लेना शुरू करो", "लेना शुरू कर दो", "शुरू करो", "शुरू कर दो", "बनाओ", "बना लो", "चालू करो", "चालू कर दो", "लिखो"],
  notesStop: ["stop", "stop taking", "end", "finish", "turn off", "switch off", "pause", "done with", "close", "stop recording"],
  notesStopHi: ["off", "stop", "done", "band", "band karo", "band kar do", "bas", "bas karo", "rok do", "roko", "ruko", "stop karo",
    "stop kar do", "khatam karo", "khatam kar do", "khatam", "off karo", "off kar do", "lena band karo", "lena band kar do"],
  notesStopDeva: ["बंद करो", "बंद कर दो", "बंद", "रोको", "रोक दो", "बस", "बस करो", "ख़त्म करो", "खत्म करो", "ख़त्म", "खत्म", "लेना बंद करो"],
  // What kind of sentence.
  questionStart: ["what", "whats", "why", "how", "hows", "where", "wheres", "when", "whens", "who", "whos", "whom",
    "whose", "which", "can you", "could you", "would you", "will you", "do you", "did you", "does", "do i", "did i", "is", "isnt", "are", "arent",
    "was", "were", "should", "shall", "may i", "can i", "could i", "have you", "has", "kya", "kaise", "kaisa", "kaisi", "kahan", "kahaan",
    "kab", "kaun", "kaunsa", "kaunsi", "kyun", "kyon", "kyu", "kitna", "kitne", "kitni", "क्या", "कैसे", "कैसा", "कहाँ", "कहां", "कब", "कौन",
    "क्यों", "क्यूँ", "कितना", "कितने", "कितनी"],
  questionEnd: ["kya", "kya hai", "hai kya", "kaise", "kahan hai", "kab hai", "kaun hai", "kyun", "kya hua",
    "क्या", "क्या है", "है क्या", "कैसे", "कहाँ है", "कब है", "कौन है", "क्यों", "क्या हुआ"],
  commandVerbs: ["open", "close", "show", "find", "search", "look up", "lookup", "go to", "take me to", "navigate to", "click", "press", "tap",
    "scroll", "tell me", "explain", "summarize", "summarise", "translate", "read", "play", "pause", "resume", "send", "set", "turn on",
    "turn off", "switch", "remind", "schedule", "book", "plan", "fix", "create", "make", "add", "delete", "remove", "move", "rename", "start",
    "stop", "check", "help", "give me", "list", "compare", "order", "call", "email", "message", "text", "write", "draft", "copy", "save",
    "download", "upload", "share", "mute", "unmute", "zoom", "minimize", "maximize", "refresh", "reload", "undo", "redo", "select",
    "highlight", "bookmark", "install", "update", "run", "launch", "quit", "exit", "cancel", "join", "leave", "reply", "forward", "organize",
    "organise", "sort", "clean up", "empty"],
  commandEnd: ["kholo", "khol do", "dikhao", "dikha do", "batao", "bata do", "bhejo", "bhej do", "dhoondho",
    "dhundo", "dhundho", "search karo", "band karo", "band kar do", "chalao", "chala do", "samjhao", "samjha do", "padho", "padh do", "likho",
    "likh do", "karo", "kar do", "kijiye", "kariye", "खोलो", "खोल दो", "दिखाओ", "दिखा दो", "बताओ", "बता दो", "भेजो", "भेज दो", "ढूंढो",
    "ढूँढो", "चलाओ", "चला दो", "समझाओ", "समझा दो", "पढ़ो", "पढ़ दो", "लिखो", "लिख दो", "करो", "कर दो", "कीजिए", "करिए"],
  // Words that only make sense about the screen in front of them.
  screenThings: ["page", "window", "app", "error", "button", "screen", "tab", "message", "email", "mail", "chart", "graph", "code",
    "file", "thing", "word", "line", "setting", "settings", "option", "menu", "icon", "link", "popup", "pop up", "dialog", "warning",
    "notification", "form", "field", "table", "slide", "sheet", "doc", "document", "video", "image", "picture", "photo", "diagram", "equation",
    "function", "site", "website", "webpage", "spreadsheet", "cell", "column", "row", "folder"],
  // Strong: only ever about the screen, even said into a text box (patterns, on normalised words).
  screenStrong: [
    "(?:^| )(?:on|in|from) (?:my|the|this) screen(?: |$)",
    "^(?:what|whats) (?:is |s )?(?:this|that|here)$",
    "^(?:what|whats) (?:does|do|is|s) (?:this|that) (?:\\S+ )?(?:mean|means|say|says|do|does)(?: |$)",
    "(?:^| )what am i (?:looking at|seeing)(?: |$)",
    "^(?:where|wheres)(?: is| s| do i find| can i find| do i click| do i)? .*(?:button|option|setting|settings|menu|icon|tab|link|toggle|switch)(?: |$)",
    "^how do i .+ (?:here|in this app|in this page|in this window|on this page|on this screen)(?: |$)",
    "(?:^| )(?:yeh|ye|yah) (?:kya hai|kya he)$",
    "(?:^| )(?:screen|page|window) (?:par|pe|mein|me) ",
    "(?:^| )(?:यह|ये) क्या है$",
    "(?:^| )स्क्रीन (?:पर|पे|में)(?: |$)",
  ],
  // Said about selected text: explain it rather than rewrite it.
  explain: ["explain", "summarize", "summarise", "define", "what does", "what do",
    "whats", "what is", "meaning of", "tell me about", "is this", "is that", "are these", "why", "how does", "who is", "who was", "samjhao",
    "samjha do", "iska matlab", "is ka matlab", "matlab kya", "iska meaning"],
  explainAnywhere: ["kya matlab", "matlab kya", "मतलब"],
  // What the writer does with a text box ("reply saying …", "… in Hindi").
  writeStart: ["write", "reply", "respond", "draft", "compose", "make it", "make this", "rewrite", "rephrase",
    "translate", "say", "tell him", "tell her", "tell them", "let him know", "let her know", "let them know", "likho", "likh do",
    "reply karo", "jawab do", "bolo ki", "kaho ki", "लिखो", "लिख दो", "जवाब दो"],
  writeEnd: ["in hindi", "in english", "in hinglish", "formally", "formal", "casually", "shorter", "longer",
    "in bullet points", "as bullets", "politely", "hindi mein", "english mein", "हिंदी में"],
  // A task for a bot: the built-ins by name, and the tasks that are theirs (patterns, on normalised words).
  bots: [
    { slug: "plan", names: ["plan ease", "planease", "plan bot", "planner bot"] },
    { slug: "travel", names: ["travel bot"] },
    { slug: "code", names: ["xode", "code bot", "coding bot"] },
    { slug: "keybot", names: ["keylessbord", "keylessboard", "keybot", "key bot"] },
  ],
  tasks: [
    { slug: "plan", re: `^(?:plan|organi[sz]e|sort out|block) (?:my|the|our) (?:${DAYS})(?: |$)` },
    { slug: "plan", re: "^(?:add|put) .+ (?:to|on|in|into) my calendar(?: |$)" },
    { slug: "plan", re: "^schedule (?:a |an |my )?(?:meeting|call|reminder|catch up|catchup|sync)(?: |$)" },
    { slug: "plan", re: "^remind me(?: |$)" },
    { slug: "plan", re: "^(?:whats|what is) on (?:my calendar|my schedule|today|tomorrow)(?: |$)" },
    { slug: "plan", re: "^(?:set|create) (?:a |an )?(?:reminder|meeting|event)(?: |$)" },
    { slug: "plan", re: "(?:^| )(?:plan|schedule) (?:karo|kar do|banao|bana do)$" },
    { slug: "travel", re: "^(?:book|find|search|search for|look for|get) (?:me |us )?(?:a |an |some |the |cheap |cheapest )?(?:flight|flights|train|trains|train tickets|hotel|hotels|cab|taxi|bus|ticket|tickets|stay|homestay|room|rooms)(?: |$)" },
    { slug: "travel", re: "^plan (?:a |my |our |the )?(?:trip|holiday|vacation|getaway)(?: |$)" },
    { slug: "travel", re: "(?:^| )(?:flight|ticket|tickets|hotel|train) (?:book karo|book kar do)$" },
    { slug: "code", re: "^fix (?:the |a |this |that |my )?(?:.+ )?(?:bug|bugs|issue|issues|error|errors|crash|test|tests|build)(?: |$)" },
    { slug: "code", re: "^(?:deploy|refactor|ship) " },
    { slug: "code", re: "^(?:open|create|make|raise) (?:a |an )?(?:pr|pull request)(?: |$)" },
    { slug: "code", re: "^(?:fix|add|update|change|write|remove) .+ in (?:my |the )?(?:repo|project|codebase|code)(?: |$)" },
    { slug: "code", re: "^(?:write|add) (?:a |an |some )?(?:test|tests|unit test|unit tests|endpoint|api|function|migration)(?: |$)" },
    { slug: "code", re: "(?:^| )(?:bug|issue) fix (?:karo|kar do)$" },
  ],
};

// ---- the server's lists, read once per bootstrap -------------------------------------
// Each read names its key, so the knob manifest lists it and the console can set it.
function served() {
  return [
    knobs.list("desktop.router.heardAs", LISTS.heardAs),
    knobs.list("desktop.router.frontOnly", LISTS.frontOnly),
    knobs.list("desktop.router.greetings", LISTS.greetings),
    knobs.list("desktop.router.notesPre", LISTS.notesPre),
    knobs.list("desktop.router.notesSuffix", LISTS.notesSuffix),
    knobs.list("desktop.router.notesStart", LISTS.notesStart),
    knobs.list("desktop.router.notesStartHi", LISTS.notesStartHi),
    knobs.list("desktop.router.notesStartDeva", LISTS.notesStartDeva),
    knobs.list("desktop.router.notesStop", LISTS.notesStop),
    knobs.list("desktop.router.notesStopHi", LISTS.notesStopHi),
    knobs.list("desktop.router.notesStopDeva", LISTS.notesStopDeva),
    knobs.list("desktop.router.questionStart", LISTS.questionStart),
    knobs.list("desktop.router.questionEnd", LISTS.questionEnd),
    knobs.list("desktop.router.commandVerbs", LISTS.commandVerbs),
    knobs.list("desktop.router.commandEnd", LISTS.commandEnd),
    knobs.list("desktop.router.screenThings", LISTS.screenThings),
    knobs.list("desktop.router.screenStrong", LISTS.screenStrong),
    knobs.list("desktop.router.explain", LISTS.explain),
    knobs.list("desktop.router.explainAnywhere", LISTS.explainAnywhere),
    knobs.list("desktop.router.writeStart", LISTS.writeStart),
    knobs.list("desktop.router.writeEnd", LISTS.writeEnd),
    knobs.list("desktop.router.bots", LISTS.bots),
    knobs.list("desktop.router.tasks", LISTS.tasks),
  ];
}
const KEYS = ["heardAs", "frontOnly", "greetings", "notesPre", "notesSuffix", "notesStart", "notesStartHi", "notesStartDeva", "notesStop", "notesStopHi",
  "notesStopDeva", "questionStart", "questionEnd", "commandVerbs", "commandEnd", "screenThings", "screenStrong", "explain", "explainAnywhere",
  "writeStart", "writeEnd", "bots", "tasks"];

/** Words, or the fallback: a list that is not one, or has no words in it, is not used. */
function words(v, fallback) {
  const out = Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : [];
  return out.length ? out : fallback;
}
/** Patterns that compile, or the fallback's. */
function patterns(v, fallback) {
  const out = [];
  for (const p of Array.isArray(v) ? v : []) {
    if (typeof p !== "string" || !p) continue;
    try { out.push(new RegExp(p, "u")); } catch { /* a pattern that does not compile is left out */ }
  }
  return out.length ? out : fallback.map((p) => new RegExp(p, "u"));
}

/** Everything the decisions match against, compiled from a set of lists. */
function compile(raw) {
  const L = {};
  KEYS.forEach((k, i) => { L[k] = raw[i]; });
  const heardAs = {};
  for (const h of Array.isArray(L.heardAs) ? L.heardAs : []) {
    const name = h && typeof h.name === "string" ? norm(h.name) : "";
    const heard = h ? words(h.heard, []) : [];
    if (name && heard.length) heardAs[name] = heard;
  }
  if (!Object.keys(heardAs).length) for (const h of LISTS.heardAs) heardAs[h.name] = h.heard;
  const w = (k) => words(L[k], LISTS[k]);
  const NOTE = "(?:the |my |some )?(?:meeting |call |)(?:notes|note)";
  const NOTE_HI = "(?:meeting |call |meeting ke |meeting ki |)(?:notes|note)";
  const NOTE_DEVA = "(?:मीटिंग |मीटिंग के |कॉल |)(?:नोट्स|नोट)";
  const PRE = alt(w("notesPre")), SUF = alt(w("notesSuffix"));
  const whole = (cores) => new RegExp(`^(?:(?:${PRE}) )*(?:${cores.join("|")})(?: (?:${SUF}))*$`, "u");
  const START = [
    `(?:${alt(w("notesStart"))}) ${NOTE}`,
    `${NOTE_HI} (?:${alt(w("notesStartHi"))})`,
    `${NOTE_DEVA} (?:${alt(w("notesStartDeva"))})`,
  ];
  const STOP = [
    `(?:${alt(w("notesStop"))}) ${NOTE}(?: taking)?`,
    `${NOTE_HI} (?:${alt(w("notesStopHi"))})`,
    `${NOTE_DEVA} (?:${alt(w("notesStopDeva"))})`,
  ];
  const TOGGLE = ["(?:meeting|call) notes", "मीटिंग नोट्स"];
  const bots = [];
  for (const b of Array.isArray(L.bots) ? L.bots : []) {
    const names = b && typeof b.slug === "string" && b.slug ? words(b.names, []).map(norm).filter(Boolean) : [];
    if (names.length) bots.push({ slug: b.slug, names });
  }
  const tasks = [];
  for (const t of Array.isArray(L.tasks) ? L.tasks : []) {
    if (!t || typeof t.slug !== "string" || !t.slug || typeof t.re !== "string" || !t.re) continue;
    try { tasks.push({ slug: t.slug, re: new RegExp(t.re, "u") }); } catch { /* left out */ }
  }
  return {
    heardAs,
    FRONT_ONLY: new Set(w("frontOnly").map(norm).filter(Boolean)),
    G: alt(w("greetings")),
    NOTES_START: whole(START), NOTES_STOP: whole(STOP), NOTES_TOGGLE: whole(TOGGLE),
    Q_START: new RegExp(`^(?:${alt(w("questionStart"))})(?: |$)`, "u"),
    Q_END: new RegExp(`(?:^| )(?:${alt(w("questionEnd"))})$`, "u"),
    C_START: new RegExp(`^(?:(?:please|pls|can you|could you|will you|would you|kindly) )?(?:${alt(w("commandVerbs"))})(?: |$)`, "u"),
    C_END: new RegExp(`(?:^| )(?:${alt(w("commandEnd"))})(?: (?:na|please|ना))?$`, "u"),
    SCREEN_STRONG: patterns(L.screenStrong, LISTS.screenStrong),
    // Weak: "this error", "that page" — about the screen when no text box is
    // waiting for the words; said into one, "is this file ready?" is a message.
    SCREEN_WEAK: [new RegExp(`(?:^| )(?:this|that) (?:${alt(w("screenThings"))})(?: |$)`, "u")],
    EXPLAIN: new RegExp(`^(?:(?:please|can you|could you) )?(?:${alt(w("explain"))})(?: |$)|(?:^| )(?:${alt(w("explainAnywhere"))})(?: |$)`, "u"),
    WRITE_START: new RegExp(`^(?:${alt(w("writeStart"))})(?: |$)`, "u"),
    WRITE_END: new RegExp(`(?:^| )(?:${alt(w("writeEnd"))})$`, "u"),
    BUILT_IN: bots.length ? bots : LISTS.bots.map((b) => ({ slug: b.slug, names: b.names.map(norm) })),
    TASKS: tasks.length ? tasks : LISTS.tasks.map((t) => ({ slug: t.slug, re: new RegExp(t.re, "u") })),
  };
}

let compiled = null;
let compiledFrom = null;
/** The compiled rules for the lists in hand: compiled again only when a new bootstrap brought new ones. */
function rules() {
  const raw = served();
  if (!compiled || !compiledFrom || raw.some((v, i) => v !== compiledFrom[i])) {
    compiled = compile(raw);
    compiledFrom = raw;
  }
  return compiled;
}

// ---- addressed by name ----------------------------------------------------------

function nameForms(names) {
  const R = rules();
  const out = new Set();
  for (const n of Array.isArray(names) ? names : []) {
    const k = norm(n);
    if (!k) continue;
    out.add(k);
    for (const f of R.heardAs[k] || []) out.add(norm(f));
  }
  return [...out].filter(Boolean);
}

/** { addressed, rest }: the words without the name they were addressed by. */
function address(words, names) {
  const forms = nameForms(names);
  if (!forms.length || !words) return { addressed: false, rest: words };
  const R = rules();
  const N = alt(forms), G = R.G;
  const front = new RegExp(`^(?:(?:${G}) )?(?:${N})(?: ji)?(?: |$)`, "u").exec(words);
  if (front) return { addressed: true, rest: words.slice(front[0].length).trim() };
  // At the end, only a form that is never an ordinary word: "see you soon xo" is a message.
  const late = forms.filter((f) => !R.FRONT_ONLY.has(f));
  const back = late.length ? new RegExp(`(?:^| )(?:(?:${G}) )?(?:${alt(late)})(?: ji)?$`, "u").exec(words) : null;
  if (back && back.index > 0) return { addressed: true, rest: words.slice(0, back.index).trim() };
  return { addressed: false, rest: words };
}

/** The said words with the name taken off the front (or the end), in their
 *  own case and punctuation: what a bot or Ask is handed. */
function stripName(raw, names) {
  const s = String(raw == null ? "" : raw).trim();
  const forms = nameForms(names);
  if (!forms.length) return s;
  // The forms are normalised; the said words have their punctuation, so the
  // spaces in a form may be any run of spaces or punctuation.
  const N = forms.map((f) => f.split(" ").map(esc).join("[\\s,.-]+")).sort((a, b) => b.length - a.length).join("|");
  const G = rules().G;
  const front = new RegExp(`^(?:(?:${G})[\\s,.!-]+)?(?:${N})(?:\\s+ji)?(?=[\\s,.:;!?-]|$)[\\s,.:;!?-]*`, "iu");
  let out = s.replace(front, "");
  if (out === s) out = s.replace(new RegExp(`[\\s,.;:-]+(?:(?:${G})[\\s,.!-]+)?(?:${N})(?:\\s+ji)?([.!?…]*)$`, "iu"), "$1");
  out = out.trim();
  if (!out || out === s) return s;
  return out.charAt(0).toUpperCase() + out.slice(1);
}

// ---- meeting notes ----------------------------------------------------------------
// The whole sentence is the command ("take notes", "stop meeting notes",
// "notes lo", "नोट्स बंद करो"), give or take a please: "I need to take notes
// on the budget" is a sentence to type, not a command.

/** "start", "stop", "toggle", or null. */
function notesCommand(words) {
  if (!words) return null;
  const R = rules();
  if (R.NOTES_STOP.test(words)) return "stop";
  if (R.NOTES_START.test(words)) return "start";
  if (R.NOTES_TOGGLE.test(words)) return "toggle";
  return null;
}

// ---- what kind of sentence ----------------------------------------------------------

/** A question: said with its question mark, or worded as one. */
function isQuestion(raw, words) {
  if (/[?？؟]\s*["”’)]*\s*$/.test(String(raw || ""))) return true;
  const R = rules();
  return R.Q_START.test(words) || R.Q_END.test(words);
}

/** A command: an imperative at the front (English), or at the end (Hindi). */
function isCommand(words) { const R = rules(); return R.C_START.test(words) || R.C_END.test(words); }

/** About what is on the screen: a question or a command that names it.
 *  `typing`: a text box has focus, so only the strong signs count. */
function aboutScreen(raw, words, typing) {
  const R = rules();
  const signs = typing ? R.SCREEN_STRONG : R.SCREEN_STRONG.concat(R.SCREEN_WEAK);
  if (!signs.some((r) => r.test(words))) return false;
  return isQuestion(raw, words) || isCommand(words) || /^(?:what|whats|where|wheres|how)(?: |$)/u.test(words);
}

/** Said about selected text: explain it rather than rewrite it. */
function explains(words) { return rules().EXPLAIN.test(words); }

/** What the writer does with a text box ("reply saying …", "… in Hindi"):
 *  addressed to Tailzu while a text box has focus, it is still typing. */
function writingInstruction(words) { const R = rules(); return R.WRITE_START.test(words) || R.WRITE_END.test(words); }

// ---- a task for a bot -----------------------------------------------------------------

/** { slug, named } when the words are a task for a bot: `named` when they say
 *  which bot ("Plan Ease, …", "ask Xode to …"). The slug of an unnamed
 *  task is only a guess; the backend's own routing decides. */
function botTask(words, bots) {
  if (!words) return null;
  const R = rules();
  const all = R.BUILT_IN.slice();
  for (const b of Array.isArray(bots) ? bots : []) {
    const n = b && typeof b.name === "string" ? norm(b.name) : "";
    if (n && b.slug && n.split(" ").length <= 4 && n !== "tailzu") all.push({ slug: String(b.slug), names: [n] });
  }
  for (const b of all) {
    const N = alt(b.names);
    if (new RegExp(`^(?:(?:hey|ok|okay|hi) )?(?:the |my )?(?:${N})(?: |$)`, "u").test(words)
      || new RegExp(`^(?:ask|tell|get|have) (?:the |my )?(?:${N})(?: |$)`, "u").test(words)) return { slug: b.slug, named: true };
  }
  const hit = R.TASKS.find((t) => t.re.test(words));
  return hit ? { slug: hit.slug, named: false } : null;
}

// ---- the decision -----------------------------------------------------------------------

/** Everything the two decisions read, worked out once. */
function read(i) {
  const raw = String((i && (i.heard || i.text)) || "").trim();
  const words = norm(raw);
  const a = address(words, i && i.names);
  const field = i ? i.field : undefined;
  const known = field !== undefined;
  const focused = !known || !!field;          // not known: a text box, as dictation always assumed
  const sel = field && typeof field.selection === "string" && field.selection.trim() ? field.selection : "";
  const rest = a.rest;
  return {
    raw, words, rest, addressed: a.addressed, known, focused, sel,
    ours: !!(i && i.ours), askOn: !!(i && i.askOn), notesOn: !!(i && i.notesOn),
    notes: notesCommand(rest),
    q: isQuestion(raw, rest), cmd: isCommand(rest), screen: aboutScreen(raw, rest, known && !!field),
    bot: botTask(rest, i && i.bots), write: writingInstruction(rest),
    message: a.addressed ? stripName(raw, i && i.names) : raw,
  };
}

/**
 * The session's first words: paste them as they come ("type"), or keep them
 * until the stop ("hold"). Typing is never held for a signal that is not
 * there: a text box in focus and nothing below means type, now.
 */
function firstLook(i) {
  const r = read(i);
  if (!r.words || r.ours || !r.known) return "type";
  if (r.notes || r.addressed || (r.bot && r.bot.named)) return "hold";
  if (r.sel && r.askOn && (r.q || explains(r.rest))) return "hold";
  if (r.screen && r.askOn) return "hold";
  if (!r.focused && (r.q || r.cmd || r.bot)) return "hold";
  return "type";
}

/** The decision, on everything that was said. */
function route(i) {
  const r = read(i);
  const out = (to, o = {}) => Object.assign({ to, message: r.message || r.raw, alt: null, close: false, why: "" }, o);
  if (!r.words) return out("type", { why: "empty" });
  if (r.ours) return out("type", { why: "ours" });
  // "take notes", "stop meeting notes", "notes band karo".
  if (r.notes) {
    const start = r.notes === "start" || (r.notes === "toggle" && !r.notesOn);
    return out(start ? "notesStart" : "notesStop", { alt: "type", why: "notes" });
  }
  // Text selected in the box: what they said is about it. A question about it
  // goes to Ask; anything else is the rewrite the server already does.
  if (r.focused && r.sel) {
    if (r.askOn && (r.q || explains(r.rest))) return out("ask", { alt: "type", why: "selection question" });
    return out("rewrite", { alt: r.addressed && r.askOn ? "ask" : null, close: r.addressed, why: "selection" });
  }
  // A bot by name: "Plan Ease, plan my Saturday", "ask Xode to …".
  if (r.bot && r.bot.named) return out("bot", { slug: r.bot.slug, named: true, alt: "type", why: "bot named" });
  // Tailzu by name: the writer's own instruction while a text box is in focus
  // ("Tailzu, reply saying I'm late"), else Ask, or a bot for a bot's task.
  if (r.addressed) {
    if (r.focused && r.known && r.write) return out("type", { alt: r.askOn ? "ask" : null, close: true, why: "addressed, writing" });
    if (r.bot) return out("bot", { slug: r.bot.slug, alt: "type", why: "addressed, bot task" });
    if (r.askOn) return out("ask", { alt: "type", why: "addressed" });
    return out("unclear", { alt: "type", why: "addressed, no Ask" });
  }
  // About what is on the screen ("what does this error mean", "where's the export button").
  if (r.screen && r.askOn && r.known) return out("ask", { alt: "type", why: "screen" });
  // A text box in focus, and nothing above: type it. A task a bot could do,
  // typed into a box, is a close call ("book a table for 8" to a friend).
  if (r.focused) return out("type", { alt: r.known && r.bot ? "bot" : null, close: !!(r.known && r.bot), why: "focus" });
  // No text box. A task for a bot goes to one (which: the backend's say);
  // a question to Ask; any other command is either: the backend decides.
  if (r.bot) return out("bot", { slug: r.bot.slug, alt: "type", why: "bot task" });
  if (r.q && r.askOn) return out("ask", { alt: "type", why: "question" });
  if (r.q || r.cmd) return out("unclear", { alt: "type", why: r.q ? "question" : "command" });
  // A sentence with no text box seen: typed (the box may be one the system
  // cannot read), and said so, with Ask beside it.
  return out("type", { alt: r.askOn ? "ask" : null, close: true, why: "no text box" });
}

module.exports = {
  route, firstLook,
  // for the tests, and the lists the server's copy started from
  norm, address, stripName, notesCommand, isQuestion, isCommand, aboutScreen, botTask, writingInstruction, LISTS,
};
