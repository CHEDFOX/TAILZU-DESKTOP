// Fixtures for the runner's tests (not shipped, not a test): a FAKE JOBS WORKER and a fake VPS in one little server.
//
//   cloud.api        what the app calls over HTTP, recorded:  POST /v1/code/runner/ticket, progress, result;
//                    GET /v1/code/jobs/:id and /v1/code/projects
//   cloud.devices    the presence sockets that were opened (/v1/devices/connect), each a FakeSocket
//   cloud.rooms      the runner sessions (/v1/rooms/<job>/runner), each a FakeSocket
//
// Tickets are checked the way the doc says: a device or room ticket works once, and a refusal is an HTTP answer to the upgrade with
// { ok: false, code, message }. A FakeSocket records every frame the app sent, answers `ping` with `pong`, answers `hello` with `ack` (on
// the presence socket), and lets a test send frames and wait for the app's.

"use strict";

const http = require("http");
const nodeFs = require("fs");
const nodeOs = require("os");
const nodePath = require("path");
const childProcess = require("child_process");
const { acceptWs } = require("./ws.js");

/** One end of a socket, as a test sees it. */
class FakeSocket {
  constructor(conn, req, kind) {
    this.conn = conn;
    this.kind = kind;
    this.url = req.url;
    this.headers = req.headers;
    this.frames = [];
    this.texts = [];
    this.closeInfo = null;
    this.waiters = [];
    this.autoPong = true;
    this.autoAck = kind === "device";
    this.autoReady = null;
    conn.on("message", (text) => {
      this.texts.push(text);
      if (text === "ping") { if (this.autoPong) conn.send("pong"); this._wake(); return; }
      let m = null;
      try { m = JSON.parse(text); } catch { /* not JSON */ }
      if (m) {
        this.frames.push(m);
        if (m.t === "hello" && this.autoAck) conn.send(JSON.stringify({ t: "ack", v: 1, deviceId: m.deviceId }));
        if (m.t === "hello" && this.autoReady) conn.send(JSON.stringify({ t: "ready", v: 1, jobId: this.jobId || "job", idleSec: this.autoReady.idleSec || 120, maxSec: this.autoReady.maxSec || 1180 }));
      }
      this._wake();
    });
    conn.on("close", (info) => { this.closeInfo = info; this._wake(); });
    conn.on("error", () => {});
  }
  _wake() { for (const w of [...this.waiters]) w(); }
  send(obj) { return this.conn.send(JSON.stringify(obj)); }
  sendText(t) { return this.conn.send(t); }
  close(code = 1000, reason = "") { this.conn.close(code, reason); }
  terminate() { this.conn.terminate(); }
  of(t) { return this.frames.filter((f) => f.t === t); }
  get closed() { return this.closeInfo !== null; }
  /** Resolves with the first frame (already here or yet to come) that `pred` accepts. */
  waitFor(pred, ms = 8000, what = "a frame") {
    const test = typeof pred === "string" ? (f) => f.t === pred : pred;
    return new Promise((resolve, reject) => {
      const look = () => { const f = this.frames.find(test); if (f) { cleanup(); resolve(f); } };
      const timer = setTimeout(() => { cleanup(); reject(new Error("timed out waiting for " + what + "; got " + JSON.stringify(this.frames.map((f) => f.t)))); }, ms);
      const cleanup = () => { clearTimeout(timer); this.waiters.splice(this.waiters.indexOf(look), 1); };
      this.waiters.push(look);
      look();
    });
  }
  /** Resolves when the app closed this socket. */
  waitClosed(ms = 8000) {
    return new Promise((resolve, reject) => {
      const look = () => { if (this.closed) { cleanup(); resolve(this.closeInfo); } };
      const timer = setTimeout(() => { cleanup(); reject(new Error("timed out waiting for the socket to close")); }, ms);
      const cleanup = () => { clearTimeout(timer); this.waiters.splice(this.waiters.indexOf(look), 1); };
      this.waiters.push(look);
      look();
    });
  }
  /** All the `out` frames of an exec, joined. */
  output(id) { return this.frames.filter((f) => f.t === "out" && (id === undefined || f.id === id)).map((f) => f.data).join(""); }
}

/** A waiter for "something happened N times". */
function counter() {
  const waiters = [];
  const self = { n: 0, bump() { self.n += 1; for (const w of [...waiters]) w(); }, until(n, ms = 8000) { return new Promise((res, rej) => { const look = () => { if (self.n >= n) { cleanup(); res(self.n); } }; const t = setTimeout(() => { cleanup(); rej(new Error("timed out waiting for " + n + " (got " + self.n + ")")); }, ms); const cleanup = () => { clearTimeout(t); waiters.splice(waiters.indexOf(look), 1); }; waiters.push(look); look(); }); } };
  return self;
}

/**
 * o: {
 *   projects: [{ id, fullName }], jobs: { [jobId]: { projectId } }, liveOff, ticketStatus (a status to answer the ticket route with),
 *   progressStatus, resultStatus (a function (n, body) -> status, or a number), requireAuth
 * }
 */
function startFakeCloud(o = {}) {
  const cloud = {
    api: { tickets: [], progress: [], results: [], jobCalls: [], projectCalls: 0, resultAttempts: 0 },
    devices: [], rooms: [], deviceWaiter: counter(), roomWaiter: counter(),
    projects: o.projects || [{ id: "proj-1", fullName: "acme/app" }],
    jobs: o.jobs || {},
    liveOff: !!o.liveOff, ticketStatus: o.ticketStatus || 0, progressStatus: o.progressStatus || 200, resultStatus: o.resultStatus || 200,
    /** Device tickets issued and not yet used. */
    deviceTickets: new Set(), roomTickets: new Map(), seq: 0,
    refuseNext: null,
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = {};
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; } catch { /* not JSON */ }
      const json = (status, v) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(v)); };
      const path = req.url.split("?")[0];
      if (req.method === "POST" && path === "/v1/code/runner/ticket") {
        cloud.api.tickets.push(body);
        if (cloud.liveOff) return json(404, { code: "live_off", message: "The live session is not switched on." });
        if (cloud.ticketStatus) return json(cloud.ticketStatus, { code: "nope", message: "no" });
        const ticket = "t1.device." + (++cloud.seq);
        cloud.deviceTickets.add(ticket);
        return json(200, { url: "ws://127.0.0.1:" + cloud.port + "/v1/devices/connect", ticket, expiresAt: Date.now() + 120000 });
      }
      if (req.method === "GET" && /^\/v1\/code\/jobs\/[^/]+$/.test(path)) {
        const id = decodeURIComponent(path.split("/").pop());
        cloud.api.jobCalls.push(id);
        const j = cloud.jobs[id];
        return j ? json(200, { job: { id, projectId: j.projectId }, steps: [] }) : json(404, { code: "not_found" });
      }
      if (req.method === "GET" && path === "/v1/code/projects") { cloud.api.projectCalls += 1; return json(200, { projects: cloud.projects }); }
      if (req.method === "POST" && path === "/v1/code/runner/progress") {
        cloud.api.progress.push(body);
        return cloud.progressStatus === 200 ? json(200, { ok: true, leaseExpiresAt: Date.now() + 90000 }) : json(cloud.progressStatus, { code: "stale_lease", message: "gone" });
      }
      if (req.method === "POST" && path === "/v1/code/runner/result") {
        cloud.api.resultAttempts += 1;
        const status = typeof cloud.resultStatus === "function" ? cloud.resultStatus(cloud.api.resultAttempts, body) : cloud.resultStatus;
        if (status === 200) { cloud.api.results.push(body); return json(200, { ok: true, state: "running", committed: false }); }
        return json(status, { code: status === 409 ? "stale_lease" : "boom", message: "no" });
      }
      return json(404, { code: "not_found" });
    });
  });
  server.on("upgrade", (req, socket, head) => {
    const refuse = (status, code) => { socket.write("HTTP/1.1 " + status + " X\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n" + JSON.stringify({ ok: false, code, message: "refused" })); socket.destroy(); };
    const url = new URL(req.url, "http://x");
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "");
    const ticket = bearer ? bearer[1] : url.searchParams.get("ticket");
    if (cloud.refuseNext) { const r = cloud.refuseNext; cloud.refuseNext = null; return refuse(r.status, r.code); }
    if (url.pathname === "/v1/devices/connect") {
      if (!ticket || !cloud.deviceTickets.has(ticket)) return refuse(401, ticket && ticket.startsWith("t1.device.") ? "replayed" : "bad_ticket");
      cloud.deviceTickets.delete(ticket);
      const fs = new FakeSocket(acceptWs(req, socket, head), req, "device");
      fs.ticket = ticket;
      cloud.devices.push(fs);
      cloud.deviceWaiter.bump();
      return;
    }
    const m = /^\/v1\/rooms\/([^/]+)\/runner$/.exec(url.pathname);
    if (m) {
      const want = cloud.roomTickets.get(m[1]);
      if (!want || want.ticket !== ticket) return refuse(401, "bad_ticket");
      if (want.used) return refuse(401, "used");
      want.used = true;
      const fs = new FakeSocket(acceptWs(req, socket, head), req, "room");
      fs.jobId = m[1];
      fs.autoReady = want.autoReady === undefined ? { idleSec: 120, maxSec: 1180 } : want.autoReady;
      cloud.rooms.push(fs);
      cloud.roomWaiter.bump();
      return;
    }
    refuse(404, "not_found");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      cloud.port = server.address().port;
      cloud.url = "http://127.0.0.1:" + cloud.port;
      cloud.wsUrl = "ws://127.0.0.1:" + cloud.port;
      /** An offer for a live session on this cloud's room (the ticket is good for one connection). */
      cloud.sessionOffer = (jobId, extra = {}) => {
        const ticket = "t1.runner." + (++cloud.seq);
        cloud.roomTickets.set(jobId, { ticket, used: false, autoReady: extra.autoReady });
        return Object.assign({
          jobId, stepIdx: 5, epoch: 3, commands: ["tailzu:live-session"], timeoutSec: 1200,
          repo: Object.assign({ kind: "app", cloneUrl: "https://github.com/acme/app.git", branch: "tailzu/fix", headSha: "0".repeat(40), readToken: "ghs_readonlytoken0123456789abcdef", readTokenExpiresAt: Date.now() + 3600000 }, extra.repo || {}),
          session: { url: cloud.wsUrl + "/v1/rooms/" + jobId + "/runner", ticket, expiresAt: Date.now() + 900000, idleSec: extra.idleSec || 120, maxSec: extra.maxSec || 1200 },
        }, extra.offer || {});
      };
      cloud.close = () => new Promise((r) => {
        for (const s of cloud.devices.concat(cloud.rooms)) { try { s.terminate(); } catch { /* gone */ } }
        server.closeAllConnections?.();
        server.close(() => r());
      });
      resolve(cloud);
    });
  });
}

// ---- git fixtures ----

const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const sh = (cmd, cwd) => childProcess.execSync(cmd, { cwd, encoding: "utf8", env: Object.assign({}, process.env, GIT_ENV), stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A temp folder (real path), removed by the returned function. */
function tempDir(prefix = "tzrun-") {
  const dir = nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), prefix)));
  return { dir, remove: () => { try { nodeFs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } } };
}

/**
 * A local "GitHub": a bare repository with the given commits (each a map of path -> text, null to delete), as file:// URL. Returns
 * { url, shas: [sha1, sha2, ...], push(files) -> sha }.
 */
function bareRepo(base, commits, branch = "main", name = "remote") {
  const work = nodePath.join(base, "work");
  const bare = nodePath.join(base, name + ".git");
  nodeFs.mkdirSync(work, { recursive: true });
  sh("git init -q -b " + branch, work);
  const shas = [];
  const commit = (files) => {
    for (const [p, text] of Object.entries(files)) {
      const f = nodePath.join(work, p);
      if (text === null) nodeFs.rmSync(f, { force: true });
      else { nodeFs.mkdirSync(nodePath.dirname(f), { recursive: true }); nodeFs.writeFileSync(f, text); }
    }
    sh("git add -A && git commit -q --allow-empty -m c" + (shas.length + 1), work);
    const sha = sh("git rev-parse HEAD", work);
    shas.push(sha);
    return sha;
  };
  for (const c of commits) commit(c);
  sh("git clone -q --bare " + JSON.stringify(work) + " " + JSON.stringify(bare));
  return {
    url: "file://" + bare, shas, work, bare,
    push(files) { const sha = commit(files); sh("git push -q " + JSON.stringify(bare) + " " + branch, work); return sha; },
  };
}

/** Timers a test runs by hand: every setTimeout is remembered, none fires until fire() says so. */
function fakeTimers() {
  let seq = 0;
  const live = new Map();
  const self = {
    history: [],
    setTimeout(fn, ms) { const id = ++seq; live.set(id, { fn, ms }); self.history.push(ms); return id; },
    clearTimeout(id) { live.delete(id); },
    pending() { return [...live.values()].map((x) => x.ms); },
    /** Runs the oldest timer that is waiting. */
    fire() { const first = live.entries().next(); if (first.done) return false; live.delete(first.value[0]); first.value[1].fn(); return true; },
    /** Runs the timer with this delay. */
    fireMs(ms) { for (const [id, x] of live) if (x.ms === ms) { live.delete(id); x.fn(); return true; } return false; },
  };
  return self;
}
const tick = (n = 1) => new Promise((r) => { let i = 0; const go = () => { if (++i > n) r(); else setImmediate(go); }; setImmediate(go); });

/** A process id that is alive? */
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

/** Waits until `fn()` is truthy. */
async function until(fn, ms = 8000, what = "the condition") {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for " + what);
    await new Promise((r) => setTimeout(r, 15));
  }
}

module.exports = { startFakeCloud, FakeSocket, bareRepo, tempDir, sh, alive, until, counter, fakeTimers, tick, GIT_ENV };
