// node --test — the silent updater played without Electron: fake GET, fake clock, fake idle and busy, fake install.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createSilentUpdate } = require("./silentUpdate.js");

const BUILD = crypto.randomBytes(4096);
const SHA = crypto.createHash("sha512").update(BUILD).digest("hex");
const URL_ = "https://x0bot.com/downloads/Tailzu-Setup.exe";
const REL = { latest: "0.5.0", min: "", url: URL_, sha512: SHA };
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 4)); };

function rig(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tz-silent-"));
  const timers = [];
  let t = 1_000_000;
  const r = {
    dir, gets: [], installs: [], quits: 0, fallbacks: [], nags: [], idle: 0, busy: "", constrained: "", shown: false,
    knobs: Object.assign({}, o.knobs), body: o.body || BUILD, version: o.version || "0.4.7",
    advance(ms) { t += ms; for (const x of timers.splice(0)) { if (x.at <= t) x.f(); else timers.push(x); } },
  };
  const opts = {
    dir, platform: "win32", version: () => r.version, minBytes: 1024,
    canSelfUpdate: () => o.canSelfUpdate !== false, isStore: () => !!o.store,
    get: async (url, { headers }) => {
      r.gets.push([url, headers]);
      if (o.get) return o.get(url, headers);
      const b = r.body;
      return { status: 200, header: (n) => (n === "content-length" ? String(b.length) : ""), body: (async function* () { yield b.subarray(0, 1000); yield b.subarray(1000); })(), abort() {} };
    },
    prepare: async (file) => ({ file }),
    commit: async (h, how) => { if (o.commitFails) throw new Error("spawn failed"); r.installs.push([fs.readFileSync(h.file), how]); },
    discard: () => {},
    idleSeconds: () => r.idle, busy: async () => r.busy, constrained: () => r.constrained, windowShown: () => r.shown,
    settings: () => r.knobs, quit: () => { r.quits++; }, fallback: (why) => r.fallbacks.push(why), nag: (v) => r.nags.push(v),
    now: () => t, setTimeout: (f, ms) => { const x = { f, at: t + ms }; timers.push(x); return x; },
    clearTimeout: (x) => { const i = timers.indexOf(x); if (i >= 0) timers.splice(i, 1); },
  };
  r.make = () => (r.s = createSilentUpdate(opts));
  r.make();
  return r;
}

test("a newer build comes down in the background, is checked and staged; nothing is said", async () => {
  const r = rig();
  assert.strictEqual(r.s.offer(REL), true);
  await flush();
  assert.strictEqual(r.gets[0][0], URL_);
  assert.strictEqual(r.s.staged(), "0.5.0");
  assert.ok(fs.existsSync(path.join(r.dir, SHA.slice(0, 32), "Tailzu-Setup.exe")));
  assert.deepStrictEqual(r.installs, []);
  assert.deepStrictEqual(r.fallbacks, []);
});

test("a build whose checksum does not match is deleted, never staged or run, and retried with backoff", async () => {
  const r = rig({ body: crypto.randomBytes(4096), knobs: { maxRetries: 1 } });
  r.s.offer(REL);
  await flush();
  assert.strictEqual(r.s.staged(), "");
  assert.deepStrictEqual(fs.readdirSync(path.join(r.dir, SHA.slice(0, 32))), []);
  r.advance(60_000); await flush();
  assert.strictEqual(r.gets.length, 2);
  assert.deepStrictEqual(r.fallbacks, ["download"]);   // out of retries: today's notification
  assert.strictEqual(r.s.offer(REL), false);
  assert.deepStrictEqual(r.installs, []);
});

test("only our own https address is taken, and a redirect elsewhere is refused", async () => {
  const r = rig({ get: async () => ({ status: 302, location: "https://evil.example/Tailzu-Setup.exe" }), knobs: { maxRetries: 0 } });
  assert.strictEqual(r.s.offer(Object.assign({}, REL, { url: "http://x0bot.com/downloads/Tailzu-Setup.exe" })), false);
  assert.strictEqual(r.s.offer(Object.assign({}, REL, { sha512: "abc" })), false);
  assert.strictEqual(r.s.offer(REL), true);
  await flush();
  assert.strictEqual(r.gets.length, 1);
  assert.strictEqual(r.s.staged(), "");
});

test("a cut download resumes from the part on disk", async () => {
  let n = 0;
  const r = rig({
    get: async (_u, h) => {
      n++;
      if (n === 1) return { status: 200, header: (k) => (k === "content-length" ? "4096" : ""), body: (async function* () { yield BUILD.subarray(0, 1500); })(), abort() {} };
      assert.strictEqual(h.Range, "bytes=1500-");
      return { status: 206, header: (k) => (k === "content-range" ? "bytes 1500-4095/4096" : k === "content-length" ? "2596" : ""), body: (async function* () { yield BUILD.subarray(1500); })(), abort() {} };
    },
  });
  r.s.offer(REL);
  await flush();
  assert.strictEqual(r.s.staged(), "");
  r.advance(60_000); await flush();
  assert.strictEqual(r.s.staged(), "0.5.0");
});

test("installs only when idle long enough and nothing is running, then comes back up", async () => {
  const r = rig();
  r.s.offer(REL); await flush();
  r.idle = 60; r.advance(60_000); await flush();
  assert.strictEqual(r.installs.length, 0, "not idle 15 minutes");
  r.idle = 20 * 60; r.busy = "dictation"; r.advance(60_000); await flush();
  assert.strictEqual(r.installs.length, 0, "dictation running");
  r.busy = ""; r.shown = true; r.advance(60_000); await flush();
  assert.strictEqual(r.installs.length, 1);
  assert.ok(r.installs[0][0].equals(BUILD));
  assert.deepStrictEqual(r.installs[0][1], { relaunch: true });
  assert.strictEqual(r.quits, 1);
  // The new build's first launch: one quiet notice, the window back as it was, the files gone.
  r.version = "0.5.0"; r.make();
  const after = r.s.afterLaunch();
  assert.deepStrictEqual(after, { updated: "0.5.0", from: "0.4.7", reopenWindow: true, relaunched: true });
  assert.deepStrictEqual(fs.readdirSync(r.dir), ["state.json"]);
});

test("a staged build that changed on disk is refused at install time", async () => {
  const r = rig();
  r.s.offer(REL); await flush();
  fs.writeFileSync(path.join(r.dir, SHA.slice(0, 32), "Tailzu-Setup.exe"), crypto.randomBytes(4096));
  r.idle = 3600; r.advance(60_000); await flush();
  assert.strictEqual(r.installs.length, 0);
  assert.strictEqual(r.quits, 0);
});

test("on quit the staged build goes in and the app stays closed", async () => {
  const r = rig();
  assert.strictEqual(r.s.atQuit(), null);
  r.s.offer(REL); await flush();
  const res = await r.s.atQuit();
  assert.deepStrictEqual(res, { ok: true });
  assert.deepStrictEqual(r.installs[0][1], { relaunch: false });
  r.version = "0.5.0"; r.make();
  assert.strictEqual(r.s.afterLaunch().relaunched, false);
});

test("a required build goes in after a minute's quiet, on battery too, and the person is told if it cannot", async () => {
  const r = rig();
  r.constrained = "battery";
  r.s.offer(Object.assign({}, REL, { min: "0.5.0" })); await flush();
  assert.strictEqual(r.s.staged(), "0.5.0");
  r.idle = 90; r.busy = "notes"; r.advance(61 * 60_000); await flush();
  assert.deepStrictEqual(r.nags, ["0.5.0"]);
  r.busy = ""; r.advance(60_000); await flush();
  assert.strictEqual(r.installs.length, 1);
});

test("an optional build waits for power", async () => {
  const r = rig();
  r.constrained = "battery";
  r.s.offer(REL); await flush();
  assert.strictEqual(r.gets.length, 0);
  r.constrained = ""; r.advance(60_000); await flush();
  assert.strictEqual(r.s.staged(), "0.5.0");
});

test("a failed install leaves the app running and hands back to the notice; a build that did not come up is not retried", async () => {
  const r = rig({ commitFails: true });
  r.s.offer(REL); await flush();
  r.idle = 3600; r.advance(60_000); await flush();
  assert.strictEqual(r.quits, 0);
  assert.deepStrictEqual(r.fallbacks, ["install"]);
  assert.strictEqual(r.s.offer(REL), false);

  const q = rig();
  q.s.offer(REL); await flush();
  await q.s.atQuit();
  q.make();   // relaunched, still 0.4.7
  assert.deepStrictEqual(q.s.afterLaunch(), { failed: "0.5.0" });
  assert.strictEqual(q.s.offer(REL), false);
});

test("never for a Store install, a copy that cannot replace itself, or with the knob off", async () => {
  for (const r of [rig({ store: true }), rig({ canSelfUpdate: false }), rig({ knobs: { silent: false } })]) {
    assert.strictEqual(r.s.offer(REL), false);
    await flush();
    assert.strictEqual(r.gets.length, 0);
    assert.strictEqual(r.s.atQuit(), null);
  }
});
