// Watching a job live: the room's WebSocket (POST /v1/code/jobs/:id/live -> { url, ticket }, then wss://.../v1/rooms/<id>/watch).
// The room sends JSON frames: snapshot, phase, tool, result, out, cost, session, said, end, team, error
// (tulmi/src/code/live/protocol.ts ViewerEvent). Where there is no live room, the caller polls instead.
//
// The socket: the dependency-free client this package carries (../net/ws.js, a copy of the desktop runner's, which sends the
// ticket as a header), else the platform's WebSocket (the ticket goes in the address), else none.

"use strict";

const path = require("path");
const { addSecret } = require("../api/redact");

function loadDesktopWs() {
  try { return require(path.join(__dirname, "..", "net", "ws.js")); } catch { return null; }
}

/** Opens a socket to `url` with `ticket`. Resolves { send, close, on(event, fn) } with events "message" (text) and "close". */
async function connect(url, ticket) {
  const desk = loadDesktopWs();
  if (desk && typeof desk.connectWs === "function") {
    const conn = await desk.connectWs(url, { headers: { Authorization: `Bearer ${ticket}` }, timeoutMs: 10_000 });
    return {
      send: (t) => conn.send(t),
      close: () => { try { conn.close(1000, "bye"); } catch { /* closed */ } },
      on: (ev, fn) => conn.on(ev === "close" ? "close" : ev, fn),
    };
  }
  if (typeof globalThis.WebSocket === "function") {
    const u = new URL(url);
    u.searchParams.set("ticket", ticket);
    const ws = new globalThis.WebSocket(u.toString());
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("The live view didn't open.")), { once: true });
    });
    return {
      send: (t) => ws.send(t),
      close: () => { try { ws.close(1000, "bye"); } catch { /* closed */ } },
      on: (ev, fn) => ws.addEventListener(ev, ev === "message" ? (e) => fn(typeof e.data === "string" ? e.data : "") : () => fn()),
    };
  }
  return null;
}

/**
 * Watches job `jobId`: onEvent(frame) for each frame, onClose() once when it ends. Resolves a handle { close() }, or null when
 * the server has no live room for it (or no socket could be opened): then the caller polls.
 */
async function watchJob(jobs, jobId, { onEvent, onClose }) {
  let pass;
  try { pass = await jobs.live(jobId); } catch { return null; }
  if (!pass || typeof pass.url !== "string" || typeof pass.ticket !== "string") return null;
  addSecret(pass.ticket);
  let sock;
  try { sock = await connect(pass.url, pass.ticket); } catch { return null; }
  if (!sock) return null;
  let open = true;
  sock.on("message", (text) => {
    let frame = null;
    try { frame = JSON.parse(String(text)); } catch { return; }
    if (frame && typeof frame.t === "string") onEvent(frame);
  });
  sock.on("close", () => { if (open) { open = false; onClose(); } });
  return {
    get open() { return open; },
    close() { if (open) { open = false; sock.close(); } },
  };
}

module.exports = { watchJob };
