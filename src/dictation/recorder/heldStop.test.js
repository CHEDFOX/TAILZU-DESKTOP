// node --test
//
// Which stops a pause stretch holds back, and which stay where they are.
const test = require("node:test");
const assert = require("node:assert");
const { holdStop, closesHeld } = require("./heldStop.js");

test("a full stop or an ellipsis at the end of a pause stretch is held", () => {
  assert.deepStrictEqual(holdStop("The refinement is arriving in."), { text: "The refinement is arriving in", stop: "." });
  assert.deepStrictEqual(holdStop("The refinement from the backend is..."), { text: "The refinement from the backend is", stop: "..." });
  assert.deepStrictEqual(holdStop("मैं ठीक से पहुँच गया…"), { text: "मैं ठीक से पहुँच गया", stop: "…" });
  assert.deepStrictEqual(holdStop("Meet me at 5."), { text: "Meet me at 5", stop: "." });
});

test("what says what the sentence was, or belongs to its word, stays", () => {
  for (const t of ["Is it ready?", "That's great!", "Ask Dr.", "Bring snacks, drinks, etc.", "For example, e.g.", "Plan A.", "He said “yes.”", "Done 😊.", ".", ""]) {
    assert.strictEqual(holdStop(t), null, t);
  }
});

test("an answer opening with a stop closes the held sentence; any other carries it on", () => {
  assert.strictEqual(closesHeld(". Then we can look at the budget."), true);
  assert.strictEqual(closesHeld("? And when?"), true);
  assert.strictEqual(closesHeld("breaks, and one sentence gets cut in two."), false);
  assert.strictEqual(closesHeld("Priya yesterday."), false);
});
