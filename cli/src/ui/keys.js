// Key presses from the keyboard: the terminal in raw mode, each press as { name, ctrl, meta, sequence }, and a paste as one
// { name: "paste", text }. XODE_KEYS=1 reads a pipe the same way, so tests and demos can type through it.
//
// A lone Esc is said at once (the usual decoder waits half a second to see whether more of a sequence follows); a burst of
// them ("\x1b\x1b") is that many presses. Pastes come marked by the terminal (bracketed paste) when it can.

"use strict";

const readline = require("readline");
const { PassThrough } = require("stream");

const LONE_ESC = /^\x1b+$/;

/** onKey(key) for each press. Returns { pause(), resume(), close() }. */
function createKeys({ stdin, stdout, onKey }) {
  const raw = !!(stdin.isTTY && typeof stdin.setRawMode === "function");
  const decoder = new PassThrough();
  readline.emitKeypressEvents(decoder);
  let pasting = null;

  decoder.on("keypress", (str, key) => {
    const k = key || { name: "", sequence: str || "" };
    if (k.name === "paste-start") { pasting = ""; return; }
    if (k.name === "paste-end") { const text = pasting || ""; pasting = null; onKey({ name: "paste", text }); return; }
    if (pasting !== null) { pasting += k.sequence === "\r" ? "\n" : k.sequence || str || ""; return; }
    // "\x1b\x1b" read as one key is two presses of Esc.
    if (k.name === "escape" && LONE_ESC.test(k.sequence || "")) {
      for (let i = 0; i < k.sequence.length; i += 1) onKey({ name: "escape", ctrl: false, meta: false, sequence: "\x1b" });
      return;
    }
    onKey({ name: k.name || "", ctrl: !!k.ctrl, meta: !!k.meta, shift: !!k.shift, sequence: k.sequence || str || "" });
  });

  const onData = (chunk) => {
    const s = String(chunk);
    if (LONE_ESC.test(s) && pasting === null) {
      for (let i = 0; i < s.length; i += 1) onKey({ name: "escape", ctrl: false, meta: false, sequence: "\x1b" });
      return;
    }
    decoder.write(s);
  };

  function on() {
    if (raw) stdin.setRawMode(true);
    if (stdout && stdout.isTTY) stdout.write("\x1b[?2004h");
  }
  function off() {
    if (stdout && stdout.isTTY) stdout.write("\x1b[?2004l");
    if (raw) { try { stdin.setRawMode(false); } catch { /* the terminal is gone */ } }
  }

  stdin.setEncoding && stdin.setEncoding("utf8");
  stdin.on("data", onData);
  on();
  stdin.resume();

  return {
    raw,
    /** Hands the terminal back as it was (before suspending). */
    pause: off,
    resume: on,
    close() {
      stdin.removeListener("data", onData);
      off();
      stdin.pause();
    },
  };
}

module.exports = { createKeys };
