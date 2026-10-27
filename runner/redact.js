// What a command printed, before it leaves this computer.
//
// The same rules as `redact` and `lineStreamer` in the backend's runScript.ts (the GitHub runner's run.mjs), which is
// the reference for the live session: obvious secrets are replaced by [redacted] BEFORE a line is sent or kept, and the
// lines of a private key are held back from its BEGIN line to its END line, which a pattern on one line cannot do.
// The room scans again; that is a second guard, not the first.

"use strict";

const TAIL_BYTES = 8 * 1024;

const PATTERNS = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, "[redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,255}\b/g, "[redacted]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,255}/g, "[redacted]"],
  [/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
  [/\bxapp-[0-9]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
  [/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "[redacted]"],
  [/(authorization\s*[:=]\s*["']?(?:bearer|basic|token)\s+)[^\s"']+/gi, "$1[redacted]"],
  [/((?:api[_-]?key|apikey|secret(?:[_-]?key)?|client[_-]?secret|auth[_-]?token|access[_-]?token|private[_-]?key|password|passwd|token)["']?\s*[:=]\s*["']?)[A-Za-z0-9_\-+/=.]{8,}/gi, "$1[redacted]"],
];

/** The text with obvious secrets replaced by [redacted]: known patterns, and the exact values in `known` (this app's own tokens). */
function redact(text, known) {
  let out = String(text);
  const values = (known || []).filter((v) => typeof v === "string" && v.length >= 8).sort((a, b) => b.length - a.length);
  for (const v of values) out = out.split(v).join("[redacted]");
  for (const [re, to] of PATTERNS) out = out.replace(re, to);
  return out;
}

/** The last `max` bytes of the text, never starting in the middle of a character. */
function tailOf(text, max) {
  const limit = max === undefined ? TAIL_BYTES : max;
  const buf = Buffer.from(String(text), "utf8");
  if (buf.length <= limit) return String(text);
  let start = buf.length - limit;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start += 1;
  return buf.subarray(start).toString("utf8");
}

/** Values in an environment that look like secrets, so output can be scrubbed of their exact text. */
function secretValues(env) {
  const out = [];
  for (const [name, value] of Object.entries(env || {})) {
    if (typeof value === "string" && value.length >= 8 && /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL)/i.test(name)) out.push(value);
  }
  return out;
}

/**
 * A line-at-a-time stream of what the commands print: complete lines are redacted and sent, a half line waits for its
 * end (or for the flush). Batches go out at 16 KB or when `tick` is called (on a short timer, so a slow command is
 * seen as it goes).
 */
function lineStreamer(send, known) {
  let pending = "";
  let inKey = false;
  const emit = (line) => {
    if (inKey) { if (/-----END [A-Z0-9 ]*PRIVATE KEY/.test(line)) inKey = false; return "[redacted]\n"; }
    if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY/.test(line)) { inKey = true; return "[redacted]\n"; }
    return redact(line, known) + "\n";
  };
  let batch = "";
  const flushBatch = () => { if (batch) { const b = batch; batch = ""; send(b); } };
  return {
    write(chunk) {
      pending += chunk;
      let at;
      while ((at = pending.indexOf("\n")) >= 0) {
        batch += emit(pending.slice(0, at).replace(/\r$/, ""));
        pending = pending.slice(at + 1);
        if (batch.length >= 16 * 1024) flushBatch();
      }
      if (pending.length > 64 * 1024) { batch += emit(pending); pending = ""; }
    },
    /** Sends what is waiting, including a half line. */
    flush() {
      if (pending) { batch += emit(pending).replace(/\n$/, ""); pending = ""; }
      flushBatch();
    },
    /** Sends the complete lines now. */
    tick() { flushBatch(); },
  };
}

/**
 * The cap on how much of a command's output is sent. The first `headBytes` go out as they come; after that nothing is
 * sent, only the last `tailBytes` are kept, and `end()` says how much was left out and sends that tail. So a command
 * that prints a gigabyte costs the room (and this computer's memory) a megabyte and a tail, not a gigabyte.
 */
function cappedSender(send, { headBytes = 1024 * 1024, tailBytes = 16 * 1024 } = {}) {
  let sent = 0;
  let omitted = 0;
  let tail = "";
  return {
    send(data) {
      if (sent < headBytes) {
        const bytes = Buffer.byteLength(data, "utf8");
        const room = headBytes - sent;
        if (bytes <= room) { sent += bytes; send(data); return; }
        // The head fills up inside this batch: what fits, up to the last whole line, goes; the rest is left out.
        const fits = Buffer.from(data, "utf8").subarray(0, room).toString("utf8");
        const cut = fits.lastIndexOf("\n") + 1;
        if (cut > 0) send(data.slice(0, cut));
        sent = headBytes;
        data = data.slice(cut);
      }
      omitted += Buffer.byteLength(data, "utf8");
      tail = tailOf(tail + data, tailBytes);
    },
    /** True once something has been left out. */
    get truncated() { return omitted > 0; },
    get omitted() { return omitted; },
    /** Says what was left out and sends the end of it. */
    end() {
      if (omitted > 0) {
        send("[Tailzu: " + omitted + " bytes of output left out; the last part follows]\n" + tail + (tail.endsWith("\n") ? "" : "\n"));
        omitted = 0; tail = "";
      }
    },
  };
}

module.exports = { redact, tailOf, secretValues, lineStreamer, cappedSender, TAIL_BYTES, PATTERNS };
