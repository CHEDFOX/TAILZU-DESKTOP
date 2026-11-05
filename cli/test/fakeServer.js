// A stand-in for the X0 Bot server, on this computer: the sign-in, the Xode flow, jobs, their log and their live room, GitHub's
// connect link and the repositories it lets Xode see, and the runner's side (its ticket and the presence socket a computer says
// hello on). Scripted, so a test (or a demo) knows what happens next. Only fake tokens: they are made here, for here.
//
//   createFakeServer({ linkOutcome, approveAfterPolls, live, stepMs, repos, github, onJobEnd, ... })
//     -> { url, calls, tokens, addToken(t), jobs, devices, close() }

"use strict";

const http = require("http");
const path = require("path");
const crypto = require("crypto");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT_ID = "6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7";

function loadWs() {
  try { return require(path.join(__dirname, "..", "..", "src", "runner", "ws.js")); } catch { return null; }
}

/** The job's script: what it does, step by step. A `question` waits for its answer. */
function defaultScript() {
  return [
    { phase: "prepare", log: { kind: "read", text: "Read the project", files: ["README.md"] }, tool: { name: "read_file", brief: "README.md" } },
    { phase: "locate", log: { kind: "read", text: "Found where totals are made", files: ["src/cart/total.ts"] }, tool: { name: "read_file", brief: "src/cart/total.ts" } },
    { phase: "plan", log: { kind: "step", text: "Planned: round once, at the end, not per item" } },
    { phase: "work", log: { kind: "edit", text: "Round the total once", files: ["src/cart/total.ts"], data: { action: "edit" } }, tool: { name: "edit_file", brief: "src/cart/total.ts" } },
    { question: { question: "Should prices round half up, or half to even?", options: ["Half up", "Half to even"] } },
    { phase: "work", log: { kind: "edit", text: "A test for the rounding", files: ["src/cart/total.test.ts"], data: { action: "create" } }, tool: { name: "write_file", brief: "src/cart/total.test.ts" } },
    { phase: "verify", log: { kind: "command", text: "npm test", data: { kind: "test", summary: "18 passed", exitCode: 0 } }, tool: { name: "run", brief: "npm test" } },
    { phase: "pr", log: { kind: "step", text: "Opened pull request #42" }, pr: { number: 42, url: "https://github.com/ana/storefront/pull/42", ready: false } },
    { phase: "report" },
    { done: { text: "Fixed the cart rounding: the total is now rounded once, at src/cart/total.ts:42, half up as you said. A new test covers a cart of 19.995 + 0.005.", prUrl: "https://github.com/ana/storefront/pull/42" } },
  ];
}

function createFakeServer(opts = {}) {
  const o = {
    linkOutcome: "approved", approveAfterPolls: 2, pollHoldMs: 0, pollMs: 20, live: false, stepMs: 40, sayDelayMs: 0,
    gate: { open: true, reading: { status: "ready", pct: 100, phase: "" }, vision: "given" },
    projects: [{ id: PROJECT_ID, userId: "u1", installationId: 1, linkKind: "app", repoId: 1, fullName: "ana/storefront", defaultBranch: "main", private: true, createdAt: 1 }],
    script: defaultScript(), user: { email: "ana@example.com", name: "Ana" },
    // GitHub as Xode sees it: not connected, and no repository visible, unless a test says otherwise.
    github: { configured: true, connected: false, installations: [] }, repos: [],
    installUrl: "https://github.com/apps/x0bot-test/installations/new?state=signed-state",
    ...opts,
  };
  const calls = [];
  const tokens = new Map(); // device token -> device
  const links = new Map();
  const threads = new Map();
  const jobs = new Map();
  const viewers = new Map(); // jobId -> Set<conn>
  const tickets = new Set();
  const deviceTickets = new Set();
  const devices = []; // { hello, frames, conn, closed }
  const ws = loadWs();
  let base = "";

  const now = () => Date.now();
  const send = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const deviceOf = (req) => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "");
    return m ? tokens.get(m[1]) || null : null;
  };

  // ------------------------------------------------------------------ jobs

  function jobView(j) {
    return {
      job: {
        id: j.id, projectId: j.projectId, branch: j.branch, task: j.task, state: j.state, placement: "none",
        budgetPaise: 3000, spentPaise: j.step * 40, reason: j.reason, waitingOn: j.waitingOn, agent: true, createdAt: j.createdAt, updatedAt: j.updatedAt,
      },
      steps: [],
      agent: {
        phase: j.phase, staged: [], commits: [], fixRounds: 0, steps: j.step, findings: [], notes: [],
        ...(j.waiting ? { waiting: j.waiting } : {}), ...(j.pr ? { pr: j.pr } : {}), ...(j.report ? { report: j.report } : {}),
      },
    };
  }

  function emit(j, frame) {
    const set = viewers.get(j.id);
    if (!set) return;
    for (const c of set) c.send(JSON.stringify({ ...frame, at: now() }));
  }

  function advance(j) {
    if (j.state !== "running") return;
    const s = o.script[j.step];
    if (!s) return;
    j.step += 1;
    j.updatedAt = now();
    if (s.phase) { j.phase = s.phase; emit(j, { t: "phase", phase: s.phase }); }
    if (s.log) { j.log.push({ seq: j.log.length + 1, at: now(), ...s.log }); }
    if (s.tool) emit(j, { t: "tool", id: `c${j.step}`, ...s.tool });
    if (s.pr) j.pr = s.pr;
    if (s.question) {
      j.state = "waiting_for_you";
      j.waitingOn = "answer";
      j.reason = s.question.question;
      j.waiting = { kind: "question", ...s.question };
      j.log.push({ seq: j.log.length + 1, at: now(), kind: "question", text: s.question.question });
      emit(j, { t: "session", state: "closed", reason: "needs_you" });
      return;
    }
    if (s.done) {
      j.state = "done";
      j.phase = "done";
      j.report = { outcome: "done", text: s.done.text, prUrl: s.done.prUrl, costPaise: 400 };
      j.waitingOn = null;
      if (o.onJobEnd) o.onJobEnd(j);
      emit(j, { t: "end", why: "done" });
      endViewers(j);
      return;
    }
    if (s.fail) {
      j.state = "failed";
      j.reason = s.fail;
      if (o.onJobEnd) o.onJobEnd(j);
      emit(j, { t: "end", why: "failed" });
      endViewers(j);
      return;
    }
    schedule(j);
  }

  function schedule(j) {
    clearTimeout(j.timer);
    const next = o.script[j.step];
    j.timer = setTimeout(() => advance(j), (next && next.ms) || o.stepMs);
  }

  function endViewers(j) {
    clearTimeout(j.timer);
    const set = viewers.get(j.id);
    if (set) for (const c of set) { try { c.close(1000, "over"); } catch { /* gone */ } }
    viewers.delete(j.id);
  }

  function makeJob(projectId, task) {
    const id = crypto.randomUUID();
    const j = {
      id, projectId, branch: "xode/fix-cart-rounding", task, state: "running", phase: "prepare", step: 0, waitingOn: null, reason: "",
      waiting: null, log: [], createdAt: now(), updatedAt: now(), timer: null, answers: [], messages: [],
    };
    jobs.set(id, j);
    schedule(j);
    return j;
  }

  // ------------------------------------------------------------------ the flow

  function openingPlan() {
    return {
      v: 1, goal: "Tidy the checkout", state: "A small shop: a catalogue, a cart and a checkout, with tests for the catalogue only.",
      direction: "Make checkout dependable: correct totals first, then clearer errors.", suggested: true,
      steps: ["Look at how the cart adds up", "Cover the checkout with tests"], status: "proposed", at: now(),
    };
  }

  function revisedPlan(was, text) {
    return {
      ...was, v: was.v + 1, goal: "Fix the cart rounding",
      steps: [
        "Round the total once, at the end, in src/cart/total.ts:42",
        "Keep each line's price unrounded until then",
        "Add a test for a cart whose items add up to x.995",
      ],
      change: `Now about: ${text.slice(0, 60)}`, status: "proposed", at: now(),
    };
  }

  // ------------------------------------------------------------------ the routes

  async function route(req, res, url, body) {
    const p = url.pathname;
    const m = (re) => re.exec(p);

    // The sign-in, signed out.
    if (req.method === "POST" && p === "/v1/auth/link") {
      const token = crypto.randomBytes(16).toString("hex");
      const code = "ABCD-EFGH";
      links.set(token, { secret: crypto.randomBytes(16).toString("hex"), polls: 0, body });
      const l = links.get(token);
      return send(res, 200, {
        token, secret: l.secret, code, url: `https://app.x0bot.com/s/bots.link?l=${token}`, expiresAt: now() + 600_000, ttlMs: 600_000, pollMs: o.pollMs,
        deviceUrl: "https://x0bot.com/device", deviceUrlWithCode: `https://x0bot.com/device?code=${code}`,
      });
    }
    if (req.method === "POST" && p === "/v1/auth/link/poll") {
      const l = links.get(body.token);
      if (!l || l.secret !== body.secret) return send(res, 200, { status: "failed" });
      l.polls += 1;
      if (o.pollHoldMs) await new Promise((r) => setTimeout(r, o.pollHoldMs));
      if (l.polls < o.approveAfterPolls) return send(res, 200, { status: "pending" });
      if (o.linkOutcome !== "approved") return send(res, 200, { status: o.linkOutcome });
      if (l.done) return send(res, 200, { status: "used" });
      l.done = true;
      if (o.onApproved) o.onApproved(l.body.deviceName || "computer");
      const deviceToken = `xdt_${crypto.randomBytes(24).toString("base64url")}`;
      const deviceId = crypto.randomUUID();
      tokens.set(deviceToken, { id: deviceId, name: l.body.deviceName || "computer", platform: l.body.platform || "", createdAt: now(), lastUsedAt: now() });
      return send(res, 200, { status: "approved", deviceToken, deviceId });
    }

    const device = deviceOf(req);
    if (!device) return send(res, 401, { code: "unauthorized", message: "Missing or invalid token" });
    device.lastUsedAt = now();

    if (req.method === "GET" && p === "/v1/auth/device") {
      return send(res, 200, { id: device.id, name: device.name, platform: device.platform, createdAt: device.createdAt, lastUsedAt: device.lastUsedAt, user: o.user });
    }
    if (req.method === "POST" && p === "/v1/auth/device/revoke") {
      for (const [t, d] of tokens) if (d === device) tokens.delete(t);
      return send(res, 200, { ok: true });
    }
    // A device token is for Xode's routes only.
    if (!p.startsWith("/v1/code/") && !p.startsWith("/v1/bots/code/")) return send(res, 403, { code: "device_scope", message: "This sign-in is for Xode only." });

    if (req.method === "GET" && p === "/v1/code/projects") return send(res, 200, { projects: o.projects });
    if (req.method === "POST" && p === "/v1/code/projects") {
      const r = o.repos.find((x) => x.id === body.repoId);
      if (!r) return send(res, 404, { code: "not_found", message: "X0 Bot can't see that repo on GitHub." });
      let made = o.projects.find((x) => x.repoId === r.id);
      if (!made) {
        made = { id: crypto.randomUUID(), userId: "u1", installationId: 1, linkKind: "app", repoId: r.id, fullName: r.fullName, defaultBranch: r.defaultBranch || "main", private: true, createdAt: now() };
        o.projects.push(made);
      }
      return send(res, 200, { project: made, created: true });
    }
    if (req.method === "GET" && p === "/v1/code/github") return send(res, 200, o.github);
    if (req.method === "POST" && p === "/v1/code/github/connect") return send(res, 200, { installUrl: o.installUrl });
    if (req.method === "GET" && p === "/v1/code/repos") return send(res, 200, { repos: o.repos, truncated: false });

    // The runner's side: a ticket for the presence socket, and the older heartbeat.
    if (req.method === "POST" && p === "/v1/code/runner/ticket") {
      if (!ws) return send(res, 404, { code: "live_off", message: "The live session is not switched on." });
      const ticket = `dt_${crypto.randomBytes(12).toString("hex")}`;
      deviceTickets.add(ticket);
      return send(res, 200, { url: `${base.replace(/^http/, "ws")}/v1/devices/connect`, ticket, expiresAt: now() + 120_000 });
    }
    if (req.method === "POST" && p === "/v1/code/runner/heartbeat") return send(res, 200, { ok: true, onlineForSec: 60, leasesRenewed: 0 });

    let k;
    if ((k = m(/^\/v1\/bots\/code\/flow\/([^/]+)\/(gate|plan|say|approve|work|vision)$/))) {
      const [, project, what] = k;
      if (!o.projects.some((x) => x.id === project)) return send(res, 404, { code: "not_found", message: "No such project" });
      if (what === "gate") return send(res, 200, { gate: o.gate });
      if (what === "vision") { o.gate = { ...o.gate, vision: body.skip ? "skipped" : "given", open: o.gate.reading.status === "ready" }; return send(res, 200, { gate: o.gate, saved: body.skip ? "skipped" : "given" }); }
      const thread = what === "plan" ? url.searchParams.get("thread") : body.thread;
      if (!UUID.test(thread || "")) return send(res, 400, { code: "bad_request", message: "thread is the chat's id." });
      const t = threads.get(thread) || { plan: null };
      threads.set(thread, t);
      const jobOf = () => (t.plan && t.plan.jobId && jobs.get(t.plan.jobId)) || null;
      const current = () => {
        const j = jobOf();
        if (j && t.plan.status === "working" && ["done", "failed", "cancelled"].includes(j.state)) t.plan = { ...t.plan, status: "done" };
        return j;
      };
      if (what === "plan") {
        if (!o.gate.open) return send(res, 200, { gate: o.gate, plan: null, job: null });
        if (!t.plan) t.plan = openingPlan();
        const j = current();
        return send(res, 200, { gate: o.gate, plan: t.plan, job: j ? jobView(j) : null });
      }
      if (what === "say") {
        if (!String(body.text || "").trim()) return send(res, 400, { code: "bad_request", message: "Say something, in this chat." });
        if (!t.plan) return send(res, 409, { code: "no_plan", message: "The plan isn't ready yet." });
        current();
        if (o.sayDelayMs) await new Promise((r) => setTimeout(r, o.sayDelayMs));
        if (o.onSay) o.onSay(String(body.text));
        const was = t.plan;
        let changed = false;
        if (was.status === "proposed" || was.status === "done") { t.plan = revisedPlan(was.status === "done" ? { ...was, status: "proposed" } : was, String(body.text)); changed = true; }
        return send(res, 200, {
          answer: "The total is rounded per item in `src/cart/total.ts:42`, so a cart of many items drifts by a paisa or two.\n\nRounding **once**, at the end, fixes it:\n\n- keep each line unrounded\n- round the sum, half up\n\n```ts\nreturn round(sum(lines))\n```",
          next: [], plan: t.plan, changed,
        });
      }
      if (what === "approve") {
        if (!t.plan || t.plan.v !== Number(body.v)) return send(res, 409, { code: "plan_changed", message: "The plan changed since. Look at the new one first." });
        if (t.plan.status !== "proposed") { const j = jobOf(); return send(res, 200, { plan: t.plan, job: j ? jobView(j) : null }); }
        const running = jobOf();
        const j = running && !["done", "failed", "cancelled"].includes(running.state) ? running : makeJob(project, t.plan.goal);
        t.plan = { ...t.plan, status: "working", jobId: j.id, at: now() };
        return send(res, 200, { plan: t.plan, job: jobView(j) });
      }
      if (what === "work") {
        const j = current();
        if (!j || ["done", "failed", "cancelled"].includes(j.state)) return send(res, 409, { code: "no_work", message: "Nothing is being worked on in this chat right now." });
        j.messages.push(String(body.text));
        if (/\bstop\b/i.test(body.text)) return send(res, 200, { kind: "stop", say: "You want to stop the work. Stop it?", stop: j.id });
        return send(res, 200, { kind: "note", say: "Noted. I'll keep that in mind as I go." });
      }
    }

    if ((k = m(/^\/v1\/code\/jobs\/([^/]+)(\/[a-z-]+)?$/))) {
      const j = jobs.get(k[1]);
      if (!j) return send(res, 404, { code: "not_found", message: "No such job" });
      const what = k[2] || "";
      if (req.method === "GET" && what === "") return send(res, 200, jobView(j));
      if (req.method === "GET" && what === "/log") return send(res, 200, { entries: j.log });
      if (req.method === "POST" && what === "/answer") {
        if (j.state !== "waiting_for_you") return send(res, 409, { code: "not_waiting", message: "It asked nothing." });
        j.answers.push(body.answer);
        const last = [...j.log].reverse().find((e) => e.kind === "question");
        if (last) last.data = { answer: body.answer };
        j.state = "running"; j.waitingOn = null; j.waiting = null; j.reason = ""; j.updatedAt = now();
        schedule(j);
        return send(res, 200, { job: jobView(j).job });
      }
      if (req.method === "POST" && what === "/stop") {
        if (!["done", "failed", "cancelled"].includes(j.state)) {
          j.state = "cancelled"; j.reason = "Stopped by you."; j.waitingOn = null; j.waiting = null; j.updatedAt = now();
          emit(j, { t: "end", why: "stopped" });
          endViewers(j);
        }
        return send(res, 200, { job: jobView(j).job });
      }
      if (req.method === "POST" && what === "/message") { j.messages.push(String(body.text)); return send(res, 200, { delivered: true }); }
      if (req.method === "POST" && what === "/live") {
        if (!o.live || !ws) return send(res, 404, { code: "live_off", message: "The live session is not switched on." });
        const ticket = `tk_${crypto.randomBytes(12).toString("hex")}`;
        tickets.add(ticket);
        return send(res, 200, { url: `${base.replace(/^http/, "ws")}/v1/rooms/${j.id}/watch`, ticket, expiresAt: now() + 120_000 });
      }
    }
    return send(res, 404, { code: "not_found", message: `No route ${req.method} ${p}` });
  }

  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { code: "bad_json", message: "Not JSON" }); }
      const url = new URL(req.url, "http://x");
      calls.push({ method: req.method, path: url.pathname, query: url.search, body, auth: !!req.headers.authorization });
      route(req, res, url, body).catch((err) => send(res, 500, { code: "boom", message: String(err && err.message) }));
    });
  });

  // The live room's watch socket, and the presence socket a computer offered for Xode says hello on.
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/v1/devices/connect") {
      const t = (/^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "") || [])[1];
      if (!ws || !t || !deviceTickets.delete(t)) { socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\n\r\n{\"code\":\"bad_ticket\"}"); return; }
      calls.push({ method: "WS", path: url.pathname, query: "", body: {}, auth: true });
      const conn = ws.acceptWs(req, socket, head);
      const d = { hello: null, frames: [], conn, closed: false };
      devices.push(d);
      conn.on("message", (text) => {
        if (text === "ping") { conn.send("pong"); return; }
        let f = null;
        try { f = JSON.parse(text); } catch { return; }
        d.frames.push(f);
        if (f.t === "hello") { d.hello = f; conn.send(JSON.stringify({ t: "ack", v: 1, deviceId: f.deviceId })); }
      });
      conn.on("close", () => { d.closed = true; });
      conn.on("error", () => { /* closes by itself */ });
      return;
    }
    const k = /^\/v1\/rooms\/([^/]+)\/watch$/.exec(url.pathname);
    const ticket = (/^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "") || [])[1] || url.searchParams.get("ticket");
    const j = k && jobs.get(k[1]);
    if (!ws || !j || !ticket || !tickets.delete(ticket)) { socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\n\r\n{\"code\":\"bad_ticket\"}"); return; }
    calls.push({ method: "WS", path: url.pathname, query: "", body: {}, auth: true });
    const conn = ws.acceptWs(req, socket, head);
    if (!viewers.has(j.id)) viewers.set(j.id, new Set());
    viewers.get(j.id).add(conn);
    conn.on("close", () => { const s = viewers.get(j.id); if (s) s.delete(conn); });
    conn.on("error", () => { /* closes by itself */ });
    conn.send(JSON.stringify({ t: "snapshot", jobId: j.id, session: { state: "open" }, remote: true, ready: true, events: [{ t: "phase", phase: j.phase, at: now() }] }));
  });

  return new Promise((resolve) => {
    server.listen(o.port || 0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        url: base,
        calls,
        tokens,
        jobs,
        devices,
        options: o,
        projectId: PROJECT_ID,
        /** A device token the server accepts, as if a sign-in had been approved. */
        addToken(t, name = "test-box") { tokens.set(t, { id: crypto.randomUUID(), name, platform: "linux", createdAt: now(), lastUsedAt: now() }); },
        close() {
          for (const j of jobs.values()) clearTimeout(j.timer);
          for (const set of viewers.values()) for (const c of set) { try { c.terminate(); } catch { /* gone */ } }
          for (const d of devices) { try { d.conn.terminate(); } catch { /* gone */ } }
          return new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); });
        },
      });
    });
  });
}

module.exports = { createFakeServer, defaultScript, PROJECT_ID };
