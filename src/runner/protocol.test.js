// node --test
//
// The words of the live session (protocol.js), against the frames in the backend's docs/desktop-runner-session.md: what the app
// accepts from the room and the Worker, and what it says first. A frame that is wrong is flagged, not trusted; one that is merely new
// is ignored.

const test = require("node:test");
const assert = require("node:assert");
const { parseToRunner, parseToDevice, parseOffer, helloFrame, isSessionCommands, isPreviewPath, isId, SESSION_COMMAND } = require("./protocol.js");

const J = JSON.stringify;

test("the room's frames from the doc are understood", () => {
  assert.deepStrictEqual(parseToRunner(J({ t: "ready", v: 1, jobId: "j", idleSec: 120, maxSec: 1180 })), { t: "ready", v: 1, jobId: "j", idleSec: 120, maxSec: 1180 });
  const exec = parseToRunner(J({ t: "exec", id: "e-12", commands: ["npm test"], timeoutSec: 600, overlay: [{ path: "src/a.ts", content: "x" }, { path: "old.ts", content: null }], discard: true }));
  assert.strictEqual(exec.t, "exec");
  assert.deepStrictEqual(exec.commands, ["npm test"]);
  assert.strictEqual(exec.overlay.length, 2);
  assert.deepStrictEqual(parseToRunner(J({ t: "cancel", id: "e-12" })), { t: "cancel", id: "e-12" });
  assert.deepStrictEqual(parseToRunner(J({ t: "ping", at: 123 })), { t: "ping", at: 123 });
  assert.deepStrictEqual(parseToRunner(J({ t: "close", reason: "idle", message: "m" })), { t: "close", reason: "idle", message: "m" });
  assert.strictEqual(parseToRunner(J({ t: "close", reason: "nonsense" })).reason, "error");
  const g = parseToRunner(J({ t: "grep", id: "g-3", pattern: "slug", path: "src", glob: "*.ts", ignoreCase: false, context: 0, filesOnly: false, maxResults: 100 }));
  assert.strictEqual(g.pattern, "slug");
  assert.deepStrictEqual(parseToRunner(J({ t: "glob", id: "g-4", pattern: "src/**/*.test.ts" })), { t: "glob", id: "g-4", pattern: "src/**/*.test.ts" });
  const pv = parseToRunner(J({ t: "preview", id: "p-1", cmd: "npm run dev", port: 5173, prepare: "npm ci", readySec: 90, idleSec: 300, overlay: [] }));
  assert.strictEqual(pv.port, 5173);
  assert.strictEqual(pv.prepare, "npm ci");
  const h = parseToRunner(J({ t: "http", id: "h-7", method: "GET", path: "/src/main.tsx?t=1", headers: [["accept", "*/*"]], body: "" }));
  assert.strictEqual(h.method, "GET");
  assert.deepStrictEqual(parseToRunner(J({ t: "http-cancel", id: "h-7" })), { t: "http-cancel", id: "h-7" });
  assert.deepStrictEqual(parseToRunner(J({ t: "preview-stop", reason: "design round" })), { t: "preview-stop", reason: "design round" });
});

test("a frame of a known kind with a wrong field is flagged with its id; one of an unknown kind is ignored; rubbish is null", () => {
  const bad = parseToRunner(J({ t: "exec", id: "e-1", commands: [], timeoutSec: 5, overlay: [] }));
  assert.deepStrictEqual(bad, { t: "exec", bad: true, id: "e-1" });
  assert.strictEqual(parseToRunner(J({ t: "exec", id: "e-1", commands: ["a"], timeoutSec: 0, overlay: [] })).bad, true);
  assert.strictEqual(parseToRunner(J({ t: "exec", id: "e-1", commands: ["a"], timeoutSec: 4000, overlay: [] })).bad, true);
  assert.strictEqual(parseToRunner(J({ t: "exec", id: "bad id!", commands: ["a"], timeoutSec: 5, overlay: [] })).bad, true);
  assert.strictEqual(parseToRunner(J({ t: "exec", id: "e", commands: Array(21).fill("a"), timeoutSec: 5, overlay: [] })).bad, true);
  assert.strictEqual(parseToRunner(J({ t: "exec", id: "e", commands: ["x".repeat(2001)], timeoutSec: 5, overlay: [] })).bad, true);
  assert.strictEqual(parseToRunner(J({ t: "exec", id: "e", commands: ["a"], timeoutSec: 5, overlay: Array(201).fill({ path: "a", content: "" }) })).bad, true);
  assert.strictEqual(parseToRunner(J({ t: "http", id: "h", method: "CONNECT", path: "/", headers: [] })).bad, true);
  assert.strictEqual(parseToRunner(J({ t: "http", id: "h", method: "GET", path: "//evil.example/", headers: [] })).bad, true);
  assert.strictEqual(parseToRunner(J({ t: "http", id: "h", method: "GET", path: "/a b", headers: [] })).bad, true);
  assert.strictEqual(parseToRunner(J({ t: "http", id: "h", method: "GET", path: "/", headers: [["bad name", "x"]] })).bad, true);
  assert.strictEqual(parseToRunner(J({ t: "http", id: "h", method: "POST", path: "/", headers: [], body: "not base64!" })).bad, true);
  assert.strictEqual(parseToRunner(J({ t: "preview", id: "p", cmd: " ", readySec: 90, idleSec: 300, overlay: [] })).bad, true);
  assert.strictEqual(parseToRunner(J({ t: "preview", id: "p", cmd: "x", readySec: 2, idleSec: 300, overlay: [] })).bad, true);
  assert.deepStrictEqual(parseToRunner(J({ t: "something-new", x: 1 })), { t: "something-new", unknown: true });
  assert.strictEqual(parseToRunner("not json"), null);
  assert.strictEqual(parseToRunner(J([1, 2])), null);
  assert.strictEqual(parseToRunner(J({ x: 1 })), null);
});

test("an offer from the doc is read; one that cannot be run is refused", () => {
  const offer = {
    jobId: "3f9a1c2b-0000", stepIdx: 5, epoch: 3, commands: [SESSION_COMMAND], timeoutSec: 1200,
    repo: { kind: "app", cloneUrl: "https://github.com/acme/app.git", branch: "tailzu/fix-login", headSha: "a".repeat(40), readToken: "ghs_xxx", readTokenExpiresAt: 1793000000000 },
    overlay: [{ path: "src/a.ts", content: "x" }, { path: "old.ts", content: null }], discard: true,
    session: { url: "wss://jobs.example/v1/rooms/3f9a1c2b/runner", ticket: "t1.abc.def", expiresAt: 1793000000000, idleSec: 120, maxSec: 1200 },
  };
  const o = parseOffer(offer);
  assert.strictEqual(o.session.idleSec, 120);
  assert.strictEqual(o.repo.readToken, "ghs_xxx");
  assert.strictEqual(o.discard, true);
  assert.ok(isSessionCommands(o.commands));
  assert.strictEqual(parseOffer({ ...offer, repo: { ...offer.repo, kind: "svn" } }), null);
  assert.strictEqual(parseOffer({ ...offer, epoch: -1 }), null);
  assert.strictEqual(parseOffer({ ...offer, session: { url: 5 } }), null);
  assert.strictEqual(parseOffer(null), null);
  const d = parseToDevice(J({ t: "offer", offer: { ...offer, epoch: "x" } }));
  assert.deepStrictEqual([d.t, d.bad, d.jobId], ["offer", true, "3f9a1c2b-0000"]);
  assert.deepStrictEqual(parseToDevice(J({ t: "cancel", jobId: "j", epoch: 3 })), { t: "cancel", jobId: "j", epoch: 3 });
  assert.deepStrictEqual(parseToDevice(J({ t: "replaced" })), { t: "replaced" });
  assert.strictEqual(parseToDevice(J({ t: "ack", v: 1, deviceId: "laptop-0001" })).deviceId, "laptop-0001");
});

test("the hello is what the doc says, cut to its limits", () => {
  const h = helloFrame({ deviceId: "laptop-0001", name: "W".repeat(200), allowRun: true, projects: "all", busy: false, app: "tailzu-desktop 1.4.0" });
  assert.deepStrictEqual(Object.keys(h), ["t", "v", "deviceId", "name", "allowRun", "projects", "busy", "app"]);
  assert.strictEqual(h.name.length, 80);
  assert.strictEqual(h.v, 1);
  assert.deepStrictEqual(helloFrame({ deviceId: "x", name: "n", allowRun: false, projects: ["a"], busy: true }).projects, ["a"]);
  assert.strictEqual(helloFrame({ deviceId: "x", name: "n", allowRun: false, projects: Array(300).fill("p") }).projects.length, 200);
});

test("ids and preview paths follow the doc's patterns", () => {
  for (const ok of ["e-12", "a.b:c/d@e-f_g".replace("_", "-"), "x"]) assert.ok(isId(ok), ok);
  for (const bad of ["", "a b", "a".repeat(201), "é"]) assert.ok(!isId(bad), bad);
  for (const ok of ["/", "/src/main.tsx?t=1", "/a/b"]) assert.ok(isPreviewPath(ok), ok);
  for (const bad of ["", "a", "//host", "/a b", "/a\\b", "/\u0000"]) assert.ok(!isPreviewPath(bad), JSON.stringify(bad));
  assert.ok(!isSessionCommands(["tailzu:live-session", "x"]));
  assert.ok(!isSessionCommands(["npm test"]));
});
