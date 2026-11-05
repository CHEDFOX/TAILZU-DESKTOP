#!/usr/bin/env node
// xode: the command line. Reads the arguments, runs the command, exits with its code: 0 when all went well, 1 for an error,
// 2 for a command line it can't use.

"use strict";

const { parseArgs } = require("../src/args");
const { serverUrl, pollMs } = require("../src/config");
const { createStore } = require("../src/auth/store");
const { createOut } = require("../src/ui/out");
const { createInput } = require("../src/ui/input");
const { redact } = require("../src/api/redact");
const pkg = require("../package.json");

const COMMANDS = {
  login: () => require("../src/commands/login").login,
  logout: () => require("../src/commands/logout").logout,
  status: () => require("../src/commands/status").status,
  stop: () => require("../src/commands/stop").stop,
  help: () => require("../src/commands/help").help,
  chat: () => require("../src/commands/chat").chat,
  print: () => require("../src/commands/print").print,
  doctor: () => require("../src/commands/doctor").doctor,
  update: () => require("../src/commands/update").update,
};
// The ones that read the keyboard; the others leave stdin alone (-p reads it as piped text).
const TYPING = new Set(["chat", "login"]);

/** Exits once what was written has gone out. */
function exit(code) {
  process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
}

/** For the commands that ask nothing. */
const NO_INPUT = { interactive: false, ended: true, closed: false, ask: async () => null, pick: async () => null, onInterrupt: () => null, close() {} };

async function main() {
  const env = process.env;
  const out = createOut({ env });
  const args = parseArgs(process.argv.slice(2));
  if (args.error) { out.error(args.error); return 2; }
  if (args.version) { out.line(pkg.version); return 0; }
  let server;
  try { server = serverUrl(env); } catch (err) { out.error(err.message); return 2; }
  const input = TYPING.has(args.command) ? createInput({ env, term: out.term, paint: out.paint }) : NO_INPUT;
  out.attach(input === NO_INPUT ? null : input);
  // However xode ends (SIGTERM included), the terminal is handed back as it was.
  process.on("exit", () => input.close());
  try {
    const run = COMMANDS[args.command]();
    return await run({ server, store: createStore(env), out, input, cwd: process.cwd(), env, args, pollMs: pollMs(env) });
  } finally {
    input.close();
  }
}

main().then(exit, (err) => {
  process.stderr.write(`xode: ${redact(err && err.message ? err.message : String(err))}\n`);
  exit(1);
});
