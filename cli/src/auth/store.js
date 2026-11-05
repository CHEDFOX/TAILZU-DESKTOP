// Where the sign-in is kept: the keychain on macOS, the secret service on Linux, else a file only you can read.
// XODE_CRED_STORE=file|keychain|secret-tool picks one (tests use "file").

"use strict";

const { createFileStore } = require("./fileStore");
const { createKeychainStore } = require("./keychain");
const { createSecretToolStore } = require("./secretTool");

function createStore(env = process.env) {
  const file = createFileStore(env);
  const all = { file, keychain: createKeychainStore(), "secret-tool": createSecretToolStore(env) };
  const want = String(env.XODE_CRED_STORE || "auto").toLowerCase();
  const preferred = () => {
    if (all[want]) return all[want].available() ? all[want] : file;
    if (process.platform === "darwin" && all.keychain.available()) return all.keychain;
    if (process.platform === "linux" && all["secret-tool"].available()) return all["secret-tool"];
    return file;
  };
  const forcedFile = want === "file";

  return {
    /** The token for this host, or null. */
    async get(host) {
      const main = preferred();
      if (main !== file) {
        const t = await main.get(host).catch(() => null);
        if (t) return t;
      }
      return file.get(host);
    },
    /** Keeps the token; the file is the fallback when the keychain says no. Resolves where it went. */
    async set(host, token) {
      const main = preferred();
      if (main !== file) {
        try {
          await main.set(host, token);
          await file.remove(host).catch(() => false);
          return main.name;
        } catch { /* falls back to the file */ }
      }
      await file.set(host, token);
      return file.name;
    },
    /** Forgets the token everywhere it might be. */
    async remove(host) {
      let any = false;
      if (!forcedFile) {
        for (const s of [all.keychain, all["secret-tool"]]) {
          if (s.available()) any = (await s.remove(host).catch(() => false)) || any;
        }
      }
      return (await file.remove(host)) || any;
    },
    file,
  };
}

module.exports = { createStore };
