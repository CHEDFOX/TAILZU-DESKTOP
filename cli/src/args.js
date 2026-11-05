// The command line: words to start the session with, -p for one answer, a command (doctor, update, and the older login,
// logout, status, stop, help), and the flags.

"use strict";

const COMMANDS = new Set(["login", "logout", "status", "stop", "help", "chat", "doctor", "update"]);

/** { command, message, project, fresh, noRunner, help, version } or { error }. command "print" for -p. */
function parseArgs(argv) {
  const out = { command: "chat", message: "", project: "", fresh: false, noRunner: false, help: false, version: false, print: false };
  const words = [];
  let forced = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--") { words.push(...argv.slice(i + 1)); forced = true; break; }
    if (a === "--project") {
      const v = argv[i + 1];
      if (!v || v.startsWith("-")) return { error: "--project needs a project id." };
      out.project = v;
      i += 1;
    } else if (a.startsWith("--project=")) out.project = a.slice("--project=".length);
    else if (a === "-p" || a === "--print") out.print = true;
    else if (a === "--new") out.fresh = true;
    else if (a === "--no-runner") out.noRunner = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--version" || a === "-v") out.version = true;
    else if (a.startsWith("-") && a.length > 1) return { error: `Unknown option ${a}. Try xode --help.` };
    else words.push(a);
  }
  if (out.help) { out.command = "help"; return out; }
  if (out.print) {
    out.command = "print";
    out.message = words.join(" ").trim();
    return out;
  }
  if (words.length && COMMANDS.has(words[0]) && !forced) {
    out.command = words[0];
    if (out.command !== "chat" && words.length > 1) return { error: `xode ${out.command} takes no words after it.` };
    if (out.command === "chat") out.message = words.slice(1).join(" ").trim();
  } else {
    out.message = words.join(" ").trim();
  }
  return out;
}

module.exports = { parseArgs };
