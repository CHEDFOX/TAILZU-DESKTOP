// node --test
//
// The gate: a screen says what it needs, and this build either has every block or draws the screen's own fallback.
// Every block is off for a screen that says nothing, which is what keeps today's screens drawing as they always did.
const test = require("node:test");
const assert = require("node:assert");
const { fakePage } = require("../../testkit.js");

/** A page with a screen up, drawn the way repaint() draws one. */
function drawn(page, screen) {
  page.run("CURRENT_SCREEN = " + JSON.stringify(screen) + "; STATE = " + JSON.stringify(screen.state || {}) + ";");
  return page.run("node(CURRENT_SCREEN.root)");
}

test("the handshake names vocab 2 and only the blocks this window draws", () => {
  const page = fakePage();
  const hand = JSON.parse(page.run("JSON.stringify(v2Handshake())"));
  assert.strictEqual(hand.vocab, 2);
  assert.deepStrictEqual(hand.blocks, ["expr", "defs", "rules", "device", "local", "paint", "motion", "gesture", "list", "input", "media", "data", "shell", "call"]);
  // Camera is a phone's: a window has no viewfinder, so `media` here means Video and Audio and the node falls back.
  assert.strictEqual(page.run('v2Node({ type: "Camera" }, {}, "", "")'), null);
});

test("a screen that says nothing gets no blocks, and draws exactly as before", () => {
  const page = fakePage();
  const html = drawn(page, { screenId: "home", root: { type: "Text", props: { content: "Hello" } } });
  assert.match(html, /Hello/);
  assert.strictEqual(page.run("V2.on"), false);
  assert.strictEqual(page.run('v2Has("expr")'), false);
  // A `$` prop on such a screen is never evaluated: no expression ran at all.
  drawn(page, { screenId: "home2", state: { x: "secret" }, root: { type: "Text", props: { content: { $: "state.x" } } } });
  assert.strictEqual(page.run("V2.ops"), 0);
});

test("a screen that needs a block this build has not got draws its own fallback", () => {
  const page = fakePage();
  const html = drawn(page, {
    screenId: "future", needs: ["expr", "scene"],
    root: { type: "Text", props: { content: "the new thing" } },
    fallback: { type: "Text", props: { content: "Open X0 again" } },
  });
  assert.match(html, /Open X0 again/);
  assert.doesNotMatch(html, /the new thing/);
  assert.deepStrictEqual(JSON.parse(page.run("JSON.stringify(V2.missing)")), ["scene"]);
});

test("without a fallback the gate draws the update card, never a blank page", () => {
  const page = fakePage();
  const html = drawn(page, { screenId: "future", needs: ["scene"], root: { type: "Text", props: { content: "x" } } });
  assert.match(html, /Update X0/);
});

test("a kill switch takes a block out of the handshake and off every screen", () => {
  const page = fakePage();
  page.run('K.setKnobs({ labels: {}, flags: { "sdui.off": ["list"] } })');
  assert.ok(JSON.parse(page.run("JSON.stringify(v2Declared())")).indexOf("list") === -1);
  const html = drawn(page, { screenId: "feed", needs: ["list"], root: { type: "List", props: { data: [], item: { type: "Text" } } } });
  assert.match(html, /Update X0/);
  page.run('K.setKnobs({ labels: {}, flags: { "sdui.safe": true } })');
  assert.deepStrictEqual(JSON.parse(page.run("JSON.stringify(v2Declared())")), []);
});

test("a Caller draws its ground before anyone is in the call, and a letter once someone is", () => {
  const page = fakePage();
  page.run('V2.on = true; V2.needs = ["call"];');
  // No call yet: the tile is laid out, and draws nothing in it.
  const empty = page.run('v2CallerNode({ type: "Caller" }, { who: "me", background: "#111" }, "")');
  assert.match(empty, /background:#111/);
  assert.doesNotMatch(empty, /<video/);

  // In a call, with nobody's camera on: their initial.
  page.run('V2_CALL = { statePath: "c", phase: "live", mic: true, cam: false, me: { identity: "h_1", name: "Aanya" }, people: [{ identity: "g_1", name: "Ravi", role: "guest" }], waiting: [], held: [], byMid: new Map(), heard: {} };');
  const mine = page.run('v2CallerNode({ type: "Caller" }, { who: "me" }, "")');
  assert.match(mine, />A</);
  const theirs = page.run('v2CallerNode({ type: "Caller" }, { who: "g_1" }, "")');
  assert.match(theirs, />R</);
  // "speaker" with nobody talking is the first person, so a one-tile screen is never blank.
  assert.match(page.run('v2CallerNode({ type: "Caller" }, { who: "speaker" }, "")'), />R</);
  page.run("V2_CALL = null;");
});

test("the screen reads the call, and never its seat", () => {
  const page = fakePage();
  page.run('V2_CALL = { statePath: "c", phase: "live", mic: true, cam: true, seat: "r.SECRET", me: { identity: "h_1", name: "Aanya" }, people: [{ identity: "g_1", name: "Ravi", role: "guest", audio: "g_1-audio" }], waiting: [{ id: "k1", name: "Asha" }], held: [], byMid: new Map(), heard: {} };');
  const state = JSON.parse(page.run("JSON.stringify(v2CallState(V2_CALL))"));
  assert.deepStrictEqual(state.people, [{ identity: "g_1", name: "Ravi", role: "guest", speaking: false, mic: true, cam: false }]);
  assert.deepStrictEqual(state.waiting, [{ id: "k1", name: "Asha" }]);
  assert.strictEqual(JSON.stringify(state).includes("SECRET"), false);
  page.run("V2_CALL = null;");
});
