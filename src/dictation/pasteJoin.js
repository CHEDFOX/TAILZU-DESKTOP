// What goes between two stretches of one dictation, pasted one after the other.
//
// A pause pastes what was said so far and the next stretch is pasted after it
// at the cursor, so the join is ours to write. Pasted bare they ran together
// ("and" + "जिंदगी में." + "I'm" read "andजिंदगी में.I'm"); a space before
// everything would put one before a comma and between two Chinese sentences.
// The answer is one space, or none where the writing wants none:
//
//   none  the stretch starts with what attaches to the word before it: a
//         full stop, comma, colon, a closing bracket or quote, a danda, an
//         ellipsis, any of the CJK full-width marks
//   none  the one before ends with what opens onto the next: an opening
//         bracket or quote, ¿ ¡
//   none  Chinese, Japanese or Thai on both sides, or a CJK full-width mark
//         at the end of the one before (those scripts put no space between
//         words; Korean does, and gets one)
//   none  either side already has whitespace there: never two
//   one   everything else, in any script
//
// The server answers the same question for each stretch (`joinWithSpace`,
// against the context the recorder sent) by the same rule; this is what
// decides when an older server does not say.
// Split out of main.js so it can be tested (node --test) without Electron.

/** Marks that belong to the word before them. */
const ATTACH = /^[\p{Pe}\p{Pf}.,!?;:%…‼⁇⁈⁉।॥،؛؟۔።፣፤፥፦፧፨၊။\u037E\u0589\u3001\u3002\uFF01\uFF0C\uFF0E\uFF1A\uFF1B\uFF1F]/u;
/** Marks that belong to the word after them. */
const OPENS = /[\p{Ps}\p{Pi}¿¡]$/u;
/** Chinese, Japanese and Thai: no space between two stretches of them. */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\u30FC]/u;
/** The CJK punctuation and full-width forms, which carry their own space. */
const FULLWIDTH = /[\u3000-\u303F\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65]$/u;
/** Whitespace, the zero-width kinds included. */
const SPACE_END = /[\s\u200B\u2060\uFEFF]$/u;
const SPACE_START = /^[\s\u200B\u2060\uFEFF]/u;

/** "" or " ": what goes between `prev` (already pasted) and `next`. */
function separator(prev, next) {
  const a = String(prev || ""), b = String(next || "");
  if (!a || !b) return "";
  if (SPACE_END.test(a) || SPACE_START.test(b)) return "";
  if (ATTACH.test(b) || OPENS.test(a) || FULLWIDTH.test(a)) return "";
  const last = Array.from(a).pop(), first = String.fromCodePoint(b.codePointAt(0));
  if (CJK.test(last) && CJK.test(first)) return "";
  return " ";
}

/** `next` as it should be pasted after `prev`. */
function joinStretch(prev, next) { return separator(prev, next) + String(next || ""); }

module.exports = { separator, joinStretch };
