// file:line references (src/cart/total.ts:42, total.ts:40-48) picked out, so the eye finds them.

"use strict";

const REF = /(^|[\s(["'])((?:[\w.@-]+\/)*[\w.@-]+\.[A-Za-z][A-Za-z0-9]{0,9}:\d+(?:[-:]\d+)?)(?=$|[\s)\]"',.;:!?])/g;

/** The line with each file:line in bold cyan (or as it is, with no colour). */
function highlightRefs(line, paint) {
  return String(line).replace(REF, (_, before, ref) => before + paint.bold(paint.cyan(ref)));
}

/** The file:line references in a text. */
function refsIn(text) {
  return [...String(text).matchAll(REF)].map((m) => m[2]);
}

module.exports = { highlightRefs, refsIn };
