// The commands typed at the prompt after "/": what there is, and which one a line asks for. "/" alone lists them.

"use strict";

const COMMANDS = [
  { name: "help", words: "this list" },
  { name: "clear", also: ["new"], words: "a fresh chat for this folder (or /new)" },
  { name: "plan", words: "the plan, to start it" },
  { name: "diff", words: "what the last work branch changed" },
  { name: "status", words: "who, where, this computer, the job here" },
  { name: "stop", words: "stop the job here" },
  { name: "login", words: "sign in again" },
  { name: "logout", words: "sign out" },
  { name: "exit", also: ["quit"], words: "leave (or /quit)" },
];
// Kept working, not listed: approve the plan as it stands.
const HIDDEN = ["approve"];

/** Every name Tab can complete, with its "/". */
const NAMES = COMMANDS.flatMap((c) => [c.name, ...(c.also || [])]).map((n) => "/" + n);

/** { name } of the command `text` asks for (its main name), { list: true } for "/" alone, or { unknown }. */
function parseSlash(text) {
  const word = String(text).trim().slice(1).split(/\s+/)[0].toLowerCase();
  if (!word) return { list: true };
  const c = COMMANDS.find((x) => x.name === word || (x.also || []).includes(word));
  if (c) return { name: c.name };
  if (HIDDEN.includes(word)) return { name: word };
  return { unknown: word };
}

/** The list, for /help and "/". */
function helpLines(paint) {
  const lines = COMMANDS.map((c) => `  ${paint.cyan(("/" + c.name).padEnd(9))} ${c.words}`);
  lines.push(paint.dim("  ! runs a shell command · @ names a file"));
  lines.push(paint.dim("  Esc stops the job · Ctrl+C twice exits"));
  return lines;
}

module.exports = { COMMANDS, NAMES, parseSlash, helpLines };
