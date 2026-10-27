// THE RUNNER SESSION: this computer's half of the conversation with a job's room.
//
// docs/desktop-runner-session.md section 5; the reference is `runSession` in the backend's runScript.ts (what GitHub's computers
// run), and this does what it does. Connect to the room with the one-time ticket from the offer, say hello, then do what the room
// sends, ONE THING AT A TIME:
//
//   exec         refuse what the guard rails refuse (all of it, before any of it runs); reset the checkout to the branch; lay the
//                staged edits; run the commands in order with a time limit each; stream what they print a line at a time, secrets
//                replaced; say `done` with the exit code
//   cancel       kill that command's process group; `done` 130
//   grep, glob   only for a repository too big for the room's copy: git grep and git ls-files, never a secret file
//   preview ...  the project's dev server, and the HTTP the room sends it (preview.js)
//   ping         pong
//   close        leave (1000), kill everything that is still running
//
// It also leaves when the room has been silent for `idleSec` plus a 90 s grace BETWEEN commands (the room's own alarm should
// have closed it), when the socket drops, when told to stop, and at the latest a couple of minutes after the session's time is
// used up. Whatever it leaves behind is killed: the commands, the dev server, the containers.
//
// What it resolves with - { exitCode, reason, commands } - is what the caller reports to the server: exit code 0 for an end the room
// asked for, 1 for a socket that dropped or a stop.

"use strict";

const { parseToRunner } = require("./protocol.js");
const { lineStreamer, cappedSender } = require("./redact.js");
const { layOverlay, overlayPathOk } = require("./overlay.js");
const { runCommands, firstRefusal } = require("./exec.js");
const { createPreview } = require("./preview.js");
const { gitGrep, gitGlob } = require("./search.js");

/** The room's address with the one-time ticket in the query (the reference's sessionAddress). */
function sessionAddress(session) {
  return session.url + (session.url.indexOf("?") >= 0 ? "&" : "?") + "ticket=" + encodeURIComponent(session.ticket);
}

const OUT_PIECE = 128 * 1024;

/**
 * o: {
 *   session: { url, ticket, idleSec, maxSec }, dir (the workspace), connect(url) -> WsConn,
 *   git, procs, spawnCommand, env (the command environment), guard (options for checkCommand), known (secrets to redact),
 *   name (this computer's), hooks { onStart, onEnd, onRefused, onEvent }, container (bool),
 *   graceMs (the room's silence beyond idleSec; 90 s), caps { headBytes, tailBytes }, previewLimits,
 *   timers { setTimeout, clearTimeout }, fs, platform, nodeVersion, now
 * }
 */
function createSession(o) {
  const timers = o.timers || { setTimeout, clearTimeout };
  const now = o.now || Date.now;
  const graceMs = o.graceMs === undefined ? 90000 : o.graceMs;
  const hooks = o.hooks || {};
  const laid = new Set();
  let ws = null;
  let busy = null;
  let commands = 0;
  let last = now();
  let ended = false;
  let wantStop = null;
  let idleSec = Math.max(1, Number(o.session.idleSec) || 120);
  let hardStopAt = now() + (Math.max(1, Number(o.session.maxSec) || 1200) + 120) * 1000;
  let previewIdleSec = 0;
  let timer = null;
  let finish;
  const over = new Promise((r) => { finish = r; });

  const send = (obj) => { try { if (ws && ws.readyState === "open") ws.send(JSON.stringify(obj)); } catch { /* the socket is going */ } };
  const sendOut = (id, data) => { for (let i = 0; i < data.length; i += OUT_PIECE) send({ t: "out", id, data: data.slice(i, i + OUT_PIECE) }); };

  const preview = createPreview({
    cwd: o.dir, env: o.env, send, known: o.known, procs: o.procs, spawnCommand: o.spawnCommand, container: o.container, fs: o.fs,
    hooks: { onStart: (e) => hooks.onStart && hooks.onStart(e), onEnd: (e) => hooks.onEnd && hooks.onEnd(e) }, limits: o.previewLimits,
  });

  // ---- the silence rule: only between commands, longer while a preview is open ----
  function silentLimitMs() {
    const base = idleSec * 1000 + graceMs;
    return preview.alive() ? Math.max(base, previewIdleSec * 1000 + graceMs) : base;
  }
  function arm() {
    timers.clearTimeout(timer);
    if (ended) return;
    const t = now();
    const toHard = hardStopAt - t;
    const toSilent = busy ? silentLimitMs() : last + silentLimitMs() - t;
    timer = timers.setTimeout(check, Math.max(10, Math.min(toHard, toSilent)));
    if (timer && timer.unref) timer.unref();
  }
  function check() {
    timer = null;
    if (ended) return;
    if (now() >= hardStopAt) { end(0, "the session's time was used up"); closeSocket(); return; }
    if (!busy && now() - last >= silentLimitMs()) { end(0, "the room was silent"); closeSocket(); return; }
    arm();
  }
  const closeSocket = (code = 1000, why = "done") => { try { if (ws) ws.close(code, why); } catch { /* gone */ } };

  function end(exitCode, reason) {
    if (ended) return;
    ended = true;
    timers.clearTimeout(timer);
    // Whatever is still running is stopped: the command in flight, the dev server, any background process, any container.
    if (busy) { try { busy.abort.abort(); } catch { /* aborted */ } }
    preview.stop();
    o.procs.killAll();
    finish({ exitCode, reason, commands });
  }

  // ---- exec ----
  async function doExec(m) {
    const t0 = now();
    const abort = new AbortController();
    busy = { id: m.id, abort };
    const capped = cappedSender((data) => sendOut(m.id, data), o.caps);
    const stream = lineStreamer((data) => capped.send(data), o.known);
    const ticker = setInterval(() => stream.tick(), 100);
    try {
      // Every command is read before any is run: a refusal at the third must not leave the first two half done.
      const refused = firstRefusal(m.commands, o.guard);
      if (refused) {
        const text = "[Tailzu: not run on this computer: " + refused.message + "]\n";
        send({ t: "out", id: m.id, data: "$ " + refused.command + "\n" + text });
        if (hooks.onRefused) hooks.onRefused({ command: refused.command, rule: refused.rule, message: refused.message, index: refused.index });
        commands += 1;
        send({ t: "done", id: m.id, exitCode: 126, ms: now() - t0, note: ("refused (" + refused.rule + "): " + refused.message).slice(0, 500) });
        return;
      }
      // The dev server runs on the branch plus the staged edits; a command takes the checkout back.
      if (preview.alive()) { const pid = preview.id(); preview.stop(); send({ t: "preview-ended", id: pid, reason: "a command took the checkout" }); }
      const lay = await layOverlay(o.dir, m.overlay, laid, o.git, o.fs);
      if (lay.skipped.length) stream.write("[Tailzu: could not lay " + lay.skipped.slice(0, 5).join(", ") + "]\n");
      const ran = await runCommands(m.commands, m.timeoutSec > 0 ? m.timeoutSec : 600, {
        cwd: o.dir, env: o.env, echo: (x) => stream.write(x), signal: abort.signal, procs: o.procs, spawnCommand: o.spawnCommand,
        onStart: hooks.onStart, onEnd: hooks.onEnd,
      });
      clearInterval(ticker);
      stream.flush();
      capped.end();
      commands += 1;
      send({ t: "done", id: m.id, exitCode: ran.exitCode, ms: now() - t0, timedOut: ran.exitCode === 124 && ran.timedOut });
    } catch (err) {
      send({ t: "error", id: m.id, code: "failed", message: String((err && err.message) || err).slice(0, 300) });
    } finally {
      clearInterval(ticker);
      busy = null;
      last = now();
      arm();
    }
  }

  // ---- preview ----
  async function doPreview(m) {
    busy = { id: m.id, abort: new AbortController() };
    try {
      const refused = firstRefusal([m.cmd].concat(m.prepare ? [m.prepare] : []), o.guard);
      if (refused) {
        if (hooks.onRefused) hooks.onRefused({ command: refused.command, rule: refused.rule, message: refused.message, index: refused.index });
        send({ t: "preview", id: m.id, ok: false, error: ("Not started on this computer: " + refused.message).slice(0, 1900) });
        return;
      }
      // The dev server runs on the branch plus the staged edits, like a command does.
      await layOverlay(o.dir, m.overlay, laid, o.git, o.fs);
      previewIdleSec = Number(m.idleSec) > 0 ? Number(m.idleSec) : 300;
      const r = await preview.start(m);
      send(Object.assign({ t: "preview", id: m.id }, r));
    } catch (err) {
      send({ t: "preview", id: m.id, ok: false, error: String((err && err.message) || err).slice(0, 300) });
    } finally {
      busy = null;
      last = now();
      arm();
    }
  }

  // ---- search ----
  async function doSearch(m) {
    busy = { id: m.id, abort: new AbortController() };
    try {
      const r = m.t === "grep" ? await gitGrep(m, o.dir, o.git) : await gitGlob(m, o.dir, o.git, o.fs);
      send(Object.assign({ t: "found", id: m.id }, r));
    } catch (err) {
      send({ t: "found", id: m.id, ok: false, error: String((err && err.message) || err).slice(0, 300) });
    } finally {
      busy = null;
      last = now();
      arm();
    }
  }

  function onMessage(text) {
    last = now();
    const m = parseToRunner(text);
    if (!m || m.unknown) return;
    if (m.bad) {
      if (m.id) send({ t: "error", id: m.id, code: "bad_message", message: "That " + m.t + " was not understood." });
      return;
    }
    switch (m.t) {
      case "ready":
        idleSec = m.idleSec;
        hardStopAt = Math.min(hardStopAt, now() + (m.maxSec + 120) * 1000);
        arm();
        return;
      case "ping": send({ t: "pong", at: m.at || 0 }); return;
      case "close": end(0, String(m.reason || "closed")); closeSocket(1000, "done"); return;
      case "cancel": if (busy && busy.id === m.id) busy.abort.abort(); return;
      // The preview: the dev server runs in the background, and the room sends it HTTP, several requests at once.
      case "http": preview.request(m); return;
      case "http-cancel": preview.cancel(m.id); return;
      case "preview-stop": { const id = preview.id(); if (preview.stop()) send({ t: "preview-ended", id, reason: String(m.reason || "stopped").slice(0, 100) }); return; }
      case "preview":
        if (busy) { send({ t: "preview", id: m.id, ok: false, error: "A command is running on the computer; the dev server could not be started." }); return; }
        void doPreview(m);
        return;
      case "grep":
      case "glob":
        if (busy) { send({ t: "error", id: m.id, code: "busy", message: "a command is already running" }); return; }
        void doSearch(m);
        return;
      case "exec":
        if (busy) { send({ t: "error", id: m.id, code: "busy", message: "a command is already running" }); return; }
        void doExec(m);
        return;
      default:
    }
  }

  return {
    /** Connects and runs until the session is over. */
    async run() {
      if (wantStop !== null) { end(1, String(wantStop)); return over; }
      try {
        ws = await o.connect(sessionAddress(o.session));
      } catch (err) {
        end(1, "could not open the socket: " + String((err && (err.code || err.message)) || err).slice(0, 100));
        return over;
      }
      if (ended || wantStop !== null) {
        // Stopped while connecting.
        try { ws.send(JSON.stringify({ t: "bye", reason: String(wantStop || "stopped").slice(0, 200) })); ws.close(1000, "stopped"); } catch { /* gone */ }
        end(1, String(wantStop || "stopped"));
        return over;
      }
      ws.on("message", onMessage);
      ws.on("error", () => { /* the close that follows says it */ });
      ws.on("close", (info) => {
        const code = info && info.code;
        end(ended ? 0 : code === 1000 || code === 1005 ? 0 : 1, "closed");
      });
      send({ t: "hello", v: 1, kind: "desktop", name: String(o.name || "This computer").slice(0, 80), os: String(o.platform || process.platform).slice(0, 40), node: String(o.nodeVersion || process.version).slice(0, 40) });
      arm();
      return over;
    },
    /** The person said stop, or the app is going: tell the room, kill everything, leave. */
    stop(reason = "stopped on this computer") {
      if (ended) return;
      wantStop = reason;
      if (ws) {
        send({ t: "bye", reason: String(reason).slice(0, 200) });
        end(1, String(reason));
        closeSocket(1000, "stopped");
      }
    },
    /** What the window shows. */
    status() { return { commands, busy: !!busy, preview: preview.alive(), ended }; },
    get commands() { return commands; },
    overlayPathOk,
  };
}

module.exports = { createSession, sessionAddress };
