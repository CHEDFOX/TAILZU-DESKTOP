// The sign-in kept in the macOS keychain, under the service "xode" and the server's host.
//
// The token never goes on a command line (where `ps` would show it): `security -i` reads its command from stdin.

"use strict";

const { spawn } = require("child_process");
const fs = require("fs");

const SECURITY = "/usr/bin/security";
// What a token may be made of, so it can be quoted safely in the command `security -i` reads.
const SAFE = /^[A-Za-z0-9._~+/=-]{8,4096}$/;
const SAFE_HOST = /^[A-Za-z0-9.:[\]-]{1,255}$/;

/** Runs `security` with `args`, feeding `input`; resolves { code, out }. */
function run(args, input, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try { child = spawn(SECURITY, args, { stdio: ["pipe", "pipe", "ignore"] }); } catch { resolve({ code: -1, out: "" }); return; }
    const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", () => { clearTimeout(t); resolve({ code: -1, out: "" }); });
    child.on("close", (code) => { clearTimeout(t); resolve({ code, out }); });
    child.stdin.on("error", () => { /* it went away */ });
    child.stdin.end(input || "");
  });
}

function createKeychainStore() {
  return {
    name: "keychain",
    available: () => process.platform === "darwin" && fs.existsSync(SECURITY),
    async get(host) {
      if (!SAFE_HOST.test(host)) return null;
      const r = await run(["find-generic-password", "-s", "xode", "-a", host, "-w"]);
      const t = r.out.trim();
      return r.code === 0 && t ? t : null;
    },
    async set(host, token) {
      if (!SAFE.test(token) || !SAFE_HOST.test(host)) throw new Error("That sign-in can't be kept in the keychain.");
      const r = await run(["-i"], `add-generic-password -U -s xode -l xode -a "${host}" -w "${token}"\nquit\n`);
      // Interactive mode may end well even when its command did not: read it back to be sure.
      if (r.code !== 0 || (await this.get(host)) !== token) throw new Error("The keychain didn't take the sign-in.");
    },
    async remove(host) {
      if (!SAFE_HOST.test(host)) return false;
      const r = await run(["delete-generic-password", "-s", "xode", "-a", host]);
      return r.code === 0;
    },
  };
}

module.exports = { createKeychainStore };
