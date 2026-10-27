// node --test
//
// What a command printed, before it leaves this computer (redact.js): the reference's patterns, a private key held back from its first
// line to its last, the app's own tokens by their exact text, and the cap on how much is sent.

const test = require("node:test");
const assert = require("node:assert");
const { redact, tailOf, secretValues, lineStreamer, cappedSender } = require("./redact.js");

test("obvious secrets are replaced", () => {
  const ghp = "ghp_" + "a".repeat(36);
  assert.strictEqual(redact("token " + ghp + " end"), "token [redacted] end");
  assert.strictEqual(redact("github_pat_" + "B".repeat(30)), "[redacted]");
  assert.strictEqual(redact("key AKIAABCDEFGHIJKLMNOP here"), "key [redacted] here");
  assert.strictEqual(redact("xoxb-1234567890-abcdefghij"), "[redacted]");
  assert.strictEqual(redact("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij1234"), "jwt [redacted]");
  assert.strictEqual(redact("Authorization: Bearer abc.def-ghi"), "Authorization: Bearer [redacted]");
  assert.strictEqual(redact("password=hunter2hunter2"), "password=[redacted]");
  assert.strictEqual(redact('"api_key": "abcdefgh12345678"'), '"api_key": "[redacted]"');
  assert.strictEqual(redact("https://hooks.slack.com/services/T000/B000/XXXX"), "[redacted]");
  assert.strictEqual(redact("nothing secret on this line"), "nothing secret on this line");
});

test("the app's own tokens are replaced by their exact text, longest first", () => {
  assert.strictEqual(redact("a ghs_readonlytoken0123 b", ["ghs_readonlytoken0123"]), "a [redacted] b");
  assert.strictEqual(redact("x short y", ["short"]), "x short y", "a value under 8 characters is not a secret to hunt for");
  assert.strictEqual(redact("abcdefghijkl and abcdefgh", ["abcdefgh", "abcdefghijkl"]), "[redacted] and [redacted]");
});

test("a private key is held back from its BEGIN line to its END line, even split across chunks", () => {
  const sent = [];
  const s = lineStreamer((d) => sent.push(d), []);
  s.write("before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKC");
  s.write("AQEA1234\nmore key lines\n-----END RSA PRIVATE KEY-----\nafter\n");
  s.flush();
  const all = sent.join("");
  assert.ok(!/MIIEow|AQEA1234|more key lines|BEGIN RSA/.test(all), all);
  assert.match(all, /before\n/);
  assert.match(all, /after\n/);
  assert.strictEqual(all.split("[redacted]").length - 1, 4);
});

test("the stream sends complete lines, holds a half line until its end, and flushes it at the close", () => {
  const sent = [];
  const s = lineStreamer((d) => sent.push(d), []);
  s.write("one\ntw");
  s.tick();
  assert.deepStrictEqual(sent, ["one\n"]);
  s.write("o\nthree");
  s.tick();
  assert.deepStrictEqual(sent, ["one\n", "two\n"]);
  s.flush();
  assert.deepStrictEqual(sent, ["one\n", "two\n", "three"]);
});

test("the tail is cut on a character boundary", () => {
  assert.strictEqual(tailOf("abcdef", 3), "def");
  const t = tailOf("é".repeat(10), 5);
  assert.ok(Buffer.byteLength(t) <= 5);
  assert.ok(!t.includes("�"));
  assert.strictEqual(tailOf("short", 100), "short");
});

test("only values that look like secrets are hunted for in the environment", () => {
  assert.deepStrictEqual(secretValues({ GITHUB_TOKEN: "ghp_abcdefghij", PATH: "/usr/bin:/bin", MY_API_KEY: "short", AWS_SECRET_ACCESS_KEY: "abcdefghijklmnop", HOME: "/home/x" }).sort(), ["abcdefghijklmnop", "ghp_abcdefghij"]);
});

test("a command that prints without end costs the room a head and a tail, not everything", () => {
  const sent = [];
  const c = cappedSender((d) => sent.push(d), { headBytes: 100, tailBytes: 30 });
  for (let i = 0; i < 100; i += 1) c.send("line " + String(i).padStart(3, "0") + "\n");
  assert.ok(c.truncated);
  c.end();
  const all = sent.join("");
  assert.match(all, /^line 000\n/);
  assert.match(all, /bytes of output left out; the last part follows/);
  assert.match(all, /line 099\n$/);
  assert.ok(!all.includes("line 050"));
  assert.ok(all.length < 400);
});
