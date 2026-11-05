// Signing in with the phone: ask the server for a code, then wait while the person approves it in X0 Bot.
//
//   POST /v1/auth/link       { kind: "cli", deviceName, platform } -> { token, secret, code, url, expiresAt, ttlMs, pollMs, deviceUrl, deviceUrlWithCode }
//   POST /v1/auth/link/poll  { token, secret, wait }                 -> { status } or { status: "approved", deviceToken, deviceId }

"use strict";

const os = require("os");
const { addSecret } = require("../api/redact");
const { sleep } = require("../util/sleep");

const WAIT_MS = 25_000;

/** process.platform in the words the server keeps. */
function platformName(p = process.platform) {
  return p === "darwin" ? "macos" : p === "win32" ? "windows" : p;
}

/** Asks for a sign-in code. */
async function startLink(client, o = {}) {
  const r = await client.post("/v1/auth/link", {
    kind: "cli",
    deviceName: (o.deviceName || os.hostname() || "This computer").slice(0, 80),
    platform: platformName(o.platform),
  }, { signal: o.signal, auth: false });
  if (typeof r.token !== "string" || typeof r.secret !== "string" || typeof r.code !== "string") {
    throw new Error("The server's answer to the sign-in was not what xode expected.");
  }
  addSecret(r.token);
  addSecret(r.secret);
  return r;
}

/** When the code runs out, in milliseconds since 1970. */
function deadlineOf(link, now = Date.now()) {
  const at = typeof link.expiresAt === "number" ? link.expiresAt : Date.parse(link.expiresAt || "");
  if (Number.isFinite(at) && at > 0) return at;
  return now + (Number(link.ttlMs) > 0 ? Number(link.ttlMs) : 10 * 60_000);
}

/**
 * Waits for the person's answer. Resolves { status: "approved", deviceToken, deviceId } or { status: "denied" | "expired" | "used" | "failed" }.
 * Rejects only when the server can't be reached for a while, or `signal` aborts.
 */
async function waitForApproval(client, link, o = {}) {
  const deadline = deadlineOf(link);
  const pause = Math.max(50, Number(link.pollMs) || 1500);
  let misses = 0;
  for (;;) {
    if (o.signal && o.signal.aborted) throw Object.assign(new Error("Cancelled."), { code: "cancelled" });
    if (Date.now() > deadline + 5000) return { status: "expired" };
    let r;
    try {
      r = await client.post("/v1/auth/link/poll", { token: link.token, secret: link.secret, wait: WAIT_MS }, { signal: o.signal, timeoutMs: WAIT_MS + 15_000, auth: false });
      misses = 0;
    } catch (err) {
      if (err.code === "cancelled") throw err;
      // A dropped connection or a slow answer: try again a few times before giving up.
      if (++misses > 5 || err.status === 400 || err.status === 404) throw err;
      await sleep(Math.min(8000, pause * 2 ** misses), o.signal);
      continue;
    }
    const status = r && typeof r.status === "string" ? r.status : "failed";
    if (status === "approved") {
      if (typeof r.deviceToken !== "string" || !r.deviceToken) return { status: "failed" };
      addSecret(r.deviceToken);
      return { status, deviceToken: r.deviceToken, deviceId: r.deviceId || null };
    }
    if (status !== "pending") return { status: ["denied", "expired", "used", "failed"].includes(status) ? status : "failed" };
    await sleep(pause, o.signal);
  }
}

module.exports = { startLink, waitForApproval, platformName, deadlineOf };
