// node --test
//
// Paint: what the server may say, what it may not, and the numbers it is held to. Every clamp here is the phone's
// own (theme/paintCore.ts), so a box painted once looks the same on both.
const test = require("node:test");
const assert = require("node:assert");
const { fakePage } = require("../../testkit.js");

const paint = (page, style) => JSON.parse(page.run("JSON.stringify(v2Paint(" + JSON.stringify(style) + "))"));

test("a gradient comes through as CSS, written either way", () => {
  const page = fakePage();
  assert.strictEqual(
    paint(page, { backgroundImage: { kind: "linear", angle: 90, stops: [{ color: "#000" }, { color: "#fff", at: "50%" }] } }).backgroundImage,
    "linear-gradient(90deg, #000, #fff 50%)",
  );
  assert.strictEqual(
    paint(page, { backgroundImage: "linear-gradient(to right, #000, rgba(0,0,0,.2))" }).backgroundImage,
    "linear-gradient(to right, #000, rgba(0,0,0,.2))",
  );
});

test("a colour that is not a colour drops its whole layer", () => {
  const page = fakePage();
  assert.strictEqual(paint(page, { backgroundImage: 'linear-gradient(url("https://evil.test/x.png"), #000)' }).backgroundImage, undefined);
  assert.strictEqual(paint(page, { backgroundImage: { kind: "linear", stops: [{ color: "var(--secret)" }, { color: "#fff" }] } }).backgroundImage, undefined);
});

test("a shadow is clamped, however far the server pushes it", () => {
  const page = fakePage();
  const s = paint(page, { boxShadow: { offsetX: 9999, offsetY: -9999, blurRadius: 500, spreadDistance: 900, color: "#000" } }).boxShadow;
  assert.strictEqual(s, "100px -100px 80px 50px #000");
  assert.strictEqual(paint(page, { boxShadow: "0 4 12 0 rgba(0,0,0,.2)" }).boxShadow, "0px 4px 12px 0px rgba(0,0,0,.2)");
});

test("only the filters both phones draw get through", () => {
  const page = fakePage();
  assert.strictEqual(paint(page, { filter: "brightness(0.8) blur(40px)" }).filter, "brightness(0.8)");
  assert.strictEqual(paint(page, { filter: [{ opacity: 0.5 }] }).filter, "opacity(0.5)");
  assert.strictEqual(paint(page, { filter: "hue-rotate(90deg)" }).filter, undefined);
});

test("a blend mode is one of the list, and a blur becomes a backdrop filter", () => {
  const page = fakePage();
  assert.strictEqual(paint(page, { mixBlendMode: "multiply" }).mixBlendMode, "multiply");
  assert.strictEqual(paint(page, { mixBlendMode: "x; background:url(evil)" }).mixBlendMode, undefined);
  assert.strictEqual(paint(page, { blur: 100 }).backdropFilter, "blur(30px)");
  assert.strictEqual(paint(page, { blur: 9999 }).backdropFilter, "blur(30px)");
  assert.strictEqual(paint(page, { blur: { intensity: 50, tint: "dark" } }).backdropFilter, "blur(15px)");
});

test("a style with no paint keys is handed back untouched", () => {
  const page = fakePage();
  const style = { padding: 8, color: "$color.text" };
  assert.strictEqual(page.run("(function(){ var s = " + JSON.stringify(style) + "; return v2Paint(s) === s; })()"), true);
});

test("paint only runs for a screen that asked for it", () => {
  const page = fakePage();
  page.run('CURRENT_SCREEN = { screenId: "card", root: { type: "Stack", style: { boxShadow: "0 4 12 0 #000" } } }; STATE = {};');
  // Off, the key goes through css() exactly as it always has — unread by the browser, and unchanged by this build.
  assert.match(page.run("node(CURRENT_SCREEN.root)"), /box-shadow:0 4 12 0 #000/);
  page.run('CURRENT_SCREEN = { screenId: "card2", needs: ["paint"], root: { type: "Stack", style: { boxShadow: "0 4 12 0 #000" } } };');
  assert.match(page.run("node(CURRENT_SCREEN.root)"), /box-shadow:0px 4px 12px 0px #000/);
});
