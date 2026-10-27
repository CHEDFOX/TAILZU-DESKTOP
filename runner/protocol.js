// The words of the live session, as this app speaks them.
//
// The backend's tulmi/src/code/live/protocol.ts is the authority and
// docs/desktop-runner-session.md the prose; this is the app's half, in plain
// JavaScript: the frames it sends, and the checks it makes on the frames it is
// sent. A frame that is not understood is answered with an error and ignored,
// as the doc says: one bad frame never closes a socket.
//
// Nothing here touches a network or a disk.

"use strict";

/** The one command of a session step. A mark, not a program: it is never given to a shell. */
const SESSION_COMMAND = "tailzu:live-session";
const isSessionCommands = (commands) => Array.isArray(commands) && commands.length === 1 && commands[0] === SESSION_COMMAND;

const ID = /^[A-Za-z0-9._:/@-]{1,200}$/;
const DEVICE_ID = /^[A-Za-z0-9._:-]{8,100}$/;
const isId = (v) => typeof v === "string" && ID.test(v);
const isDeviceId = (v) => typeof v === "string" && DEVICE_ID.test(v);

const str = (v, max) => typeof v === "string" && v.length <= max;
const bool = (v) => typeof v === "boolean";
const int = (v, min, max) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
// eslint-disable-next-line no-control-regex
const HEADER_VALUE_BAD = /[\u0000-\u0008\u000a-\u001f\u007f]/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
// eslint-disable-next-line no-control-regex
const PATH_BAD = /[\u0000- \u007f\\]/;

/** A path for the dev server: root-relative, no spaces, control characters or backslashes, not a scheme-relative `//host`. */
const isPreviewPath = (v) => typeof v === "string" && v.length >= 1 && v.length <= 4000 && v.startsWith("/") && !v.startsWith("//") && !PATH_BAD.test(v);

function pairsOf(v, max) {
  if (!Array.isArray(v) || v.length > max) return null;
  const out = [];
  for (const p of v) {
    if (!Array.isArray(p) || p.length !== 2) return null;
    const [k, val] = p;
    if (typeof k !== "string" || !HEADER_NAME.test(k) || typeof val !== "string" || val.length > 16 * 1024 || HEADER_VALUE_BAD.test(val)) return null;
    out.push([k, val]);
  }
  return out;
}

function overlayOf(v) {
  if (!Array.isArray(v) || v.length > 200) return null;
  const out = [];
  for (const f of v) {
    if (!isObj(f) || !str(f.path, 500) || !f.path || (f.content !== null && typeof f.content !== "string")) return null;
    out.push({ path: f.path, content: f.content });
  }
  return out;
}

/** The JSON of a text frame, if it is an object with a `t`. */
function json(raw, maxChars) {
  if (typeof raw !== "string" || raw.length > maxChars) return null;
  try {
    const v = JSON.parse(raw);
    return isObj(v) && typeof v.t === "string" ? v : null;
  } catch { return null; }
}

const CLOSE_REASONS = ["idle", "cap", "needs_you", "job_end", "superseded", "expired", "error"];

/**
 * A frame the room sent, checked. `null` for one that does not parse or has no `t`; `{ t, bad: true, id? }` for a
 * known type with a field of the wrong kind (answer it with an error, ignore it); `{ t, unknown: true }` for a type
 * this app does not know (ignore it: a newer room may say more than this app understands).
 */
function parseToRunner(raw) {
  const m = json(raw, 4 * 1024 * 1024);
  if (!m) return null;
  const bad = () => ({ t: m.t, bad: true, ...(isId(m.id) ? { id: m.id } : {}) });
  switch (m.t) {
    case "ready":
      return str(m.jobId, 100) && int(m.idleSec, 1, 86400) && int(m.maxSec, 1, 86400) ? { t: "ready", v: 1, jobId: m.jobId, idleSec: m.idleSec, maxSec: m.maxSec } : bad();
    case "exec": {
      if (!isId(m.id) || !Array.isArray(m.commands) || !m.commands.length || m.commands.length > 20 || !m.commands.every((c) => str(c, 2000) && c.trim())) return bad();
      const overlay = overlayOf(m.overlay === undefined ? [] : m.overlay);
      if (!int(m.timeoutSec, 1, 3600) || !overlay) return bad();
      return { t: "exec", id: m.id, commands: m.commands, timeoutSec: m.timeoutSec, overlay, discard: true };
    }
    case "cancel":
      return isId(m.id) ? { t: "cancel", id: m.id } : bad();
    case "grep":
      return isId(m.id) && str(m.pattern, 1000) ? {
        t: "grep", id: m.id, pattern: m.pattern, ...(str(m.path, 500) ? { path: m.path } : {}), ...(str(m.glob, 200) ? { glob: m.glob } : {}),
        ...(bool(m.ignoreCase) ? { ignoreCase: m.ignoreCase } : {}), ...(int(m.context, 0, 5) ? { context: m.context } : {}),
        ...(bool(m.filesOnly) ? { filesOnly: m.filesOnly } : {}), ...(int(m.maxResults, 1, 500) ? { maxResults: m.maxResults } : {}),
      } : bad();
    case "glob":
      return isId(m.id) && str(m.pattern, 200) ? { t: "glob", id: m.id, pattern: m.pattern } : bad();
    case "preview": {
      const overlay = overlayOf(m.overlay === undefined ? [] : m.overlay);
      if (!isId(m.id) || !str(m.cmd, 2000) || !m.cmd.trim() || !int(m.readySec, 5, 180) || !int(m.idleSec, 5, 3600) || !overlay) return bad();
      if (m.port !== undefined && !int(m.port, 1, 65535)) return bad();
      if (m.prepare !== undefined && !str(m.prepare, 2000)) return bad();
      return { t: "preview", id: m.id, cmd: m.cmd, ...(m.port !== undefined ? { port: m.port } : {}), ...(m.prepare ? { prepare: m.prepare } : {}), readySec: m.readySec, idleSec: m.idleSec, overlay };
    }
    case "preview-stop":
      return { t: "preview-stop", ...(str(m.reason, 100) ? { reason: m.reason } : {}) };
    case "http": {
      const headers = pairsOf(m.headers, 100);
      if (!isId(m.id) || typeof m.method !== "string" || !HTTP_METHODS.has(m.method) || !isPreviewPath(m.path) || !headers) return bad();
      if (m.body !== undefined && (!str(m.body, 1500000) || !/^[A-Za-z0-9+/]*={0,2}$/.test(m.body))) return bad();
      return { t: "http", id: m.id, method: m.method, path: m.path, headers, ...(m.body ? { body: m.body } : {}) };
    }
    case "http-cancel":
      return isId(m.id) ? { t: "http-cancel", id: m.id } : bad();
    case "ping":
      return { t: "ping", at: typeof m.at === "number" ? m.at : 0 };
    case "close":
      return { t: "close", reason: CLOSE_REASONS.includes(String(m.reason)) ? m.reason : "error", ...(str(m.message, 300) ? { message: m.message } : {}) };
    default:
      return { t: m.t, unknown: true };
  }
}

/** A frame the presence socket received: ack, offer, cancel, replaced, error. Same conventions as parseToRunner. */
function parseToDevice(raw) {
  const m = json(raw, 4 * 1024 * 1024);
  if (!m) return null;
  switch (m.t) {
    case "ack": return { t: "ack", v: 1, deviceId: str(m.deviceId, 100) ? m.deviceId : "" };
    case "offer": { const offer = parseOffer(m.offer); return offer ? { t: "offer", offer } : { t: "offer", bad: true, jobId: isObj(m.offer) && str(m.offer.jobId, 64) ? m.offer.jobId : "", epoch: isObj(m.offer) && int(m.offer.epoch, 0, Number.MAX_SAFE_INTEGER) ? m.offer.epoch : 0 }; }
    case "cancel": return str(m.jobId, 100) && int(m.epoch, 0, Number.MAX_SAFE_INTEGER) ? { t: "cancel", jobId: m.jobId, epoch: m.epoch } : { t: "cancel", bad: true };
    case "replaced": return { t: "replaced" };
    case "error": return { t: "error", code: str(m.code, 60) ? m.code : "error", message: str(m.message, 1000) ? m.message : "" };
    default: return { t: m.t, unknown: true };
  }
}

/** An offer, checked down to the fields this app uses; null when it cannot be run. */
function parseOffer(o) {
  if (!isObj(o) || !str(o.jobId, 64) || !o.jobId || !int(o.stepIdx, 0, 1e9) || !int(o.epoch, 0, Number.MAX_SAFE_INTEGER)) return null;
  if (!Array.isArray(o.commands) || o.commands.length > 100 || !o.commands.every((c) => typeof c === "string" && c.length <= 20000)) return null;
  if (typeof o.timeoutSec !== "number" || !Number.isFinite(o.timeoutSec) || o.timeoutSec <= 0) return null;
  const r = o.repo;
  if (!isObj(r) || (r.kind !== "app" && r.kind !== "oauth") || !str(r.cloneUrl, 2000) || !str(r.branch, 300) || !str(r.headSha, 64)) return null;
  const overlay = o.overlay === undefined ? [] : overlayOf(o.overlay);
  if (!overlay) return null;
  let session;
  if (o.session !== undefined) {
    const s = o.session;
    if (!isObj(s) || !str(s.url, 2000) || !str(s.ticket, 4000) || typeof s.expiresAt !== "number" || !Number.isFinite(s.expiresAt)) return null;
    session = {
      url: s.url, ticket: s.ticket, expiresAt: s.expiresAt,
      idleSec: typeof s.idleSec === "number" && s.idleSec > 0 ? Math.min(86400, s.idleSec) : 120,
      maxSec: typeof s.maxSec === "number" && s.maxSec > 0 ? Math.min(86400, s.maxSec) : 1200,
    };
  }
  return {
    jobId: o.jobId, stepIdx: o.stepIdx, epoch: o.epoch, commands: o.commands, timeoutSec: Math.min(3600, Math.max(1, Math.round(o.timeoutSec))),
    repo: {
      kind: r.kind, cloneUrl: r.cloneUrl, branch: r.branch, headSha: r.headSha,
      ...(str(r.readToken, 4000) && r.readToken ? { readToken: r.readToken } : {}),
      ...(typeof r.readTokenExpiresAt === "number" ? { readTokenExpiresAt: r.readTokenExpiresAt } : {}),
      ...(str(r.tarballUrl, 4000) && r.tarballUrl ? { tarballUrl: r.tarballUrl } : {}),
    },
    overlay, discard: o.discard === true, ...(session ? { session } : {}),
  };
}

/** The `hello` of the presence socket. */
function helloFrame({ deviceId, name, allowRun, projects, busy, app }) {
  return {
    t: "hello", v: 1, deviceId, name: String(name || "This computer").slice(0, 80), allowRun: !!allowRun,
    projects: projects === "all" ? "all" : (Array.isArray(projects) ? projects.slice(0, 200) : []), busy: !!busy,
    ...(app ? { app: String(app).slice(0, 60) } : {}),
  };
}

module.exports = {
  SESSION_COMMAND, isSessionCommands, isId, isDeviceId, isPreviewPath, parseToRunner, parseToDevice, parseOffer, helloFrame,
  CLOSE_REASONS, HTTP_METHODS,
};
