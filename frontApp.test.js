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
