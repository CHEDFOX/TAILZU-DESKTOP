// The sign-in kept in the desktop's secret service on Linux (GNOME Keyring, KWallet), through `secret-tool`.
// The token goes in on stdin, never on the command line.

"use strict";

const { spawn } = require("child_process");
const { which } = require("../util/which");

/** Runs secret-tool; resolves { code, out }. A secret service that never answers (no desktop session) is given up on. */
function run(bin, args, input, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try { child = spawn(bin, args, { stdio: ["pipe", "pipe", "ignore"] }); } catch { resolve({ code: -1, out: "" }); return; }
    const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", () => { clearTimeout(t); resolve({ code: -1, out: "" }); });
    child.on("close", (code) => { clearTimeout(t); resolve({ code, out }); });
    child.stdin.on("error", () => { /* it went away */ });
    child.stdin.end(input || "");
  });
}

function createSecretToolStore(env = process.env) {
  const bin = () => which("secret-tool", env);
  return {
    name: "secret-tool",
    available: () => process.platform === "linux" && !!bin(),
    async get(host) {
      const r = await run(bin(), ["lookup", "service", "xode", "account", host]);
      const t = r.out.trim();
      return r.code === 0 && t ? t : null;
    },
    async set(host, token) {
      const r = await run(bin(), ["store", "--label=xode", "service", "xode", "account", host], token);
      if (r.code !== 0) throw new Error("The secret service didn't take the sign-in.");
    },
    async remove(host) {
      const r = await run(bin(), ["clear", "service", "xode", "account", host]);
      return r.code === 0;
    },
  };
}

module.exports = { createSecretToolStore };
