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
const API = ["available", "start", "stop", "trusted", "snapshot", "press", "click", "setValue", "focus", "scroll", "key", "open", "look", "caret"];

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
  assert.deepStrictEqual(s.window, { frame: [100, 80, 800, 600], title: "Q3 plan.txt — Fake" });
  // What the helper was asked: the max, a walk budget inside the call's
  // timeout, and that timeout itself.
  assert.strictEqual(s.got.cmd, "snapshot");
  assert.strictEqual(s.got.max, 40);
  assert.strictEqual(s.got.timeoutMs, 1500);
  assert.ok(s.got.budgetMs > 0 && s.got.budgetMs <= 1200, `budget ${s.got.budgetMs}`);
});

// agent.js refuses a private window or a sensitive site from this title on
// every read, so it is always there to test: a string of at most 200
// characters, "" when the helper sent none. It never joins the elements.
test("a snapshot's window always has a title string, and no window is null", async (t) => {
  const d = fake();
  t.after(() => d.stop());
  const old = await d.snapshot({ max: 2 });
  assert.deepStrictEqual(old.window, { frame: [100, 80, 800, 600], title: "" });
  const long = await d.snapshot({ max: 3 });
  assert.strictEqual(long.window.title.length, 200);
  assert.ok(long.window.title.startsWith("Private Browsing — "));
  assert.deepStrictEqual(long.window.frame, [100, 80, 800, 600]);
  for (const s of [old, long]) assert.ok(!JSON.stringify(s.elements).includes("Private Browsing"));
  const none = await d.snapshot({ max: 4 });
  assert.strictEqual(none.ok, true);
  assert.strictEqual(none.window, null);
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

// A look is the window's picture and its text, read on the Mac (v2 §A). The
// agent places everything by the window's frame, matches the lines against
// what the user says, and sends the picture only with permission.
const FAKE_LINES = [
  { text: "Export as PDF", frame: [180, 140, 240, 30], conf: 0.93 },
  { text: "x² + y² = 1", frame: [180, 326, 200, 24], conf: 0.7 },
  { text: "Q3 revenue", frame: [500, 326, 160, 24], conf: 0.88 },
];

test("a look comes back with its window, its lines and its picture", async (t) => {
  const d = fake();
  t.after(() => d.stop());
  const r = await d.look();
  assert.strictEqual(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.deepStrictEqual(r.window, { frame: [100, 50, 800, 600], title: "Q3 plan.txt — Fake" });
  assert.strictEqual(r.scale, "points");
  assert.deepStrictEqual(r.lines, FAKE_LINES);
  assert.deepStrictEqual(r.titleFrames, [[100, 50, 800, 28]], "where the title bar is, a frame only");
  assert.strictEqual(r.image.mime, "image/jpeg");
  assert.deepStrictEqual([r.image.width, r.image.height], [1600, 1200]);
  assert.ok(Buffer.from(r.image.data, "base64").subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), "a JPEG");
  assert.strictEqual(r.ms, 12);
  assert.strictEqual(r.id, undefined);
  // In the helper's words: the contract's defaults, and the look's own time.
  const { id, ...sent } = r.got;
  assert.ok(Number.isInteger(id) && id > 0);
  assert.deepStrictEqual(sent, { cmd: "look", budgetMs: 1500, maxSide: 1600, quality: 0.82, ocr: true, image: true, timeoutMs: 2500 });

  const bare = await d.look({ ocr: false, image: false, maxSide: 800, quality: 0.6, budgetMs: 900 });
  assert.strictEqual(bare.ok, true);
  assert.deepStrictEqual(bare.lines, []);
  assert.strictEqual(bare.image, null);
  assert.deepStrictEqual(bare.window.frame, [100, 50, 800, 600]);
  assert.deepStrictEqual([bare.got.ocr, bare.got.image, bare.got.maxSide, bare.got.quality, bare.got.budgetMs], [false, false, 800, 0.6, 900]);
});

test("a look waits its own time, longer than an action's, and then resolves timeout", async (t) => {
  const d = fake({ actionTimeoutMs: 100, lookTimeoutMs: 400 });
  t.after(() => d.stop());
  const first = await d.focus("e1");
  const t0 = Date.now();
  const r = await d.look({ maxSide: 998 });
  const took = Date.now() - t0;
  assert.deepStrictEqual(r, { ok: false, error: "timeout" });
  assert.ok(took >= 390 && took < 1500, `took ${took} ms`);
  // The helper was slow, not stuck: it carries on.
  const after = await d.focus("e1");
  assert.strictEqual(after.pid, first.pid);
  // A call may set its own time; the budget stays inside it.
  const long = await d.look({ timeoutMs: 5000 });
  assert.deepStrictEqual([long.got.timeoutMs, long.got.budgetMs], [5000, 1500]);
  const short = await d.look({ timeoutMs: 600 });
  assert.deepStrictEqual([short.got.timeoutMs, short.got.budgetMs], [600, 200]);
});

test("a slow look holds up none of the calls made beside it", async (t) => {
  const d = fake();
  t.after(() => d.stop());
  const order = [];
  const looking = d.look({ maxSide: 997 }).then((r) => { order.push("look"); return r; });
  const snap = await d.snapshot();
  order.push("snapshot");
  const pressed = await d.press("e3");
  order.push("press");
  const r = await looking;
  assert.deepStrictEqual(order, ["snapshot", "press", "look"]);
  assert.strictEqual(snap.ok, true);
  assert.strictEqual(pressed.ok, true);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.got.maxSide, 997);
});

test("a Mac without Screen Recording gets no_screen_permission, nothing more", async (t) => {
  const d = fake();
  t.after(() => d.stop());
  const r = await d.look({ maxSide: 999 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, "no_screen_permission");
  assert.strictEqual(r.window, undefined);
  assert.strictEqual(r.image, undefined);
});

test("a look's answer is cleaned: what cannot be placed goes, a picture that is not one is null", async (t) => {
  const d = fake();
  t.after(() => d.stop());
  const r = await d.look({ maxSide: 996 });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.window, { frame: [100, 50, 800, 600], title: "" });
  assert.strictEqual(r.scale, "points");
  assert.strictEqual(r.image, null);
  assert.strictEqual(r.lines.length, 300);
  assert.deepStrictEqual(r.lines.slice(0, 3).map((l) => [l.text.length, l.conf]), [[120, 1], ["no conf".length, 0], ["odd conf".length, 0]]);
  assert.ok(r.lines.slice(3).every((l, i) => l.text === "line " + i && l.conf === 0));
  for (const l of r.lines) {
    assert.ok(typeof l.text === "string" && l.text.trim() && l.text.length <= 120);
    assert.ok(Array.isArray(l.frame) && l.frame.length === 4 && l.frame.every(Number.isFinite) && l.frame[2] >= 0 && l.frame[3] >= 0);
  }
  assert.deepStrictEqual(r.titleFrames, Array.from({ length: 8 }, (_, i) => [100, 50 + i, 800, 28]), "frames only, with a size, at most 8");
  // Without a window there is nothing to place anything by.
  assert.deepStrictEqual(await d.look({ maxSide: 995 }), { ok: false, error: "bad_answer" });
});

test("a picture of several megabytes comes through whole", async (t) => {
  const d = fake();
  t.after(() => d.stop());
  const r = await d.look({ maxSide: 994 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.image.data.length, 5 << 20);
  assert.deepStrictEqual(r.lines, FAKE_LINES);
  assert.strictEqual((await d.focus("e1")).ok, true, "the pipe is clean after it");
});

// The driver looks for a newline only in the pieces that have one; a line
// still has to end wherever its newline lands, and what follows it in the
// same piece is still read.
test("an answer whose newline comes in a later piece, with more after it, is read whole", async (t) => {
  const d = fake();
  t.after(() => d.stop());
  const r = await d.look({ maxSide: 993 });
  assert.strictEqual(r.ok, true, JSON.stringify(r).slice(0, 200));
  assert.deepStrictEqual(r.lines, FAKE_LINES);
  assert.strictEqual(r.got.maxSide, 993);
  const [a, b] = await Promise.all([d.focus("e1"), d.look({ maxSide: 994 })]);
  assert.strictEqual(a.ok, true);
  assert.strictEqual(b.image.data.length, 5 << 20);
});

test("look's arguments are clamped before they reach the helper", async (t) => {
  const d = fake();
  t.after(() => d.stop());
  const big = await d.look({ budgetMs: 99999, maxSide: 100000, quality: 5 });
  assert.deepStrictEqual([big.got.budgetMs, big.got.maxSide, big.got.quality], [2100, 4096, 0.95]);
  const small = await d.look({ budgetMs: -5, maxSide: 1, quality: "high" });
  assert.deepStrictEqual([small.got.budgetMs, small.got.maxSide, small.got.quality], [50, 64, 0.82]);
  const junk = await d.look("whatever");
  assert.deepStrictEqual([junk.got.budgetMs, junk.got.maxSide, junk.got.quality, junk.got.ocr, junk.got.image], [1500, 1600, 0.82, true, true]);
});

test("the Mac look says where the title bar is: the traffic lights' row, of the window accessibility named", () => {
  const swift = fs.readFileSync(path.join(__dirname, "native", "tzax.swift"), "utf8");
  const band = swift.slice(swift.indexOf("func titleBand("), swift.indexOf("func listedWindows("));
  assert.match(band, /for attr in \["AXCloseButton", "AXMinimizeButton", "AXZoomButton"\]/);
  assert.match(band, /let h = \(2 \* \(f\.midY - frame\.minY\)\)\.rounded\(\.up\)/);
  assert.match(band, /guard h > 0, h <= frame\.height \/ 4 else \{ return nil \}/);
  assert.match(swift, /if focusedOne, let ax = window \{ band = titleBand\(ax, w\.frame\) \}/);
  assert.match(swift, /r\.append\(\("titleFrames", \.arr\(win\.titleBand\.map \{ \[frameJ\(\$0\)\] \} \?\? \[\]\)\)\)/);
});

// ---- caret (peek-spec §A) ------------------------------------------------------
// Where the text cursor and its box are, for Blip to peek over the box while
// the user dictates: asked every few hundred milliseconds, only of a helper
// Ask already has running, and answered with two rectangles and the app.

/** A driver on the fake helper that keeps every line it writes to the helper
 *  and counts its spawns. */
function spied(extra = {}) {
  const lines = [];
  let spawns = 0;
  const d = fake({
    spawn: (bin, args, o) => {
      spawns++;
      const c = require("node:child_process").spawn(bin, args, o);
      const write = c.stdin.write.bind(c.stdin);
      c.stdin.write = (line, ...rest) => { lines.push(JSON.parse(line)); return write(line, ...rest); };
      return c;
    },
    ...extra,
  });
  return { d, lines, spawns: () => spawns };
}

const CARET_KEYS = ["app", "caret", "field", "ok", "scale"];

test("caret is asked only of a helper that is already running, and never starts one", async (t) => {
  const { d, lines, spawns } = spied();
  t.after(() => d.stop());
  assert.deepStrictEqual(await d.caret(), { ok: false, error: "unavailable" });
  assert.deepStrictEqual(await d.caret({ budgetMs: 400 }), { ok: false, error: "unavailable" });
  assert.strictEqual(spawns(), 0, "a dictation never starts the helper");
  assert.strictEqual(lines.length, 0);
  // Ask's helper up (main.js starts it with Ask): now it answers.
  assert.strictEqual(d.start(), true);
  assert.strictEqual((await d.caret()).ok, true);
  assert.strictEqual(spawns(), 1);
  // Off a Mac there is nothing to ask.
  const linux = createAxDriver({ bin: process.execPath, args: [FAKE], platform: "linux" });
  assert.deepStrictEqual(await linux.caret(), { ok: false, error: "unavailable" });
});

test("a caret comes back in the spec's shape and nothing else, asked with its own budget", async (t) => {
  const { d, lines } = spied();
  t.after(() => d.stop());
  d.start();
  const r = await d.caret();
  assert.deepStrictEqual(r, { ok: true, caret: [352, 148, 2, 18], field: [120, 100, 300, 28], app: { name: "Fake", pid: 4242 }, scale: "points" });
  assert.deepStrictEqual(Object.keys(r).sort(), CARET_KEYS, "no how, no ms, no bundleId, no id");
  const sent = lines.filter((l) => l.cmd === "caret");
  assert.deepStrictEqual(sent.map(({ id, ...rest }) => rest), [{ cmd: "caret", timeoutMs: 250 }], "the budget is the helper's time too");
  // The budget can be set (main.js passes desktop.dictation.peekBudgetMs), and is kept sane.
  for (const [o, want] of [[{ budgetMs: 400 }, 400], [{ timeoutMs: 600 }, 600], [{ budgetMs: 5 }, 100], [{ budgetMs: 99999 }, 2000],
    [{ budgetMs: "soon" }, 250], ["whatever", 250], [null, 250]]) {
    lines.length = 0;
    assert.strictEqual((await d.caret(o)).ok, true);
    assert.strictEqual(lines[0].timeoutMs, want, JSON.stringify(o));
  }
});

test("a password field gives no caret and no field; a refusal is its error alone", async (t) => {
  const d = fake();
  t.after(() => d.stop());
  d.start();
  assert.deepStrictEqual(await d.caret({ budgetMs: 999 }), { ok: true, caret: null, field: null, app: { name: "Fake", pid: 4242 }, scale: "points" });
  assert.deepStrictEqual(await d.caret({ budgetMs: 997 }), { ok: false, error: "not_trusted" });
  // An error that is not one of the helper's words is not passed on.
  assert.deepStrictEqual(await d.caret({ budgetMs: 994 }), { ok: false, error: "failed" });
});

test("a caret answer is cleaned, and no text the helper wrote ever gets through", async (t) => {
  const d = fake();
  t.after(() => d.stop());
  d.start();
  const r = await d.caret({ budgetMs: 996 });
  assert.deepStrictEqual(r, { ok: true, caret: null, field: null, app: { name: "", pid: 0 }, scale: "points" });
  const out = JSON.stringify(r);
  for (const word of ["Priya", "hunter2", "offer", "Private", "Bank", "Dear"]) assert.ok(!out.includes(word), word);
});

test("a caret the helper never answers resolves timeout within its budget, and the helper carries on", async (t) => {
  const d = fake();
  t.after(() => d.stop());
  const first = await d.focus("e1");
  const t0 = Date.now();
  assert.deepStrictEqual(await d.caret({ budgetMs: 998 }), { ok: false, error: "timeout" });
  const took = Date.now() - t0;
  assert.ok(took >= 990 && took < 1500, `took ${took} ms`);
  const after = await d.focus("e1");
  assert.strictEqual(after.pid, first.pid, "a slow caret is not a reason to restart the helper");
});

test("a slow caret holds up none of the calls made beside it", async (t) => {
  const d = fake();
  t.after(() => d.stop());
  d.start();
  const order = [];
  const reading = d.caret({ budgetMs: 995 }).then((r) => { order.push("caret"); return r; });
  const pressed = await d.press("e3");
  order.push("press");
  const r = await reading;
  assert.deepStrictEqual(order, ["press", "caret"]);
  assert.strictEqual(pressed.ok, true);
  assert.deepStrictEqual(r.caret, [352, 148, 2, 18]);
});

test("a helper that died is not started again for a caret, only by Ask's next call", async (t) => {
  const { d, spawns } = spied();
  t.after(() => d.stop());
  const before = await d.focus("e1");
  assert.deepStrictEqual(await d.key("die"), { ok: false, error: "helper_exited" });
  assert.deepStrictEqual(await d.caret(), { ok: false, error: "unavailable" });
  assert.strictEqual(spawns(), 1);
  const again = await d.focus("e1");
  assert.notStrictEqual(again.pid, before.pid);
  assert.strictEqual((await d.caret()).ok, true);
  d.stop();
  assert.deepStrictEqual(await d.caret(), { ok: false, error: "unavailable" }, "nor after stop()");
});

test("driver.js: each platform's caret is its driver's, and with no driver it is unavailable at once", async () => {
  const { pick } = require("./driver.js");
  assert.strictEqual(pick("darwin").caret, axDriver.caret);
  assert.strictEqual(pick("win32").caret, require("./uiaDriver.js").caret);
  // What the peek takes for "no helper here": it stops asking for this dictation.
  const stub = pick("linux");
  assert.deepStrictEqual(await stub.caret(), { ok: false, error: "unavailable" });
  assert.deepStrictEqual(await stub.caret({ budgetMs: 250 }), { ok: false, error: "unavailable" });
});

/** tzax.swift's caret section: from its mark to the next. */
function caretSection(swift) {
  const at = swift.indexOf("// MARK: - Where the caret is");
  assert.ok(at > 0, "the caret section");
  return swift.slice(at, swift.indexOf("// MARK: - Commands", at));
}

test("the helper reads the caret on a queue of its own, with Accessibility, in its own small time", () => {
  const swift = fs.readFileSync(path.join(__dirname, "native", "tzax.swift"), "utf8");
  const code = swiftCode(swift);
  const recv = swiftFunc(swift, "func receive(_ line: String) {");
  assert.match(recv, /case "caret":\s*caretQueue\.async \{ performCaret\(key, id, req, deadline\) \}/);
  assert.match(recv, /cmd == "caret" \? 250/);
  const perform = swiftFunc(swift, "func performCaret(");
  assert.match(perform, /if out\.isAnswered\(key\) \|\| DispatchTime\.now\(\) >= deadline - \.milliseconds\(30\) \{ return \}/, "never read late");
  assert.match(perform, /let reply = run\("caret", req, deadline\)/, "through run, behind its Accessibility check");
  const run = swiftFunc(swift, "func run(_ cmd: String, _ req: [String: Any], _ deadline: DispatchTime) -> Reply {");
  const trustAt = run.indexOf('guard AXIsProcessTrusted() else { return fail("not_trusted") }');
  assert.match(run, /case "snapshot", "press", "click", "setValue", "focus", "scroll", "key", "caret":\s*break/);
  assert.ok(trustAt > 0 && run.indexOf("return caret(deadline)") > trustAt);
  // A stuck read is a stuck helper, and one asked as stdin closes is still answered.
  assert.match(code, /busy\.stuck\(\) \|\| lookBusy\.stuck\(\) \|\| caretBusy\.stuck\(\)/);
  assert.match(code, /caretQueue\.sync \{\}\n\s*lookQueue\.sync \{\}/);
});

test("the helper's caret: zero characters as asked, then the character after (left edge), then before (right edge)", () => {
  const swift = fs.readFileSync(path.join(__dirname, "native", "tzax.swift"), "utf8");
  const at = swiftFunc(swift, "func caretAt(");
  const zero = at.indexOf("boundsFor(el, location: location, length: 0,");
  const after = at.indexOf("boundsFor(el, location: location, length: 1,");
  const before = at.indexOf("boundsFor(el, location: location - 1, length: 1,");
  assert.ok(zero > 0 && zero < after && after < before, "in that order");
  assert.match(at, /return \.bar\(CGRect\(x: r\.minX, y: r\.minY, width: 2, height: r\.height\), "after"\)/);
  assert.match(at, /return \.bar\(CGRect\(x: r\.maxX, y: r\.minY, width: 2, height: r\.height\), "before"\)/);
  assert.match(at, /guard location > 0 else \{ return cut \? \.cut : \.nothing \}/);
  // An app that did not answer in time is told apart from one with nothing
  // to say: the time gone, or any ask answered busy, is cut, not nothing.
  assert.equal((at.match(/guard msLeft\(stopAt\) > 0 else \{ return \.cut \}/g) || []).length, 2);
  assert.match(at, /if got\.busy \{ cut = true \}/);
  assert.match(at, /return cut \? \.cut : \.nothing\n\}/);
  // No height, the screen's corner, or nowhere near the element: not the caret.
  assert.match(at, /r\.height > 0/);
  assert.match(at, /!\(r\.minX == 0 && r\.minY == 0\)/);
  assert.match(at, /f\.insetBy\(dx: -40, dy: -40\)\.intersects\(bar\)/);
  const bounds = swiftFunc(swift, "func boundsFor(");
  assert.match(bounds, /AXValueCreate\(\.cfRange, &range\)/);
  assert.match(bounds, /AXUIElementCopyParameterizedAttributeValue\(timed\(el, timeout\), "AXBoundsForRange" as CFString, param, &out\)/);
  assert.match(bounds, /AXValueGetType\(v\) == \.cgRect/);
  assert.match(bounds, /if err == \.cannotComplete \{ return \(nil, true\) \}/);
});

test("the helper's caret: the system-wide focus, a password field gives nulls, the box a scroll view shows", () => {
  const swift = fs.readFileSync(path.join(__dirname, "native", "tzax.swift"), "utf8");
  const fn = swiftFunc(swift, "func caret(_ deadline: DispatchTime) -> Reply {");
  assert.match(fn, /AXUIElementCopyAttributeValue\(AXUIElementCreateSystemWide\(\), "AXFocusedUIElement" as CFString, &ref\)/);
  assert.match(fn, /if err == \.apiDisabled \{ return fail\("not_trusted"\) \}/);
  assert.match(fn, /guard let el = element\(ref\) else \{ return fail\("no_focus"\) \}/);
  const secure = fn.indexOf('if role == "AXSecureTextField" || sub == "AXSecureTextField" { return answer(nil, nil, "secure") }');
  assert.ok(secure > 0, "a secure field, by role or subrole");
  assert.ok(secure < fn.indexOf("caretAt("), "before anything is asked of its text's place");
  assert.match(fn, /\(pv\[0\] as\? String\) == "AXScrollArea"/);
  assert.match(fn, /let seen = f\.intersection\(pf\)/);
  // The caret is where the selection starts.
  assert.match(fn, /switch caretAt\(el, location: range\.location, near: own, until: stopAt\) \{/);
  assert.match(fn, /r\.append\(\("scale", \.str\("points"\)\)\)/);
  assert.match(swift, /let caretAttrNames = \["AXRole", "AXSubrole", "AXPosition", "AXSize", "AXSelectedTextRange", "AXParent"\]/);
});

// "Never shows where it cannot know where the cursor is": a window, a list or
// a button with the keyboard (an Electron app whose tree is not built yet
// answers its window) is no text box, and Blip at its corner would be Blip
// where nobody types. And an app too busy to answer (as one is just after a
// paste lands) is no news, never a field without its caret: that would move
// Blip from the caret to the field's corner and back on the next read.
test("the helper's caret: a box only for a text box, and an app too busy to say is no news", () => {
  const swift = fs.readFileSync(path.join(__dirname, "native", "tzax.swift"), "utf8");
  const fn = swiftFunc(swift, "func caret(_ deadline: DispatchTime) -> Reply {");
  assert.match(swift, /let caretTextRoles: Set<String> = \["AXTextField", "AXTextArea", "AXComboBox"\]/);
  const texty = fn.indexOf('if textRange == nil && !caretTextRoles.contains(role) { return answer(nil, nil, "none") }');
  assert.ok(texty > 0, "no range and no text role: neither rectangle");
  assert.ok(texty > fn.indexOf('return answer(nil, nil, "secure")') && texty < fn.indexOf("fetch(parent,"), "after the password check, before anything more is asked");
  assert.match(fn, /if let rv = axValue\(v\[4\]\), AXValueGetType\(rv\) == \.cfRange \{ textRange = rv \}/);
  // Busy, anywhere: the parent, the bounds, or the time gone before they are asked.
  assert.match(fn, /if got == \.cannotComplete \{ return fail\("app_busy"\) \}/);
  assert.match(fn, /if got == \.invalidUIElement \{ return fail\("no_focus"\) \}/);
  assert.match(fn, /if pe == \.cannotComplete \{ return fail\("app_busy"\) \}/);
  assert.equal((fn.match(/guard msLeft\(stopAt\) > 0 else \{ return fail\("app_busy"\) \}/g) || []).length, 2);
  assert.match(fn, /case \.bar\(let bar, let how\): found = \(bar, how\)\s*case \.cut: return fail\("app_busy"\)\s*case \.nothing: break/);
  // Every failure it answers is one the drivers pass on and nativeCheck knows.
  const errors = [...new Set([...fn.matchAll(/fail\("(\w+)"\)/g)].map((m) => m[1]))].sort();
  assert.deepStrictEqual(errors, ["app_busy", "no_focus", "not_trusted"]);
});

test("the helper's caret reads no text, and every message it sends keeps to the caret's time", () => {
  const swift = fs.readFileSync(path.join(__dirname, "native", "tzax.swift"), "utf8");
  const code = swiftCode(caretSection(swift));
  for (const attr of ["AXValue", "AXSelectedText", "AXStringForRange", "AXAttributedStringForRange", "AXTitle", "AXDescription",
    "AXPlaceholderValue", "AXHelp", "AXNumberOfCharacters", "AXVisibleCharacterRange"]) {
    assert.ok(!code.includes(`"${attr}"`), `the caret asks for ${attr}`);
  }
  assert.ok(!/selectionOf\(|copyAttr\(/.test(code), "nothing read by the snapshot's helpers, which would wait a quarter second each");
  // The system-wide element keeps the default: a timeout set on it is everyone's.
  assert.ok(!/timed\(AXUIElementCreateSystemWide\(\)/.test(code));
  assert.match(code, /return max\(0\.02, min\(messageTimeout, Float\(msLeft\(stopAt\)\) \/ 1000\)\)/);
  assert.equal((code.match(/caretTimeout\(stopAt\)/g) || []).length, 5, "the two reads and the three bounds, each in the time left");
  assert.equal((code.match(/fetch\(/g) || []).length, 2);
  assert.ok(!/usleep|sleep\(/.test(code), "no waiting");
});

test("nativeCheck asks the built Mac helper for the caret and takes only the spec's shape or a known refusal", () => {
  const nc = fs.readFileSync(path.join(__dirname, "nativeCheck.js"), "utf8");
  const mac = nc.slice(nc.indexOf('if (which === "mac")'), nc.indexOf('} else if (which === "win")'));
  assert.match(mac, /\{"id":6,"cmd":"caret","timeoutMs":1000\}/);
  assert.match(mac, /const CARET_REFUSALS = \["not_trusted", "no_focus", "app_busy"\]/);
  assert.match(mac, /caret\.scale !== "points"/);
});

test("look on a machine without the helper resolves, never rejects", async () => {
  const linux = createAxDriver({ bin: process.execPath, platform: "linux" });
  assert.deepStrictEqual(await linux.look(), { ok: false, error: "unavailable" });
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
  for (const cmd of ["ping", "trusted", "snapshot", "press", "click", "setValue", "focus", "scroll", "key", "open", "look", "caret"]) {
    assert.ok(swift.includes(`case "${cmd}"`), `tzax.swift has no case "${cmd}"`);
  }
  for (const field of ['"el"', '"text"', '"dir"', '"lines"', '"chord"', '"app"', '"max"', '"budgetMs"', '"timeoutMs"', '"prompt"',
    '"maxSide"', '"quality"', '"ocr"', '"image"']) {
    assert.ok(swift.includes(field), `tzax.swift never reads ${field}`);
  }
});

/** One Swift function's code, comments left out, from its signature to the
 *  closing brace at the start of a line. */
function swiftFunc(swift, signature) {
  const at = swift.indexOf(signature);
  assert.ok(at >= 0, `tzax.swift has no ${signature}`);
  const end = swift.indexOf("\n}\n", at);
  return swift.slice(at, end + 2).split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
}

test("the helper's press is AXPress, a row's choice, or a failure the agent clicks", () => {
  const swift = fs.readFileSync(path.join(__dirname, "native", "tzax.swift"), "utf8");
  const press = swiftFunc(swift, "func press(_ e: Entry) -> Reply {");
  // AXConfirm is Return in a field (it sends, submits), AXShowMenu a context
  // menu: an ok for either would also stop agent.js's real click.
  for (const not of ["AXConfirm", "AXShowMenu", "AXPick"]) assert.ok(!press.includes(not), `press performs ${not}`);
  assert.match(press, /AXUIElementPerformAction\(timed\(e\.el, actionTimeout\), "AXPress" as CFString\)/);
  assert.equal((press.match(/AXUIElementPerformAction/g) || []).length, 1, "one action, AXPress");
  assert.match(press, /"AXSelected"/);
  assert.match(press, /fail\(/);
  // A press or a choice the app was slow to confirm may have happened: it is
  // an ok with slow set (agent.js never clicks on top of it), never a failure.
  assert.equal((press.match(/case \.cannotComplete:/g) || []).length, 2);
  assert.equal((press.match(/\("slow", \.bool\(true\)\)/g) || []).length, 2);
});

test("the helper sends the window's title beside the elements, never in them", () => {
  const swift = fs.readFileSync(path.join(__dirname, "native", "tzax.swift"), "utf8");
  const snap = swiftFunc(swift, "func snapshot(maxCount: Int, budgetMs: Int, deadline: DispatchTime) -> Reply {");
  assert.match(snap, /copyAttr\(win, "AXTitle"\)/);
  assert.match(snap, /fullTitle = clean\(raw, 200\)/);
  assert.match(snap, /wo\.append\(\("title", \.str\(fullTitle\)\)\)/);
  assert.match(snap, /r\.append\(\("window", windowJ\)\)/);
  // An element's json has no title field, and a window element's label is
  // its description, never its title.
  const json = swiftFunc(swift, "func json(_ id: String) -> J {");
  assert.ok(!/"title"/.test(json));
  assert.match(swift, /case "window":\n\s+label = desc/);
});

test("a just-woken Chromium app is read again by its page, not by its menus", () => {
  const swift = fs.readFileSync(path.join(__dirname, "native", "tzax.swift"), "utf8");
  const snap = swiftFunc(swift, "func snapshot(maxCount: Int, budgetMs: Int, deadline: DispatchTime) -> Reply {");
  assert.match(snap, /let inWindow = w\.found\.filter \{ \$0\.role != "menu" \}\.count/);
  assert.match(snap, /engine != \.other && !w\.busy && \(w\.emptyWeb \|\| inWindow < 15\)/);
  assert.ok(!/w\.found\.count < 15/.test(snap), "the menu bar still counts");
  // The second read never wins by being smaller (cut short by the time left,
  // it may not have reached the page); a page that filled in wins a tie.
  assert.match(snap, /again\.found\.count > w\.found\.count\s*\|\| \(again\.found\.count == w\.found\.count && w\.emptyWeb && !again\.emptyWeb && !again\.busy\)/);
  assert.ok(!/again\.found\.count < w\.found\.count|\|\| \(w\.emptyWeb && !again\.emptyWeb/.test(snap), "a smaller second read can win");
  // Only the page's own area counts, the first one met breadth first: an
  // empty frame inside a page (on most pages) must not double every read.
  const walk = swiftFunc(swift, "func walk(app: AXUIElement,");
  assert.match(walk, /var webSeen = false/);
  assert.match(walk, /if axRole == "AXWebArea" \{\s*if !webSeen && kids\.isEmpty \{ w\.emptyWeb = true \}\s*webSeen = true\s*\}/);
  assert.equal((walk.match(/w\.emptyWeb = true/g) || []).length, 1);
});

/** tzax.swift with its comments taken out. */
function swiftCode(swift) {
  return swift.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
}

test("the helper's look checks Screen Recording first and never asks for it", () => {
  const swift = fs.readFileSync(path.join(__dirname, "native", "tzax.swift"), "utf8");
  const code = swiftCode(swift);
  const look = swiftFunc(swift, "func look(_ req: [String: Any], _ deadline: DispatchTime) -> Reply {");
  // A prompt from a helper nobody sees would land over the user's app.
  assert.ok(!/CGRequestScreenCaptureAccess/.test(code), "the helper asks for Screen Recording");
  const pre = look.indexOf("guard CGPreflightScreenCaptureAccess() else { return fail(\"no_screen_permission\") }");
  assert.ok(pre > 0, "look does not check the permission");
  for (const after of ["lookWindow(", "capture(", "Reading(", "jpeg("]) {
    assert.ok(look.indexOf(after) > pre, `${after} comes before the permission check`);
  }
});

test("the helper captures with public APIs only: ScreenCaptureKit from 14, the window list on 13", () => {
  const swift = fs.readFileSync(path.join(__dirname, "native", "tzax.swift"), "utf8");
  const code = swiftCode(swift);
  // The window's number comes from the public window list, by owner and bounds.
  for (const no of [/_AXUIElementGetWindow/, /\bCGS[A-Z]\w*\s*\(/, /\bSLS[A-Z]\w*\s*\(/, /dlopen/]) {
    assert.ok(!no.test(code), `tzax.swift uses ${no}`);
  }
  // The one symbol found at run time is the public macOS 13 capture call.
  assert.deepStrictEqual(code.match(/dlsym\(.*?"\w*"\)|dlsym\b/g), ['dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGWindowListCreateImage")']);
  assert.match(code, /CGWindowListCopyWindowInfo\(\[\.optionOnScreenOnly, \.excludeDesktopElements\], kCGNullWindowID\)/);
  assert.match(code, /kCGWindowOwnerPID/);
  assert.match(code, /kCGWindowBounds/);
  const sck = swiftFunc(swift, "func captureWithScreenCaptureKit(");
  assert.match(code, /@available\(macOS 14\.0, \*\)\nfunc captureWithScreenCaptureKit\(/);
  assert.match(sck, /SCContentFilter\(desktopIndependentWindow: /);
  assert.match(sck, /SCScreenshotManager\.captureImage\(contentFilter: filter, configuration: config\)/);
  assert.match(sck, /config\.showsCursor = false/);
  assert.match(sck, /config\.ignoreShadowsSingleWindow = true/);
  assert.equal((code.match(/SCScreenshotManager/g) || []).length, 1, "SCScreenshotManager outside the macOS 14 function");
  // The macOS 13 call is reached only when the 14 one is not available, and
  // is never named to the compiler: the macOS 15 SDK obsoletes it, and a
  // newer one may refuse a direct call from Swift outright. Its C signature
  // and fixed option values (bounds without framing, best resolution) are
  // spelled out, and the image it makes is taken over, not leaked.
  const cap = swiftFunc(swift, "func capture(_ win: LookWindow, until: DispatchTime) -> Shot {");
  assert.match(cap, /if #available\(macOS 14\.0, \*\) \{\s*return captureWithScreenCaptureKit\(win, until: until\)\s*\}\s*typealias CreateImage = @convention\(c\) \(CGRect, UInt32, CGWindowID, UInt32\) -> UnsafeMutableRawPointer\?/);
  assert.match(cap, /let options: UInt32 = \(1 << 0\) \| \(1 << 3\)/);
  assert.match(cap, /createImage\(\.null, CGWindowListOption\.optionIncludingWindow\.rawValue, win\.id, options\)/);
  assert.match(cap, /Unmanaged<CGImage>\.fromOpaque\(made\)\.takeRetainedValue\(\)/);
  assert.equal((code.match(/CGWindowListCreateImage/g) || []).length, 1);
  assert.ok(!/CGWindowListCreateImage\s*\(/.test(code), "CGWindowListCreateImage is called by name");
  assert.ok(!/\bCGWindowImageOption\b/.test(code), "the capture's options are taken from the SDK");
  // Every wait on a completion handler gives up at a deadline.
  assert.ok(!/\.wait\(\s*\)/.test(code), "a wait without a timeout");
  assert.match(code, /sem\.wait\(timeout: deadline\)/);
});

test("the helper reads text fast and plain, and encodes the picture as asked", () => {
  const swift = fs.readFileSync(path.join(__dirname, "native", "tzax.swift"), "utf8");
  const code = swiftCode(swift);
  assert.match(code, /request\.recognitionLevel = \.fast/);
  assert.match(code, /request\.usesLanguageCorrection = false/);
  assert.match(code, /if late \{ text\.request\.cancel\(\) \}/);
  // Vision's boxes have their origin at the bottom left; the screen's is the top left.
  assert.match(code, /y: frame\.minY \+ \(1 - y1\) \* frame\.height/);
  assert.match(code, /CGImageDestinationCreateWithData\(data as CFMutableData, "public\.jpeg" as CFString, 1, nil\)/);
  assert.match(code, /kCGImageDestinationLossyCompressionQuality as String: q/);
  assert.match(code, /lookMaxLines = 300/);
  assert.match(code, /clean\(best\.string, 120\)/);
});

// .fast reads Latin scripts only: on a Japanese or Russian window it makes
// Latin junk of every label, which would go out as the window's text.
test("the helper reads text in the user's languages, .accurate only for one .fast cannot read", () => {
  const swift = fs.readFileSync(path.join(__dirname, "native", "tzax.swift"), "utf8");
  const init = swiftFunc(swift, "  init(_ image: CGImage, in frame: CGRect) {");
  assert.match(init, /let preferred = Locale\.preferredLanguages/);
  // Each level's own list, from Vision, never one written out here.
  assert.match(init, /let fast = ocrLanguages\(preferred, \(try\? request\.supportedRecognitionLanguages\(\)\) \?\? \[\]\)\s*request\.recognitionLevel = \.accurate\s*let accurate = ocrLanguages\(preferred, \(try\? request\.supportedRecognitionLanguages\(\)\) \?\? \[\]\)/);
  assert.match(init, /if accurate\.contains\(where: \{ !fast\.contains\(\$0\) \}\) \{\s*request\.recognitionLanguages = accurate\s*\} else \{\s*request\.recognitionLevel = \.fast\s*if !fast\.isEmpty \{ request\.recognitionLanguages = fast \}\s*\}/);
  assert.ok(init.indexOf("request.recognitionLevel = .accurate") < init.indexOf("VNImageRequestHandler"), "chosen before the read starts");
  // Matched on the language, the one the tag names first, in the user's order.
  const langs = swiftFunc(swift, "func ocrLanguages(_ preferred: [String], _ supported: [String]) -> [String] {");
  assert.match(langs, /let same = supported\.filter \{ !lang\(\$0\)\.isEmpty && lang\(\$0\) == lang\(tag\) \}/);
  assert.match(langs, /for s in same\.filter\(\{ tag\.hasPrefix\(\$0\.lowercased\(\)\) \}\) \+ same where !found\.contains\(s\) \{ found\.append\(s\) \}/);
});

// The agent refuses a private window by the look's title, so the title must
// be the pictured window's: a window that only covers the focused one may be
// another one (the browser's private window over its ordinary one).
test("the helper's look is titled by the window in its picture", () => {
  const swift = fs.readFileSync(path.join(__dirname, "native", "tzax.swift"), "utf8");
  const win = swiftFunc(swift, "func lookWindow(_ pid: pid_t) -> LookWindow? {");
  assert.match(win, /if let p = pick, apart\(p\.frame, f\) > 8 \{[\s\S]*?\} else \{\s*focusedOne = pick != nil\s*\}/);
  assert.match(win, /let named = focusedOne \|\| listedName\.isEmpty \? title : listedName/);
  assert.match(win, /return LookWindow\(id: w\.id, frame: w\.frame, title: named\.isEmpty \? listedName : named, titleBand: band\)/);
  assert.equal((win.match(/LookWindow\(/g) || []).length, 1, "one way out with a window");
});

test("the helper takes a look off the main thread, so a snapshot is not kept waiting", () => {
  const swift = fs.readFileSync(path.join(__dirname, "native", "tzax.swift"), "utf8");
  const code = swiftCode(swift);
  const recv = swiftFunc(swift, "func receive(_ line: String) {");
  assert.match(recv, /case "look":\s*lookQueue\.async \{ performLook\(key, id, req, deadline\) \}/);
  assert.match(recv, /cmd == "look" \? 2500/);
  // A stuck look is a stuck helper too, and one asked for just before stdin
  // closes is still answered.
  assert.match(code, /busy\.stuck\(\) \|\| lookBusy\.stuck\(\)/);
  assert.match(code, /lookQueue\.sync \{\}\n\s*DispatchQueue\.main\.async \{ exit\(0\) \}/);
});

// UniCharCount is not imported into Swift; using it broke the CI build once.
test("the helper names no type the SDK does not import into Swift", () => {
  const code = swiftCode(fs.readFileSync(path.join(__dirname, "native", "tzax.swift"), "utf8"));
  assert.ok(!/\bUniCharCount\b/.test(code));
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
