"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { parseArgs } = require("../src/args");
const { createClient } = require("../src/api/client");
const { redact, addSecret } = require("../src/api/redact");
const { serverUrl, configDir } = require("../src/config");
const { createFileStore } = require("../src/auth/fileStore");
const { createStore } = require("../src/auth/store");
const { folderState, saveFolderState } = require("../src/state/folders");
const { stageOf } = require("../src/chat/stages");
const { needOf } = require("../src/chat/needs");
const { logLine, toolLine } = require("../src/chat/activity");

test("arguments: a message, -p, commands, flags", () => {
  assert.strictEqual(parseArgs(["login"]).command, "login");
  assert.deepStrictEqual(parseArgs(["fix", "the", "cart"]).message, "fix the cart");
  assert.strictEqual(parseArgs(["fix the cart rounding"]).command, "chat");
  assert.strictEqual(parseArgs([]).command, "chat");
  assert.strictEqual(parseArgs(["--project", "abc", "hi"]).project, "abc");
  assert.strictEqual(parseArgs(["--project=abc"]).project, "abc");
  assert.strictEqual(parseArgs(["--", "login"]).message, "login");
  assert.ok(parseArgs(["--nope"]).error);
  assert.ok(parseArgs(["status", "extra"]).error);
  assert.strictEqual(parseArgs(["--no-runner", "hi"]).noRunner, true);
  assert.strictEqual(parseArgs(["hi"]).noRunner, false);
  // -p is the one answer, not a project.
  assert.deepStrictEqual([parseArgs(["-p", "why", "this"]).command, parseArgs(["-p", "why", "this"]).message], ["print", "why this"]);
  assert.strictEqual(parseArgs(["--print", "doctor"]).message, "doctor");
  assert.strictEqual(parseArgs(["doctor"]).command, "doctor");
  assert.strictEqual(parseArgs(["update"]).command, "update");
  assert.strictEqual(parseArgs(["--help", "x"]).command, "help");
});

test("server address: https, or http only to this computer", () => {
  assert.strictEqual(serverUrl({}), "https://api.x0bot.com");
  assert.strictEqual(serverUrl({ XODE_SERVER: "http://127.0.0.1:4545/" }), "http://127.0.0.1:4545");
  assert.throws(() => serverUrl({ XODE_SERVER: "http://api.x0bot.com" }), /https/);
  assert.strictEqual(configDir({ XDG_CONFIG_HOME: "/x/y" }), path.join("/x/y", "xode"));
});

test("redaction takes out tokens, bearer headers and tickets", () => {
  addSecret("supersecretvalue123");
  const s = redact("Bearer abc.def xdt_AAAA-bbbb ?ticket=zzz&x=1 supersecretvalue123");
  assert.ok(!/abc\.def|AAAA|zzz|supersecretvalue123/.test(s), s);
  // A git remote's address with a password or token in it.
  const g = redact("fatal: unable to access 'https://ana:ghp_tokentoken@github.com/ana/storefront.git/' and ssh://git@github.com/ana/x");
  assert.ok(!/ghp_tokentoken|ana:/.test(g), g);
  assert.match(g, /ssh:\/\/git@github\.com/);
});

test("errors: 401 is signed out, 403 device_scope, a server's own words otherwise, never a token", async () => {
  const token = "xdt_fake_error_mapping_token_123456";
  const srv = http.createServer((req, res) => {
    const codes = { "/a": [401, {}], "/b": [403, { code: "device_scope" }], "/c": [409, { code: "plan_changed", message: `The plan changed. ${req.headers.authorization}` }], "/d": [502, {}] };
    const [status, body] = codes[req.url];
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const c = createClient({ server: `http://127.0.0.1:${srv.address().port}`, token });
  try {
    await assert.rejects(c.get("/a"), { code: "signed_out", message: "Signed out: run xode to sign in again." });
    await assert.rejects(c.get("/b"), (e) => e.code === "device_scope" && e.status === 403);
    await assert.rejects(c.get("/c"), (e) => e.code === "plan_changed" && e.message.startsWith("The plan changed.") && !e.message.includes(token));
    await assert.rejects(c.get("/d"), (e) => e.status === 502 && /had a problem/.test(e.message));
  } finally {
    srv.close();
  }
  const dead = createClient({ server: "http://127.0.0.1:9", token });
  await assert.rejects(dead.get("/x"), { code: "unreachable" });
});

test("the file store: 700 folder, 600 file, one host at a time, gone when empty", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xode-store-"));
  try {
    const env = { XDG_CONFIG_HOME: dir, XODE_CRED_STORE: "file" };
    const s = createStore(env);
    assert.strictEqual(await s.set("a.example:1", "xdt_fake_one_aaaaaaaa"), "file");
    await s.set("b.example", "xdt_fake_two_bbbbbbbb");
    assert.strictEqual(await s.get("a.example:1"), "xdt_fake_one_aaaaaaaa");
    const file = createFileStore(env).file;
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    await s.remove("a.example:1");
    assert.strictEqual(await s.get("a.example:1"), null);
    await s.remove("b.example");
    assert.ok(!fs.existsSync(file));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("folder state remembers the last job per folder and server", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xode-state-"));
  try {
    const env = { XDG_CONFIG_HOME: dir };
    saveFolderState("https://s", "/work/shop", { jobId: "j1" }, env);
    saveFolderState("https://s", "/work/blog", { jobId: "j2" }, env);
    assert.strictEqual(folderState("https://s", "/work/shop", env).jobId, "j1");
    assert.strictEqual(folderState("https://other", "/work/shop", env).jobId, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stages follow the app's mapping of phases", () => {
  assert.deepStrictEqual(["prepare", "locate", "plan", "work", "verify", "pr", "report"].map((p) => stageOf(p, "running")), [0, 0, 1, 2, 3, 4, 4]);
  assert.strictEqual(stageOf("work", "done"), 5);
});

test("what the job waits on", () => {
  const q = needOf({ job: { state: "waiting_for_you", waitingOn: "answer" }, agent: { waiting: { kind: "question", question: "Which?", options: ["A", " ", "B"] } } });
  assert.deepStrictEqual([q.kind, q.question, q.options], ["answer", "Which?", ["A", "B"]]);
  assert.strictEqual(needOf({ job: { state: "running" } }), null);
  assert.strictEqual(needOf({ job: { state: "waiting_for_you", waitingOn: "approval" }, agent: { waiting: { kind: "approval", action: "github.pr_ready", summary: {} } } }).question, "Okay to pr ready?");
});

test("activity lines", () => {
  assert.strictEqual(logLine({ kind: "edit", files: ["src/a/b/c.ts", "d.ts"], data: { action: "create" } }), "Made a/b/c.ts and 1 more");
  assert.strictEqual(logLine({ kind: "command", text: "npm test", data: { kind: "test", summary: "18 passed" } }), "Ran the tests · 18 passed");
  assert.strictEqual(logLine({ kind: "note", text: "x" }), null);
  assert.strictEqual(toolLine({ name: "run", brief: "npm test" }), "Ran npm test");
  assert.strictEqual(toolLine({ name: "ask_user", brief: "?" }), null);
});

test("the chat is the app's own thread for the person and the project; --new keeps a separate one per folder", () => {
  const { appThread, threadFor } = require("../src/chat/thread");
  const os = require("os"), fs = require("fs"), path = require("path");
  // The same rule as tulmi/src/experience/bots/screens/codeWork/parts.ts threadFor.
  const h = require("crypto").createHash("sha256").update("tailzu:code-chat:u1:p1").digest("hex");
  assert.strictEqual(appThread("u1", "p1"), `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "xode-thread-"));
  const env = { XDG_CONFIG_HOME: home };
  const at = { server: "http://127.0.0.1:1", cwd: "/work/shop", projectId: "p1", env };
  assert.strictEqual(threadFor({ ...at, userId: "u1" }), appThread("u1", "p1"));
  const own = threadFor({ ...at, userId: "u1", fresh: true });
  assert.notStrictEqual(own, appThread("u1", "p1"));
  assert.strictEqual(threadFor({ ...at, userId: "u1" }), own, "once --new, this folder keeps its own");
  fs.rmSync(home, { recursive: true, force: true });
});

test("the socket client this package carries is the desktop runner's, unchanged", (t) => {
  const fs = require("fs"), path = require("path");
  const desk = path.join(__dirname, "..", "..", "src", "runner", "ws.js");
  if (!fs.existsSync(desk)) { t.skip("not beside the desktop app"); return; }
  assert.strictEqual(fs.readFileSync(path.join(__dirname, "..", "src", "net", "ws.js"), "utf8"), fs.readFileSync(desk, "utf8"));
});
