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
  const out = ["AXTextArea", "", "Message #design", "", "", "yes", "", "Morning all,\nquick one"].join(RS) + "\n";
  assert.deepStrictEqual(macFieldOf(out, 1000), { kind: "message", label: "Message #design", before: "Morning all,\nquick one" });
  assert.deepStrictEqual(macFieldOf(["AXTextField", "AXSearchField", "", "search", "", "no", "", ""].join(RS)), { kind: "search", label: "search" });
  assert.strictEqual(macFieldOf(["AXTextField", "AXSecureTextField", "", "Password", "", "no", "", ""].join(RS)), null);
  assert.strictEqual(macFieldOf(""), null);
});

// WHAT IS SELECTED: said with a selection, an instruction rewrites it, and the
// rewrite is pasted over all of it — so it is read whole or not at all.
test("the selection in the field goes with it, whole or not at all", () => {
  const RS = "\u001e";
  const sel = "We ship on Friday and we should tell the team.\n";
  assert.deepStrictEqual(macFieldOf(["AXTextArea", "", "Notes", "", "", "yes", sel, "Plan:\n"].join(RS) + "\n", 1000),
    { kind: "longtext", label: "Notes", before: "Plan:\n", selection: sel });
  // No selection, or only whitespace: nothing to rewrite.
  assert.strictEqual(macFieldOf(["AXTextArea", "", "Notes", "", "", "yes", " \n", "x"].join(RS)).selection, undefined);
  // Too long to send whole: not sent, so nothing is half-rewritten.
  assert.strictEqual(fieldOf({ role: "area", caret: true, before: "", selection: "x".repeat(8001) }).selection, undefined);
  assert.strictEqual(fieldOf({ role: "area", caret: true, before: "", selection: "x".repeat(8000) }).selection.length, 8000);
  // Never out of a password field.
  assert.strictEqual(fieldOf({ role: "field", subrole: "AXSecureTextField", selection: "hunter2" }), null);
  assert.deepStrictEqual(windowsField({ ok: true, type: "ControlType.Edit", name: "Reply", caret: true, before: "", selection: "thanks so much" }),
    { kind: "text", label: "Reply", before: "", selection: "thanks so much" });
});

test("a field that takes a value sends no selection: it is the old address or query", () => {
  const RS = "\u001e";
  // Cmd+L in a browser selects the whole address; a search box its last query.
  const url = "https://docs.google.com/document/d/abc123/edit?usp=sharing";
  assert.deepStrictEqual(fieldOf({ role: "field", label: "Address and search bar", caret: true, before: "", selection: url }),
    { kind: "url", label: "Address and search bar", before: "" });
  assert.strictEqual(fieldOf({ role: "field", subrole: "AXSearchField", caret: true, before: "", selection: "old query" }).selection, undefined);
  assert.strictEqual(fieldOf({ role: "field", label: "Email address", caret: true, before: "", selection: "me@x.com" }).selection, undefined);
  assert.strictEqual(macFieldOf(["AXTextField", "AXSearchField", "Search", "", "", "yes", "last query", ""].join(RS)).selection, undefined);
  assert.strictEqual(windowsField({ ok: true, type: "ControlType.Edit", name: "Address and search bar", caret: true, before: "", selection: url }).selection, undefined);
  assert.strictEqual(windowsField({ ok: true, type: "ControlType.ComboBox", name: "Search or type web address", caret: true, before: "", selection: url }).selection, undefined);
  // Prose fields still send it.
  assert.strictEqual(fieldOf({ role: "field", label: "Subject", caret: true, before: "", selection: "Q3 plan" }).selection, "Q3 plan");
  assert.strictEqual(fieldOf({ role: "area", label: "Message #design", caret: true, before: "", selection: "see you" }).selection, "see you");
});

test("the field scripts read the selection where it can be written over", () => {
  const { macFieldScript, PS } = require("./frontApp.js");
  const mac = macFieldScript(1000);
  assert.match(mac, /AXSelectedText"/);
  // A Mac reads it only where the field's value can be set, as Windows checks
  // IsReadOnly: a terminal's selected output is not text a paste replaces.
  assert.match(mac, /if settable of attribute "AXValue" of el then set sel to value of attribute "AXSelectedText" of el/);
  assert.ok(!/^\s*set sel to value of attribute "AXSelectedText"/m.test(mac), "AXSelectedText is read with no settable check");
  assert.match(mac, /caret & RS & sel & RS & b/);
  assert.match(mac, /> 8000 then set sel to ""/);
  assert.match(PS, /ValuePattern\]::Pattern/);
  assert.match(PS, /IsReadOnly/);
  assert.match(PS, /GetText\(8001\)/);
  assert.match(PS, /\$st\.Length -le 8000/);
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

test("Ask's Always is kept by the app's own name: never a page's title, never the frame every Store app shares", () => {
  const { infoFrom } = require("./frontApp.js");
  assert.strictEqual(infoFrom("Slack", "general - Acme - Slack").pictureKey, "Slack");
  assert.strictEqual(infoFrom("Microsoft PowerPoint", "Q3.pptx - PowerPoint").pictureKey, "Microsoft PowerPoint");
  // A browser: the site in its label is the tab's title, which the page writes.
  assert.strictEqual(infoFrom("Google Chrome", "Dashboard - Google Chrome").label, "Chrome: Dashboard");
  assert.strictEqual(infoFrom("Google Chrome", "Dashboard - Google Chrome").pictureKey, null);
  assert.strictEqual(infoFrom("Safari", "lecture3.pdf").pictureKey, null);
  assert.strictEqual(infoFrom("msedge.exe", "Inbox - Outlook - Microsoft Edge").pictureKey, null);
  // Windows' frame for a Store app, when what is in it could not be told.
  assert.strictEqual(infoFrom("Application Frame Host", "Calculator").pictureKey, null);
  assert.strictEqual(infoFrom("ApplicationFrameHost.exe", "Settings").pictureKey, null);
  assert.strictEqual(infoFrom("", "anything"), null);
});

test("Windows: a Store app is named by the app in its frame, not by the frame's own process", () => {
  const { PS } = require("./frontApp.js");
  assert.match(PS, /\$p\.ProcessName -eq 'ApplicationFrameHost'/);
  assert.match(PS, /FindWindowEx\(\$h, \[IntPtr\]::Zero, 'Windows\.UI\.Core\.CoreWindow', \[IntPtr\]::Zero\)/,
    "the title is passed as a null pointer: PowerShell hands $null to a string parameter as \"\", which finds only untitled windows");
  assert.match(PS, /GetWindowThreadProcessId\(\$core, \[ref\]\$coreId\)/);
  // Then named as any other app is, from that process.
  assert.ok(PS.indexOf("CoreWindow") < PS.indexOf("$name = $p.ProcessName"));
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

// OCR fills what the accessibility tree did not have, and never repeats it.
const { mergeScreen } = require("./frontApp.js");

test("the tree leads; OCR only adds lines it did not already have", () => {
  // Tree has the conversation; OCR repeats some lines exactly and adds new ones.
  const ax = "Aarav: move the sync to Friday?\nReply";
  const ocr = "reply\nAarav: Move the sync to Friday?\nQ3 Plan.docx\nSend";
  const out = mergeScreen(ax, ocr, 2000);
  // Dedup is case-insensitive and whole-line: "reply" and the Friday line
  // (same letters, different case) drop; only the genuinely new lines add.
  assert.strictEqual(out, "Aarav: move the sync to Friday?\nReply\nQ3 Plan.docx\nSend");
});

test("tree empty: OCR is the whole of it; both empty: nothing", () => {
  assert.strictEqual(mergeScreen("", "Doc title\nParagraph one", 2000), "Doc title\nParagraph one");
  assert.strictEqual(mergeScreen("Just the tree", "", 2000), "Just the tree");
  assert.strictEqual(mergeScreen("", "", 2000), "");
  assert.strictEqual(mergeScreen(null, null), "");
});

test("the merged screen is cut from the end, keeping whole lines", () => {
  const out = mergeScreen("AAAA".repeat(20), "line two\nthe newest line", 30);
  assert.ok(out.length <= 30);
  assert.ok(out.endsWith("the newest line"));
  assert.ok(!out.includes("AAAA"));
});

// THE RECORDER'S SIDE OF IT (recorder.js, the hidden window's script, run
// here in a sandbox with a stand-in for the main process and the server).
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

/** recorder.js in a sandbox: `on` holds the handlers it registered, `sent`
 *  what it told the main process, `posts` every upload's form fields. */
function loadRecorder(flags = {}, platform = "MacIntel") {
  const on = {}, sent = [], posts = [];
  const tailzu = {
    token: async () => "token",
    result: (p) => sent.push(["result", p]), segment: (p) => sent.push(["segment", p]),
    error: (p) => sent.push(["error", p]), partial: () => {},
  };
  for (const name of ["onStart", "onTarget", "onAround", "onField", "onStop", "onCancel"]) tailzu[name] = (cb) => { on[name] = cb; };
  const reply = { cleanedText: "Shorter.", replacedSelection: true };
  const sandbox = {
    window: { tailzu, TailzuKnobs: require("./knobs.js") },
    // The microphone never opens: these tests send by hand.
    navigator: { platform, mediaDevices: { getUserMedia: () => new Promise(() => {}) } },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Promise, Blob, FormData, AbortController, console,
    fetch: async (url, init) => {
      posts.push(Object.fromEntries([...init.body.entries()].filter(([k]) => k !== "audio")));
      return { ok: true, status: 200, json: async () => reply };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "recorder.js"), "utf8"), sandbox, { filename: "recorder.js" });
  const start = (session) => on.onStart({ session, baseUrl: "https://api.example", knobs: { flags, labels: {} } });
  const upload = async (sid, isSegment = false) => {
    const report = await sandbox.transcribe(sid, [new Blob(["x"])], "audio/webm", isSegment, 1000, false);
    if (report) report();
  };
  return { on, sent, posts, start, upload, sandbox, reply };
}

test("a rewrite keeps up to 64 characters of the selection's own whitespace each side", () => {
  const { sandbox } = loadRecorder();
  const indent = " ".repeat(12);
  const sel = indent + "total = 0\n" + indent + "for x in xs:\n" + indent + "    total += x\n";
  assert.deepStrictEqual([...sandbox.edgesOf(sel)], [indent, "\n"]);
  assert.deepStrictEqual([...sandbox.edgesOf("\n".repeat(10) + "text" + " ".repeat(30))], ["\n".repeat(10), " ".repeat(30)]);
  // Beyond 64 the main process would refuse it anyway (fromRecorder).
  const deep = sandbox.edgesOf(" ".repeat(100) + "x" + "\n".repeat(100));
  assert.strictEqual(deep[0].length, 64);
  assert.strictEqual(deep[1].length, 64);
  // Unchanged text comes back as itself: a no-op edit changes nothing.
  assert.strictEqual(deep[0] + "x" + deep[1], " ".repeat(64) + "x" + "\n".repeat(64));
  assert.strictEqual(sandbox.edgesOf(indent + "a")[0] + "a" + sandbox.edgesOf(indent + "a")[1], indent + "a");
});

test("a short instruction waits for the field read, and carries the selection it found", async () => {
  const r = loadRecorder({ "desktop.recorder.fieldWaitMs": 2000 });
  r.start(1);
  const sel = "We ship on Friday and we should tell the whole team about it.\n";
  // "shorter", stopped before the main process had read the field.
  const sending = r.upload(1);
  setTimeout(() => r.on.onField({ session: 1, field: { kind: "message", label: "Message", before: "", selection: sel } }), 40);
  await sending;
  assert.strictEqual(r.posts.length, 1);
  assert.strictEqual(r.posts[0].selection, sel);
  assert.strictEqual(r.posts[0].fieldKind, "message");
  // Pasted over the selection with its own trailing line break.
  const [kind, msg] = r.sent[0];
  assert.strictEqual(kind, "result");
  assert.deepStrictEqual([...msg.edges], ["", "\n"]);
});

test("the wait is bounded, ends on an empty answer, and only the first request waits", async () => {
  // No read ever comes: the upload goes after fieldWaitMs, without one.
  let r = loadRecorder({ "desktop.recorder.fieldWaitMs": 80 });
  r.start(1);
  let t0 = Date.now();
  await r.upload(1);
  assert.ok(Date.now() - t0 >= 70, "it did not wait for the field read");
  assert.ok(Date.now() - t0 < 1000);
  assert.strictEqual(r.posts[0].selection, undefined);
  // A later request never waits, however long the wait may be, and a read
  // that lands after the first request is not taken.
  require("./knobs.js").setKnobs({ flags: { "desktop.recorder.fieldWaitMs": 5000 }, labels: {} });
  r.reply.cleanedText = "";
  t0 = Date.now();
  await r.upload(1, true);
  assert.ok(Date.now() - t0 < 2000, "a later request waited");
  r.on.onField({ session: 1, field: { kind: "longtext", before: "", selection: "late" } });
  await r.upload(1, true);
  assert.strictEqual(r.posts[2].selection, undefined);

  // The main process said there is no text field: no wait at all.
  r = loadRecorder({ "desktop.recorder.fieldWaitMs": 5000 });
  r.start(2);
  r.on.onField({ session: 2, field: null });
  t0 = Date.now();
  await r.upload(2);
  assert.ok(Date.now() - t0 < 500);

  // A private window: its field is never read, so nothing is waited for.
  r = loadRecorder({ "desktop.recorder.fieldWaitMs": 5000 });
  r.start(3);
  r.on.onTarget({ session: 3, targetApp: "Chrome", privateField: true });
  t0 = Date.now();
  await r.upload(3);
  assert.ok(Date.now() - t0 < 500);
  assert.strictEqual(r.posts[0].selection, undefined);

  // Long after the press, a read that has not come never will: no wait.
  r = loadRecorder({ "desktop.recorder.fieldWaitMs": 5000, "desktop.field.timeoutMs": 0 });
  r.start(4);
  await new Promise((res) => setTimeout(res, 1600));
  t0 = Date.now();
  await r.upload(4);
  assert.ok(Date.now() - t0 < 500);

  // The app was named: the read began then and gives up desktop.field.timeoutMs
  // later. The main process sends nothing for "no text field", so that is
  // where the wait ends, not a second and a half after the press.
  r = loadRecorder({ "desktop.recorder.fieldWaitMs": 5000, "desktop.field.timeoutMs": 150 });
  r.start(5);
  r.on.onTarget({ session: 5, targetApp: "Finder" });
  t0 = Date.now();
  await r.upload(5);
  assert.ok(Date.now() - t0 >= 120, "it did not wait for the read that had begun");
  assert.ok(Date.now() - t0 < 1000, "it waited past the read's own limit");

  // Linux reads no field (frontApp.focusedField), so nothing is waited for.
  r = loadRecorder({ "desktop.recorder.fieldWaitMs": 5000 }, "Linux x86_64");
  r.start(6);
  t0 = Date.now();
  await r.upload(6);
  assert.ok(Date.now() - t0 < 500);
  assert.strictEqual(r.posts.length, 1);
});
