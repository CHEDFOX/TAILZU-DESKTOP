/**
 * A FULL STOP HELD AT A PAUSE.
 *
 * A pause pastes what was said so far while the person is still talking, and
 * the server, handed that stretch on its own, ends it: "The refinement is
 * arriving in." The next stretch, written after that stop, then came back as a
 * sentence of its own: "Breaks and a single sentence…". Two sentences where
 * one was said.
 *
 * So a pause stretch that ends in a full stop or an ellipsis is pasted without
 * it and the stop is held. The next stretch goes up with context that ends
 * where they paused, and heldStop set, and the server's answer decides: one
 * that opens with a stop closes the sentence ("I finished the report" +
 * ". Then the budget."), and any other carries it on, so the held stop is
 * never pasted. When the dictation ends on that pause, the stop goes in after
 * all. A question mark or an exclamation stays where it is: it says what the
 * sentence was. So does a stop that belongs to its word ("Dr.", "e.g.", "A.").
 *
 * Loaded by recorder.html (window.TailzuHeld) and by node --test.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.TailzuHeld = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  /** Words a full stop shortens rather than ends. */
  const SHORT = new Set(["mr", "mrs", "ms", "dr", "st", "vs", "etc", "jr", "sr", "prof", "inc", "ltd", "co", "no", "approx", "dept", "fig"]);

  /** `text` without the stop that ends it, and that stop; null when there is none to hold. */
  function holdStop(text) {
    const t = String(text || "");
    const m = /(?:\.\.\.|…|\.)$/u.exec(t);
    if (!m) return null;
    const body = t.slice(0, -m[0].length);
    // The word the stop is on: none (a quote, a bracket, an emoji) and it stays.
    const last = (/[\p{L}\p{M}\p{N}.'’]+$/u.exec(body) || [""])[0];
    if (!last.replace(/[.'’]/g, "")) return null;
    if (m[0] === "." && (SHORT.has(last.toLowerCase()) || last.includes(".") || /^\p{Lu}$/u.test(last))) return null;
    return { text: body, stop: m[0] };
  }

  /** Does `answer` close the held sentence itself, by opening with a stop of its own? */
  function closesHeld(answer) { return /^[.!?…]/u.test(String(answer || "").trim()); }

  return { holdStop, closesHeld };
});
