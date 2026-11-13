// node --test
//
// DotArt (sdui/dots.js, ../../dotArt.js; shared/types/sdui.ts 3k): what a bot draws, as dots that obey physics. The window says it
// draws it; the node is a box with an empty canvas and a label for a screen reader; a picture that comes in is on the one loop until
// it settles, then costs nothing; a click scatters it and the loop runs again until it is home; a repaint keeps it, so a refreshed
// chat does not bring it in again; Reduce Motion is still and deaf to the pointer; and the rules are generated from the phone's file,
// untouched.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { fakePage } = require("./testkit.js");

const FILES = ["knobs.js", "botTiles.js", "dotArt.js", "botLooks.js", "sdui.js"];

/** A bar of 12 dots and a faint track under it. */
const picture = (extra = {}) => {
  const d = [];
  for (let i = 0; i < 12; i++) d.push(8 + i * 10, 12, 3, 1, 0);
  for (let i = 0; i < 12; i++) d.push(8 + i * 10, 30, 2, 0.18, 1);
  return { type: "DotArt", props: Object.assign({ w: 140, h: 40, d, key: "t1.b0", label: "Spending by month" }, extra) };
};

function page(kids, o = {}) {
  const p = fakePage(Object.assign({ files: FILES }, o));
  p.run("ENV = { baseUrl: 'https://api.test' }; SESSION = null");
  p.view.rect = { left: 0, top: 0, width: 720, height: 800 };
  p.ctx.__sc = { screenId: "bots.chat", look: "bots", root: { type: "Stack", children: kids }, state: {} };
  p.run("STACK = [{ screenId: 'bots.chat', params: { slug: 'travel' } }]; STATE = {}; repaint(__sc)");
  const hosts = () => p.view.querySelectorAll(".tz-da");
  const members = () => p.run("DA_LOOP.members.size");
  return { p, hosts, members };
}

test("the window says it draws DotArt", () => {
  const { p } = page([]);
  assert.ok(p.run("capabilities().components").includes("DotArt"));
});

test("the node: a w x h box with an empty canvas and a label; a picture with no dots is nothing", () => {
  const { hosts } = page([picture(), picture({ d: [], key: "t1.b1" })]);
  const [a, b] = hosts();
  assert.strictEqual(hosts().length, 1);
  assert.strictEqual(a.getAttribute("role"), "img");
  assert.strictEqual(a.getAttribute("aria-label"), "Spending by month");
  assert.match(a.style.width, /^140px$/);
  assert.ok(a.querySelector(".tz-da-c"), "a canvas to draw in");
  assert.strictEqual(b, undefined);
});

test("a picture that comes in is on the loop until it settles, then costs nothing", () => {
  const { p, members } = page([picture({ enter: "fall" })]);
  assert.strictEqual(members(), 1);
  p.tick(5000);
  assert.strictEqual(members(), 0, "home and asleep");
  const f = p.run("DA_KEPT.get('t1.b0')");
  assert.strictEqual(f.awake, false);
});

test("a picture already home is not on the loop; a click scatters it and the loop runs until it is home again", () => {
  const { p, hosts, members } = page([picture()]);
  assert.strictEqual(members(), 0);
  const host = hosts()[0];
  host.rect = { left: 0, top: 0, width: 140, height: 40 };
  host.dispatchEvent(new p.dom.Ev("pointerdown", { clientX: 30, clientY: 12 }));
  host.dispatchEvent(new p.dom.Ev("pointerleave", {}));
  assert.strictEqual(members(), 1);
  p.tick(50);
  const f = p.run("DA_KEPT.get('t1.b0')");
  let off = 0;
  for (let i = 0; i < f.spec.n; i++) off = Math.max(off, Math.abs(f.px[i] - f.spec.x[i]));
  assert.ok(off > 0.5, "the dots near the click moved");
  p.tick(5000);
  assert.strictEqual(members(), 0);
});

test("the pointer resting on it pushes the dots aside while it is there", () => {
  const { p, hosts, members } = page([picture()]);
  const host = hosts()[0];
  host.rect = { left: 0, top: 0, width: 140, height: 40 };
  host.dispatchEvent(new p.dom.Ev("pointermove", { clientX: 60, clientY: 12 }));
  p.tick(400);
  assert.strictEqual(members(), 1, "still pushed, still moving");
  host.dispatchEvent(new p.dom.Ev("pointerleave", {}));
  p.tick(5000);
  assert.strictEqual(members(), 0);
});

test("a repaint keeps the picture: a refreshed chat does not bring it in again", () => {
  const { p, members } = page([picture({ enter: "gather" })]);
  p.tick(5000);
  const before = p.run("DA_KEPT.get('t1.b0')");
  p.run("repaint(__sc)");
  assert.strictEqual(p.run("DA_KEPT.get('t1.b0')"), before);
  assert.strictEqual(members(), 0, "nothing comes in again");
});

test("Reduce Motion: at home, still, and deaf to the pointer", () => {
  const { p, hosts, members } = page([picture({ enter: "fall", heat: 1 })], { reduced: true });
  assert.strictEqual(members(), 0);
  const host = hosts()[0];
  host.dispatchEvent(new p.dom.Ev("pointerdown", { clientX: 30, clientY: 12 }));
  assert.strictEqual(members(), 0);
  const f = p.run("DA_KEPT.get('t1.b0')");
  assert.strictEqual(f.motion, false);
});

test("the rules are the phone's, generated, and untouched", () => {
  const text = fs.readFileSync(path.join(__dirname, "../../dotArt.js"), "utf8");
  assert.match(text, /^\/\/ GENERATED: do not edit\./);
  assert.match(text, /dotArtCore\.ts sha256 [0-9a-f]{64}/);
  const body = /body sha256 ([0-9a-f]{64})/.exec(text)[1];
  const at = text.indexOf("\n(function (root, factory)");
  assert.strictEqual(crypto.createHash("sha256").update(text.slice(at + 1)).digest("hex"), body, "dotArt.js was edited by hand: regenerate it");
  const api = require("../../dotArt.js");
  for (const name of ["readDotArt", "DotField", "Kept", "fieldFor", "DOT_PHYSICS"]) assert.ok(api[name], name);
  // it ships
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"));
  assert.ok(pkg.build.files.includes("dotArt.js"));
});
