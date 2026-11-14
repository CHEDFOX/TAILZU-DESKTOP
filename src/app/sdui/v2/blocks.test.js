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
  assert.deepStrictEqual(hand.blocks, ["expr", "defs", "rules", "device", "local", "paint", "motion", "gesture", "list", "input", "media", "data", "shell"]);
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
