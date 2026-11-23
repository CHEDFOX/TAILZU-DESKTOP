// THE SIGN-IN ON DISK: session.json, sealed with the system's own key store when there is one.
//
// The file holds the account's Supabase tokens, the refresh token among them (long-lived). Where Electron's safeStorage can encrypt
// (the macOS Keychain, Windows DPAPI, a Linux keyring), the file is the encrypted bytes and nothing else; anything running as the
// person that reads the file gets ciphertext. Where it cannot (Linux without a keyring, or the "basic_text" store that only hides the
// text), the file is the JSON as before, 0600.
//
// A file an older build wrote is JSON (its first byte is "{"): it is read as it is, and sealed the next time it is written, which
// main.js does as soon as the app is ready. safeStorage works only after `ready`, so a sealed file read before then is "locked":
// read again once ready.

"use strict";

const OPEN_BRACE = 0x7b;

/**
 * o: {
 *   fs            node's fs (or a fake)
 *   file          the session file's path
 *   safeStorage   Electron's (may be missing: then the plain file)
 *   isReady()     whether the app has emitted `ready` (safeStorage needs it)
 *   platform      process.platform
 * }
 */
function createSessionFile(o) {
  const fs = o.fs;
  const file = o.file;
  const platform = o.platform || process.platform;
  let kind = "none";   // what is on disk: "none", "plain", "sealed"

  /** Can the session be sealed (and a sealed one opened) right now? */
  function canSeal() {
    const ss = o.safeStorage;
    try {
      if (!ss || !o.isReady()) return false;
      if (!ss.isEncryptionAvailable()) return false;
      // On Linux the "basic_text" store encrypts with a fixed password: no better than the 0600 file, and a keyring set up later
      // could not open it. The plain file stays there.
      if (platform === "linux" && typeof ss.getSelectedStorageBackend === "function" && ss.getSelectedStorageBackend() === "basic_text") return false;
      return true;
    } catch { return false; }
  }

  /** The session, or null (none, unreadable, or sealed and not openable yet: see locked()). */
  function load() {
    let raw;
    try { raw = fs.readFileSync(file); } catch { kind = "none"; return null; }
    if (!raw || !raw.length) { kind = "none"; return null; }
    let i = 0;
    while (i < raw.length && (raw[i] === 0x20 || raw[i] === 0x0a || raw[i] === 0x0d || raw[i] === 0x09)) i += 1;
    if (raw[i] === OPEN_BRACE) {
      kind = "plain";
      try { return JSON.parse(raw.toString("utf8")); } catch { return null; }
    }
    kind = "sealed";
    if (!canSeal()) return null;
    try { return JSON.parse(o.safeStorage.decryptString(Buffer.from(raw))); } catch { return null; }
  }

  /** Keeps the session (sealed when it can be), or removes the file for null. */
  function save(v) {
    try {
      if (v) {
        const text = JSON.stringify(v, null, 2);
        const sealed = canSeal();
        const body = sealed ? o.safeStorage.encryptString(text) : text;
        fs.mkdirSync(require("path").dirname(file), { recursive: true });
        fs.writeFileSync(file, body, { mode: 0o600 });
        // `mode` only applies to a file being created; one an older build wrote keeps whatever it had, so it is narrowed every time.
        try { fs.chmodSync(file, 0o600); } catch { /* Windows: no modes */ }
        kind = sealed ? "sealed" : "plain";
      } else if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        kind = "none";
      }
    } catch { /* a session that will not persist still works for this run */ }
  }

  return {
    load,
    save,
    canSeal,
    /** A sealed file that could not be opened yet (before `ready`). */
    locked: () => kind === "sealed" && !canSeal(),
    /** The file on disk is plain JSON (an older build's, or no key store here). */
    plain: () => kind === "plain",
  };
}

module.exports = { createSessionFile };
