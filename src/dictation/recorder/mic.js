// The microphone, and the words a failure is said in: the server's sentences
// with the built-in ones under them.

// A server-drawn sentence, handed over with the session. Falls back to
// the built-in wording when a launch never reached the backend.
const STRING_FALLBACKS = {
  micBlockedMac: "microphone blocked — System Settings → Privacy & Security → Microphone → X0 Bot",
  micBlockedWindows: "microphone blocked — Settings → Privacy & security → Microphone → let desktop apps access",
  micMissing: "no microphone found — plug one in, then try again",
  micBusy: "microphone is in use by another app",
  noSpeech: "no speech detected — check your microphone",
};
function str(key) {
  const v = cfg.strings && cfg.strings[key];
  return (typeof v === "string" && v.trim()) ? v : STRING_FALLBACKS[key];
}

function micMessage(err) {
  const m = (err && err.message) ? err.message : String(err);
  // A sentence getMic already wrote is passed through as it is.
  // Compared against the resolved strings rather than a prefix, so
  // server-drawn copy in any wording still matches.
  for (const k of ["micBlockedMac", "micBlockedWindows", "micMissing", "micBusy"]) {
    if (m === str(k)) return m;
  }
  // Anything else is a failure we cannot name, and the browser's words
  // for it ("AbortError: Could not start audio source") are not for
  // people. The notification says the mic did not start; the caller
  // sends the error itself to the log.
  return K.txt("desktop.recorder.micError", "Couldn't start the microphone. Try again.");
}

/**
 * A refused upload, worded by what the server said. It used to be the
 * status and the raw body ("HTTP 429 {code: quota_exceeded, …}") in the
 * notification. The words are the phones' (labels error.*), so one edit
 * on the server changes every surface; the word cap's own sentence is
 * already written for people (the number, the reset date, the way out)
 * and is shown.
 */
function httpMessage(status, body) {
  let j = null;
  try { j = JSON.parse(body); } catch { j = null; }
  if (j && j.code === "quota_exceeded") {
    return (typeof j.message === "string" && j.message.trim())
      ? j.message.trim() : K.txt("error.quota", "You've used this month's free words.");
  }
  if (status === 401 || status === 403) return K.txt("error.unauthorized", "Your session has expired. Sign in again to continue.");
  if (status === 429) return K.txt("error.rateLimited", "Too many requests. Wait a moment, then try again.");
  if (status >= 500) return K.txt("error.server", "Something went wrong on our side. Try again in a moment.");
  return K.txt("error.generic", "Something went wrong. Try again.");
}

async function getMic() {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: K.obj("desktop.mic.constraints", { echoCancellation: true, noiseSuppression: true, autoGainControl: true }),
    });
  } catch (err) {
    // THERE IS NO PERMISSION SCREEN HERE, AND THERE SHOULD NOT BE.
    //
    // Electron already grants the microphone to its own page (main.js
    // setPermissionRequestHandler), so an in-app step would have nothing
    // to ask. The gate that is left belongs to the operating system, and
    // no screen we draw can open it — only a sentence that says which
    // settings panel to go to. Chromium's own wording ("Permission
    // denied by system") names the problem and not the fix.
    // The sentences come with the session (cfg.strings), so the panel
    // this names can be corrected from the backend — Microsoft moves
    // that menu between Windows releases, and a wrong direction baked
    // into an installer is a wrong direction forever.
    const name = (err && err.name) || "";
    const mac = navigator.platform.indexOf("Mac") === 0;
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new Error(str(mac ? "micBlockedMac" : "micBlockedWindows"));
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      throw new Error(str("micMissing"));
    }
    if (name === "NotReadableError") {
      throw new Error(str("micBusy"));
    }
    throw err;
  }
}
