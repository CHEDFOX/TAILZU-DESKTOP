// The name of the app dictation goes into: the app, and for a browser the
// site — never the rest of a window's title, which can hold an email subject,
// an address or a document's name.
const test = require("node:test");
const assert = require("node:assert");
const { label } = require("./frontApp.js");

test("a browser is named with the site it is on", () => {
  assert.strictEqual(label("Google Chrome", "ChatGPT - Google Chrome"), "Chrome: ChatGPT");
  assert.strictEqual(label("Mozilla Firefox", "Claude — Mozilla Firefox"), "Firefox: Claude");
  assert.strictEqual(label("Microsoft Edge", "(2) WhatsApp - Personal - Microsoft​ Edge"), "Edge: WhatsApp");
  assert.strictEqual(label("Safari", "Gmail"), "Safari: Gmail");
});

test("what is theirs in a title never leaves the computer", () => {
  const gmail = label("Google Chrome", "Re: salary revision (3) - you@gmail.com - Gmail - Google Chrome");
  assert.strictEqual(gmail, "Chrome: Gmail");
  assert.strictEqual(label("Google Chrome", "Q3 plan.docx - Google Docs - Google Chrome"), "Chrome: Google Docs");
  // Any other app: its name alone.
  assert.strictEqual(label("Notepad", "secret.txt - Notepad"), "Notepad");
  assert.strictEqual(label("Slack", "general - Acme - Slack"), "Slack");
});

test("short, on one line, and nothing when the system said nothing", () => {
  assert.strictEqual(label("", "anything"), null);
  assert.ok(label("A".repeat(80), "") .length <= 40);
  assert.strictEqual(label("Outlook\n<x>", ""), "Outlook x");
});

// THE FIELD ITSELF (focusedField): what kind it is, its label, and what is
// before the cursor — never a password field, and no text without a cursor.
const { kindOf, fieldOf, windowsField, macFieldOf } = require("./frontApp.js");

test("the field's kind, from its role and its label", () => {
  assert.strictEqual(kindOf("field", "AXSearchField", ""), "search");
  assert.strictEqual(kindOf("field", "", "Search mail"), "search");
  assert.strictEqual(kindOf("field", "", "Address and search bar"), "url");
  assert.strictEqual(kindOf("combo", "", "Search or type web address"), "url");
  assert.strictEqual(kindOf("field", "", "Email address"), "email");
  assert.strictEqual(kindOf("field", "", "Subject"), "text");
  assert.strictEqual(kindOf("area", "", "Message #design"), "message");
  assert.strictEqual(kindOf("area", "", "Message Body"), "message");
  assert.strictEqual(kindOf("area", "", ""), "longtext");
  assert.strictEqual(kindOf("field", "AXSecureTextField", "Password"), "password");
  assert.strictEqual(kindOf(undefined, "", "a button"), null);
});

test("a password field, or anything that is not a text field, says nothing", () => {
  assert.strictEqual(fieldOf({ role: "field", subrole: "AXSecureTextField", label: "Password", caret: true, before: "hunter2" }), null);
  assert.strictEqual(windowsField({ ok: true, type: "ControlType.Edit", password: true, name: "Password", caret: true, before: "x" }), null);
  assert.strictEqual(windowsField({ ok: true, type: "ControlType.Button", name: "Send" }), null);
  assert.strictEqual(windowsField({ ok: false }), null);
  assert.strictEqual(windowsField(null), null);
});

test("what is before the cursor goes only when the cursor was read", () => {
  assert.deepStrictEqual(fieldOf({ role: "area", label: "Message #design", caret: true, before: "Hi team," }),
    { kind: "message", label: "Message #design", before: "Hi team," });
  assert.deepStrictEqual(fieldOf({ role: "area", label: "", caret: false, before: "anything" }), { kind: "longtext" });
  assert.strictEqual(fieldOf({ role: "area", caret: true, before: "x".repeat(50) }, 10).before.length, 10);
  // An empty field with the cursor read is known to be empty.
  assert.deepStrictEqual(fieldOf({ role: "field", label: "Subject", caret: true, before: "" }), { kind: "text", label: "Subject", before: "" });
});

test("a label is one short line", () => {
  const f = fieldOf({ role: "field", label: "Search\n<b>mail</b>   now " + "x".repeat(80) });
  assert.ok(!/[\n<>]/.test(f.label) && f.label.length <= 60);
});

test("Windows: UI Automation's answer, read", () => {
  assert.deepStrictEqual(windowsField({ ok: true, type: "ControlType.Document", password: false, name: "Page 1 content", caret: true, before: "Dear Priya,\n" }),
    { kind: "longtext", label: "Page 1 content", before: "Dear Priya,\n" });
  assert.deepStrictEqual(windowsField({ ok: true, type: "ControlType.Edit", name: "", help: "Search mail" }), { kind: "search", label: "Search mail" });
});

test("Mac: System Events' answer, read, with the text keeping its own lines", () => {
  const RS = "\u001e";
  const out = ["AXTextArea", "", "Message #design", "", "", "yes", "Morning all,\nquick one"].join(RS) + "\n";
  assert.deepStrictEqual(macFieldOf(out, 1000), { kind: "message", label: "Message #design", before: "Morning all,\nquick one" });
  assert.deepStrictEqual(macFieldOf(["AXTextField", "AXSearchField", "", "search", "", "no", ""].join(RS)), { kind: "search", label: "search" });
  assert.strictEqual(macFieldOf(["AXTextField", "AXSecureTextField", "", "Password", "", "no", ""].join(RS)), null);
  assert.strictEqual(macFieldOf(""), null);
});

// THE SCREEN AROUND THE FIELD (surroundings): other people's words, read only
// where it is safe — never a private window, never a money/health app.
const { isPrivate, looksSensitive, joinSurroundings, windowsSurroundings } = require("./frontApp.js");

test("a private or incognito window is known from its title", () => {
  assert.ok(isPrivate("Google - Google Chrome (Incognito)"));
  assert.ok(isPrivate("DuckDuckGo — Mozilla Firefox (Private Browsing)"));
  assert.ok(isPrivate("New InPrivate tab - Microsoft Edge"));
  assert.ok(!isPrivate("Inbox - you@gmail.com - Gmail - Google Chrome"));
});

test("a money or health app is treated as sensitive, by name or title", () => {
  assert.ok(looksSensitive("Chase"));
  assert.ok(looksSensitive("Chrome: HDFC Bank"));
  assert.ok(looksSensitive("1Password"));
  assert.ok(looksSensitive("MyChart - patient portal"));
  assert.ok(!looksSensitive("Slack"));
  assert.ok(!looksSensitive("Chrome: Gmail"));
});

test("the screen is cleaned, deduped, and cut from the end", () => {
  const parts = ["  Aarav Shah  ", "x", "::", "Can we move the sync to Friday?", "Can we move the sync to Friday?", "Reply", "Priya"];
  const out = joinSurroundings(parts, 2000);
  assert.strictEqual(out, "Aarav Shah\nCan we move the sync to Friday?\nReply\nPriya");
  // Cap keeps the tail (newest, nearest the field) and drops a partial head line.
  const big = joinSurroundings(["AAAA".repeat(30), "line two here", "the last message"], 40);
  assert.ok(big.length <= 40);
  assert.ok(big.endsWith("the last message"));
  assert.ok(!big.includes("AAAA"));
  assert.strictEqual(joinSurroundings([]), "");
  assert.strictEqual(joinSurroundings(null), "");
});

test("Windows: the UI Automation window walk, read into a blob", () => {
  assert.strictEqual(windowsSurroundings({ ok: true, parts: ["Design sync", "Aarav: Friday?", "x"] }, 2000),
    "Design sync\nAarav: Friday?");
  assert.strictEqual(windowsSurroundings({ ok: false }, 2000), "");
  assert.strictEqual(windowsSurroundings(null, 2000), "");
});
