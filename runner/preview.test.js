// node --test
//
// The preview (preview.js): the project's dev server, started for real (a tiny Node HTTP server as the project's), its port found from what it
// prints, and the room's requests proxied to it on the loopback: the head and the body in pieces, headers cleaned, the 10 MB and 32-at-once
// limits, a timeout, a cancel, never anything but 127.0.0.1 / ::1, and the dev server killed with everything it started.

const nodeTest = require("node:test");
const { afterEach } = nodeTest;
// A test that waits for ever fails after a minute and a half instead of hanging the run.
const SKIP = process.platform === "win32" ? "needs bash, git and process groups: not run on Windows" : false;
const test = (name, fn) => nodeTest(name, { timeout: 90000, skip: SKIP }, fn);
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { createPreview, detectPorts } = require("./preview.js");
const { createSpawner } = require("./exec.js");
const { commandEnv, runnerPaths, ensurePaths } = require("./env.js");
const { createProcs } = require("./procs.js");
const { tempDir, alive, until } = require("./testkit.js");

const NODE = JSON.stringify(process.execPath);

/** The project's dev server: a script that listens on $PORT (or on what the test says) and prints a Vite-style line. */
const DEV = `
const http = require("http");
const mode = process.env.DEV_MODE || "normal";
const want = Number(process.env.PORT);
const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/") { res.writeHead(200, { "content-type": "text/html", "set-cookie": ["a=1", "b=2"] }); return res.end("<h1>hello preview</h1>"); }
  if (url === "/missing") { res.writeHead(404, { "content-type": "text/plain" }); return res.end("nope"); }
  if (url === "/headers") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ headers: req.headers, method: req.method, url: req.url })); }
  if (url === "/echo") { const chunks = []; req.on("data", (c) => chunks.push(c)); return req.on("end", () => { res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(Buffer.concat(chunks)); }); }
  if (url === "/big") { res.writeHead(200); return res.end(Buffer.alloc(2500, 97)); }
  if (url === "/huge") { res.writeHead(200); const t = setInterval(() => res.write(Buffer.alloc(1000, 98)), 1); return res.on("close", () => clearInterval(t)); }
  if (url === "/slow") { return setTimeout(() => { res.writeHead(200); res.end("late"); }, 1500); }
  if (url === "/broken") { res.writeHead(200, { "content-length": "100" }); res.write("part"); return setTimeout(() => req.socket.destroy(), 30); }
  res.writeHead(200); res.end("ok " + req.url);
});
const listen = mode === "ignores-port" ? 0 : want;
server.listen(listen, process.env.HOST || "127.0.0.1", () => {
  const port = server.address().port;
  if (mode === "busy-first") console.log("Port 5173 is in use, trying another one...");
  if (mode === "silent") return;
  console.log("\\x1b[32m  Local:   http://localhost:" + port + "/\\x1b[0m");
});
if (mode === "exits-later") setTimeout(() => process.exit(3), 600);
`;

function rig(o = {}) {
  const t = tempDir("tzprev-");
  const paths = runnerPaths(path.join(t.dir, "ud"));
  ensurePaths(paths);
  const ws = path.join(paths.workspaces, "p1");
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "dev.js"), DEV);
  const real = { PATH: process.env.PATH, HOME: "/home/x", LANG: "C.UTF-8" };
  const env = commandEnv({ real, paths, platform: process.platform });
  const procs = createProcs({});
  const frames = [];
  const hooks = { starts: [], ends: [] };
  const preview = createPreview({
    cwd: ws, env, send: (f) => frames.push(f), known: [], procs, spawnCommand: o.spawnCommand || createSpawner({}), container: !!o.container,
    hooks: { onStart: (e) => hooks.starts.push(e.command), onEnd: (e) => hooks.ends.push([e.command, e.exitCode]) },
    limits: { probeEveryMs: 50, probeMs: 500, readyMinSec: 1, ...(o.limits || {}) },
  });
  const request = async (m) => {
    const id = "h-" + Math.random().toString(36).slice(2, 8);
    preview.request({ id, method: "GET", path: "/", headers: [], ...m });
    await until(() => frames.some((f) => f.id === id && (f.t === "res-error" || (f.t === "res-data" && f.last))), 8000, "the answer to " + m.path);
    const mine = frames.filter((f) => f.id === id);
    return { frames: mine, head: mine.find((f) => f.t === "res"), error: mine.find((f) => f.t === "res-error"), body: Buffer.concat(mine.filter((f) => f.t === "res-data").map((f) => Buffer.from(f.data, "base64"))), pieces: mine.filter((f) => f.t === "res-data") };
  };
  const rigged = { t, ws, procs, frames, preview, hooks, request, env, remove: () => { preview.stop(); procs.killAll(); t.remove(); } };
  rigs.push(rigged);
  return rigged;
}
// A test that fails halfway must not leave a dev server running, or the run never ends.
const rigs = [];
afterEach(() => { for (const r of rigs.splice(0)) r.remove(); });
const dev = (extra = "") => ({ id: "p-1", cmd: extra + NODE + " dev.js", readySec: 8, idleSec: 300, overlay: [] });

test("the port is found in what a dev server prints: its own lines, the newest, never one it was refused", () => {
  assert.deepStrictEqual(detectPorts("  \u001b[32mLocal:\u001b[0m   http://localhost:5173/\n  Network: use --host to expose\n"), [5173]);
  assert.deepStrictEqual(detectPorts("ready - started server on 0.0.0.0:3000, url: http://localhost:3000\n"), [3000]);
  assert.deepStrictEqual(detectPorts("listening on port 8080\n"), [8080]);
  assert.deepStrictEqual(detectPorts("Server running at http://127.0.0.1:4321/\n"), [4321]);
  assert.deepStrictEqual(detectPorts("Port 5173 is in use, trying another one...\n  Local: http://localhost:5174/\n"), [5174]);
  assert.deepStrictEqual(detectPorts("error: EADDRINUSE :::3000\nlistening on port 3001\n"), [3001]);
  assert.deepStrictEqual(detectPorts("http://localhost:3000/ then http://localhost:3001/\n"), [3000, 3001], "the newest last");
  assert.deepStrictEqual(detectPorts("http://localhost:3000/ and again http://localhost:3000/\n"), [3000]);
  assert.deepStrictEqual(detectPorts("nothing here, 12 files in 3 ms\n"), []);
  assert.deepStrictEqual(detectPorts("built in port 2\n"), [], "under 80 is not a dev server");
});

test("it starts the dev server with PORT, HOST=127.0.0.1 and BROWSER=none, and answers when it does", async () => {
  const r = rig();
  const res = await r.preview.start({ ...dev(), cmd: "echo \"PORT=$PORT HOST=$HOST BROWSER=$BROWSER NO_COLOR=$NO_COLOR\"; exec " + NODE + " dev.js" });
  assert.strictEqual(res.ok, true, res.error);
  assert.ok(res.port > 1023 && res.ms >= 0);
  const out = r.frames.filter((f) => f.t === "out" && f.id === "p-1").map((f) => f.data).join("");
  assert.match(out, /\$ echo .*PORT=/);
  assert.match(out, new RegExp("PORT=" + res.port + " HOST=127\\.0\\.0\\.1 BROWSER=none NO_COLOR=1"));
  assert.match(out, /Local:\s+http:\/\/localhost:\d+/);
  assert.deepStrictEqual(r.hooks.starts.length, 1, "the audit hears of the dev server like any command");
  assert.ok(r.preview.alive());
  r.remove();
});

test("the named port wins over a guess, and a server that picks its own port is found from its output", async () => {
  const r = rig();
  process.env.DEV_MODE = "ignores-port";
  try {
    const res = await r.preview.start(dev("DEV_MODE=ignores-port "));
    assert.strictEqual(res.ok, true, res.error);
    const got = await r.request({ path: "/x" });
    assert.strictEqual(got.body.toString(), "ok /x", "requests go to the port it really listens on");
  } finally { delete process.env.DEV_MODE; }
  r.remove();
});

test("a port the server said it could not have is not mistaken for its own", async () => {
  const r = rig();
  const res = await r.preview.start(dev("DEV_MODE=busy-first "));
  assert.strictEqual(res.ok, true, res.error);
  const out = r.frames.filter((f) => f.t === "out").map((f) => f.data).join("");
  assert.match(out, /Port 5173 is in use/);
  assert.notStrictEqual(res.port, 5173);
  r.remove();
});

test("a request is proxied: the head, then the body in pieces, with the status and the headers (set-cookie twice)", async () => {
  const r = rig({ limits: { chunk: 1000 } });
  await r.preview.start(dev());
  const home = await r.request({ path: "/" });
  assert.strictEqual(home.head.status, 200);
  assert.strictEqual(home.body.toString(), "<h1>hello preview</h1>");
  assert.ok(home.head.headers.some(([k, v]) => k.toLowerCase() === "content-type" && v === "text/html"));
  assert.strictEqual(home.head.headers.filter(([k]) => k.toLowerCase() === "set-cookie").length, 2);
  assert.strictEqual(home.pieces.length, 1);
  assert.strictEqual(home.pieces[0].last, true);
  const nope = await r.request({ path: "/missing" });
  assert.strictEqual(nope.head.status, 404, "any status is passed on");
  const big = await r.request({ path: "/big" });
  assert.strictEqual(big.body.length, 2500);
  assert.deepStrictEqual(big.pieces.map((p) => [Buffer.from(p.data, "base64").length, p.last]), [[1000, false], [1000, false], [500, true]], "pieces of at most the chunk, the last marked");
  const echoed = await r.request({ method: "POST", path: "/echo", headers: [["content-type", "application/octet-stream"]], body: Buffer.from("posted body").toString("base64") });
  assert.strictEqual(echoed.body.toString(), "posted body");
  r.remove();
});

test("what is sent to the dev server: Host is localhost:port, no compression asked for, the hop-by-hop and upgrade headers dropped, cookies joined", async () => {
  const r = rig();
  const started = await r.preview.start(dev());
  const got = await r.request({ path: "/headers?a=1", headers: [["Host", "evil.example"], ["Accept-Encoding", "gzip, br"], ["Connection", "Upgrade"], ["Upgrade", "websocket"], ["Keep-Alive", "5"], ["Transfer-Encoding", "chunked"], ["Cookie", "a=1"], ["Cookie", "b=2"], ["X-Custom", "yes"], ["Accept", "text/html"]] });
  const seen = JSON.parse(got.body.toString());
  assert.strictEqual(seen.headers.host, "localhost:" + started.port);
  assert.strictEqual(seen.headers["accept-encoding"], "identity");
  assert.strictEqual(seen.headers.upgrade, undefined);
  assert.notStrictEqual(String(seen.headers.connection || "").toLowerCase(), "upgrade");
  assert.strictEqual(seen.headers["keep-alive"], undefined);
  assert.strictEqual(seen.headers["transfer-encoding"], undefined);
  assert.strictEqual(seen.headers.cookie, "a=1; b=2");
  assert.strictEqual(seen.headers["x-custom"], "yes");
  assert.strictEqual(seen.url, "/headers?a=1");
  r.remove();
});

test("only a path on the dev server is ever asked for: nothing absolute, nothing scheme-relative, no spaces", async () => {
  const r = rig();
  await r.preview.start(dev());
  for (const path of ["//evil.example/x", "http://evil.example/", "/a b", "/a\\b", "evil", ""]) {
    const got = await r.request({ path });
    assert.strictEqual(got.error.code, "bad_request", JSON.stringify(path));
  }
  r.remove();
});

test("a response over the limit is stopped with too_large; one that breaks off is failed; a slow one times out", async () => {
  const r = rig({ limits: { resMax: 20000, requestMs: 400, chunk: 5000 } });
  await r.preview.start(dev());
  const huge = await r.request({ path: "/huge" });
  assert.strictEqual(huge.error.code, "too_large");
  assert.ok(huge.head, "the head had been sent: a res-error may follow a res");
  const slow = await r.request({ path: "/slow" });
  assert.strictEqual(slow.error.code, "timeout");
  const broken = await r.request({ path: "/broken" });
  assert.strictEqual(broken.error.code, "failed");
  // Each request is settled once.
  await new Promise((res) => setTimeout(res, 300));
  for (const id of new Set(r.frames.filter((f) => f.id && f.id.startsWith("h-")).map((f) => f.id))) {
    assert.ok(r.frames.filter((f) => f.id === id && (f.t === "res-error" || (f.t === "res-data" && f.last))).length <= 1, id + " was settled twice");
  }
  r.remove();
});

test("at most 32 requests at once (here 2): the next is busy; a cancel lets go of one", async () => {
  const r = rig({ limits: { pending: 2, requestMs: 5000 } });
  await r.preview.start(dev());
  r.preview.request({ id: "s-1", method: "GET", path: "/slow", headers: [] });
  r.preview.request({ id: "s-2", method: "GET", path: "/slow", headers: [] });
  assert.strictEqual(r.preview.inflight(), 2);
  const third = await r.request({ path: "/" });
  assert.strictEqual(third.error.code, "busy");
  r.preview.cancel("s-1");
  assert.strictEqual(r.preview.inflight(), 1);
  const fourth = await r.request({ path: "/" });
  assert.strictEqual(fourth.head.status, 200);
  await until(() => r.frames.some((f) => f.id === "s-2" && f.t === "res-data" && f.last), 4000, "the other to finish");
  assert.ok(!r.frames.some((f) => f.id === "s-1" && (f.t === "res-data" || f.t === "res-error")), "a cancelled request says nothing more");
  r.remove();
});

test("with no dev server running a request is unreachable", async () => {
  const r = rig();
  const none = await r.request({ path: "/" });
  assert.strictEqual(none.error.code, "unreachable");
  r.remove();
});

test("stop kills the dev server and everything it started, and requests are unreachable after", async () => {
  const r = rig();
  const res = await r.preview.start({ ...dev(), cmd: "sleep 300 & echo $! > kid.pid; echo $$ > shell.pid; exec " + NODE + " dev.js" });
  assert.strictEqual(res.ok, true, res.error);
  const kid = Number(fs.readFileSync(path.join(r.ws, "kid.pid"), "utf8"));
  const shell = Number(fs.readFileSync(path.join(r.ws, "shell.pid"), "utf8"));
  assert.ok(alive(kid) && alive(shell));
  assert.strictEqual(r.preview.stop(), true);
  await until(() => !alive(kid) && !alive(shell), 5000, "the tree to be gone");
  assert.strictEqual(r.preview.alive(), false);
  assert.strictEqual((await r.request({ path: "/" })).error.code, "unreachable");
  assert.strictEqual(r.preview.stop(), false, "stopping nothing is nothing");
  r.remove();
});

test("a dev server that exits by itself after it was up is reported as preview-ended", async () => {
  const r = rig();
  const res = await r.preview.start(dev("DEV_MODE=exits-later "));
  assert.strictEqual(res.ok, true, res.error);
  await until(() => r.frames.find((f) => f.t === "preview-ended"), 5000, "preview-ended");
  const ended = r.frames.find((f) => f.t === "preview-ended");
  assert.deepStrictEqual([ended.id, ended.reason], ["p-1", "the dev server exited (3)"]);
  assert.strictEqual(r.preview.alive(), false);
  r.remove();
});

test("a dev server that stops before it answers, or never answers, is a sentence with the end of what it printed", async () => {
  const r = rig();
  const died = await r.preview.start({ ...dev(), cmd: "echo 'Error: cannot find module vite'; exit 1" });
  assert.strictEqual(died.ok, false);
  assert.match(died.error, /stopped \(exit 1\) before it answered/);
  assert.match(died.error, /cannot find module vite/);
  const mute = await r.preview.start({ ...dev("DEV_MODE=silent "), readySec: 1, port: 0 });
  // A server that listens but prints nothing is still found by the port it was told.
  assert.strictEqual(mute.ok, true, mute.error);
  r.preview.stop();
  const never = await r.preview.start({ id: "p-2", cmd: "sleep 30", readySec: 1, idleSec: 300, overlay: [] });
  assert.strictEqual(never.ok, false);
  assert.match(never.error, /did not answer within 1 seconds/);
  assert.strictEqual(r.preview.alive(), false, "and it was killed");
  r.remove();
});

test("the install runs first when there is a package.json and no node_modules, and not otherwise", async () => {
  const r = rig();
  fs.writeFileSync(path.join(r.ws, "package.json"), "{}");
  const m = { ...dev(), prepare: "echo installing > prepared.txt; echo install-output" };
  const first = await r.preview.start(m);
  assert.strictEqual(first.ok, true, first.error);
  assert.ok(fs.existsSync(path.join(r.ws, "prepared.txt")));
  assert.ok(r.frames.filter((f) => f.t === "out").map((f) => f.data).join("").includes("install-output"), "its output is streamed");
  fs.rmSync(path.join(r.ws, "prepared.txt"));
  fs.mkdirSync(path.join(r.ws, "node_modules"));
  r.preview.stop();
  await r.preview.start({ ...m, id: "p-2" });
  assert.ok(!fs.existsSync(path.join(r.ws, "prepared.txt")), "node_modules is there: no install");
  r.preview.stop();
  fs.rmSync(path.join(r.ws, "node_modules"), { recursive: true });
  const failing = await r.preview.start({ ...m, id: "p-3", prepare: "echo 'npm ERR! boom'; exit 4" });
  assert.strictEqual(failing.ok, false);
  assert.match(failing.error, /install before the dev server failed \(exit 4\)/);
  assert.match(failing.error, /npm ERR! boom/);
  r.remove();
});

test("in a container the dev server is told to listen on every address inside it, and the one port is published on the loopback", async () => {
  const seen = [];
  const inner = createSpawner({});
  const r = rig({ container: true, spawnCommand: (command, opts) => { seen.push(opts); return inner(command, { ...opts, env: { ...opts.env, ...opts.extraEnv, HOST: "127.0.0.1" } }); } });
  const res = await r.preview.start(dev());
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual(seen[0].extraEnv.HOST, "0.0.0.0");
  assert.deepStrictEqual(seen[0].ports, [Number(seen[0].extraEnv.PORT)]);
  r.remove();
});
