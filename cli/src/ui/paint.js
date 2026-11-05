// Plain ANSI styles, or none at all.

"use strict";

const CODES = { bold: [1, 22], dim: [2, 22], cyan: [36, 39], green: [32, 39], yellow: [33, 39], red: [31, 39] };

/** { bold, dim, cyan, green, yellow, red }: each wraps text in its style when `color` is on, and returns it as it is when off. */
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

module.exports = { painter, strip, visible };
