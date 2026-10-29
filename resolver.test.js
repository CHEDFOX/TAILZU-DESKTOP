// node --test
//
// The resolver on this computer is a port of the server's (tulmi
// src/agent/resolver.ts and grammar.ts): the first half of this file is the
// server's own tests (tests/agent-units.test.ts), case for case, so the two
// cannot drift apart unnoticed. Then what only this side has: match(), one
// answer with its intent, and isVisualQuestion().

const test = require("node:test");
const assert = require("node:assert");
const {
  match, isVisualQuestion, commandText, modeOf, plainWords, resolverAsk, resolve, labelScore, nameWords,
  ACCEPT_AT, MARGIN, NAMES,
} = require("./resolver.js");

const SERVER_NAMES = ["X0", "Blip", "Zara"];

// ---- the server's cases ---------------------------------------------------------

test("commandText takes off fillers, a name it was called by, and politeness", () => {
  assert.strictEqual(commandText("Hey X0, um, can you scroll down please?", SERVER_NAMES), "scroll down");
  assert.strictEqual(commandText("Zara, go back.", SERVER_NAMES), "go back");
  assert.strictEqual(commandText("okay so just undo that, thanks", SERVER_NAMES), "undo that");
  assert.strictEqual(commandText("right click the file", SERVER_NAMES), "right click the file");
});

test("modeOf shows for questions and pointing, does for commands", () => {
  for (const q of ["where's export?", "How do I turn on captions", "what does this error mean?", "show me the settings", "point at the send button", "find export", "Is there a dark mode?", "export kahan hai", "help me understand this chart"]) {
    assert.strictEqual(modeOf(q, SERVER_NAMES), "show", q);
  }
  for (const c of ["turn on captions", "open #design and tell them the mockups are ready", "Can you turn on captions?", "Hey X0, could you export this?", "scroll down"]) {
    assert.strictEqual(modeOf(c, SERVER_NAMES), "do", c);
  }
});

const ELS = [
  { id: "e1", role: "button", label: "Search" },
  { id: "e2", role: "menu", label: "File" },
  { id: "e3", role: "button", label: "Export…" },
  { id: "e4", role: "text", label: "Export settings are below" },
  { id: "e5", role: "button", label: "Save" },
  { id: "e6", role: "button", label: "Save" },
  { id: "e7", role: "link", label: "Share" },
  { id: "e8", role: "heading", label: "Share" },
  { id: "e9", role: "tab", label: "Settings" },
];
const idOf = (r) => r && r.element.id;

test("resolverAsk reads what they asked for and the kind of control they named", () => {
  assert.deepStrictEqual(resolverAsk("where's export"), { verb: "point", target: "export", roleHint: undefined });
  assert.deepStrictEqual(resolverAsk("where is the export button"), { verb: "point", target: "export", roleHint: "button" });
  assert.deepStrictEqual(Object.assign({}, resolverAsk("show me where export is"), { roleHint: undefined }), { verb: "point", target: "export", roleHint: undefined });
  assert.strictEqual(resolverAsk("click on export").verb, "press");
  assert.strictEqual(resolverAsk("click on export").target, "export");
  assert.strictEqual(resolverAsk("turn on captions"), null);
  // Not a role word, whatever an object's prototype has on it.
  assert.strictEqual(resolverAsk("where is the export constructor").roleHint, undefined);
});

test("resolve accepts a clear match, a misspoken one included", () => {
  assert.strictEqual(idOf(resolve({ verb: "point", target: "export" }, ELS)), "e3");
  assert.strictEqual(idOf(resolve({ verb: "press", target: "setings" }, ELS)), "e9");
  assert.strictEqual(labelScore("search", "Search"), 1);
});

test("resolve rejects a tie, and a weak match", () => {
  assert.strictEqual(resolve({ verb: "press", target: "save" }, ELS), null);
  assert.strictEqual(resolve({ verb: "point", target: "the settings for exporting" }, ELS), null);
  assert.strictEqual(resolve({ verb: "point", target: "captions" }, ELS), null);
});

test("a press never lands on text or a heading, and a role named breaks a tie", () => {
  assert.strictEqual(idOf(resolve({ verb: "press", target: "share" }, ELS)), "e7");
  assert.strictEqual(resolve({ verb: "point", target: "share" }, ELS), null);
  assert.strictEqual(idOf(resolve({ verb: "point", target: "share", roleHint: "link" }, ELS)), "e7");
});

test("a disabled control is never pressed", () => {
  assert.strictEqual(resolve({ verb: "press", target: "search" }, [{ id: "e1", role: "button", label: "Search", disabled: true }]), null);
});

// ---- the same thresholds, and the bits underneath ---------------------------------

test("the bars are the server's: 0.85, and 0.2 over the runner-up", () => {
  assert.strictEqual(ACCEPT_AT, 0.85);
  assert.strictEqual(MARGIN, 0.2);
  assert.deepStrictEqual(NAMES, ["X0", "Blip", "Tailzu"]);
  // Exactly 0.2 apart is enough (the float slack): 1.0 against 0.8, where
  // 1 - 0.8 is 0.19999999999999996 and would fail a bare comparison.
  const els = [{ id: "e1", role: "button", label: "Export PDF" }, { id: "e2", role: "button", label: "Export as PDF" }];
  assert.strictEqual(labelScore("export pdf", "Export as PDF"), 0.8);
  const r = resolve({ verb: "point", target: "export pdf" }, els);
  assert.strictEqual(idOf(r), "e1");
  assert.ok(r.margin < 0.2, "the margin really is a hair under 0.2");
  // A hair less than that is not.
  assert.strictEqual(resolve({ verb: "point", target: "export pdf" }, els, { margin: 0.2001 }), null);
  // A bar given by the caller (a knob) is used instead.
  assert.strictEqual(resolve({ verb: "point", target: "export" }, [{ id: "e1", role: "button", label: "Export" }], { score: 1.01 }), null);
  assert.strictEqual(idOf(resolve({ verb: "press", target: "save" }, ELS, { margin: 0 })), "e5");
});

test("resolve says how sure it is: its score and its margin", () => {
  const r = resolve({ verb: "point", target: "export" }, ELS);
  assert.strictEqual(r.score, 1);
  assert.ok(r.margin >= 0.2);
  const alone = resolve({ verb: "point", target: "export" }, [{ id: "e1", role: "button", label: "Export" }]);
  assert.strictEqual(alone.margin, 1, "with no runner-up the margin is the score itself");
});

test("labelScore and nameWords: accents, punctuation and case do not count; a misspelling nearly does", () => {
  assert.strictEqual(nameWords("Café — Paramètres!"), "cafe parametres");
  assert.strictEqual(labelScore("export", "Export…"), 1);
  // A letter wrong is the same word; two (a swap) is not, as on the server.
  assert.strictEqual(labelScore("expott as pdf", "Export as PDF"), 1);
  assert.ok(labelScore("exprot as pdf", "Export as PDF") < 0.85);
  assert.strictEqual(labelScore("", "Export"), 0);
});

test("plainWords keeps what chords and channels are spelled with", () => {
  assert.strictEqual(plainWords("Open #design, @sam!"), "open #design @sam");
  assert.strictEqual(plainWords("Press Cmd+K."), "press cmd+k");
  assert.strictEqual(plainWords("What’s this?"), "what's this");
});

// ---- match ----------------------------------------------------------------------

const SCREEN = [
  { id: "e1", role: "button", label: "Export" },
  { id: "e2", role: "area", label: "Message #design" },
  { id: "e3", role: "button", label: "Send" },
  { id: "o1", role: "text", label: "Quarterly revenue", ocr: true },
];

test("match: a question that names one thing is a show, with its id, label and how sure", () => {
  const m = match("Hey X0, where's export?", SCREEN);
  assert.deepStrictEqual(Object.keys(m).sort(), ["id", "intent", "label", "margin", "score"]);
  assert.strictEqual(m.id, "e1");
  assert.strictEqual(m.label, "Export");
  assert.strictEqual(m.intent, "show");
  assert.strictEqual(m.score, 1);
  assert.ok(m.margin >= 0.2);
});

test("match: an order to press is a do; the lines read off a picture match too", () => {
  assert.strictEqual(match("click send", SCREEN).intent, "do");
  assert.strictEqual(match("click send", SCREEN).id, "e3");
  assert.strictEqual(match("where is quarterly revenue", SCREEN).id, "o1");
});

test("match: question and order disagreeing is no intent, the server's to sort out", () => {
  // "?" makes it a question; "open" asks for a press.
  const m = match("open export?", SCREEN);
  assert.strictEqual(m.id, "e1");
  assert.strictEqual(m.intent, null);
});

test("match: nothing named, half a word, or nothing clear is null", () => {
  assert.strictEqual(match("", SCREEN), null);
  assert.strictEqual(match("turn on captions", SCREEN), null);
  assert.strictEqual(match("where's the exp", SCREEN), null, "a partial word is not yet a match");
  assert.strictEqual(match("where's save", [{ id: "e1", role: "button", label: "Save" }, { id: "e2", role: "button", label: "Save" }]), null);
  assert.strictEqual(match("where's export", "not a list"), null);
});

test("match: the names it answers to are taken off the front, the knobs' bars used", () => {
  assert.strictEqual(match("Zara, where's export", SCREEN, { names: ["Zara"] }).id, "e1");
  assert.strictEqual(match("Zara, where's export", SCREEN), null, "an unknown name stays in the words");
  assert.strictEqual(match("where's export", SCREEN, { score: 1.5 }), null);
});

// ---- isVisualQuestion -------------------------------------------------------------

test("isVisualQuestion: equations, charts, sums to solve and a bare “what's this”", () => {
  for (const q of [
    "explain this equation", "what does this chart show", "solve this", "what's this?", "whats this",
    "Hey X0, what is this?", "how do I solve this", "help me understand this graph",
    "can you describe this picture", "is this graph going up?", "what am I looking at",
    "find the derivative", "find x", "summarize this diagram", "ye kya hai", "is equation ko samjhao",
    "what is the formula in this cell", "show me what this chart means",
  ]) {
    assert.strictEqual(isVisualQuestion(q), true, q);
  }
});

test("isVisualQuestion: finding, pressing, written things and orders are not", () => {
  for (const q of [
    "", "what is this error", "where is the chart", "show me the chart", "open the image",
    "what does the image size setting do", "send this picture to sam", "explain this",
    "what does this button do", "where is export", "make this shorter", "turn on captions",
    "click the chart button",
  ]) {
    assert.strictEqual(isVisualQuestion(q), false, q);
  }
});

test("isVisualQuestion: an order that also puts the answer somewhere is not, since the picture's run never acts", () => {
  for (const q of [
    "calculate the total and type it in the reply box", "solve this and paste the answer into the chat",
    "evaluate the formula in B2 and put it in C2", "compute the average and send it to #finance",
    "fill in the amount field with the sum of these, calculate it", "describe this image and paste it into the reply",
  ]) {
    assert.strictEqual(isVisualQuestion(q), false, q);
  }
  // Working it out, or explaining it, still is; and those words as nouns are no order.
  for (const q of [
    "solve this equation", "calculate the total", "calculate this and add up the rest", "solve this and write out the steps",
    "what's the answer? type it in the box", "identify the type of graph", "summarize the chart in this post",
  ]) {
    assert.strictEqual(isVisualQuestion(q), true, q);
  }
});

test("isVisualQuestion: how to do something to a picture is about the app, not the picture", () => {
  for (const q of [
    "how do I insert an image", "can I add a chart here?", "how can I crop this photo", "how to create a pie chart",
    "is there a way to resize the image?", "how do I change the logo", "what happens if I delete this image",
    "how do i quickly rotate the picture?", "I can't figure out how to export?",
  ]) {
    assert.strictEqual(isVisualQuestion(q), false, q);
  }
  // …while reading it, or working it out, still is.
  for (const q of [
    "how do I read this chart", "how do I make sense of this graph", "how do I solve this equation",
    "how do i get the area of this triangle", "what does this figure show",
  ]) {
    assert.strictEqual(isVisualQuestion(q), true, q);
  }
});

test("the server's grammar replaces the rules here, rule by rule; one that does not compile keeps today's", () => {
  const knobs = require("./knobs.js");
  const res = require("./resolver.js");
  try {
    knobs.setKnobs({ labels: {}, flags: { "desktop.agent.grammar": {
      headFiller: { source: "^(?:um+|accha|so)\\b[\\s,]*", flags: "" },
      pointAsk: { source: "(", flags: "" },
      roleWords: { knob: ["slider"] },
    } } });
    assert.strictEqual(res.commandText("accha scroll down"), "scroll down");
    assert.deepStrictEqual(res.resolverAsk("where's export"), { verb: "point", target: "export", roleHint: undefined });
    assert.strictEqual(res.resolverAsk("where's the volume knob").roleHint, "knob");
  } finally {
    knobs.setKnobs({ labels: {}, flags: {} });
  }
  assert.strictEqual(res.commandText("accha scroll down"), "accha scroll down");
});
