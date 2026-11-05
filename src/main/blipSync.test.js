// node --test
//
// Keeping Blip's catalog up to date: fetched only when the server names another version, checked before it is kept,
// kept for the next launch, and a bad one never replaces a good one.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createBlipSync } = require("./blipSync.js");

const starter = () => JSON.parse(JSON.stringify(require("../shared/blipStarter.js")));
function rig(answer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blip-sync-"));
  const asked = [], changed = [];
  const fetch = async (url) => { asked.push(url); const a = answer(url); return { ok: a !== null, text: async () => (typeof a === "string" ? a : JSON.stringify(a)) }; };
  const make = () => createBlipSync({ userData: dir, baseUrl: () => "https://api.local/", fetch, onChange: (c) => changed.push(c.v) });
  return { dir, asked, changed, make };
}

test("a newer catalog is fetched, checked, kept for the next launch and handed on", async () => {
  const v2 = Object.assign(starter(), { v: 2 });
  const r = rig(() => v2);
  const s = r.make();
  assert.strictEqual(s.catalog(), null);
  assert.strictEqual(await s.check({ v: 2, url: "/v1/blip?v=2" }), true);
  assert.deepStrictEqual(r.asked, ["https://api.local/v1/blip?v=2"]);
  assert.deepStrictEqual(r.changed, [2]);
  assert.strictEqual(s.catalog().v, 2);
  // The same version again: nothing fetched.
  assert.strictEqual(await s.check({ v: 2, url: "/v1/blip?v=2" }), false);
  assert.strictEqual(r.asked.length, 1);
  // The next launch has it before any network.
  assert.strictEqual(r.make().catalog().v, 2);
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test("a catalog that does not compile, has another v, or comes from elsewhere is not kept", async () => {
  const bad = { v: 3, gestures: { jelly: { pose: { tilt: 1 } } } };
  const r = rig((url) => (url.endsWith("=3") ? bad : url.endsWith("=4") ? Object.assign(starter(), { v: 9 }) : "not json"));
  const s = r.make();
  assert.strictEqual(await s.check({ v: 3, url: "/v1/blip?v=3" }), false);
  assert.strictEqual(await s.check({ v: 4, url: "/v1/blip?v=4" }), false);
  assert.strictEqual(await s.check({ v: 5, url: "/v1/blip?v=5" }), false);
  assert.strictEqual(await s.check({ v: 6, url: "https://elsewhere.example/blip" }), false);
  assert.strictEqual(await s.check({ v: "7", url: "/v1/blip" }), false);
  assert.strictEqual(s.catalog(), null);
  assert.deepStrictEqual(r.changed, []);
  assert.ok(!r.asked.some((u) => u.includes("elsewhere")));
  fs.rmSync(r.dir, { recursive: true, force: true });
});
