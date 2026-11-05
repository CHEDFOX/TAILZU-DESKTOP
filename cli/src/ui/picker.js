// A choice from a short list, the way a permission prompt asks:
//
//   Start this plan?
//   ❯ 1. Yes
//     2. No, tell Xode what to change
//
// Up and Down move, Enter takes the one marked, a number takes that one, Esc takes the last. Where keys can't be read, the
// same list is printed and a typed number (or the words of an option, or y / n for a yes-or-no) answers it.

"use strict";

const { wrapLine } = require("./wrap");

/** The lines to draw for the list, `at` marked. */
function pickerLines({ title, options, at, paint, width = 80 }) {
  const out = [];
  for (const l of wrapLine(String(title), Math.max(20, width - 1))) out.push(paint.bold(l));
  options.forEach((o, i) => {
    const label = `${i + 1}. ${o}`;
    out.push(i === at ? paint.cyan(`❯ ${label}`) : `  ${label}`);
  });
  return out;
}

/** What a key does: { at } to move, { pick } to choose, or null. */
function pickerKey(key, { at, count }) {
  if (key.name === "up" || (key.ctrl && key.name === "p")) return { at: (at - 1 + count) % count };
  if (key.name === "down" || (key.ctrl && key.name === "n") || key.name === "tab") return { at: (at + 1) % count };
  if (key.name === "return" || key.name === "enter") return { pick: at };
  if (key.name === "escape") return { pick: count - 1 };
  const n = Number(key.sequence);
  if (/^[1-9]$/.test(key.sequence || "") && n <= count) return { pick: n - 1 };
  return null;
}

/** A typed answer to the printed list: the option's index, or -1. */
function typedPick(text, options) {
  const t = String(text || "").trim();
  const n = Number(t);
  if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
  const low = t.toLowerCase();
  const exact = options.findIndex((o) => o.toLowerCase() === low);
  if (exact >= 0) return exact;
  if (/^y(es)?$/.test(low)) { const i = options.findIndex((o) => /^yes\b/i.test(o)); if (i >= 0) return i; }
  if (/^no?$/.test(low)) { const i = options.findIndex((o) => /^no\b/i.test(o)); if (i >= 0) return i; }
  return -1;
}

module.exports = { pickerLines, pickerKey, typedPick };
