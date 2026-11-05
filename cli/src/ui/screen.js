// The bottom of the terminal, redrawn in place: a few lines (the status line while Xode works, the line being typed, a picker,
// a hint), with everything printed going above them. Each change is one write, so nothing flickers.
//
// Lines other than the one being typed are cut to the width; the typed one wraps, and the cursor is put back where the person
// is typing.

"use strict";

const { visible, fit } = require("./paint");

/** width(): the terminal's columns now. */
function createScreen({ stdout, width }) {
  let lines = [];
  let cursor = null; // { line, col }: where the person is typing, or null
  let cursorRow = 0; // the row, counted from the region's top, the terminal's cursor was left on
  let drawn = false;

  const cols = () => Math.max(10, width());

  /** Moves to the region's top and clears it, and everything under it. */
  function eraseSeq() {
    if (!drawn) return "";
    return (cursorRow > 0 ? `\x1b[${cursorRow}A` : "") + "\r\x1b[J";
  }

  function drawSeq() {
    if (!lines.length) { drawn = false; cursorRow = 0; return ""; }
    const w = cols();
    let s = "";
    let row = 0;
    const starts = [];
    lines.forEach((l, i) => {
      starts.push(row);
      const typed = cursor && cursor.line === i;
      let text = typed ? l : fit(l, w - 1);
      const len = visible(text);
      // A typed line that ends exactly at the edge gets a space, so the terminal wraps it now and the rows add up.
      if (typed && len > 0 && len % w === 0) text += " ";
      s += text;
      row += Math.max(1, Math.ceil(visible(text) / w));
      if (i < lines.length - 1) s += "\r\n";
    });
    const last = row - 1;
    let target = last;
    let col = -1;
    if (cursor && cursor.line < lines.length) {
      target = starts[cursor.line] + Math.floor(cursor.col / w);
      col = cursor.col % w;
    }
    if (last > target) s += `\x1b[${last - target}A`;
    if (col >= 0) s += "\r" + (col > 0 ? `\x1b[${col}C` : "");
    cursorRow = target;
    drawn = true;
    return s;
  }

  const write = (s) => { if (s) stdout.write(s); };

  return {
    /** Shows `next` (lines) with the cursor at `at` ({ line, col }, or null). */
    set(next, at = null) {
      lines = next.slice();
      cursor = at;
      write("\x1b[?25l" + eraseSeq() + drawSeq() + "\x1b[?25h");
    },
    /** Draws the same lines again (after a resize, or a tick of the spinner). */
    redraw() { write("\x1b[?25l" + eraseSeq() + drawSeq() + "\x1b[?25h"); },
    /** Prints `text` above the region. `to` is the stream (stderr for errors). */
    print(text, to = stdout) {
      if (to === stdout) { write("\x1b[?25l" + eraseSeq() + text + "\n" + drawSeq() + "\x1b[?25h"); return; }
      write(eraseSeq());
      drawn = false;
      to.write(text + "\n");
      write(drawSeq());
    },
    /** Takes the region away, leaving the cursor at the start of a clean line. */
    clear() {
      write(eraseSeq());
      drawn = false;
      cursorRow = 0;
      lines = [];
      cursor = null;
    },
    get lines() { return lines.slice(); },
  };
}

module.exports = { createScreen };
