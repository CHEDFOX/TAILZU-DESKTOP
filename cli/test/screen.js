// A small terminal for the tests: plays back what xode wrote (text, carriage returns, cursor moves, clears) at a width, and
// gives the rows as a person would see them, scrollback included. Colours are dropped.

"use strict";

/** The rows `text` leaves on a terminal `cols` wide, and where the cursor ended: { rows, row, col }. */
function play(text, cols = 80) {
  const rows = [[]];
  let row = 0;
  let col = 0;
  let pending = false; // at the right edge: the next character goes on the next row
  const at = (r) => { while (rows.length <= r) rows.push([]); return rows[r]; };
  const s = String(text);
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === "\x1b") {
      const m = /^\x1b\[(\??)([0-9;]*)([A-Za-z])/.exec(s.slice(i));
      if (!m) continue;
      i += m[0].length - 1;
      if (m[1]) continue; // private modes: cursor shown or hidden, bracketed paste
      const n = m[2] === "" ? 1 : Number(m[2].split(";")[0]);
      switch (m[3]) {
        case "A": row = Math.max(0, row - n); pending = false; break;
        case "B": row += n; at(row); pending = false; break;
        case "C": col = Math.min(cols - 1, col + n); pending = false; break;
        case "D": col = Math.max(0, col - n); pending = false; break;
        case "G": col = Math.min(cols - 1, n - 1); pending = false; break;
        case "J":
          if (m[2] === "2") { rows.length = 0; rows.push([]); row = 0; col = 0; break; }
          at(row).length = Math.min(at(row).length, col);
          rows.length = row + 1;
          break;
        case "K": at(row).length = Math.min(at(row).length, m[2] === "2" ? 0 : col); break;
        case "H": row = 0; col = 0; break;
        default: break; // colours
      }
      continue;
    }
    if (c === "\r") { col = 0; pending = false; continue; }
    if (c === "\n") { row += 1; col = 0; at(row); pending = false; continue; }
    if (pending) { row += 1; col = 0; pending = false; }
    const line = at(row);
    while (line.length < col) line.push(" ");
    line[col] = c;
    col += 1;
    if (col >= cols) { col = cols; pending = true; }
  }
  return { rows: rows.map((r) => r.join("").replace(/\s+$/, "")), row, col: Math.min(col, cols - 1) };
}

/** Just the rows, without the empty ones at the end. */
function screenRows(text, cols) {
  const r = play(text, cols).rows;
  while (r.length && !r[r.length - 1]) r.pop();
  return r;
}

module.exports = { play, screenRows };
