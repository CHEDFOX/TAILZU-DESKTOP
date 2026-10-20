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
const API = ["available", "start", "stop", "trusted", "snapshot", "press", "click", "setValue", "focus", "scroll", "key", "open", "look"];

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
  for (const cmd of ["ping", "trusted", "snapshot", "press", "click", "setValue", "focus", "scroll", "key", "open", "look"]) {
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

// The agent refuses a private window by the look's title, so the title must
// be the pictured window's: a window that only covers the focused one may be
// another one (the browser's private window over its ordinary one).
test("the helper's look is titled by the window in its picture", () => {
  const swift = fs.readFileSync(path.join(__dirname, "native", "tzax.swift"), "utf8");
  const win = swiftFunc(swift, "func lookWindow(_ pid: pid_t) -> LookWindow? {");
  assert.match(win, /if let p = pick, apart\(p\.frame, f\) > 8 \{[\s\S]*?\} else \{\s*focusedOne = pick != nil\s*\}/);
  assert.match(win, /let named = focusedOne \|\| listedName\.isEmpty \? title : listedName/);
  assert.match(win, /return LookWindow\(id: w\.id, frame: w\.frame, title: named\.isEmpty \? listedName : named\)/);
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
