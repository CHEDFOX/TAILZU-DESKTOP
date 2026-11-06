// node --test
//
// "Add this" (addThis.js): which words point at the screen, what "this" is (the selection, else the page, else the visible window),
// what goes to Plan Ease's box and what comes back, and the old way whenever the box can't say.
const test = require("node:test");
const assert = require("node:assert");
const { createAddThis, seenOf, boxBody, replyOf } = require("./addThis.js");
const { pointsAtScreen } = require("./router.js");

test("words that point at the screen, in English, Hinglish and Hindi; a time is not a thing on the screen", () => {
  for (const s of ["Add this", "Add this to my plan for Friday.", "remind me about this", "add these to my calendar", "save it for later",
    "what's this bill", "isko plan mein daal do", "iske baare mein yaad dila do", "इसे जोड़ दो", "add this email"]) {
    assert.ok(pointsAtScreen(s), s);
  }
  for (const s of ["remind me to call Mom this evening", "plan this weekend", "remind me that rent is due", "remind me at this time tomorrow",
    "ye hafte ka plan", "Dentist Fri 5 pm", "", "next Friday at 6"]) {
    assert.ok(!pointsAtScreen(s), s);
  }
});

test("what goes as seen: its lines kept, control characters and blank runs not, cut to length; nothing for nothing", () => {
  assert.strictEqual(seenOf({ from: "elsewhere", text: "x" }, 1000), null);
  assert.strictEqual(seenOf({ from: "page", text: " \n\t " }, 1000), null);
  const v = seenOf({ from: "page", text: "Dear parents,\r\n\r\n\r\n\r\nDress-up day\u0007 Fri 13 Nov\n  Trip money by Wed  ", app: "Mail\n", title: "School circular", where: "Dress-up" }, 1000);
  assert.deepStrictEqual(v, { from: "page", text: "Dear parents,\n\nDress-up day Fri 13 Nov\nTrip money by Wed", app: "Mail", title: "School circular", where: "Dress-up" });
  assert.strictEqual(seenOf({ from: "selection", text: "x".repeat(5000) }, 300).text.length, 300);
});

test("the box's request: the words as the box takes them, the time zone kept in range", () => {
  assert.deepStrictEqual(boxBody("  add this  ", { from: "page", text: "t" }, 330), { words: "add this", tz: 330, seen: { from: "page", text: "t" } });
  assert.strictEqual(boxBody("x".repeat(3000), null, 0).words.length, 2000);
  assert.strictEqual(boxBody("x", null, 99999).tz, 840);
  assert.strictEqual(boxBody("x", null, "nope").tz, 0);
});

test("the box's answer: a line with its Undo, a card's screen to open, or the chat's (the words then go the old way)", () => {
  assert.strictEqual(replyOf({ slot: "chat", kind: "chat", line: "" }, "Plan Ease"), null);
  assert.strictEqual(replyOf({ kind: "added", line: "  " }, "Plan Ease"), null);
  assert.strictEqual(replyOf(null, "Plan Ease"), null);
  assert.deepStrictEqual(replyOf({ slot: "item", kind: "added", line: "Added: Dentist, Fri 13 Nov, 5 pm", undo: { item: "pe:e1:2026-11-13", action: "undo" } }, "Plan Ease"), {
    name: "Plan Ease", text: "Added: Dentist, Fri 13 Nov, 5 pm", kind: "added", open: { screenId: "bots.plan", params: {} },
    undo: { item: "pe:e1:2026-11-13", action: "undo" },
  });
  assert.deepStrictEqual(replyOf({ slot: "capture", kind: "capture", line: "4 things from the school circular", open: { screen: "bots.plan.capture", params: { id: "c1", n: 2 } } }, "Plan Ease"), {
    name: "Plan Ease", text: "4 things from the school circular", kind: "capture", open: { screenId: "bots.plan.capture", params: { id: "c1" } },
  });
  const odd = replyOf({ kind: "added", line: "Added", undo: { item: "nope", action: "undo" }, open: { screen: "../x" } }, "Plan Ease");
  assert.strictEqual(odd.undo, undefined);
  assert.deepStrictEqual(odd.open, { screenId: "bots.plan", params: {} });
});

function rig(o = {}) {
  const did = [];
  const a = createAddThis({
    on: () => o.on !== false,
    page: async (w) => { did.push(["page", w]); return o.page !== undefined ? o.page : { text: "Your dentist appointment is confirmed for Fri 13 Nov at 5 pm, Dr Mehta.", where: "confirmed" }; },
    screen: async () => { did.push(["screen"]); return o.screen || ""; },
    post: async (path, body) => { did.push(["post", path, body]); if (o.fail) throw new Error("/box → 503"); return o.answer || { slot: "item", kind: "added", line: "Added: Dentist, Fri 13 Nov, 5 pm", undo: { item: "pe:e1:2026-11-13", action: "undo" } }; },
    act: async (item, action) => { did.push(["act", item, action]); return o.act !== false; },
    tz: () => 330,
    knobs: { num: (_k, f) => f, str: (_k, f) => f },
  });
  return { a, did };
}

test("what this is: the selection first, and the page is never read for it", async () => {
  const h = rig();
  const v = await h.a.read({ words: "add this", selection: "PTM Sat 9:30 am", app: "Chrome", title: "Inbox" });
  assert.deepStrictEqual(v, { from: "selection", text: "PTM Sat 9:30 am", app: "Chrome", title: "Inbox" });
  assert.deepStrictEqual(h.did, []);
});

test("what this is with nothing selected: the page in front, else the visible window, else nothing", async () => {
  const page = rig();
  assert.deepStrictEqual(await page.a.read({ words: "add this", app: "Mail", title: "Appointment" }), {
    from: "page", text: "Your dentist appointment is confirmed for Fri 13 Nov at 5 pm, Dr Mehta.", app: "Mail", title: "Appointment", where: "confirmed" });
  assert.deepStrictEqual(page.did, [["page", "add this"]]);
  const thin = rig({ page: { text: "OK", where: "" }, screen: "Electricity bill: due 14 Nov. Pay by UPI before the due date." });
  assert.strictEqual((await thin.a.read({ words: "add this" })).from, "screen");
  assert.deepStrictEqual(thin.did, [["page", "add this"], ["screen"]]);
  const none = rig({ page: null, screen: "" });
  assert.strictEqual(await none.a.read({ words: "add this" }), null);
});

test("sent to Plan Ease's box with the words; a failure or the chat's answer is null, so the words go the old way", async () => {
  const h = rig();
  const seen = { from: "page", text: "Dentist Fri 5 pm" };
  const r = await h.a.send("add this", seen, "Plan Ease");
  assert.deepStrictEqual(h.did[0], ["post", "/v1/botsapp/bots/plan/box", { words: "add this", tz: 330, seen }]);
  assert.strictEqual(r.text, "Added: Dentist, Fri 13 Nov, 5 pm");
  assert.strictEqual(await rig({ fail: true }).a.send("add this", seen, "Plan Ease"), null);
  assert.strictEqual(await rig({ answer: { slot: "chat", kind: "chat", line: "" } }).a.send("add this", seen, "Plan Ease"), null);
});

test("Undo through the act door, and only an item of ours", async () => {
  const h = rig();
  assert.strictEqual(await h.a.undo({ item: "pe:e1:2026-11-13", action: "undo" }), true);
  assert.deepStrictEqual(h.did, [["act", "pe:e1:2026-11-13", "undo"]]);
  assert.strictEqual(await h.a.undo({ item: "https://x", action: "undo" }), false);
  assert.strictEqual(await rig({ act: false }).a.undo({ item: "pt:t1", action: "undo" }), false);
  assert.strictEqual(rig({ on: false }).a.on(), false);
});
