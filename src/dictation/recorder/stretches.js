// One stretch after another; and what both capture paths share: what is sent
// to the main process, the account's token, and tearing everything down.
//
// A session's stretches are sent one after another, each once the one
// before it has been answered. Sent together, the short last one came back
// first and was pasted before the words it follows; and each went with the
// context of what had been written when it LEFT, which missed the stretch
// still in flight — so the server shaped it as a new sentence and said no
// space was needed after nothing. In turn, each carries exactly what was
// written before it. Per session: a newer one never waits on an older one.
const queues = new Map();   // session → the previous stretch's turn
function turn(sid) {
  const wait = queues.get(sid) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  queues.set(sid, mine);
  return { wait, done: () => { release(); if (queues.get(sid) === mine) queues.delete(sid); } };
}

/** End this segment and start the next one on the SAME microphone. The
 *  stream is never touched, so there is no permission blink, no device
 *  re-acquire, and no gap where speech would be lost. */
function flushSegment(sid) {
  if (!mediaRecorder || mediaRecorder.state === "inactive") return;
  flushing = true;
  try { mediaRecorder.stop(); } catch { flushing = false; }
}

// `join`: the server's word on a space before `text` (see transcribe).
// `heard`: what the recogniser heard for the stretch (its raw transcript), which
// the main process reads to decide where the words go (routing.js); only the
// written `text` is ever pasted.
function emitSegment(sid, text, join, edges, heard) { window.tailzu.segment({ session: sid, text: text, join: join, edges: edges, heard: heard || "" }); }
function emitResult(sid, text, join, edges, heard) { window.tailzu.result({ session: sid, text: text, join: join, edges: edges, heard: heard || "" }); }
/** A failure. `message` is the sentence the notification shows, and
 *  only ever words for a person; what actually went wrong travels in
 *  `extra.detail` to the main process's log, with the server's `code`
 *  when there was one. */
function emitError(sid, message, extra) {
  window.tailzu.error(Object.assign({ session: sid, message: message }, extra || {}));
}
/** An error as a developer reads it — for the log, never the screen. */
function errText(err) {
  return (err && err.message) ? (err.name ? err.name + ": " : "") + err.message : String(err);
}
function emitPartial(sid, text) { window.tailzu.partial({ session: sid, text: text }); }

function base() { return (cfg.baseUrl || "").replace(/\/+$/, ""); }
/** The account's bearer, and no header at all without one. */
function auth(token) { return token ? { Authorization: "Bearer " + token } : {}; }

/**
 * The token for one request, from the main process, which alone renews it.
 * The one handed over at the start used to serve every stretch, and a
 * dictation that outlived it was refused halfway. `renew`: the server has
 * just refused the one sent, so it is renewed now rather than at its stated
 * expiry.
 */
async function freshToken(renew) {
  try {
    const t = window.tailzu.token ? await window.tailzu.token(!!renew) : null;
    if (typeof t === "string" && t) cfg.token = t;
  } catch { /* the main process did not answer: the one in hand is tried */ }
  return cfg.token;
}

/** A request with the account's token; refused as unauthorised, sent once
 *  more with a renewed one before anything else is concluded. */
async function authorized(send) {
  const res = await send(auth(await freshToken(false)));
  if (res.status !== 401 && res.status !== 403) return res;
  return send(auth(await freshToken(true)));
}
function stopTracks() {
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
}
function forceTeardownAll() {
  stopBands();
  // The meter too: left running, the old one's timer and audio context
  // outlived its session, and its stop could close the new one's.
  stopWatchingLevel();
  flushing = false;
  try {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.ondataavailable = null;
      mediaRecorder.onstop = null;
      mediaRecorder.stop();
    }
  } catch {}
  mediaRecorder = null;
  if (liveRec) { try { liveRec.ondataavailable = liveRec.onstop = null; if (liveRec.state !== "inactive") liveRec.stop(); } catch {} liveRec = null; }
  liveChunks = [];
  teardownLiveGraph();
  if (ws) {
    ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null;
    try { ws.close(); } catch {}
    ws = null;
  }
  live = false;
  clearTimeout(wsWatchdog);
  stopTracks();
}
