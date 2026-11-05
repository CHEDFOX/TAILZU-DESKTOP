// "!" at the start of the prompt: a command of the person's own, run in the project's folder through their shell (they typed
// it at their own terminal, so the shell is theirs to use). Its output is shown dim (the last 200 lines), and what happened
// is kept to go in front of the next message to Xode:
//
//   I ran: npm test
//   exit 1
//   <the last 60 lines of its output>
//
// Esc or Ctrl+C stops it. Nothing is read from the keyboard while it runs (its input is empty).

"use strict";

const { spawn } = require("child_process");
const { redact } = require("../api/redact");

const SHOW = 200;
const SEND = 60;
const KEEP_BYTES = 2 * 1024 * 1024;
// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Text as lines, without terminal escapes or carriage-return redraws, and with any known secret taken out. */
function cleanLines(text) {
  return redact(String(text).replace(ESCAPES, ""))
    .split("\n")
    .map((l) => l.replace(/\r$/, "").split("\r").pop());
}

/**
 * Runs `cmd` in `cwd`. Returns { done, kill() }: done resolves { code, lines, shown, attachment }: code is the exit code (or
 * the signal's name), lines all of its output (tail kept), shown the last 200 lines, attachment the words for Xode.
 */
function runShell(cmd, { cwd, env = process.env, run = spawn } = {}) {
  let text = "";
  let child;
  const keep = (d) => { text += d; if (text.length > KEEP_BYTES) text = text.slice(-KEEP_BYTES); };
  const done = new Promise((resolve) => {
    try {
      child = run(cmd, { cwd, env, shell: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      resolve(result(cmd, 127, `It couldn't start: ${err.message}`));
      return;
    }
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (err) => keep(`It couldn't start: ${err.message}\n`));
    child.on("close", (code, signal) => resolve(result(cmd, code === null ? signal || "stopped" : code, text)));
  });
  return {
    done,
    kill() { if (child && child.exitCode === null) { try { child.kill("SIGTERM"); } catch { /* gone */ } } },
  };
}

function result(cmd, code, text) {
  const lines = cleanLines(text);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const shown = lines.slice(-SHOW);
  const sent = lines.slice(-SEND);
  const attachment = [`I ran: ${redact(cmd)}`, `exit ${code}`, ...sent].join("\n");
  return { code, lines, shown, hidden: lines.length - shown.length, attachment };
}

/** The message with the kept commands in front of it. */
function withAttachments(text, attachments) {
  return attachments.length ? `${attachments.join("\n\n")}\n\n${text}` : text;
}

module.exports = { runShell, withAttachments, cleanLines, SHOW, SEND };
