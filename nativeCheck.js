// CI ONLY: the halves of frontApp.js that only Windows and a Mac can run,
// run where they can be (build.yml). Not shipped.
//
//   node nativeCheck.js win   the PowerShell answers an app question and a
//                             field question, one JSON line each, in order
//   node nativeCheck.js mac   the field's AppleScript compiles (running it
//                             needs Accessibility, which a CI Mac lacks); the
//                             OCR and Ask helpers build and answer, the caret
//                             question too
//   node nativeCheck.js winagent  Ask's Windows UIA helper answers a ping (its
//                             look, OCR, pool and caret all ready), a snapshot,
//                             a look at the window in front and where the
//                             caret is (shapes only)
const { execFileSync, spawn } = require("child_process");
const os = require("os");
const path = require("path");
const fa = require("./frontApp.js");

const which = process.argv[2];
if (which === "mac") {
  execFileSync("osacompile", ["-o", path.join(os.tmpdir(), "tz-field.scpt"), "-e", fa.macFieldScript(1000)], { stdio: "inherit" });
  execFileSync("osacompile", ["-o", path.join(os.tmpdir(), "tz-around.scpt"), "-e", fa.macSurroundingsScript()], { stdio: "inherit" });
  console.log("the field and surroundings AppleScript both compile");
  // Build the Vision OCR helper exactly as the app ships it (universal,
  // both arches, lipo'd) so a cross-compile problem surfaces here, cheaply,
  // not inside the dmg build; then read a known image with it.
  execFileSync("npm", ["run", "tzocr"], { stdio: "inherit", cwd: __dirname });
  const bin = path.join(__dirname, "build", "tzocr");
  const text = execFileSync(bin, [path.join(__dirname, "native", "ocr-test.png")], { encoding: "utf8" });
  console.log("tzocr read:", JSON.stringify(text.replace(/\n/g, " | ")));
  if (!/TZOCR/.test(text) || !/Friday/.test(text)) { console.error("Vision OCR did not read the test image"); process.exit(1); }
  console.log("the Vision OCR helper reads the test image");
  // Ask's accessibility helper (native/tzax.swift, axDriver.js), built the
  // same universal way, then spoken to in its line protocol: it must answer a
  // ping, say whether it is trusted (a CI Mac is not, so only the shape is
  // checked), answer a garbled line instead of dying, answer a snapshot one
  // way or the other, answer a look, say where the caret is (or why it
  // cannot), and exit when its stdin closes. A look and a caret run beside
  // the other commands, so answers are matched by id, not order.
  execFileSync("npm", ["run", "tzax"], { stdio: "inherit", cwd: __dirname });
  const ax = require("child_process").spawnSync(path.join(__dirname, "build", "tzax"), [], {
    input: ['{"id":1,"cmd":"ping"}', '{"id":2,"cmd":"trusted"}', "not json", '{"id":3,"cmd":"snapshot","max":20}',
      '{"id":4,"cmd":"look","maxSide":640,"budgetMs":4500,"timeoutMs":6000}', '{"id":6,"cmd":"caret","timeoutMs":1000}',
      '{"id":5,"cmd":"ping"}'].join("\n") + "\n",
    encoding: "utf8", timeout: 30000, maxBuffer: 64 << 20,
  });
  const said = String(ax.stdout || "").trim().split("\n").filter(Boolean);
  console.log("tzax said:", said.map((l) => l.replace(/"data":"[^"]{40}[^"]*"/, '"data":"…"')).join(" | ").slice(0, 900));
  if (ax.error || ax.status !== 0) { console.error("tzax did not exit cleanly:", ax.error || ax.status, ax.signal || ""); process.exit(1); }
  let answers;
  try { answers = said.map((l) => JSON.parse(l)); } catch { console.error("tzax wrote a line that is not JSON"); process.exit(1); }
  const byId = new Map(answers.map((a) => [a && a.id, a]));
  const [ping, trust, bad, snap, look, again, caret] = [1, 2, null, 3, 4, 5, 6].map((id) => byId.get(id));
  if (answers.length !== 7
    || !ping || ping.ok !== true || ping.pong !== true
    || !trust || trust.ok !== true || typeof trust.trusted !== "boolean"
    || !bad || bad.ok !== false
    || !snap || typeof snap.ok !== "boolean" || (snap.ok ? !Array.isArray(snap.elements) : typeof snap.error !== "string")
    || !again || again.ok !== true || again.pong !== true) {
    console.error("tzax's answers are not the shapes axDriver.js reads");
    process.exit(1);
  }
  // The look: a CI Mac has no Screen Recording (no_screen_permission), or no
  // window in front; with both it takes a real picture, which must then be
  // the shape axDriver.js reads. Never a timeout: that is a capture that hung
  // (the look was given most of its six seconds, room for a cold runner's
  // first ScreenCaptureKit call; the runner is trusted, so it may get that far).
  // Nor capture_failed: past those two, that is the capture itself broken
  // (ScreenCaptureKit, or the window-list call macOS 13 makes).
  const LOOK_REFUSALS = ["no_screen_permission", "no_app", "no_window"];
  const isFrame = (f) => Array.isArray(f) && f.length === 4 && f.every(Number.isFinite);
  if (!look || typeof look.ok !== "boolean"
    || (!look.ok && !LOOK_REFUSALS.includes(look.error))
    || (look.ok && (!look.window || !isFrame(look.window.frame) || typeof look.window.title !== "string" || look.scale !== "points"
      || !Array.isArray(look.lines) || look.lines.length > 300
      || look.lines.some((l) => typeof l.text !== "string" || !isFrame(l.frame) || typeof l.conf !== "number")
      // Where the title bar is, frames only (agent.js cuts the picture below them).
      || !Array.isArray(look.titleFrames) || look.titleFrames.length > 8 || !look.titleFrames.every(isFrame)
      || !(look.image === null || (look.image.mime === "image/jpeg" && typeof look.image.data === "string"
        && Buffer.from(look.image.data, "base64").subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))
        && Math.max(look.image.width, look.image.height) <= 640))))) {
    console.error("tzax's look is not the shape axDriver.js reads:", JSON.stringify(look && { ...look, image: look.image && "…" }).slice(0, 400));
    process.exit(1);
  }
  // The caret (peek-spec §A): ok with two rectangles or nulls and the app,
  // never any text; or, on a runner without Accessibility, not_trusted, and
  // with it, nothing focused or an app too busy to say. Never a timeout: that
  // is a read that hung, past the second it was given.
  const CARET_REFUSALS = ["not_trusted", "no_focus", "app_busy"];
  const isBox = (f) => f === null || (isFrame(f) && f[2] >= 0 && f[3] > 0);
  const CARET_FIELDS = ["id", "ok", "caret", "field", "app", "scale", "how", "ms"];
  if (!caret || typeof caret.ok !== "boolean"
    || (!caret.ok && (!CARET_REFUSALS.includes(caret.error) || Object.keys(caret).some((k) => !["id", "ok", "error"].includes(k))))
    || (caret.ok && (!isBox(caret.caret) || !isBox(caret.field) || caret.scale !== "points"
      || !caret.app || typeof caret.app.name !== "string" || !Number.isInteger(caret.app.pid)
      || Object.keys(caret).some((k) => !CARET_FIELDS.includes(k))
      || !["range", "after", "before", "none", "secure"].includes(caret.how)))) {
    console.error("tzax's caret is not the shape axDriver.js reads:", JSON.stringify(caret).slice(0, 300));
    process.exit(1);
  }
  console.log(`the accessibility helper answers (trusted: ${trust.trusted}; snapshot: ${snap.ok ? snap.elements.length + " elements" : snap.error}; `
    + `look: ${look.ok ? look.lines.length + " lines, " + (look.image ? look.image.width + "x" + look.image.height + " picture" : "no picture") + " in " + look.ms + " ms" : look.error}; `
    + `caret: ${caret.ok ? JSON.stringify({ caret: caret.caret, field: caret.field, how: caret.how }) + " in " + caret.ms + " ms" : caret.error})`);
  // The one key's Fn watcher (native/tzkey.swift, oneKey.js), built the same
  // universal way. A CI Mac may not let it listen: it says "ready", or exits 3
  // at once; either way it must exit when its stdin closes.
  execFileSync("npm", ["run", "tzkey"], { stdio: "inherit", cwd: __dirname });
  const key = require("child_process").spawnSync(path.join(__dirname, "build", "tzkey"), [], { input: "", encoding: "utf8", timeout: 15000 });
  if (key.error || !(key.status === 0 || key.status === 3)) { console.error("tzkey did not answer as oneKey.js reads it:", key.error || key.status, key.signal || ""); process.exit(1); }
  if (key.status === 0 && !/^ready$/m.test(key.stdout || "")) { console.error("tzkey listened without saying ready:", JSON.stringify(key.stdout)); process.exit(1); }
  console.log(`the Fn watcher builds and answers (${key.status === 0 ? "ready" : "not allowed to listen here"})`);
} else if (which === "win") {
  const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", Buffer.from(fa.PS, "utf16le").toString("base64")], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  let out = "";
  ps.stdout.setEncoding("utf8");
  ps.stdout.on("data", (d) => { out += d; });
  const timer = setTimeout(() => { console.error("no answer in 90 s:", out); process.exit(1); }, 90000);
  ps.on("exit", () => {
    clearTimeout(timer);
    const lines = out.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length !== 4) { console.error("expected four answers, got:", JSON.stringify(out)); process.exit(1); }
    const [app, field, around, ocr] = lines.map((l) => JSON.parse(l));
    console.log("app:", JSON.stringify(app));
    console.log("field:", JSON.stringify(field), "→", JSON.stringify(fa.windowsField(field, 500)));
    console.log("around:", (around.parts || []).length, "parts →", JSON.stringify(fa.windowsSurroundings(around, 300)).slice(0, 200));
    console.log("ocr:", JSON.stringify((ocr.text || "").replace(/\r?\n/g, " | ")));
    if (!("app" in app) || !("ok" in field) || !("ok" in around) || !("ok" in ocr)) { console.error("answers are not the shapes frontApp.js reads"); process.exit(1); }
    if (!ocr.ok || !/TZOCR/.test(ocr.text || "") || !/Friday/.test(ocr.text || "")) { console.error("Windows OCR did not read the test image"); process.exit(1); }
    console.log("Windows.Media.Ocr reads the test image");
  });
  const img = path.join(__dirname, "native", "ocr-test.png");
  ps.stdin.write("q\nf500\ns1000\no" + img + "\n");
  ps.stdin.end();
} else if (which === "winagent") {
  // Ask's Windows accessibility/action helper (native/uia-agent.ps1,
  // uiaDriver.js), run for real on the Windows runner: it must answer a ping,
  // a snapshot and a look, one JSON line each, and exit when its stdin
  // closes. The ping must say the look's C#, the OCR and its thread pool all
  // loaded: each fails quietly otherwise, and every PC would answer looks
  // with no picture or no lines. A CI runner has a desktop with some window
  // in front, so the snapshot may come back ok with elements or ok:false with
  // a reason, and the look ok with that window's picture and lines, or
  // no_window when nothing is in front; only the shapes are required, never
  // specific elements or text. The caret likewise: ok with two rectangles or
  // nulls and the app, or no_window, from the real C# (UI Automation's COM
  // TextPattern2, the system caret) on threads of its own. The look and the
  // caret are answered by workers of their own, after the snapshot as often
  // as not, and the helper ends when its stdin closes without waiting for
  // them, so stdin is closed only once all four have answered.
  const ud = require("./uiaDriver.js");
  const cmd = ud.defaultCommand();
  const agent = spawn(cmd.cmd, cmd.args, { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  agent.on("error", (e) => { console.error("uia-agent did not start:", e.message); process.exit(1); });
  agent.stdin.on("error", () => { /* it died; "close" says so */ });
  const said = [];
  const byId = new Map();
  let notJson = false;
  let ended = false;
  let buf = "";
  agent.stdout.setEncoding("utf8");
  agent.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      said.push(line);
      try { const a = JSON.parse(line); byId.set(a && a.id, a); } catch { notJson = true; }
    }
    if (!ended && byId.has(1) && byId.has(2) && byId.has(3) && byId.has(4)) { ended = true; agent.stdin.end(); }
  });
  const timer = setTimeout(() => { console.error("no answers in 90 s:", said.join(" | ").slice(0, 600)); agent.kill(); process.exit(1); }, 90000);
  // "close", not "exit": by then everything it wrote has been read.
  agent.on("close", (code, signal) => {
    clearTimeout(timer);
    console.log("uia-agent said:", said.map((l) => l.replace(/"data":"[^"]{40}[^"]*"/, '"data":"…"')).join(" | ").slice(0, 900));
    if (code !== 0) { console.error("uia-agent did not exit cleanly:", code, signal || ""); process.exit(1); }
    if (notJson) { console.error("uia-agent wrote a line that is not JSON"); process.exit(1); }
    const [ping, snap, look, caret] = [1, 2, 3, 4].map((id) => byId.get(id));
    if (said.length !== 4
      || !ping || ping.ok !== true || ping.pong !== true
      || !snap || typeof snap.ok !== "boolean"
      || (snap.ok ? (snap.scale !== "pixels" || !Array.isArray(snap.elements)) : typeof snap.error !== "string")) {
      console.error("uia-agent's answers are not the shapes uiaDriver.js reads");
      process.exit(1);
    }
    if (ping.look !== true || ping.ocr !== true || ping.pool !== true) {
      console.error("uia-agent cannot look: its ping says", JSON.stringify({ look: ping.look, ocr: ping.ocr, pool: ping.pool }));
      process.exit(1);
    }
    // The caret's C# compiled, or every caret would answer no_caret.
    if (ping.caret !== true) { console.error("uia-agent cannot read the caret: its ping says", JSON.stringify({ caret: ping.caret })); process.exit(1); }
    const isFrame = (f) => Array.isArray(f) && f.length === 4 && f.every(Number.isFinite);
    if (!look || typeof look.ok !== "boolean"
      || (!look.ok && look.error !== "no_window")
      || (look.ok && (!look.window || !isFrame(look.window.frame) || !(look.window.frame[2] > 0 && look.window.frame[3] > 0)
        || typeof look.window.title !== "string" || look.scale !== "pixels"
        || !Array.isArray(look.lines) || look.lines.length > 300
        || look.lines.some((l) => typeof l.text !== "string" || !l.text || l.text.length > 120 || !isFrame(l.frame))
        // Where the title is drawn, frames only: the TzShot.Reply field the
        // device cuts the picture by, from the real C# and worker.
        || !Array.isArray(look.titleFrames) || look.titleFrames.length > 8 || !look.titleFrames.every(isFrame)
        || !(look.ocr === "ok" || look.ocr === "partial") || typeof look.ms !== "number"
        || !look.image || look.image.mime !== "image/jpeg" || typeof look.image.data !== "string"
        || !Buffer.from(look.image.data, "base64").subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))
        || !(Math.max(look.image.width, look.image.height) <= 640)))) {
      console.error("uia-agent's look is not the shape uiaDriver.js reads:", JSON.stringify(look && { ...look, image: look.image && "…" }).slice(0, 400));
      process.exit(1);
    }
    // The caret (peek-spec §A): its fields and no others, so no text can ride
    // along; how it was found is one of the C#'s own words.
    const isBox = (f) => f === null || (isFrame(f) && f[2] >= 0 && f[3] > 0);
    const CARET_FIELDS = ["id", "ok", "caret", "field", "app", "scale", "how", "ms"];
    if (!caret || typeof caret.ok !== "boolean"
      || (!caret.ok && (caret.error !== "no_window" || Object.keys(caret).some((k) => !["id", "ok", "error"].includes(k))))
      || (caret.ok && (!isBox(caret.caret) || !isBox(caret.field) || caret.scale !== "pixels"
        || !caret.app || typeof caret.app.name !== "string" || !Number.isInteger(caret.app.pid)
        || Object.keys(caret).some((k) => !CARET_FIELDS.includes(k))
        || !/^(caret|selection|system|none|secure)(\+(char|before))?$/.test(caret.how) || typeof caret.ms !== "number"))) {
      console.error("uia-agent's caret is not the shape uiaDriver.js reads:", JSON.stringify(caret).slice(0, 300));
      process.exit(1);
    }
    console.log(`the UIA agent answers (snapshot: ${snap.ok ? snap.elements.length + " elements, app " + JSON.stringify(snap.app && snap.app.name) : snap.error}; `
      + `look: ${look.ok ? look.lines.length + " lines, a " + look.image.width + "x" + look.image.height + " picture in " + look.ms + " ms" : look.error}; `
      + `caret: ${caret.ok ? JSON.stringify({ caret: caret.caret, field: caret.field, how: caret.how }) + " in " + caret.ms + " ms" : caret.error})`);
  });
  agent.stdin.write(['{"id":1,"cmd":"ping"}', '{"id":2,"cmd":"snapshot","max":20}',
    '{"id":3,"cmd":"look","maxSide":640,"budgetMs":4000}', '{"id":4,"cmd":"caret","budgetMs":3000}'].join("\n") + "\n");
} else {
  console.error("usage: node nativeCheck.js win|mac|winagent");
  process.exit(2);
}
