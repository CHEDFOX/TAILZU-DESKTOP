// PRESENCE: this computer, online for the Code bot, for as long as the socket is open.
//
// docs/desktop-runner-session.md section 3. The app asks the VPS for a ticket (a two-minute, one-use pass), opens
// `wss://<jobs>/v1/devices/connect` with it, says `hello` (who this computer is, whether it may run commands, for which
// projects, whether it is busy), and keeps the socket open. While it is open and quiet it costs the server nothing, and it costs
// this computer one small text frame every 30 seconds - the only heartbeat the protocol asks for.
//
//   keepalive    the plain text `ping` every 30 s (answered `pong` by Cloudflare without waking anything); 90 s with no
//                `pong` and the socket is taken for dead
//   reconnect    a new ticket every time, after 1, 2, 4 ... up to 60 seconds, with a little jitter
//   replaced     another copy of the app took this computer's place: do NOT reconnect on our own
//   live_off     the VPS says the jobs are not on Cloudflare (404 live_off): nothing to do here, look again much later
//   signed_out   no ticket without a person: wait to be started again
//
// Everything outside the socket (the ticket, the clock, the random jitter, the timers) is handed in, so the tests drive all of
// it with a fake server and a fake clock.

"use strict";

const { parseToDevice } = require("./protocol.js");

/**
 * @param {object} o
 *   getTicket()   -> { ok: true, url, ticket } | { ok: false, reason: "signed_out" | "live_off" | "error", message? }
 *   connect(url, { headers }) -> a WsConn (ws.js)
 *   hello()       -> the frame to say first (protocol.helloFrame)
 *   onOffer(offer), onCancel(jobId, epoch), onStatus({ state, ... }), log(line)
 *   timers        { setTimeout, clearTimeout } (default: the real ones)
 *   now, random   (default: Date.now, Math.random)
 */
function createPresence(o) {
  const timers = o.timers || { setTimeout, clearTimeout };
  const now = o.now || Date.now;
  const random = o.random || Math.random;
  const log = o.log || (() => {});
  const pingEveryMs = o.pingEveryMs || 30000;
  const deadAfterMs = o.deadAfterMs || 90000;
  const baseMs = o.baseMs || 1000;
  const maxMs = o.maxMs || 60000;
  const liveOffRetryMs = o.liveOffRetryMs || 15 * 60000;

  let running = false;
  let state = "idle";
  let conn = null;
  let attempts = 0;
  let retryTimer = null;
  let pingTimer = null;
  let probeTimer = null;
  let lastAlive = 0;
  let replaced = false;
  let generation = 0;   // a connection attempt that is no longer wanted finds this changed

  const setState = (s, extra) => {
    state = s;
    try { o.onStatus && o.onStatus(Object.assign({ state: s }, extra || {})); } catch { /* a listener must not stop the socket */ }
  };
  const clearTimers = () => {
    timers.clearTimeout(retryTimer); retryTimer = null;
    timers.clearTimeout(pingTimer); pingTimer = null;
    timers.clearTimeout(probeTimer); probeTimer = null;
  };

  /** 1, 2, 4 ... 60 seconds, plus or minus a fifth. */
  function delayFor(n) {
    const base = Math.min(maxMs, baseMs * 2 ** Math.min(n, 12));
    return Math.round(base * (0.8 + random() * 0.4));
  }
  function retryIn(ms, why, label) {
    if (!running) return;
    timers.clearTimeout(retryTimer);
    setState(label || "backoff", { retryInMs: ms, why });
    retryTimer = timers.setTimeout(() => { retryTimer = null; void attempt(); }, ms);
  }
  function backoff(why, atLeast) {
    const ms = Math.max(delayFor(attempts), atLeast || 0);
    attempts += 1;
    log("presence: " + why + "; trying again in " + Math.round(ms / 1000) + "s");
    retryIn(ms, why);
  }

  /** One try at getting online. Whatever goes wrong inside it is a reason to wait and try again, never an error nobody catches. */
  async function attempt() {
    try { await tryOnce(); } catch (err) {
      if (running) backoff("failed (" + String((err && err.message) || err).slice(0, 100) + ")");
    }
  }

  async function tryOnce() {
    if (!running) return;
    const mine = ++generation;
    setState("connecting");
    let t;
    try { t = await o.getTicket(); } catch (err) { t = { ok: false, reason: "error", message: String((err && err.message) || err) }; }
    if (!running || mine !== generation) return;
    if (!t || !t.ok) {
      const reason = t && t.reason;
      if (reason === "signed_out") { setState("signed_out"); return; }
      if (reason === "live_off") { log("presence: the jobs are not on Cloudflare; the old runner is used"); retryIn(liveOffRetryMs, "live_off", "live_off"); return; }
      backoff("no ticket (" + ((t && t.message) || reason || "unknown") + ")", reason === "too_many" ? 60000 : 0);
      return;
    }
    let c;
    try { c = await o.connect(t.url, { headers: { Authorization: "Bearer " + t.ticket } }); } catch (err) {
      if (!running || mine !== generation) return;
      const status = err && err.status;
      backoff("could not connect (" + (status ? status + " " : "") + ((err && err.code) || (err && err.message) || "failed") + ")", status === 429 ? 60000 : 0);
      return;
    }
    if (!running || mine !== generation) { try { c.close(1000, "no longer wanted"); } catch { /* gone */ } return; }
    conn = c;
    replaced = false;
    lastAlive = now();
    c.on("message", (text) => onMessage(c, text));
    c.on("close", (info) => onClose(c, info));
    c.on("error", (err) => log("presence: socket error " + String((err && err.message) || err)));
    c.send(JSON.stringify(o.hello()));
    // The hello is not answered until the Worker has read it; "online" is the ack.
    schedulePing();
  }

  function onMessage(c, text) {
    if (c !== conn) return;
    lastAlive = now();
    if (text === "pong") return;
    const m = parseToDevice(text);
    if (!m || m.unknown) return;
    switch (m.t) {
      case "ack":
        attempts = 0;
        setState("online");
        break;
      case "offer":
        if (m.bad) { if (m.jobId) decline(m.jobId, m.epoch, "bad_offer"); else log("presence: an offer that could not be read"); break; }
        try { o.onOffer(m.offer); } catch (err) { log("presence: offer handler failed " + String((err && err.message) || err)); }
        break;
      case "cancel":
        if (!m.bad) { try { o.onCancel(m.jobId, m.epoch); } catch { /* the handler's own */ } }
        break;
      case "replaced":
        replaced = true;
        break;
      case "error":
        log("presence: the Worker said " + m.code + (m.message ? " (" + m.message + ")" : ""));
        break;
      default:
    }
  }

  function onClose(c, info) {
    if (c !== conn) return;
    conn = null;
    clearTimers();
    if (!running) return;
    if (replaced || (info && info.code === 4000)) {
      running = false;
      setState("replaced");
      log("presence: another copy of X0 Bot has this computer now; not reconnecting");
      return;
    }
    backoff("the socket closed (" + ((info && info.code) || "?") + ")");
  }

  function schedulePing() {
    timers.clearTimeout(pingTimer);
    pingTimer = timers.setTimeout(() => {
      pingTimer = null;
      if (!conn) return;
      if (now() - lastAlive > deadAfterMs) { log("presence: no pong for " + Math.round((now() - lastAlive) / 1000) + "s; the socket is dead"); const c = conn; try { c.terminate(); } catch { /* gone */ } onClose(c, { code: 1006 }); return; }
      conn.send("ping");
      schedulePing();
    }, pingEveryMs);
  }

  function decline(jobId, epoch, reason) {
    if (conn) conn.send(JSON.stringify({ t: "decline", jobId, epoch, ...(reason ? { reason: String(reason).slice(0, 200) } : {}) }));
  }

  return {
    /** Starts keeping this computer online. Safe to call again. */
    start() {
      if (running) return;
      running = true;
      replaced = false;
      attempts = 0;
      void attempt();
    },
    /** Leaves politely and stays off. */
    stop() {
      running = false;
      generation += 1;
      clearTimers();
      const c = conn;
      conn = null;
      if (c) { try { c.send(JSON.stringify({ t: "bye" })); c.close(1000, "bye"); } catch { /* gone */ } }
      setState("idle");
    },
    /** `state` frame: any of allowRun, busy, name, projects. Nothing is sent when offline: the next hello says it all. */
    sendState(partial) {
      if (conn && state === "online") conn.send(JSON.stringify({ t: "state", ...partial }));
    },
    decline,
    /** After a sleep: is the socket still alive? Asks, and gives it ten seconds; or reconnects at once if it was waiting. */
    nudge() {
      if (!running) return;
      if (state === "backoff") { timers.clearTimeout(retryTimer); retryTimer = null; attempts = 0; void attempt(); return; }
      if (!conn) return;
      const c = conn;
      const before = lastAlive;
      c.send("ping");
      timers.clearTimeout(probeTimer);
      probeTimer = timers.setTimeout(() => {
        probeTimer = null;
        if (c === conn && lastAlive === before) { log("presence: no answer after waking; reconnecting"); try { c.terminate(); } catch { /* gone */ } onClose(c, { code: 1006 }); }
      }, 10000);
    },
    get state() { return state; },
    get online() { return state === "online"; },
    get connected() { return !!conn; },
  };
}

module.exports = { createPresence };
