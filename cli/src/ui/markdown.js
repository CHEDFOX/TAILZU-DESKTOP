// An answer's Markdown as plain lines for a terminal: no backticks, stars or hashes; code blocks kept, and marked as code.

"use strict";

/** [{ text, code }] for each line. */
function plainLines(md) {
  const out = [];
  let inCode = false;
  for (const raw of String(md || "").replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*```/.test(raw)) { inCode = !inCode; continue; }
    if (inCode) { out.push({ text: raw.replace(/\t/g, "  "), code: true }); continue; }
    let s = raw.replace(/\t/g, "  ");
    s = s.replace(/^\s{0,3}#{1,6}\s+/, "");
    s = s.replace(/^(\s*)[*+]\s+/, "$1- ");
    s = s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1");
    s = s.replace(/`([^`]+)`/g, "$1");
    s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, "$1 ($2)");
    out.push({ text: s, code: false });
  }
  // No runs of blank lines, none at the ends.
  const tidy = [];
  for (const l of out) {
    if (!l.text.trim() && !l.code && (!tidy.length || !tidy[tidy.length - 1].text.trim())) continue;
    tidy.push(l);
  }
  while (tidy.length && !tidy[tidy.length - 1].text.trim()) tidy.pop();
  return tidy;
}

module.exports = { plainLines };
