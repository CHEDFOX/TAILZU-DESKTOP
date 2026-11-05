// Talks to the server: JSON in and out, the device token as a Bearer header, and errors in words a person can act on.

"use strict";

const { redact, addSecret } = require("./redact");
const pkg = require("../../package.json");

/** A request the server refused, or one that never got there. `code` is the server's own (or "unreachable", "timeout", "signed_out"). */
class ApiError extends Error {
  constructor(message, { status = 0, code = "error", body = null } = {}) {
    super(redact(message));
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/**
 * A client for one server. `token` is the device token (or null when signed out).
 * request(method, path, body?, { signal, timeoutMs }) resolves the JSON answer, or rejects an ApiError.
 */
function createClient({ server, token = null, fetchImpl = globalThis.fetch, timeoutMs = 60_000 } = {}) {
  if (token) addSecret(token);
  const host = new URL(server).host;

  async function request(method, path, body, o = {}) {
    const ctl = new AbortController();
    const outer = o.signal;
    const onAbort = () => ctl.abort();
    if (outer) { if (outer.aborted) ctl.abort(); else outer.addEventListener("abort", onAbort, { once: true }); }
    const timer = setTimeout(() => ctl.abort(new Error("timeout")), o.timeoutMs || timeoutMs);
    const headers = { Accept: "application/json", "User-Agent": `xode/${pkg.version} (${process.platform})` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token && o.auth !== false) headers.Authorization = `Bearer ${token}`;
    let res;
    try {
      res = await fetchImpl(server + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
    } catch (err) {
      if (outer && outer.aborted) throw new ApiError("Cancelled.", { code: "cancelled" });
      if (ctl.signal.aborted) throw new ApiError(`${host} took too long to answer.`, { code: "timeout" });
      throw new ApiError(`Couldn't reach ${host}. Check your connection and try again.`, { code: "unreachable" });
    } finally {
      clearTimeout(timer);
      if (outer) outer.removeEventListener("abort", onAbort);
    }
    let text = "";
    try { text = await res.text(); } catch { /* an empty answer */ }
    let json = null;
    try { json = text ? JSON.parse(text) : {}; } catch { json = null; }
    if (res.ok) {
      if (json === null) throw new ApiError(`${host} sent an answer xode can't read.`, { status: res.status, code: "bad_answer" });
      return json;
    }
    throw errorOf(res.status, json || {}, { host, signedIn: !!token });
  }

  return {
    server,
    host,
    signedIn: !!token,
    request,
    get: (path, o) => request("GET", path, undefined, o),
    post: (path, body = {}, o) => request("POST", path, body, o),
  };
}

/** A refusal in words. */
function errorOf(status, body, { host, signedIn }) {
  const code = typeof body.code === "string" ? body.code : "";
  const said = typeof body.message === "string" ? body.message : "";
  if (status === 401) {
    return new ApiError(signedIn ? "Signed out: run xode to sign in again." : "Not signed in: run xode", { status, code: "signed_out", body });
  }
  if (status === 403 && code === "device_scope") {
    return new ApiError("This sign-in only works for Xode, and that request was for something else.", { status, code, body });
  }
  if (status === 429) return new ApiError(said || "Too many requests just now. Wait a moment and try again.", { status, code: code || "rate_limited", body });
  if (status >= 500 && !said) return new ApiError(`${host} had a problem (${status}). Try again in a moment.`, { status, code: code || "server_error", body });
  return new ApiError(said || `${host} said no (${status}).`, { status, code: code || "error", body });
}

module.exports = { createClient, ApiError };
