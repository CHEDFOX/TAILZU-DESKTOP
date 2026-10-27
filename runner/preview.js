// THE PREVIEW: the project's dev server, started on this computer and seen through the room.
//
// docs/desktop-runner-session.md "The preview". The agent's design round wants to look at the app it built. The browser never
// reaches this computer: the room sends each request as an `http` frame over the session's own socket, and this makes it on the
// loopback and sends the answer back in pieces.
//
//   start(m)    runs m.prepare (the install) when there is a package.json and no node_modules, then m.cmd with PORT, HOST=127.0.0.1
//               and BROWSER=none, finds the port it listens on (from what it prints, then the one named, then the one it was told),
//               asks it for / until it answers, and says { ok, port, ms } or { ok: false, error }
//   request(m)  one HTTP request, to 127.0.0.1 or ::1 on that port ONLY: the head, then the body in pieces of at most 192 KB, at most
//               10 MB in all, 50 seconds at most; never a WebSocket upgrade
//   stop()      SIGTERM to the dev server's process group and everything it started, SIGKILL after two seconds
//
// The port detection and the shape of the answers are the reference's (createPreview in the backend's runScript.ts). In a
// container the dev server listens on 0.0.0.0 inside it, and the one chosen port is published on this computer's 127.0.0.1.

"use strict";

const http = require("http");
const net = require("net");
const nodeFs = require("fs");
const nodePath = require("path");
const { redact, lineStreamer } = require("./redact.js");
const { runCommands } = require("./exec.js");

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
const stripAnsi = (text) => String(text).replace(ANSI, "");

const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::(\d{2,5}))?/gi;
const WORD_PORT = /(?:listening|running|started|ready|serving|available|server)[^\n]{0,60}?(?:\bon\b|\bat\b)\s+(?:port\s+)?(?:[\w.[\]:]*:)?(\d{2,5})\b/gi;
const PORT_IS = /\bport\s*(?:is\s*|number\s*)?[:=]?\s*(\d{2,5})\b/gi;
/** A line that names a port it did NOT get ("Port 5173 is in use, trying another one"): that port belongs to somebody else. */
const NOT_OURS = /in use|already|busy|EADDRINUSE|trying another|taken|occupied/i;

/** The ports a dev server's output mentions as its own, in the order it said them (the newest last). */
function detectPorts(text) {
  const found = [];
  const add = (n) => { const p = Number(n); if (p >= 80 && p <= 65535) { const i = found.indexOf(p); if (i >= 0) found.splice(i, 1); found.push(p); } };
  for (const line of stripAnsi(text).split("\n")) {
    if (NOT_OURS.test(line)) continue;
    for (const m of line.matchAll(LOCAL_URL)) if (m[1]) add(m[1]);
    for (const m of line.matchAll(WORD_PORT)) add(m[1]);
    for (const m of line.matchAll(PORT_IS)) add(m[1]);
  }
  return found;
}

function freePort() {
  return new Promise((done) => {
    const s = net.createServer();
    s.on("error", () => done(0));
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => done(p)); });
  });
}

/** One GET / to the port, on 127.0.0.1 and then ::1: the host that answered (any status), or "". */
function probe(port, hosts, timeoutMs = 2000) {
  const one = (host) => new Promise((done) => {
    const req = http.request({ host, port, path: "/", method: "GET", headers: { host: "localhost:" + port, accept: "text/html,*/*" }, agent: false, timeout: timeoutMs }, (res) => { res.destroy(); done(true); });
    req.on("timeout", () => req.destroy());
    req.on("error", () => done(false));
    req.end();
  });
  return (async () => { for (const h of hosts || ["127.0.0.1", "::1"]) if (await one(h)) return h; return ""; })();
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const HEADER_NAME_OK = /^[!#$%&'*+.^_|~0-9A-Za-z-]{1,100}$/;

/**
 * o: {
 *   cwd, env (the command environment), send(frame), known (secrets to redact), procs, spawnCommand,
 *   container (bool: the dev server runs in one), hooks { onStart, onEnd } (for the audit), fs,
 *   limits { resMax, chunk, pending, requestMs, probeEveryMs }  (the doc's numbers; tests make them small)
 * }
 */
function createPreview(o) {
  const L = Object.assign({ resMax: 10 * 1024 * 1024, chunk: 192 * 1024, pending: 32, requestMs: 50000, probeEveryMs: 400, probeMs: 2000, readyMinSec: 5 }, o.limits || {});
  const fs = o.fs || nodeFs;
  const hold = { child: null, id: "", port: 0, host: "127.0.0.1", ready: false, out: "" };
  const inflight = new Map();

  function stop() {
    for (const r of inflight.values()) { try { r.destroy(); } catch { /* gone */ } }
    inflight.clear();
    const c = hold.child;
    if (!c) return false;
    hold.child = null;
    hold.ready = false;
    o.procs.terminate(c, 2000);
    return true;
  }

  const tail = () => { const t = stripAnsi(hold.out).trim().split("\n").slice(-12).join(" | "); return t ? " The end of what it printed: " + redact(t.slice(-700), o.known) : ""; };

  async function start(m) {
    stop();
    const t0 = Date.now();
    const chosen = Number(m.port) > 0 ? Number(m.port) : await freePort();
    const inBox = !!o.container;
    const extraEnv = { PORT: String(chosen), HOST: inBox ? "0.0.0.0" : "127.0.0.1", BROWSER: "none", FORCE_COLOR: "0", NO_COLOR: "1", npm_config_color: "false" };
    const env = Object.assign({}, o.env, extraEnv);
    const stream = lineStreamer((data) => o.send({ t: "out", id: m.id, data }), o.known);
    const timer = setInterval(() => stream.tick(), 100);
    const done = (r) => { clearInterval(timer); stream.flush(); return r; };
    const fail = (error) => done({ ok: false, error: String(error).slice(0, 1900) });

    if (m.prepare && fs.existsSync(nodePath.resolve(o.cwd, "package.json")) && !fs.existsSync(nodePath.resolve(o.cwd, "node_modules"))) {
      const ran = await runCommands([m.prepare], 300, {
        cwd: o.cwd, env: o.env, echo: (x) => stream.write(x), procs: o.procs, spawnCommand: o.spawnCommand,
        onStart: o.hooks && o.hooks.onStart, onEnd: o.hooks && o.hooks.onEnd,
      });
      if (ran.exitCode !== 0) return fail("The install before the dev server failed (exit " + ran.exitCode + ")." + (ran.output ? " The end of what it printed: " + redact(stripAnsi(ran.output).trim().split("\n").slice(-6).join(" | ").slice(-500), o.known) : ""));
    }

    stream.write("$ " + m.cmd + "\n");
    const cmdAt = Date.now();
    if (o.hooks && o.hooks.onStart) o.hooks.onStart({ command: m.cmd, index: 0, preview: true });
    let started;
    try { started = o.spawnCommand(m.cmd, { cwd: o.cwd, env, extraEnv, ports: inBox ? [chosen].concat(Number(m.port) > 0 && Number(m.port) !== chosen ? [Number(m.port)] : []) : [] }); } catch (err) {
      return fail("The dev server could not be started: " + String((err && err.message) || err).slice(0, 200));
    }
    const child = started.child;
    o.procs.track(child, "dev server", started.container);
    hold.child = child;
    hold.id = m.id;
    hold.ready = false;
    hold.out = "";
    let exited = null;
    let was = false;
    child.on("error", () => { exited = exited || { code: 127 }; });
    child.on("exit", (code, signal) => {
      exited = { code, signal };
      o.procs.settle(child);
      if (o.hooks && o.hooks.onEnd) o.hooks.onEnd({ command: m.cmd, index: 0, preview: true, exitCode: code === null ? 128 : code, ms: Date.now() - cmdAt, timedOut: false, cancelled: false });
      if (hold.child === child) {
        hold.child = null;
        hold.ready = false;
        if (was) o.send({ t: "preview-ended", id: m.id, reason: "the dev server exited (" + (code === null ? signal : code) + ")" });
      }
    });
    let streaming = true;
    for (const s of [child.stdout, child.stderr]) {
      if (!s) continue;
      s.setEncoding("utf8");
      s.on("data", (d) => { hold.out = (hold.out + d).slice(-200000); if (streaming) stream.write(d); });
      s.on("error", () => {});
    }

    const deadline = t0 + Math.max(L.readyMinSec, Math.min(180, Number(m.readySec) || 90)) * 1000;
    for (;;) {
      if (exited) return fail("The dev server stopped (exit " + (exited.code === null || exited.code === undefined ? exited.signal : exited.code) + ") before it answered." + tail());
      // The newest port it printed first, then the one that was named, then the one it was told to use.
      const cands = [];
      for (const p of detectPorts(hold.out).reverse()) if (!cands.includes(p)) cands.push(p);
      if (Number(m.port) > 0 && !cands.includes(Number(m.port))) cands.push(Number(m.port));
      if (!cands.includes(chosen)) cands.push(chosen);
      for (const port of cands) {
        const host = await probe(port, inBox ? ["127.0.0.1"] : undefined, L.probeMs);
        if (host) {
          hold.port = port; hold.host = host; hold.ready = true; was = true; streaming = false;
          return done({ ok: true, port, ms: Date.now() - t0 });
        }
      }
      if (Date.now() > deadline) { stop(); return fail("The dev server did not answer within " + Math.round((deadline - t0) / 1000) + " seconds." + tail()); }
      await sleepMs(L.probeEveryMs);
    }
  }

  function request(m) {
    const id = m.id;
    const err = (code, message) => o.send({ t: "res-error", id, code, message });
    if (!hold.ready || !hold.child) return err("unreachable", "no preview is running");
    if (inflight.size >= L.pending) return err("busy", "too many requests at once");
    if (!/^\/(?!\/)[^\s\\]*$/.test(String(m.path))) return err("bad_request", "that is not a path");
    const headers = {};
    for (const pair of Array.isArray(m.headers) ? m.headers : []) {
      const k = String(pair[0]).toLowerCase();
      // Hop-by-hop and framing headers are ours to set; an upgrade is never passed.
      if (k === "host" || k === "content-length" || k === "connection" || k === "transfer-encoding" || k === "accept-encoding" || k === "upgrade" || k === "te" || k === "keep-alive") continue;
      headers[k] = k in headers ? headers[k] + (k === "cookie" ? "; " : ", ") + pair[1] : pair[1];
    }
    headers.host = "localhost:" + hold.port;
    headers["accept-encoding"] = "identity";
    const body = m.body ? Buffer.from(String(m.body), "base64") : null;
    if (body) headers["content-length"] = String(body.length);
    let req;
    const sent = { size: 0, parts: [], len: 0 };
    // Pieces of at most `chunk` bytes however the dev server writes; what is left waits for more or for the end.
    const flush = (last) => {
      let all = Buffer.concat(sent.parts);
      while (all.length >= L.chunk) { o.send({ t: "res-data", id, data: all.subarray(0, L.chunk).toString("base64"), last: false }); all = all.subarray(L.chunk); }
      if (last) { o.send({ t: "res-data", id, data: all.toString("base64"), last: true }); all = Buffer.alloc(0); }
      sent.parts = all.length ? [all] : [];
      sent.len = all.length;
    };
    try {
      req = http.request({ host: hold.host, port: hold.port, method: m.method, path: m.path, headers, agent: false, timeout: L.requestMs, setHost: false }, (res) => {
        const head = [];
        for (let i = 0; i + 1 < res.rawHeaders.length && head.length < 200; i += 2) {
          const k = res.rawHeaders[i];
          // eslint-disable-next-line no-control-regex
          const v = String(res.rawHeaders[i + 1]).replace(/[\u0000-\u0008\u000a-\u001f\u007f]/g, " ").slice(0, 16000);
          if (HEADER_NAME_OK.test(k)) head.push([k, v]);
        }
        o.send({ t: "res", id, status: res.statusCode >= 100 && res.statusCode <= 599 ? res.statusCode : 502, headers: head });
        res.on("data", (chunk) => {
          if (!inflight.has(id)) return;
          sent.size += chunk.length;
          if (sent.size > L.resMax) { inflight.delete(id); req.destroy(); err("too_large", "the response is over " + Math.round(L.resMax / 1048576) + " MB"); return; }
          sent.parts.push(chunk);
          sent.len += chunk.length;
          if (sent.len >= L.chunk) flush(false);
        });
        res.on("end", () => { if (inflight.delete(id)) flush(true); });
        res.on("error", () => { if (inflight.delete(id)) err("failed", "the response broke off"); });
        res.on("aborted", () => { if (inflight.delete(id)) err("failed", "the response broke off"); });
      });
    } catch (e) { return err("bad_request", String((e && e.message) || e).slice(0, 200)); }
    inflight.set(id, req);
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "TIMEOUT" })));
    req.on("error", (e) => {
      if (!inflight.delete(id)) return;
      const code = e && e.code === "TIMEOUT" ? "timeout" : e && /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|EPIPE/.test(String(e.code)) ? "unreachable" : "failed";
      err(code, String((e && e.message) || e).slice(0, 200));
    });
    req.end(body || undefined);
  }

  return {
    start, stop, request,
    cancel(id) { const r = inflight.get(id); if (r) { inflight.delete(id); try { r.destroy(); } catch { /* gone */ } } },
    alive() { return !!hold.child; },
    id() { return hold.id; },
    inflight() { return inflight.size; },
  };
}

module.exports = { createPreview, detectPorts, stripAnsi, freePort, probe };
