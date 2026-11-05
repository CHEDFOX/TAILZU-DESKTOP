// Plain ANSI styles, or none at all.

"use strict";

const CODES = { bold: [1, 22], dim: [2, 22], cyan: [36, 39], green: [32, 39], yellow: [33, 39], red: [31, 39], inverse: [7, 27] };

/** { bold, dim, cyan, green, yellow, red, inverse }: each wraps text in its style when `color` is on, and returns it as it is when off. */
function painter(color) {
  const p = {};
  for (const [name, [on, off]] of Object.entries(CODES)) {
    p[name] = color ? (s) => `\x1b[${on}m${s}\x1b[${off}m` : (s) => String(s);
  }
  return p;
}

// eslint-disable-next-line no-control-regex
const ESC = /\x1b\[[0-9;]*m/g;
const strip = (s) => String(s).replace(ESC, "");
const visible = (s) => strip(s).length;

/** `s` cut to `n` visible characters (styles kept, and closed), with "…" where it was cut. */
function fit(s, n) {
  const text = String(s);
  if (visible(text) <= n) return text;
  if (n <= 0) return "";
  let out = "";
  let seen = 0;
  for (let i = 0; i < text.length;) {
    const m = /^\x1b\[[0-9;]*m/.exec(text.slice(i));
    if (m) { out += m[0]; i += m[0].length; continue; }
    if (seen === n - 1) break;
    out += text[i];
    seen += 1;
    i += 1;
  }
  return out + "…" + (/\x1b\[/.test(out) ? "\x1b[0m" : "");
}

module.exports = { painter, strip, visible, fit };
