// The command line: a command (login, logout, status, stop, help), or words to send Xode, and the flags.

"use strict";

const COMMANDS = new Set(["login", "logout", "status", "stop", "help", "chat"]);

/** { command, message, project, fresh, noRunner, help, version } or { error }. */
function parseArgs(argv) {
  const out = { command: "chat", message: "", project: "", fresh: false, noRunner: false, help: false, version: false };
  const words = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--") { words.push(...argv.slice(i + 1)); break; }
    if (a === "--project" || a === "-p") {
      const v = argv[i + 1];
      if (!v || v.startsWith("-")) return { error: "--project needs a project id." };
      out.project = v;
      i += 1;
    } else if (a.startsWith("--project=")) out.project = a.slice("--project=".length);
    else if (a === "--new") out.fresh = true;
    else if (a === "--no-runner") out.noRunner = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--version" || a === "-v") out.version = true;
    else if (a.startsWith("-") && a.length > 1) return { error: `Unknown option ${a}. Try xode --help.` };
    else words.push(a);
  }
  if (words.length && COMMANDS.has(words[0]) && !argv.includes("--")) {
    out.command = words[0];
    if (out.command !== "chat" && words.length > 1) return { error: `xode ${out.command} takes no words after it.` };
    if (out.command === "chat") out.message = words.slice(1).join(" ").trim();
  } else {
    out.message = words.join(" ").trim();
  }
  if (out.help) out.command = "help";
  return out;
}

module.exports = { parseArgs };
