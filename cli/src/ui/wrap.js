// Word wrapping to a width, with a hanging indent for list items. Works on plain text (styles go on after).

"use strict";

/** `line` wrapped to `width` columns; the lines after the first start with `indent` spaces. A word longer than the width is cut. */
function wrapLine(line, width, indent = 0) {
  const w = Math.max(10, width);
  if (line.length <= w) return [line];
  const pad = " ".repeat(Math.min(indent, w - 5));
  const lead = /^\s*/.exec(line)[0].slice(0, w - 5);
  const out = [];
  let cur = lead;
  for (const word of line.trim().split(/\s+/)) {
    let rest = word;
    while (rest) {
      const sep = cur.trim() ? 1 : 0;
      if (cur.length + sep + rest.length <= w) { cur += (sep ? " " : "") + rest; rest = ""; }
      else if (cur.trim()) { out.push(cur); cur = pad; }
      else {
        const room = Math.max(1, w - cur.length);
        out.push(cur + rest.slice(0, room));
        rest = rest.slice(room);
        cur = pad;
      }
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** How far a line's continuation is indented: under the words of a "- item" or "12. item". */
function hangOf(line) {
  const m = /^(\s*(?:[-*•]|\d{1,3}[.)])\s+)/.exec(line);
  return m ? m[1].length : (/^\s+/.exec(line) || [""])[0].length;
}

/** A block of text (several lines) wrapped line by line. */
function wrapText(text, width) {
  const out = [];
  for (const line of String(text).split("\n")) out.push(...wrapLine(line, width, Math.min(hangOf(line), 12)));
  return out;
}

module.exports = { wrapLine, wrapText, hangOf };
