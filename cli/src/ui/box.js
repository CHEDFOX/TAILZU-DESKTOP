// Xode's words in a box with a faint border, wrapped to the terminal; plain lines when it isn't a terminal.

"use strict";

const { plainLines } = require("./markdown");
const { wrapLine, hangOf } = require("./wrap");
const { highlightRefs } = require("./refs");
const { visible } = require("./paint");

/**
 * The lines to print for `text` (Markdown) under `title`.
 * term: { tty, width() }; paint: from painter().
 */
function boxLines(text, { title = "Xode", term, paint }) {
  const lines = plainLines(text);
  if (!term.tty) {
    return [`${title}:`, ...lines.map((l) => (l.code ? "    " + l.text : l.text))];
  }
  const W = term.width();
  const inner = W - 4;
  const body = [];
  for (const l of lines) {
    const parts = l.code ? cut(l.text, inner) : wrapLine(l.text, inner, Math.min(hangOf(l.text), 12));
    for (const p of parts) body.push(l.code ? paint.dim(p) : highlightRefs(p, paint));
  }
  const label = ` ${title} `;
  const top = paint.dim("┌─") + paint.bold(label) + paint.dim("─".repeat(Math.max(0, W - 3 - label.length)) + "┐");
  const side = paint.dim("│");
  const rows = body.map((b) => `${side} ${b}${" ".repeat(Math.max(0, inner - visible(b)))} ${side}`);
  const bottom = paint.dim("└" + "─".repeat(W - 2) + "┘");
  return [top, ...rows, bottom];
}

/** A line of code cut into pieces of `n` (code is not word-wrapped). */
function cut(s, n) {
  if (!s) return [""];
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

module.exports = { boxLines };
