// node --test
//
// The joins a pause makes, in the scripts people dictate in. Each case is two
// stretches as the recogniser wrote them and the text that must end up in the
// field.

const test = require("node:test");
const assert = require("node:assert");
const { separator, joinStretch } = require("./pasteJoin.js");

/** Paste the stretches one after another, the way main.js does. */
const paste = (...parts) => parts.reduce((field, p, i) => field + (i ? joinStretch(parts[i - 1], p) : p), "");

test("the owner's texts: one space between stretches, whatever the script", () => {
  assert.strictEqual(paste("So see that and", "जिंदगी में.", "I'm not a", "जिंदगी में."),
    "So see that and जिंदगी में. I'm not a जिंदगी में.");
  assert.strictEqual(paste("Jhal", "Thank you.", "Jhal"), "Jhal Thank you. Jhal");
});

test("after a full stop, a question mark, an exclamation", () => {
  assert.strictEqual(paste("Are we stuck up?", "Then we move."), "Are we stuck up? Then we move.");
  assert.strictEqual(paste("It works sometimes.", "Okay."), "It works sometimes. Okay.");
  assert.strictEqual(paste("Wow!", "Great."), "Wow! Great.");
});

test("Devanagari and Bengali, with and without the danda", () => {
  assert.strictEqual(paste("मैं घर जा रहा हूँ।", "कल मिलते हैं।"), "मैं घर जा रहा हूँ। कल मिलते हैं।");
  assert.strictEqual(paste("मैं घर जा रहा हूँ", "।"), "मैं घर जा रहा हूँ।");
  assert.strictEqual(paste("আমি বাড়ি যাচ্ছি।", "কাল দেখা হবে।"), "আমি বাড়ি যাচ্ছি। কাল দেখা হবে।");
  assert.strictEqual(paste("Meeting at five", "आज शाम को"), "Meeting at five आज शाम को");
});

test("a stretch that starts with what belongs to the word before", () => {
  for (const mark of [".", ",", "?", "!", ";", ":", "...", "…", ")", "]", "”", "’s", "%", "»", "،", "؟"]) {
    assert.strictEqual(separator("word", mark + " more"), "", mark);
  }
});

test("a stretch ending in what opens onto the next", () => {
  for (const mark of ["(", "[", "“", "‘", "«", "¿", "¡"]) {
    assert.strictEqual(separator("he said " + mark, "hello"), "", mark);
  }
  assert.strictEqual(paste("He said “", "hello”", "and left."), "He said “hello” and left.");
});

test("Chinese, Japanese and Thai take no space between stretches; Korean does", () => {
  assert.strictEqual(paste("我今天很忙。", "明天见。"), "我今天很忙。明天见。");
  assert.strictEqual(paste("我今天很忙", "明天见"), "我今天很忙明天见");
  assert.strictEqual(paste("今日は忙しいです。", "また明日。"), "今日は忙しいです。また明日。");
  assert.strictEqual(paste("コーヒー", "ください"), "コーヒーください");
  assert.strictEqual(paste("你好，", "Tailzu"), "你好，Tailzu");
  assert.strictEqual(paste("用 Tailzu", "写的"), "用 Tailzu 写的");
  assert.strictEqual(paste("오늘은 바빠요.", "내일 봐요."), "오늘은 바빠요. 내일 봐요.");
  assert.strictEqual(paste("สวัสดีครับ", "วันนี้อากาศดี"), "สวัสดีครับวันนี้อากาศดี");
});

test("never two spaces, never a space from nothing", () => {
  assert.strictEqual(separator("ends with a space ", "next"), "");
  assert.strictEqual(separator("line\n", "next"), "");
  assert.strictEqual(separator("word", " starts with one"), "");
  assert.strictEqual(separator("word", "\u200Bzero width"), "");
  assert.strictEqual(separator("", "first stretch"), "");
  assert.strictEqual(separator("word", ""), "");
  assert.strictEqual(joinStretch(undefined, "first"), "first");
});

test("other scripts get the one space", () => {
  assert.strictEqual(paste("Привет.", "Как дела?"), "Привет. Как дела?");
  assert.strictEqual(paste("مرحبا", "كيف حالك؟"), "مرحبا كيف حالك؟");
  assert.strictEqual(paste("Done", "👍"), "Done 👍");
});
