// What the person types: questions that wait for an answer, lines typed while nothing asked (a message to the working job),
// and Ctrl+C, handed to whoever is listening for it.
//
// Questions stack: the newest one gets the next line ("Stop the job?" asked over "Your answer:"), the older one waits its turn.

"use strict";

const readline = require("readline");

function createInput({ stdin = process.stdin, stdout = process.stdout } = {}) {
  const interactive = !!stdin.isTTY;
  const rl = readline.createInterface({ input: stdin, output: interactive ? stdout : undefined, terminal: interactive, historySize: interactive ? 100 : 0 });
  const queue = [];
  const asks = [];
  let idle = null;
  let idlePrompt = "";
  let closed = false;
  let shown = false;
  let interrupt = () => { process.exitCode = 130; api.close(); };

  const promptOf = () => (asks.length ? asks[asks.length - 1].prompt : idle ? idlePrompt : "");

  function show() {
    if (!interactive || closed) return;
    const p = promptOf();
    if (!asks.length && !idle) { shown = false; return; }
    rl.setPrompt(p);
    rl.prompt(true);
    shown = true;
  }

  rl.on("line", (line) => {
    const top = asks.pop();
    if (top) { top.resolve(line); show(); return; }
    if (idle) { idle(line); show(); return; }
    queue.push(line);
  });
  rl.on("close", () => {
    closed = true;
    while (asks.length) asks.pop().resolve(null);
  });
  const onSigint = () => interrupt();
  rl.on("SIGINT", onSigint);
  process.on("SIGINT", onSigint);

  const api = {
    interactive,
    get closed() { return closed; },

    /** Waits for the next line, after showing `prompt`. Null when input has ended. The promise has cancel(). */
    ask(prompt) {
      let entry = null;
      const p = new Promise((resolve) => {
        if (queue.length) { if (!interactive && prompt.trim().length > 1) stdout.write(prompt.trimEnd() + "\n"); resolve(queue.shift()); return; }
        if (closed) { resolve(null); return; }
        entry = { prompt, resolve };
        asks.push(entry);
        if (interactive) show();
        else if (prompt.trim().length > 1) stdout.write(prompt.trimEnd() + "\n");
      });
      p.cancel = () => {
        const i = entry ? asks.indexOf(entry) : -1;
        if (i < 0) return;
        asks.splice(i, 1);
        entry.resolve(null);
        if (interactive) { clearLine(); show(); }
      };
      return p;
    },

    /** Lines typed when nothing is asking go to `fn` (null: they wait for the next question). `prompt` shows meanwhile. */
    setIdle(fn, prompt = "") {
      idle = fn;
      idlePrompt = prompt;
      if (fn) while (queue.length && !asks.length) fn(queue.shift());
      if (interactive) { if (fn || asks.length) show(); else if (shown) { clearLine(); shown = false; } }
    },

    /** Ctrl+C calls `fn` from now on. Returns the one it replaces. */
    onInterrupt(fn) { const was = interrupt; interrupt = fn; return was; },

    /** Is a question waiting for its answer? */
    asking: () => asks.length > 0,

    /** Writes a line without breaking the prompt the person may be typing at. */
    print(text, stream = stdout) {
      if (interactive && shown && !closed) {
        clearLine();
        stream.write(text + "\n");
        rl.prompt(true);
      } else {
        stream.write(text + "\n");
      }
    },

    close() {
      process.removeListener("SIGINT", onSigint);
      if (!closed) rl.close();
    },
  };

  function clearLine() {
    readline.clearLine(stdout, 0);
    readline.cursorTo(stdout, 0);
  }

  return api;
}

module.exports = { createInput };
