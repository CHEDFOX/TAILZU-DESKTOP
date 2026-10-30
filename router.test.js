// node --test
//
// Where the one key's words go (router.js): every rule as a sentence someone
// would say, with where they said it. Nothing here touches Electron.

const test = require("node:test");
const assert = require("node:assert");
const r = require("./router.js");

const NAMES = ["Tailzu", "Blip", "Jarvis"];
const BOX = {};                      // a text box has focus
const NONE = null;                   // no text box
const UNKNOWN = Symbol("not read");   // the field was never read
const field = (f) => (f === UNKNOWN ? undefined : f);
const go = (heard, f = BOX, o = {}) => r.route(Object.assign({ heard, field: field(f), names: NAMES, askOn: true, notesOn: false }, o));
const look = (heard, f = BOX, o = {}) => r.firstLook(Object.assign({ heard, field: field(f), names: NAMES, askOn: true, notesOn: false }, o));

test("a text box in focus and nothing else: typed, at once, with no label", () => {
  for (const s of ["Running late, be there in ten.", "Kal 7 baje milte hain", "I need to take notes on the budget", "Is this file ready?",
    "Hello how are you", "Can you send me the deck?"]) {
    assert.strictEqual(look(s), "type", s);
    const x = go(s);
    assert.strictEqual(x.to, "type", s);
    assert.strictEqual(x.close, false, s);
    assert.strictEqual(x.alt, null, s);
  }
});

test("where the field could not be read at all (Linux, reading off), everything is typed as before", () => {
  for (const s of ["Tailzu, what is this?", "take notes", "plan my Saturday", "what does this error mean?"]) {
    assert.strictEqual(look(s, UNKNOWN), "type", s);
  }
  assert.strictEqual(go("what does this error mean?", UNKNOWN).to, "type");
});

test("Tailzu's own window in front: always typed", () => {
  assert.strictEqual(look("Tailzu, what is this?", NONE, { ours: true }), "type");
  assert.strictEqual(go("take notes", NONE, { ours: true }).to, "type");
});

test("meeting notes: the whole sentence is the command, in English, Hinglish and Hindi", () => {
  for (const s of ["take notes", "Take notes.", "start meeting notes", "Start taking meeting notes please", "notes lo", "meeting notes shuru karo",
    "मीटिंग नोट्स शुरू करो", "नोट्स लो", "Tailzu, take notes", "okay start notes now"]) {
    assert.strictEqual(look(s), "hold", s);
    assert.strictEqual(go(s).to, "notesStart", s);
    assert.strictEqual(go(s, NONE).to, "notesStart", s);
  }
  for (const s of ["stop meeting notes", "Stop taking notes.", "end notes", "notes band karo", "meeting notes band kar do", "नोट्स बंद करो।", "Blip, stop notes"]) {
    assert.strictEqual(go(s).to, "notesStop", s);
  }
  // "meeting notes" alone turns them on, or off when they are on.
  assert.strictEqual(go("meeting notes").to, "notesStart");
  assert.strictEqual(go("meeting notes", BOX, { notesOn: true }).to, "notesStop");
  // A sentence about notes is a sentence.
  for (const s of ["I'll take notes in the meeting", "please send me your notes", "notes from today are attached"]) assert.strictEqual(go(s).to, "type", s);
  // Its alternative is to type it.
  assert.strictEqual(go("take notes").alt, "type");
});

test("addressed by name: Ask, the name taken off; heard many ways", () => {
  for (const [s, msg] of [["Tailzu, what is this error?", "What is this error?"], ["hey Blip where is the export button", "Where is the export button"],
    ["Jarvis kya hai yeh", "Kya hai yeh"], ["What does this say, Tailzu?", "What does this say?"], ["tail zoo how do I mute here", "How do I mute here"]]) {
    assert.strictEqual(look(s), "hold", s);
    const x = go(s);
    assert.strictEqual(x.to, "ask", s);
    assert.strictEqual(x.message, msg, s);
    assert.strictEqual(x.alt, "type", s);
  }
  // A name that only starts a word is not the name.
  assert.strictEqual(go("Tailzuish things happen").to, "type");
  assert.strictEqual(go("Blipping along").to, "type");
});

test("addressed by name with a text box: the writer's own instruction is still typed", () => {
  for (const s of ["Tailzu, reply saying I'm running late", "Jarvis, write a thank you note", "Tailzu make it formal", "Tailzu, translate this in Hindi"]) {
    const x = go(s);
    assert.strictEqual(x.to, "type", s);
    assert.strictEqual(x.close, true, s);
    assert.strictEqual(x.alt, "ask", s);
  }
  // With no text box it is a request for Ask.
  assert.strictEqual(go("Tailzu, write a thank you note", NONE).to, "ask");
});

test("about what is on the screen: Ask, even into a text box when it can only mean the screen", () => {
  for (const s of ["what does this error mean?", "What is on my screen", "where's the export button", "what am I looking at", "yeh kya hai",
    "what is this", "how do I mute here"]) {
    assert.strictEqual(look(s), "hold", s);
    assert.strictEqual(go(s).to, "ask", s);
  }
  // "this file" into a text box is a message; with no text box it is about the screen.
  assert.strictEqual(go("Is this file ready?").to, "type");
  assert.strictEqual(go("Is this file ready?", NONE).to, "ask");
});

test("text selected: an instruction rewrites it (the server's path); a question about it goes to Ask", () => {
  const sel = { selection: "The quarterly numbers were up." };
  for (const s of ["make this shorter", "bullet points", "in Hindi", "fix the grammar", "Tailzu, make this formal"]) {
    assert.strictEqual(look(s, sel), s.startsWith("Tailzu") ? "hold" : "type", s);
    assert.strictEqual(go(s, sel).to, "rewrite", s);
  }
  assert.strictEqual(go("Tailzu, make this formal", sel).close, true, "addressed: said, with Ask beside it");
  assert.strictEqual(go("Tailzu, make this formal", sel).alt, "ask");
  for (const s of ["what does this mean?", "explain this", "iska matlab kya hai", "is this correct?"]) {
    assert.strictEqual(look(s, sel), "hold", s);
    const x = go(s, sel);
    assert.strictEqual(x.to, "ask", s);
    assert.strictEqual(x.alt, "type", s);
  }
  // A blank selection is no selection.
  assert.strictEqual(go("make this shorter", { selection: "   " }).to, "type");
});

test("a task for a bot: to a bot, named or not; typed into a text box unless it names one", () => {
  for (const [s, slug] of [["plan my Saturday", "plan"], ["book a flight to Goa", "travel"], ["fix the login bug in tailzu-web", "code"],
    ["remind me to call mom at 6", "plan"], ["what's on my calendar tomorrow", "plan"], ["flight book karo", "travel"]]) {
    assert.strictEqual(look(s, NONE), "hold", s);
    const x = go(s, NONE);
    assert.strictEqual(x.to, "bot", s);
    assert.strictEqual(x.slug, slug, s);
    assert.strictEqual(x.alt, "type", s);
    // Into a text box ("book a table" to a friend): typed, said so, with the bot beside it.
    const t = go(s);
    assert.strictEqual(t.to, "type", s);
    assert.strictEqual(t.close, true, s);
    assert.strictEqual(t.alt, "bot", s);
  }
  // Named, it goes whatever has focus.
  for (const [s, slug] of [["Plan Ease, what's on tomorrow", "plan"], ["ask the code bot to fix the build", "code"], ["Travel bot find me a hotel", "travel"]]) {
    assert.strictEqual(look(s), "hold", s);
    const x = go(s);
    assert.strictEqual(x.to, "bot", s);
    assert.strictEqual(x.slug, slug, s);
  }
  // The person's own bot, by its name.
  assert.strictEqual(go("Chef bot, dinner for four", BOX, { bots: [{ slug: "chef", name: "Chef bot" }] }).slug, "chef");
  // Addressed to Tailzu, a bot's task still goes to a bot.
  assert.strictEqual(go("Tailzu, plan my Saturday").to, "bot");
});

test("no text box: a question to Ask, another command is the backend's call, a sentence is typed and said so", () => {
  assert.strictEqual(go("how far is Goa from Mumbai?", NONE).to, "ask");
  assert.strictEqual(go("kaise hai aaj ka mausam", NONE).to, "ask");
  for (const s of ["open gmail", "Gmail kholo", "send this to Rahul"]) {
    assert.strictEqual(look(s, NONE), "hold", s);
    assert.strictEqual(go(s, NONE).to, "unclear", s);
  }
  const x = go("hello how are you", NONE);
  assert.strictEqual(look("hello how are you", NONE), "type");
  assert.strictEqual(x.to, "type");
  assert.strictEqual(x.close, true);
  assert.strictEqual(x.alt, "ask");
});

test("Ask off on this computer: nothing is sent to it", () => {
  assert.strictEqual(go("Tailzu, what is this?", BOX, { askOn: false }).to, "unclear");
  assert.strictEqual(go("what does this error mean?", BOX, { askOn: false }).to, "type");
  assert.strictEqual(go("how far is Goa?", NONE, { askOn: false }).to, "unclear");
  assert.strictEqual(go("hello", NONE, { askOn: false }).alt, null);
  assert.strictEqual(look("what does this error mean?", BOX, { askOn: false }), "type");
});

test("nothing said: typed (nothing), never held", () => {
  assert.strictEqual(look("", NONE), "type");
  assert.strictEqual(go("  ", NONE).to, "type");
  assert.strictEqual(r.route({}).to, "type");
});

test("the pieces: names, questions, commands", () => {
  assert.deepStrictEqual(r.address(r.norm("Hey Tailzu, open mail"), NAMES), { addressed: true, rest: "open mail" });
  assert.deepStrictEqual(r.address(r.norm("open mail"), NAMES), { addressed: false, rest: "open mail" });
  assert.deepStrictEqual(r.address(r.norm("Tailzu"), []), { addressed: false, rest: "tailzu" }, "no names, no address");
  assert.strictEqual(r.stripName("Hey Tailzu, what's this?", NAMES), "What's this?");
  assert.strictEqual(r.stripName("plain words", NAMES), "plain words");
  assert.ok(r.isQuestion("is it raining", "is it raining"));
  assert.ok(r.isQuestion("Raining?", "raining"));
  assert.ok(r.isQuestion("", "yeh kab hai"));
  assert.ok(!r.isQuestion("It is raining.", "it is raining"));
  assert.ok(r.isCommand("open settings"));
  assert.ok(r.isCommand("settings kholo"));
  assert.ok(!r.isCommand("the settings are open"));
  assert.strictEqual(r.notesCommand("take notes"), "start");
  assert.strictEqual(r.notesCommand("stop notes"), "stop");
  assert.strictEqual(r.notesCommand("meeting notes"), "toggle");
  assert.strictEqual(r.notesCommand("notes"), null);
});

test("the server's lists: they replace today's, and a list that is not one keeps today's", () => {
  const knobs = require("./knobs.js");
  try {
    knobs.setKnobs({ labels: {}, flags: {
      // A new way the recogniser hears the name, a new greeting, a new bot, a new task rule.
      "desktop.router.heardAs": [{ name: "tailzu", heard: ["tailzu", "tale zoo"] }, { name: "blip", heard: ["blip"] }],
      "desktop.router.greetings": ["hey", "namaste"],
      "desktop.router.bots": [{ slug: "plan", names: ["plan bot"] }, { slug: "chef", names: ["chef bot"] }],
      "desktop.router.tasks": [{ slug: "chef", re: "^(?:cook|bake) " }, { slug: "x", re: "(" }],
      // Not words: today's list holds.
      "desktop.router.questionStart": [1, null],
      "desktop.router.screenStrong": ["("],
    } });
    assert.deepStrictEqual(r.address(r.norm("Namaste tale zoo, open mail"), NAMES), { addressed: true, rest: "open mail" });
    assert.deepStrictEqual(r.botTask(r.norm("Chef bot, dinner ideas"), []), { slug: "chef", named: true });
    assert.deepStrictEqual(r.botTask(r.norm("cook something with paneer"), []), { slug: "chef", named: false });
    assert.strictEqual(r.botTask(r.norm("travel bot, find a hotel"), []), null, "the server's bots are the bots");
    assert.ok(r.isQuestion("", "what is this"), "an unusable list keeps today's");
    assert.ok(r.aboutScreen("what is this", "what is this", true), "patterns that do not compile keep today's");
  } finally {
    knobs.setKnobs({ labels: {}, flags: {} });
  }
  assert.deepStrictEqual(r.botTask(r.norm("travel bot, find a hotel"), []), { slug: "travel", named: true }, "today's again");
});

// ---- X0, however it is heard --------------------------------------------------------

const X0_NAMES = ["X0", "Blip", "Zara"];
const goX = (heard, f = BOX, o = {}) => r.route(Object.assign({ heard, field: field(f), names: X0_NAMES, askOn: true, notesOn: false }, o));

test("X0 by name, as the recogniser spells it: Ask, with the name taken off", () => {
  for (const [s, msg] of [
    ["X0, what is this error?", "What is this error?"], ["x0 what is this error", "What is this error"],
    ["XO, where is the export button?", "Where is the export button?"], ["x o where is the export button", "Where is the export button"],
    ["X-0, what is this?", "What is this?"], ["X.O. what is this?", "What is this?"],
    ["X zero, what does this say?", "What does this say?"], ["Ex zero what does this say", "What does this say"],
    ["Ex-oh, explain this chart", "Explain this chart"], ["Zo, what's this?", "What's this?"],
    ["Zero bot, what is this?", "What is this?"], ["X0 Bot, what is this?", "What is this?"], ["XO bot what is this", "What is this"],
    ["hey X0, what is this?", "What is this?"], ["Hey ex oh what is this", "What is this"],
    ["एक्स ज़ीरो यह क्या है", "यह क्या है"],
    ["What does this say, X zero?", "What does this say?"], ["what does this error mean ex oh", "What does this error mean"],
  ]) {
    assert.strictEqual(r.firstLook({ heard: s, field: BOX, names: X0_NAMES, askOn: true }), "hold", s);
    const x = goX(s);
    assert.strictEqual(x.to, "ask", s);
    assert.strictEqual(x.message, msg, s);
  }
});

test("their own name for it works the same, case and punctuation aside", () => {
  for (const s of ["Zara, what is this?", "zara what is this", "ZARA... what is this?", "hey zara, what is this"]) {
    assert.strictEqual(goX(s).to, "ask", s);
    assert.strictEqual(goX(s).message, "What is this?".replace(/\?$/, s.endsWith("?") ? "?" : ""), s);
  }
});

test("xo and zo are words too: at the end of a message they are typed, not an address", () => {
  for (const s of ["Love you, xo", "see you soon xo", "miss you x o", "that was a zo"]) {
    const x = goX(s);
    assert.strictEqual(x.to, "type", s);
    assert.strictEqual(x.message, s, s);
  }
  // At the front they are the name.
  assert.strictEqual(goX("xo, what is this?").to, "ask");
  // A name that only starts a word is not the name.
  assert.strictEqual(goX("Xoxo gossip girl is on").to, "type");
  assert.strictEqual(goX("Zombies are coming").to, "type");
  assert.strictEqual(goX("Exodus is a good film").to, "type");
});

test("X0 by name with a text box: the writer's own instruction is still typed", () => {
  for (const s of ["X0, reply saying I'm running late", "ex zero make it formal", "Zara, translate this in Hindi"]) {
    const x = goX(s);
    assert.strictEqual(x.to, "type", s);
    assert.strictEqual(x.close, true, s);
  }
});

test("the server's front-only list replaces today's", () => {
  const knobs = require("./knobs.js");
  try {
    knobs.setKnobs({ labels: {}, flags: { "desktop.router.frontOnly": ["zero bot"] } });
    assert.strictEqual(goX("see you soon xo").to, "ask", "xo counts at the end once the server says so");
    assert.strictEqual(goX("see you soon zero bot").to, "type");
  } finally {
    knobs.setKnobs({ labels: {}, flags: {} });
  }
  assert.strictEqual(goX("see you soon xo").to, "type", "today's again");
});
