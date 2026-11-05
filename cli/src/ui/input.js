// What the person types, and the bottom of the screen.
//
// Three ways in, picked once at the start:
//   keys + screen  a terminal: keys read one by one (keys.js), and the bottom of the screen redrawn in place (screen.js): the
//                  status line while Xode works, the line being typed (or a picker, or a question's line), a hint under it
//   keys           keys read one by one, but what is printed goes out as plain lines (output piped; XODE_KEYS=1 in tests)
//   lines          a pipe: one line at a time (Ctrl+C arrives as SIGINT)
//
// At the prompt ("> "), Enter sends; a line ending in "\" or Ctrl+J goes on to a new line; a paste is one message; Up and
// Down go through what was typed in this folder before (history.js); Tab completes a command or an @file (complete.js).
// Ctrl+C clears what is typed; on an empty line, and Ctrl+D likewise, and Esc anywhere, go to whoever is in charge
// (onInterrupt): the session decides what they mean (twoPress.js).
//
// Questions stack over the prompt: a picker (picker.js) or a line of its own (ask). Lines sent while nothing reads them wait
// for the next read.

"use strict";

const readline = require("readline");
const { createKeys } = require("./keys");
const { createScreen } = require("./screen");
const { createEditor } = require("./editor");
const { pickerLines, pickerKey, typedPick } = require("./picker");
const { visible } = require("./paint");

const PRINTABLE = /^[^\x00-\x1f\x7f]+$/;

/** o: { stdin, stdout, stderr, env, term, paint } */
function createInput({ stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, env = process.env, term, paint }) {
  const keysMode = !!stdin.isTTY || env.XODE_KEYS === "1";
  const screenMode = keysMode && !!(term && term.tty);
  const width = () => Number(env.COLUMNS) || stdout.columns || 80;
  const screen = screenMode ? createScreen({ stdout, width }) : null;

  const base = { kind: "prompt", editor: createEditor(), hist: null, histAt: null, draft: "" };
  const modes = [];
  const queue = [];
  let waiter = null;
  let promptOn = false;
  let statusFn = null;
  let hintText = "";
  let hintTimer = null;
  let history = null;
  let completer = null;
  let ended = false;
  let closed = false;
  let control = (kind) => { if (kind === "ctrl-c") { process.exitCode = 130; api.close(); } };

  const top = () => (modes.length ? modes[modes.length - 1] : promptOn ? base : null);

  // ------------------------------------------------------------------ drawing

  function render() {
    if (!screen || closed) return;
    const lines = [];
    let at = null;
    const s = statusFn ? statusFn() : null;
    if (s) lines.push(s);
    const m = top();
    if (m && m.editor) {
      const pre = m.kind === "prompt" ? paint.dim(">") + " " : m.prompt;
      const pad = " ".repeat(visible(pre));
      const w = m.editor.where();
      const first = lines.length;
      m.editor.text.split("\n").forEach((l, i) => lines.push((i === 0 ? pre : pad) + l));
      at = { line: first + w.line, col: visible(pre) + w.col };
    } else if (m && m.kind === "pick") {
      lines.push(...pickerLines({ title: m.title, options: m.options, at: m.at, paint, width: width() }));
    }
    if (hintText) lines.push(paint.dim(hintText));
    screen.set(lines, at);
  }

  function print(text, stream = stdout) {
    if (screen && !closed) screen.print(text, stream);
    else stream.write(text + "\n");
  }

  /** What was sent, kept above the prompt as it was typed. */
  function echo(prefix, text) {
    const pad = " ".repeat(visible(prefix));
    print(text.split("\n").map((l, i) => (i === 0 ? prefix : pad) + l).join("\n"));
  }

  // ------------------------------------------------------------------ the prompt's lines

  function deliver(text) {
    if (waiter) { const w = waiter; waiter = null; w({ type: "line", text }); return; }
    queue.push(text);
  }

  function fireControl(kind) {
    try { control(kind); } catch { /* the handler says its own errors */ }
  }

  function submit(m) {
    const e = m.editor;
    const text = e.text;
    if (m.kind === "prompt") {
      // A "\" at the end: the message goes on, on the next line.
      if (/\\$/.test(text) && e.pos === text.length) { e.set(text.slice(0, -1) + "\n"); render(); return; }
      if (!text.trim()) return;
      echo(paint.dim(">") + " ", text);
      e.clear();
      m.histAt = null;
      if (history) history.add(text);
      deliver(text);
      render();
      return;
    }
    echo(m.prompt, text);
    finish(m, text);
  }

  // ------------------------------------------------------------------ questions over the prompt

  function finish(m, value) {
    const i = modes.indexOf(m);
    if (i < 0) return;
    modes.splice(i, 1);
    m.resolve(value);
    render();
  }

  function choose(m, index) {
    if (screen) {
      print(m.title.split("\n").map((l) => paint.bold(l)).join("\n"));
    }
    print("  " + paint.cyan(`❯ ${m.options[index]}`));
    finish(m, index);
  }

  /** A line typed in lines mode, for whatever waits. */
  function takeLine(line) {
    const m = modes[modes.length - 1];
    if (m) { answerTyped(m, line); return; }
    deliver(line);
  }

  function answerTyped(m, line) {
    if (m.kind === "ask") { finish(m, line); return; }
    const i = typedPick(line, m.options);
    if (i >= 0) { print("  " + `❯ ${m.options[i]}`); finish(m, i); return; }
    if (m.freeText && line.trim()) { finish(m, line.trim()); return; }
    print(paint.dim(`Type a number from 1 to ${m.options.length}.`));
  }

  // ------------------------------------------------------------------ keys

  let pendingReturn = null;

  function onKey(k) {
    if (closed) return;
    // A return followed at once by more keys was pasted (a terminal that doesn't mark pastes): it is a new line, not a send.
    if (pendingReturn && k.name !== "return") {
      const m = pendingReturn;
      pendingReturn = null;
      if (m.editor && top() === m) m.editor.insert("\n");
    }
    const m = top();
    if (k.ctrl && k.name === "c") {
      if (m && m.kind === "pick") { choose(m, m.options.length - 1); return; }
      if (m && m.editor && !m.editor.empty) { m.editor.clear(); m.histAt = null; render(); return; }
      fireControl("ctrl-c");
      return;
    }
    if (k.ctrl && k.name === "d") {
      if (m && m.editor && !m.editor.empty) { m.editor.del(); render(); return; }
      if (m && m.kind === "pick") return;
      fireControl("ctrl-d");
      return;
    }
    if (k.name === "escape") {
      if (m && m.kind === "pick") { choose(m, m.options.length - 1); return; }
      if (m && m.kind === "ask" && m.escCancels) { finish(m, null); return; }
      fireControl("esc");
      return;
    }
    if (k.ctrl && k.name === "z" && keys && keys.raw) { suspend(); return; }
    if (k.ctrl && k.name === "l" && screen) { stdout.write("\x1b[2J\x1b[H"); screen.clear(); render(); return; }
    if (!m) return;
    if (m.kind === "pick") {
      const r = pickerKey(k, { at: m.at, count: m.options.length });
      if (!r) return;
      if (r.pick !== undefined) choose(m, r.pick);
      else { m.at = r.at; render(); }
      return;
    }
    editKey(m, k);
  }

  function editKey(m, k) {
    const e = m.editor;
    const n = k.name;
    if (n === "return" && !k.meta) {
      if (m.kind !== "prompt") { submit(m); return; }
      pendingReturn = m;
      setImmediate(() => { if (pendingReturn === m) { pendingReturn = null; submit(m); } });
      return;
    }
    if (n === "enter" || (n === "return" && k.meta)) e.insert("\n");
    else if (n === "paste") e.insert(String(k.text).replace(/\r\n?/g, "\n").replace(/\t/g, "  "));
    else if (n === "backspace") { if (k.meta) e.killWord(); else e.backspace(); }
    else if (n === "delete") e.del();
    else if (n === "left" || (k.ctrl && n === "b")) { if (k.ctrl && n === "left") e.wordLeft(); else e.left(); }
    else if (n === "right" || (k.ctrl && n === "f")) { if (k.ctrl && n === "right") e.wordRight(); else e.right(); }
    else if (k.meta && n === "b") e.wordLeft();
    else if (k.meta && n === "f") e.wordRight();
    else if (n === "home" || (k.ctrl && n === "a")) e.home();
    else if (n === "end" || (k.ctrl && n === "e")) e.end();
    else if (k.ctrl && n === "u") e.killLeft();
    else if (k.ctrl && n === "k") e.killRight();
    else if (k.ctrl && n === "w") e.killWord();
    else if (n === "up" || (k.ctrl && n === "p")) { if (!e.up() && m.kind === "prompt") historyStep(m, -1); }
    else if (n === "down" || (k.ctrl && n === "n")) { if (!e.down() && m.kind === "prompt") historyStep(m, 1); }
    else if (n === "tab") { if (m.kind === "prompt") complete(m); return; }
    else if (!k.ctrl && !k.meta && PRINTABLE.test(k.sequence || "")) e.insert(k.sequence);
    else return;
    render();
  }

  function historyStep(m, dir) {
    if (!history) return;
    const list = m.histAt === null ? history.list() : m.hist;
    if (!list.length) return;
    if (m.histAt === null) {
      if (dir > 0) return;
      m.hist = list;
      m.draft = m.editor.text;
      m.histAt = list.length;
    }
    const next = m.histAt + dir;
    if (next < 0) return;
    if (next >= list.length) { m.histAt = null; m.editor.set(m.draft); return; }
    m.histAt = next;
    m.editor.set(list[next]);
  }

  async function complete(m) {
    if (!completer) return;
    const e = m.editor;
    const was = e.text;
    let r = null;
    try { r = await completer(e.text, e.pos); } catch { return; }
    if (!r || e.text !== was || closed) return;
    e.set(r.text, r.pos);
    if (r.options.length) print(paint.dim(r.options.join("  ")));
    render();
  }

  function suspend() {
    if (screen) screen.clear();
    keys.pause();
    process.once("SIGCONT", () => { keys.resume(); render(); });
    process.kill(process.pid, "SIGTSTP");
  }

  // ------------------------------------------------------------------ the streams

  let keys = null;
  let rl = null;
  const onEnd = () => {
    ended = true;
    while (modes.length) { const m = modes.pop(); m.resolve(null); }
    if (waiter) { const w = waiter; waiter = null; w({ type: "end" }); }
  };
  if (keysMode) {
    keys = createKeys({ stdin, stdout, onKey });
    stdin.on("end", onEnd);
    if (screen && stdout.on) stdout.on("resize", render);
  } else {
    rl = readline.createInterface({ input: stdin, terminal: false });
    rl.on("line", takeLine);
    rl.on("close", onEnd);
  }
  const onSigint = () => fireControl("ctrl-c");
  process.on("SIGINT", onSigint);

  const api = {
    /** Keys are read one by one (a person at a terminal, or XODE_KEYS=1). */
    interactive: keysMode,
    /** The bottom of the screen is redrawn in place. */
    screen: screenMode,
    get closed() { return closed; },
    /** No more input will come (the pipe ended). */
    get ended() { return ended; },

    print,
    render,

    /** Shows the prompt ("> ") from now on, or hides it. */
    showPrompt(on) { promptOn = !!on; render(); },
    /** The next message sent at the prompt: { type: "line", text }, or { type: "end" } once input has ended. */
    next() {
      if (queue.length) return Promise.resolve({ type: "line", text: queue.shift() });
      if (ended || closed) return Promise.resolve({ type: "end" });
      return new Promise((resolve) => { waiter = resolve; });
    },
    /** Takes back a next() still waiting: it resolves { type: "none" }. */
    stopWaiting() { if (waiter) { const w = waiter; waiter = null; w({ type: "none" }); } },

    /** A line of its own, after `prompt`. Resolves the text, or null (input ended, cancelled). o.escCancels: Esc gives null. */
    ask(prompt, o = {}) {
      let m = null;
      const p = new Promise((resolve) => {
        if (!keysMode && queue.length) { const line = queue.shift(); if (prompt.trim().length > 1) print(prompt.trimEnd()); resolve(line); return; }
        if (ended || closed) { resolve(null); return; }
        m = { kind: "ask", prompt, editor: createEditor(), resolve, escCancels: !!o.escCancels };
        modes.push(m);
        if (screen) render();
        else if (prompt.trim().length > 1) print(prompt.trimEnd());
      });
      p.cancel = () => { if (m) finish(m, null); };
      return p;
    },

    /**
     * A choice: resolves the index of the option taken, or null (input ended, cancelled). Esc takes the last one.
     * o.freeText: where keys can't be read, words that aren't an option come back as they are (a string).
     */
    pick({ title, options, freeText = false }) {
      let m = null;
      const p = new Promise((resolve) => {
        if (closed || (ended && (keysMode || !queue.length))) { resolve(null); return; }
        m = { kind: "pick", title: String(title), options: options.slice(), at: 0, resolve, freeText };
        if (!screen) {
          print(paint.bold(m.title));
          m.options.forEach((o, i) => print(`  ${paint.cyan(String(i + 1) + ".")} ${o}`));
        }
        modes.push(m);
        if (!keysMode) {
          while (queue.length && modes.includes(m)) answerTyped(m, queue.shift());
          if (ended && modes.includes(m)) finish(m, null);
          if (!modes.includes(m)) return;
        }
        render();
      });
      p.cancel = () => { if (m) finish(m, null); };
      return p;
    },

    /** Is a question (a picker or a line of its own) waiting for its answer? */
    asking: () => modes.length > 0,
    /** Everything waiting for an answer gets null. */
    cancelAll() { while (modes.length) { const m = modes.pop(); m.resolve(null); } render(); },

    /** The status line above the prompt: fn() gives it (null: none). On a terminal only. */
    setStatus(fn) { statusFn = fn; render(); },
    /** A dim line under the prompt for `ms`; elsewhere printed once. */
    hint(text, ms = 2000) {
      clearTimeout(hintTimer);
      if (!screen) { print(paint.dim(text)); return; }
      hintText = text;
      render();
      hintTimer = setTimeout(() => { hintText = ""; render(); }, ms);
      if (hintTimer.unref) hintTimer.unref();
    },
    clearHint() { clearTimeout(hintTimer); if (hintText) { hintText = ""; render(); } },

    /** Up and Down go through `h` ({ list(), add(line) }, history.js). */
    setHistory(h) { history = h; },
    /** Tab asks `fn` (complete.js). */
    setCompleter(fn) { completer = fn; },

    /** Ctrl+C, Ctrl+D (on an empty line) and Esc call fn(kind) from now on: "ctrl-c", "ctrl-d" or "esc". Returns the one it replaces. */
    onInterrupt(fn) { const was = control; control = fn; return was; },

    close() {
      if (closed) return;
      closed = true;
      clearTimeout(hintTimer);
      if (screen) screen.clear();
      process.removeListener("SIGINT", onSigint);
      if (keys) { keys.close(); stdin.removeListener("end", onEnd); if (stdout.removeListener) stdout.removeListener("resize", render); }
      if (rl) rl.close();
      while (modes.length) { const m = modes.pop(); m.resolve(null); }
      if (waiter) { const w = waiter; waiter = null; w({ type: "end" }); }
    },
  };
  return api;
}

module.exports = { createInput };
