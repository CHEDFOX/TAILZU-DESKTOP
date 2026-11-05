// The text being typed and where the cursor is in it: the usual moves and deletions, over one line or several (a newline
// typed with Ctrl+J, after a "\", or pasted).

"use strict";

function createEditor() {
  let text = "";
  let pos = 0;

  const lineStart = (p) => (p <= 0 ? 0 : text.lastIndexOf("\n", p - 1) + 1);
  const lineEnd = (p) => { const i = text.indexOf("\n", p); return i < 0 ? text.length : i; };

  return {
    get text() { return text; },
    get pos() { return pos; },
    get empty() { return text.length === 0; },
    set(t, p) { text = String(t); pos = p === undefined ? text.length : Math.max(0, Math.min(p, text.length)); },
    clear() { text = ""; pos = 0; },
    insert(s) { text = text.slice(0, pos) + s + text.slice(pos); pos += s.length; },
    backspace() { if (pos > 0) { text = text.slice(0, pos - 1) + text.slice(pos); pos -= 1; } },
    del() { if (pos < text.length) text = text.slice(0, pos) + text.slice(pos + 1); },
    left() { if (pos > 0) pos -= 1; },
    right() { if (pos < text.length) pos += 1; },
    home() { pos = lineStart(pos); },
    end() { pos = lineEnd(pos); },
    wordLeft() {
      let p = pos;
      while (p > 0 && /\s/.test(text[p - 1])) p -= 1;
      while (p > 0 && !/\s/.test(text[p - 1])) p -= 1;
      pos = p;
    },
    wordRight() {
      let p = pos;
      while (p < text.length && /\s/.test(text[p])) p += 1;
      while (p < text.length && !/\s/.test(text[p])) p += 1;
      pos = p;
    },
    /** Ctrl+U: from the start of this line to the cursor (at its start already: joins it to the line before). */
    killLeft() {
      const s = lineStart(pos);
      if (s === pos) { this.backspace(); return; }
      text = text.slice(0, s) + text.slice(pos);
      pos = s;
    },
    /** Ctrl+K: from the cursor to the end of this line. */
    killRight() { text = text.slice(0, pos) + text.slice(lineEnd(pos)); },
    /** Ctrl+W: the word before the cursor. */
    killWord() { const end = pos; this.wordLeft(); text = text.slice(0, pos) + text.slice(end); },
    /** Up a line within the text; false when already on the first. */
    up() {
      const s = lineStart(pos);
      if (s === 0) return false;
      const col = pos - s;
      const ps = lineStart(s - 1);
      pos = Math.min(ps + col, s - 1);
      return true;
    },
    /** Down a line within the text; false when already on the last. */
    down() {
      const e = lineEnd(pos);
      if (e === text.length) return false;
      const col = pos - lineStart(pos);
      pos = Math.min(e + 1 + col, lineEnd(e + 1));
      return true;
    },
    /** { line, col } of the cursor. */
    where() {
      const before = text.slice(0, pos).split("\n");
      return { line: before.length - 1, col: before[before.length - 1].length };
    },
  };
}

module.exports = { createEditor };
