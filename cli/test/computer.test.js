"use strict";

// This computer, offered to Xode while xode is open: the desktop app's runner run headless, for this folder's project only, and
// shut down when xode ends. Also the runner packed into the package (scripts/bundle-runner.js).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Writable } = require("stream");
const { createFakeServer, defaultScript, PROJECT_ID } = require("./fakeServer");
const { runCli, tempHome } = require("./runCli");
const { createFileStore } = require("../src/auth/fileStore");
const { createOut } = require("../src/ui/out");
const { chat } = require("../src/commands/chat");
const { startComputer, terminalName } = require("../src/computer/host");
const { runnerDir, loadCreateRunner } = require("../src/computer/load");
const { wordsOf } = require("../src/computer/statusLine");
const { bundle } = require("../scripts/bundle-runner");

const FAKE = "xdt_fake_computer_test_token_abcdefg";
const SHORT = defaultScript().filter((s) => !s.question);
const until = async (fn, ms = 8000, what = "it") => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error(`Timed out waiting for ${what}`);
};

async function setup(opts = {}) {
  const server = await createFakeServer({ script: SHORT, stepMs: 20, ...opts });
  const home = tempHome();
  server.addToken(FAKE);
  const env = { XDG_CONFIG_HOME: home.config, XDG_CACHE_HOME: path.join(home.root, "cache"), XODE_CRED_STORE: "file" };
  await createFileStore(env).set(new URL(server.url).host, FAKE);
  return { server, home, env, close: async () => { await server.close(); home.cleanup(); } };
}

/** Printing into a string, as a pipe would get it. */
function captureOut() {
  let text = "";
  const sink = new Writable({ write(chunk, enc, cb) { text += chunk; cb(); } });
  const out = createOut({ stdout: sink, stderr: sink, env: { XODE_TTY: "0" } });
  return { out, get text() { return text; } };
}

/** Typed answers, one per question; null once they run out. */
function fakeInput(answers) {
  let interrupt = null;
  return {
    interactive: false,
    closed: false,
    ask() { const p = Promise.resolve(answers.length ? answers.shift() : null); p.cancel = () => {}; return p; },
    onInterrupt(fn) { const was = interrupt; interrupt = fn; return was; },
    setIdle() {},
    asking: () => false,
    close() { this.closed = true; },
  };
}

/** A createRunner that only notes what it is asked. */
function fakeRunnerMaker() {
  const calls = [];
  let opts = null;
  const make = (o) => {
    opts = o;
    calls.push("create");
    return {
      installProcessHooks: () => calls.push("hooks"),
      start: () => { calls.push("start"); o.onChange(); },
      status: () => ({ state: "online", project: "" }),
      shutdown: () => calls.push("shutdown"),
    };
  };
  return { make, calls, get opts() { return opts; } };
}

test("xode offers this computer for this folder's project only, named for the terminal, and shuts it down when it ends", async () => {
  const t = await setup({ projects: [{ id: "11111111-1111-4111-8111-111111111111", fullName: "ana/blog", defaultBranch: "main" }, { id: PROJECT_ID, fullName: "ana/storefront", defaultBranch: "main" }] });
  const sigterm = process.listenerCount("SIGTERM");
  try {
    const fake = fakeRunnerMaker();
    const cap = captureOut();
    const store = { get: async () => FAKE };
    const code = await chat({
      server: t.server.url, store, out: cap.out, input: fakeInput(["y"]), cwd: t.home.work, env: t.env, pollMs: 30,
      args: { message: "fix the cart rounding", project: "", fresh: false, noRunner: false },
      deps: { createRunner: fake.make, hostname: "studio.local", holdMs: 10 },
    });
    assert.strictEqual(code, 0, cap.text);
    assert.deepStrictEqual(fake.calls, ["create", "hooks", "start", "shutdown"]);
    const o = fake.opts;
    assert.strictEqual(o.onlyProject, PROJECT_ID);
    assert.strictEqual(o.hostname, "studio (terminal)");
    assert.strictEqual(o.userData, path.join(t.env.XDG_CACHE_HOME, "xode", "runner"));
    assert.strictEqual(o.state.enabled, true);
    assert.deepStrictEqual(o.secrets(), [FAKE]);
    assert.strictEqual(o.api.signedIn(), true);
    assert.strictEqual(typeof o.powerMonitor.on, "function");
    assert.strictEqual(o.powerMonitor.isOnBatteryPower(), false);
    // The runner's api.fetch is the server, as this terminal's sign-in.
    const res = await o.api.fetch("/v1/code/projects", { method: "GET" });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).projects.length, 2);
    // Its state is kept, 600.
    const file = path.join(t.home.config, "xode", "runner", "state.json");
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(JSON.parse(fs.readFileSync(file, "utf8")).runners[`${t.server.url} ${PROJECT_ID}`]);
    assert.match(cap.text, /This computer: online for Xode, for ana\/storefront only\./);
    assert.ok(!cap.text.includes(FAKE));
    assert.strictEqual(process.listenerCount("SIGTERM"), sigterm, "its SIGTERM handler is gone");
  } finally {
    await t.close();
  }
});

test("--no-runner and XODE_RUNNER=0: this computer isn't offered", async () => {
  const t = await setup();
  try {
    for (const [args, env] of [[{ noRunner: true }, {}], [{}, { XODE_RUNNER: "0" }]]) {
      const fake = fakeRunnerMaker();
      const cap = captureOut();
      const code = await chat({
        server: t.server.url, store: { get: async () => FAKE }, out: cap.out, input: fakeInput(["y"]), cwd: t.home.work, env: { ...t.env, ...env }, pollMs: 30,
        args: { message: "fix the cart rounding", project: "", fresh: false, ...args }, deps: { createRunner: fake.make },
      });
      assert.strictEqual(code, 0, cap.text);
      assert.deepStrictEqual(fake.calls, []);
      assert.ok(!/This computer/.test(cap.text));
    }
  } finally {
    await t.close();
  }
});

test("the desktop's own runner, headless: online for one project, then a clean goodbye", async () => {
  const t = await setup();
  try {
    const cap = captureOut();
    const createRunner = loadCreateRunner();
    assert.strictEqual(typeof createRunner, "function");
    const c = startComputer({
      server: t.server.url, token: FAKE, project: { id: PROJECT_ID, name: "ana/storefront" }, out: cap.out, env: t.env, version: "9.9.9",
      createRunner, hostname: "box", holdMs: 10,
    });
    await until(() => c.runner.status().state === "online", 8000, "online");
    const dev = t.server.devices[0];
    assert.deepStrictEqual(dev.hello.projects, [PROJECT_ID]);
    assert.strictEqual(dev.hello.name, "box (terminal)");
    assert.strictEqual(dev.hello.allowRun, true);
    assert.strictEqual(c.runner.status().deviceName, "box (terminal)");
    assert.ok(t.server.calls.some((x) => x.path === "/v1/code/runner/ticket" && x.auth));
    // The older heartbeat route answers the runner's api.fetch too (the same sign-in).
    const api = require("../src/computer/host").authorizedFetch(t.server.url, FAKE);
    assert.strictEqual((await api("/v1/code/runner/heartbeat", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 200);
    await until(() => /This computer: online/.test(cap.text), 3000, "the status line");
    c.stop();
    c.stop();
    await until(() => dev.closed, 3000, "the socket closed");
    assert.ok(dev.frames.some((f) => f.t === "bye"));
    assert.strictEqual(c.runner.status().state === "online", false);
    assert.ok(fs.existsSync(path.join(t.env.XDG_CACHE_HOME, "xode", "runner", "workspaces")), "its workspaces live under the cache folder");
  } finally {
    await t.close();
  }
});

test("SIGTERM: xode shuts this computer down and leaves", async () => {
  const t = await setup();
  try {
    const run = runCli([], { server: t.server, home: t.home });
    await run.waitFor("Approve? (y/n)");
    await until(() => t.server.devices.length && t.server.devices[0].hello, 8000, "the hello");
    run.child.kill("SIGTERM");
    const r = await run.done;
    assert.strictEqual(r.code, 143, r.all);
    await until(() => t.server.devices[0].closed, 3000, "the socket closed");
    assert.ok(t.server.devices[0].frames.some((f) => f.t === "bye"));
  } finally {
    await t.close();
  }
});

test("the status line's words", () => {
  assert.strictEqual(wordsOf({ state: "working", project: "ana/storefront" }, "x"), "This computer: working on ana/storefront.");
  assert.strictEqual(wordsOf({ state: "paused", pausedReason: "battery_low" }, "x"), "This computer: paused (the battery is low).");
  assert.strictEqual(wordsOf({ state: "backoff" }, "x"), "This computer: connecting…");
  assert.strictEqual(terminalName("mac.local"), "mac (terminal)");
});

test("packing: the runner's runtime files are copied, its tests and window are not, and the copy loads", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xode-pack-"));
  try {
    const into = path.join(root, "runner");
    const files = bundle({ into });
    assert.ok(files.includes("index.js") && files.includes("guard.js") && files.includes("ws.js"), files.join(" "));
    const there = fs.readdirSync(into);
    assert.ok(!there.some((f) => /\.test\.js$|^testkit\.js$|^ui\.js$|\.html$/.test(f)), there.join(" "));
    // Every file the copy requires is in it.
    for (const f of there.filter((x) => x.endsWith(".js"))) {
      for (const m of fs.readFileSync(path.join(into, f), "utf8").matchAll(/require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) {
        assert.ok(fs.existsSync(path.resolve(into, m[1])), `${f} requires ${m[1]}`);
      }
    }
    const { createRunner } = require(path.join(into, "index.js"));
    assert.strictEqual(typeof createRunner, "function");
    // xode prefers the packed copy.
    assert.strictEqual(runnerDir(root), into);
    // Packing again replaces it; a folder that isn't an earlier bundle is left alone.
    assert.deepStrictEqual(bundle({ into }), files);
    const other = path.join(root, "other");
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, "keep.txt"), "x");
    assert.throws(() => bundle({ into: other }), /has other files in it/);
    assert.ok(fs.existsSync(path.join(other, "keep.txt")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
