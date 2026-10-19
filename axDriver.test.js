// node --test
//
// The Mac driver's plumbing, run against a fake helper (test-fixtures/
// fake-tzax.js) that speaks build/tzax's line protocol, so it runs on any
// machine. What matters here is the promise to main.js: every call resolves,
// never rejects, within its timeout; answers find their own caller even out
// of order; junk on the pipe is stepped over; a dead or hung helper is
// replaced by the next call. The Swift side itself only runs on a Mac
// (nativeCheck.js mac, in CI).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const axDriver = require("./axDriver.js");
const { createAxDriver } = axDriver;

const FAKE = path.join(__dirname, "test-fixtures", "fake-tzax.js");
const API = ["available", "start", "stop", "trusted", "snapshot", "press", "click", "setValue", "focus", "scroll", "key", "open"];

/** A driver on the fake helper, as if on a Mac. */
function fake(extra = {}) {
  return createAxDriver({ bin: process.execPath, args: [FAKE], platform: "darwin", ...extra });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("the module is exactly the driver API", () => {
  assert.deepStrictEqual(Object.keys(axDriver).sort(), [...API].sort());
  for (const name of API) assert.strictEqual(typeof axDriver[name], "function", name);
  assert.strictEqual(typeof createAxDriver, "function");
});

test("off a Mac, or without the helper, nothing starts and every call says so", async () => {
  const linux = createAxDriver({ bin: process.execPath, platform: "linux" });
  assert.strictEqual(linux.available(), false);
  assert.strictEqual(linux.start(), false);
  assert.deepStrictEqual(await linux.snapshot(), { ok: false, error: "unavailable" });

  const missing = createAxDriver({ bin: path.join(__dirname, "build", "no-such-helper"), platform: "darwin" });
  assert.strictEqual(missing.available(), false);
  assert.deepStrictEqual(await missing.press("e1"), { ok: false, error: "unavailable" });
  assert.deepStrictEqual(await missing.trusted({ prompt: true }), { ok: false, error: "unavailable" });
  missing.stop(); // nothing to stop: no throw
});

test("a snapshot comes back whole, past junk lines and a split write", async (t) => {
  const d = fake();
  t.after(() => d.stop());
  assert.strictEqual(d.available(), true);
  const s = await d.snapshot({ max: 40 });
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.id, undefined, "the protocol's id is not the caller's business");
  assert.deepStrictEqual(s.elements.map((e) => e.id), ["e1", "e2", "e3"]);
  assert.strictEqual(s.focused, "e2");
  assert.strictEqual(s.scale, "points");
  // What the helper was asked: the max, a walk budget inside the call's
  // timeout, and that timeout itself.
  assert.strictEqual(s.got.cmd, "snapshot");
  assert.strictEqual(s.got.max, 40);
  assert.strictEqual(s.got.timeoutMs, 1500);
  assert.ok(s.got.budgetMs > 0 && s.got.budgetMs <= 1200, `budget ${s.got.budgetMs}`);
});

test("trusted answers only ok and trusted", async (t) => {
  const d = fake();
  t.after(() => d.stop());
  assert.deepStrictEqual(await d.trusted({ prompt: false }), { ok: true, trusted: true });
  assert.deepStrictEqual(await d.trusted(), { ok: true, trusted: true });
});

test("each command goes out in the helper's words", async (t) => {
  const d = fake();
  t.after(() => d.stop());
  const sent = async (p) => {
    const r = await p;
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const { id, timeoutMs, ...rest } = r.got;
    assert.ok(Number.isInteger(id) && id > 0);
    assert.strictEqual(timeoutMs, 1200);
    return rest;
  };
  assert.deepStrictEqual(await sent(d.press("e3")), { cmd: "press", el: "e3" });
  assert.deepStrictEqual(await sent(d.click("e3")), { cmd: "click", el: "e3" });
  assert.deepStrictEqual(await sent(d.setValue("e2", "quarterly report")), { cmd: "setValue", el: "e2", text: "quarterly report" });
  assert.deepStrictEqual(await sent(d.setValue("e2", "")), { cmd: "setValue", el: "e2", text: "" });
  assert.deepStrictEqual(await sent(d.focus("e2")), { cmd: "focus", el: "e2" });
  assert.deepStrictEqual(await sent(d.scroll("e3", "Down", 3)), { cmd: "scroll", el: "e3", dir: "down", lines: 3 });
  assert.deepStrictEqual(await sent(d.scroll(null, "up")), { cmd: "scroll", el: null, dir: "up", lines: 5 });
  assert.deepStrictEqual(await sent(d.key("cmd+shift+t")), { cmd: "key", chord: "cmd+shift+t" });
  assert.deepStrictEqual(await sent(d.open("Slack")), { cmd: "open", app: "Slack" });
});

test("answers find their own caller when they come back out of order", async (t) => {
  const d = fake();
  t.after(() => d.stop());
  const order = [];
  const slow = d.press("e300").then((r) => { order.push("slow"); return r; });
  const quick = d.press("e10").then((r) => { order.push("quick"); return r; });
  const [a, b] = await Promise.all([slow, quick]);
  assert.deepStrictEqual(order, ["quick", "slow"]);
  assert.strictEqual(a.got.el, "e300");
  assert.strictEqual(b.got.el, "e10");
  assert.strictEqual(a.how, "AXPress");
});

test("a call the helper never answers resolves timeout, and the helper carries on", async (t) => {
  const d = fake({ actionTimeoutMs: 150 });
  t.after(() => d.stop());
  const first = await d.focus("e1");
  const t0 = Date.now();
  const r = await d.press("e999");
  const took = Date.now() - t0;
  assert.deepStrictEqual(r, { ok: false, error: "timeout" });
  assert.ok(took >= 140 && took < 1000, `took ${took} ms`);
  const after = await d.focus("e1");
  assert.strictEqual(after.ok, true);
  assert.strictEqual(after.pid, first.pid, "a slow answer is not a reason to restart the helper");
});

test("a helper that dies fails its calls at once and is started again by the next one", async (t) => {
  const d = fake();
  t.after(() => d.stop());
  const before = await d.focus("e1");
  const waiting = d.press("e400");
  const t0 = Date.now();
  const died = await d.key("die");
  assert.deepStrictEqual(died, { ok: false, error: "helper_exited" });
  assert.deepStrictEqual(await waiting, { ok: false, error: "helper_exited" });
  assert.ok(Date.now() - t0 < 1000, "a dead helper is not waited out to the timeout");
  const again = await d.focus("e1");
  assert.strictEqual(again.ok, true);
  assert.notStrictEqual(again.pid, before.pid);
});

test("a helper that hangs is killed after its silence and replaced", async (t) => {
  const d = fake({ actionTimeoutMs: 120, wedgeMs: 200 });
  t.after(() => d.stop());
  const before = await d.focus("e1");
  assert.deepStrictEqual(await d.key("hang"), { ok: false, error: "timeout" });
  await sleep(350);
  const again = await d.focus("e1");
  assert.strictEqual(again.ok, true, JSON.stringify(again));
  assert.notStrictEqual(again.pid, before.pid);
});

test("an answer without ok is a failure, not a success", async (t) => {
  const d = fake();
  t.after(() => d.stop());
  assert.deepStrictEqual(await d.open("noshape"), { ok: false, error: "bad_answer" });
});

test("bad arguments resolve a failure without bothering the helper", async (t) => {
  const d = fake();
  t.after(() => d.stop());
  const cases = [
    [d.press(), "bad_id"], [d.press("x1"), "bad_id"], [d.press(7), "bad_id"], [d.click({}), "bad_id"],
    [d.focus("e1; rm -rf"), "bad_id"], [d.setValue(undefined, "hi"), "bad_id"],
    [d.scroll("e1", "sideways"), "bad_dir"], [d.scroll("nope", "down"), "bad_id"],
    [d.key(""), "bad_chord"], [d.key(null), "bad_chord"], [d.open(""), "bad_app"], [d.open(42), "bad_app"],
  ];
  for (const [p, error] of cases) assert.deepStrictEqual(await p, { ok: false, error });
  // A strange snapshot argument is just the defaults.
  const s = await d.snapshot("whatever");
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.got.max, 250);
});

test("nothing rejects, even when spawning itself fails", async () => {
  const throws = createAxDriver({ bin: "/x/tzax", platform: "darwin", exists: () => true, spawn: () => { throw new Error("EACCES"); } });
  assert.strictEqual(throws.start(), false);
  assert.deepStrictEqual(await throws.snapshot(), { ok: false, error: "spawn_failed" });

  // There, but not something that runs: the spawn errors asynchronously.
  const broken = createAxDriver({ bin: path.join(__dirname, "test-fixtures", "no-such-binary"), platform: "darwin", exists: () => true });
  const r = await broken.press("e1");
  assert.strictEqual(r.ok, false);
  assert.ok(["helper_failed", "helper_exited"].includes(r.error), r.error);
  broken.stop();
});

test("start is idempotent and stop answers what was waiting", async () => {
  const d = fake();
  assert.strictEqual(d.start(), true);
  assert.strictEqual(d.start(), true);
  const a = await d.focus("e1");
  const b = await d.focus("e1");
  assert.strictEqual(a.pid, b.pid, "one warm helper, not one per call");
  const waiting = d.press("e800");
  d.stop();
  assert.deepStrictEqual(await waiting, { ok: false, error: "stopped" });
  const c = await d.focus("e1"); // the next call starts it again
  assert.strictEqual(c.ok, true);
  assert.notStrictEqual(c.pid, a.pid);
  d.stop();
});

// The helper and the driver are two halves of one protocol, written in two
// languages; this keeps them from drifting apart where it can be seen from
// here.
test("the Swift helper knows every command the driver sends", () => {
  const swift = fs.readFileSync(path.join(__dirname, "native", "tzax.swift"), "utf8");
  for (const cmd of ["ping", "trusted", "snapshot", "press", "click", "setValue", "focus", "scroll", "key", "open"]) {
    assert.ok(swift.includes(`case "${cmd}"`), `tzax.swift has no case "${cmd}"`);
  }
  for (const field of ['"el"', '"text"', '"dir"', '"lines"', '"chord"', '"app"', '"max"', '"budgetMs"', '"timeoutMs"', '"prompt"']) {
    assert.ok(swift.includes(field), `tzax.swift never reads ${field}`);
  }
});

test("the helper is built and shipped with the Mac app", () => {
  const pkg = require("./package.json");
  assert.match(pkg.scripts.tzax, /native\/tzax\.swift/);
  assert.match(pkg.scripts.tzax, /arm64-apple-macos13/);
  assert.match(pkg.scripts.tzax, /x86_64-apple-macos13/);
  assert.match(pkg.scripts.tzax, /lipo -create -output build\/tzax /);
  assert.ok(pkg.build.mac.extraResources.some((r) => r.from === "build/tzax" && r.to === "tzax"));
  assert.match(pkg.build.mac.x64ArchFiles, /\*\*\/tzax\b/);
  const ci = fs.readFileSync(path.join(__dirname, ".github", "workflows", "build.yml"), "utf8");
  assert.match(ci, /npm run tzax/);
});
