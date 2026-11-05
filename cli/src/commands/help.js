// xode --help: the few ways in, and the keys inside. Fits 60 columns.

"use strict";

const TEXT = `xode: Xode in your terminal.

  xode                start in this project's folder
  xode "fix the cart" start with that message
  xode -p "question"  answer once and exit (pipe text in)
  xode doctor         check your setup

Inside: / for commands, ! to run a shell command,
@ to name a file, Esc to stop, Ctrl+C twice to exit.

Also: xode update, --new (a fresh chat), --no-runner.`;

async function help({ out }) {
  out.line(TEXT);
  return 0;
}

module.exports = { help, TEXT };
