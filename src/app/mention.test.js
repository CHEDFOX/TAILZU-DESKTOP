// node --test
//
// MentionField (sdui/mention.js): "@" for a person and "/" for a bot's thing, the draft it writes, Escape and Enter, "@name" typed
// out at send, and the field surviving a live reload (its words, its chips and its focus kept: it is moved, never rebuilt).
const test = require("node:test");
const assert = require("node:assert");
const { fakePage } = require("./testkit.js");

const PEOPLE = [{ id: "u-mom", name: "Mom" }, { id: "u-rohan", name: "Rohan Sharma" }];
const BOTS = [{ slug: "plan", name: "Plan Ease", color: "#8F6A1F", kind: "plan" }, { slug: "notes", name: "Notes", color: "#5B6B3A", kind: "notes" }];
const field = (extra = {}) => ({
  type: "MentionField",
  props: Object.assign({
    life: "space.compose.s1", placeholder: "Write to everyone, or @ someone", draftPath: "draft", people: PEOPLE, bots: BOTS,
    thingsPath: "/v1/botsapp/bots/work/:bot/mine", autoFocus: true, maxLength: 4000,
    tools: [{ id: "money", label: "Ask for money", action: { kind: "setState", path: "tool", value: "money" } }],
    words: { people: "People in this space", bots: "Share from a bot", empty: "Nothing here yet" },
  }, extra),
  on: { onSubmit: { kind: "setState", path: "submitted", value: "$state.draft" } },
});

function page(o = {}) {
  const fetched = [];
  const p = fakePage({
    fetch: async (url) => {
      fetched.push(url);
      return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ items: [{ id: "e:1@2026-11-14", title: "Doctor, knee check-up", line: "Fri, 7:40" }] }) };
    },
  });
  p.run("ENV = { baseUrl: 'https://api.test' }; SESSION = null");
  p.view.rect = { left: 0, top: 0, width: 720, height: 800 };
  p.ctx.__sc = { screenId: "bots.spaces", look: "bots", root: { type: "Stack", children: [field(o.props)] }, state: { draft: { text: "", toId: "", toName: "", bot: "", botName: "", thingId: "", thingTitle: "" } } };
  p.run("STACK = [{ screenId: 'bots.spaces', params: { id: 's1' } }]; STATE = Object.assign({}, __sc.state); repaint(__sc)");
  // Count the repaints from here.
  p.run("var __paints = 0; var __repaint = repaint; repaint = function (s) { __paints++; return __repaint(s); }");
  const input = () => p.view.querySelector(".tz-mf-in");
  const list = () => p.document.body.querySelector(".tz-mf-pop");
  const draft = () => { const d = p.run("STATE.draft"); return d === undefined ? undefined : JSON.parse(JSON.stringify(d)); };
  return { p, fetched, input, list, draft, paints: () => p.run("__paints") };
}

test("the rules: \"@\" and \"/\" at the start or after a space; the filter; a pick's cut; \"@name\" typed out at send", () => {
  const { p } = page();
  const trig = (t, c, has) => JSON.parse(JSON.stringify(p.run("mentionTrigger(" + JSON.stringify(t) + "," + (c == null ? "null" : c) + "," + !!has + ")")));
  assert.deepStrictEqual(trig("@", 1), { kind: "people", start: 0, query: "" });
  assert.deepStrictEqual(trig("hi @mo", 6), { kind: "people", start: 3, query: "mo" });
  assert.deepStrictEqual(trig("see /", 5), { kind: "bots", start: 4, query: "" });
  assert.strictEqual(trig("mail a@b", 8), null, "not in the middle of a word");
  assert.strictEqual(trig("hi @mo there", 12), null, "a space after it: done");
  assert.strictEqual(trig("@mo", 3, true), null, "a person is picked already");
  assert.deepStrictEqual(trig("@mo /", 5, true), { kind: "bots", start: 4, query: "" }, "\"/\" with a person picked too");
  const names = (q) => JSON.parse(JSON.stringify(p.run("mentionPeople(" + JSON.stringify(PEOPLE) + "," + JSON.stringify(q) + ")"))).map((x) => x.name);
  assert.deepStrictEqual(names(""), ["Mom", "Rohan Sharma"]);
  assert.deepStrictEqual(names("sh"), ["Rohan Sharma"], "any word of the name");
  const bots = (q) => JSON.parse(JSON.stringify(p.run("mentionBots(" + JSON.stringify(BOTS) + "," + JSON.stringify(q) + ")"))).map((x) => x.slug);
  assert.deepStrictEqual(bots(""), ["plan", "notes"]);
  assert.deepStrictEqual(bots("eas"), ["plan"], "a bot's name holding it");
  assert.deepStrictEqual(bots("no"), ["notes"], "or its slug starting with it");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p.run("mentionCut('hi @mo there', 3, 6)"))), { text: "hi there", caret: 3 });
  const at = (text, people) => JSON.parse(JSON.stringify(p.run("mentionAtSend(" + JSON.stringify({ text }) + "," + JSON.stringify(people || PEOPLE) + ")")));
  const one = at("@mom see you at 7");
  assert.strictEqual(one.send, true);
  assert.deepStrictEqual([one.draft.toId, one.draft.toName, one.draft.text], ["u-mom", "Mom", "see you at 7"]);
  assert.strictEqual(at("@Mom, see you").draft.toId, "u-mom", "its punctuation off");
  assert.deepStrictEqual(at("@mom hi", PEOPLE.concat([{ id: "u-mom2", name: "Mom Two" }])), { send: false, query: "mom" }, "two Moms: the list, nothing sent");
  assert.deepStrictEqual(at("@zed hi"), { send: true }, "nobody by that name: as it is written");
  assert.deepStrictEqual(at("hello @mom"), { send: true }, "not at the start: just text");
});

test("\"@\" opens the people in the space; a pick makes a chip and writes the draft; typing never repaints", () => {
  const { p, input, list, draft, paints } = page();
  assert.strictEqual(p.document.activeElement, input(), "autoFocus when it appears");
  input().type("@");
  assert.ok(list() && list().classList.contains("on"), "the list is up");
  assert.match(list().textContent, /People in this space/);
  assert.deepStrictEqual(list().querySelectorAll(".tz-mf-person").map((r) => r.textContent), ["Mom", "Rohan Sharma"], "their names, no initials");
  input().type("ro");
  assert.deepStrictEqual(list().querySelectorAll(".tz-mf-person").map((r) => r.textContent), ["Rohan Sharma"], "filtered by what follows");
  list().querySelector(".tz-mf-person").click();
  assert.strictEqual(list(), null, "closed");
  assert.strictEqual(input().value, "", "\"@ro\" taken out");
  assert.deepStrictEqual(p.view.querySelectorAll(".tz-mf-chip").map((c) => c.textContent), ["@Rohan Sharma×"]);
  input().type("see you at 7");
  assert.deepStrictEqual(draft(), { text: "see you at 7", toId: "u-rohan", toName: "Rohan Sharma", bot: "", botName: "", thingId: "", thingTitle: "" });
  input().type(" @");
  assert.strictEqual(list(), null, "one person only");
  assert.strictEqual(paints(), 0, "not one repaint while typing and picking");
});

test("\"/\" opens the bots and the screen's tools; a bot's things come from thingsPath; a pick makes a thing chip", async () => {
  const { p, fetched, input, list, draft } = page();
  input().type("/");
  assert.match(list().textContent, /Share from a bot/);
  assert.deepStrictEqual(list().querySelectorAll(".tz-mf-bot").map((r) => r.textContent), ["Plan Ease", "Notes"]);
  assert.deepStrictEqual(list().querySelectorAll(".tz-mf-tool").map((r) => r.textContent), ["Ask for money"]);
  input().type("no");
  assert.deepStrictEqual(list().querySelectorAll(".tz-mf-bot").map((r) => r.textContent), ["Notes"], "filtered by what follows");
  input().setSelectionRange(1, 3);
  input().type("");
  assert.strictEqual(list().querySelectorAll(".tz-mf-bot").length, 2, "all of them again");
  list().querySelector(".tz-mf-bot").click();
  await p.settle();
  assert.deepStrictEqual(fetched, ["https://api.test/v1/botsapp/bots/work/plan/mine"], "the person's own things in that bot");
  assert.deepStrictEqual(list().querySelectorAll(".tz-mf-thing").map((r) => r.textContent), ["Doctor, knee check-upFri, 7:40"]);
  list().querySelector(".tz-mf-thing").click();
  assert.strictEqual(input().value, "");
  assert.deepStrictEqual(p.view.querySelectorAll(".tz-mf-chip").map((c) => c.textContent), ["Doctor, knee check-up · Plan Ease×"]);
  assert.deepStrictEqual(draft(), { text: "", toId: "", toName: "", bot: "plan", botName: "Plan Ease", thingId: "e:1@2026-11-14", thingTitle: "Doctor, knee check-up" });
  // A tool closes the list and runs its action.
  input().type("/");
  list().querySelector(".tz-mf-tool").click();
  assert.strictEqual(list(), null);
  assert.strictEqual(p.run("STATE.tool"), "money");
  // Backspace in the empty field takes the last chip.
  input().key("Backspace");
  assert.strictEqual(p.view.querySelectorAll(".tz-mf-chip").length, 0);
  assert.strictEqual(draft().thingId, "");
});

test("Escape closes the list, then lets go of the field; Enter sends the draft, and a cleared draft empties the field", async () => {
  const { p, input, list, draft } = page();
  input().type("@");
  const esc = input().key("Escape");
  assert.strictEqual(esc, false, "taken: the thought does not also close");
  assert.strictEqual(list(), null);
  assert.strictEqual(p.document.activeElement, input(), "the field still has the focus");
  input().key("Escape");
  assert.notStrictEqual(p.document.activeElement, input(), "the second Escape lets go");
  input().focus();
  // What was typed stays (the "@" too): it is cleared by hand here.
  assert.strictEqual(input().value, "@");
  input().value = ""; input().setSelectionRange(0, 0);
  input().type("dinner at 8?");
  input().key("Enter");
  await p.settle();
  assert.strictEqual(p.run("STATE.submitted.text"), "dinner at 8?");
  // The server's sent(): clearState draft (and a repaint): the field empties itself.
  p.run("STATE.draft = undefined; __repaint()");
  assert.strictEqual(input().value, "");
  assert.strictEqual(p.view.querySelectorAll(".tz-mf-chip").length, 0);
  assert.strictEqual(draft(), undefined, "nothing written back into it");
});

test("\"@mom\" typed out with no chip: one Mom becomes the chip before it sends; two open the list and nothing is sent", async () => {
  const { p, input, list } = page();
  input().type("@mom see you at 7");
  // The list closed itself at the space after "@mom" (what follows is not a name any more).
  input().key("Enter");
  await p.settle();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p.run("STATE.submitted"))).toId, "u-mom");
  assert.strictEqual(p.run("STATE.submitted.text"), "see you at 7");
  const two = page({ props: { people: PEOPLE.concat([{ id: "u-mom2", name: "Mom Two" }]) } });
  two.input().type("@mom see you");
  two.input().key("Enter");
  await two.p.settle();
  assert.strictEqual(two.p.run("STATE.submitted"), undefined, "nothing sent");
  assert.ok(two.list(), "the people list, open on the word");
  assert.deepStrictEqual(two.list().querySelectorAll(".tz-mf-person").map((r) => r.textContent), ["Mom", "Mom Two"]);
  assert.strictEqual(list(), null, "the first field's list went once it sent");
});

test("a live reload while it holds words, a chip and the focus keeps all three: the same element, moved into the new paint", () => {
  const { p, input, list } = page();
  input().type("@");
  list().querySelector(".tz-mf-person").click();
  input().type("pick up the dahi");
  input().setSelectionRange(4, 4);
  const el = input();
  // A quiet reload: the server's tree again, the local draft kept (live.js mergeLiveState), the view painted again.
  p.run("__repaint(__sc)");
  assert.strictEqual(input(), el, "not rebuilt");
  assert.strictEqual(input().value, "pick up the dahi");
  assert.strictEqual(p.document.activeElement, el, "the focus is back");
  assert.strictEqual(el.selectionStart, 4, "and the caret");
  assert.deepStrictEqual(p.view.querySelectorAll(".tz-mf-chip").map((c) => c.textContent), ["@Mom×"]);
  // A write's fetch of the same screen brings the server's empty draft: the words stay.
  p.run("STATE = Object.assign({}, __sc.state); mentionCarry(); __repaint(__sc)");
  assert.strictEqual(input().value, "pick up the dahi");
  assert.strictEqual(p.run("STATE.draft.toId"), "u-mom");
});
