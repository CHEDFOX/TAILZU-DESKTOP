// CI ONLY: the halves of frontApp.js that only Windows and a Mac can run,
// run where they can be (build.yml). Not shipped.
//
//   node nativeCheck.js win   the PowerShell answers an app question and a
//                             field question, one JSON line each, in order
//   node nativeCheck.js mac   the field's AppleScript compiles (running it
//                             needs Accessibility, which a CI Mac lacks)
//   node nativeCheck.js winagent  Ask's Windows UIA helper answers a ping and
//                             a snapshot (shapes only; a runner has no app)
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
  // way or the other, and exit when its stdin closes.
  execFileSync("npm", ["run", "tzax"], { stdio: "inherit", cwd: __dirname });
  const ax = require("child_process").spawnSync(path.join(__dirname, "build", "tzax"), [], {
    input: ['{"id":1,"cmd":"ping"}', '{"id":2,"cmd":"trusted"}', "not json", '{"id":3,"cmd":"snapshot","max":20}'].join("\n") + "\n",
    encoding: "utf8", timeout: 20000,
  });
  const said = String(ax.stdout || "").trim().split("\n").filter(Boolean);
  console.log("tzax said:", said.join(" | ").slice(0, 600));
  if (ax.error || ax.status !== 0) { console.error("tzax did not exit cleanly:", ax.error || ax.status, ax.signal || ""); process.exit(1); }
  let answers;
  try { answers = said.map((l) => JSON.parse(l)); } catch { console.error("tzax wrote a line that is not JSON"); process.exit(1); }
  const [ping, trust, bad, snap] = answers;
  if (answers.length !== 4
    || !ping || ping.id !== 1 || ping.ok !== true || ping.pong !== true
    || !trust || trust.id !== 2 || trust.ok !== true || typeof trust.trusted !== "boolean"
    || !bad || bad.id !== null || bad.ok !== false
    || !snap || snap.id !== 3 || typeof snap.ok !== "boolean" || (snap.ok ? !Array.isArray(snap.elements) : typeof snap.error !== "string")) {
    console.error("tzax's answers are not the shapes axDriver.js reads");
    process.exit(1);
  }
  console.log(`the accessibility helper answers (trusted: ${trust.trusted}; snapshot: ${snap.ok ? snap.elements.length + " elements" : snap.error})`);
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
  // uiaDriver.js), run for real on the Windows runner: it must answer a ping
  // and a snapshot, one JSON line each, and exit when its stdin closes. A CI
  // runner has a desktop with some window in front, so the snapshot may come
  // back ok with elements or ok:false with a reason — only the shapes are
  // required here, never specific elements.
  const ud = require("./uiaDriver.js");
  const cmd = ud.defaultCommand();
  const agent = require("child_process").spawnSync(cmd.cmd, cmd.args, {
    input: ['{"id":1,"cmd":"ping"}', '{"id":2,"cmd":"snapshot","max":20}'].join("\n") + "\n",
    encoding: "utf8", timeout: 90000, windowsHide: true,
  });
  const said = String(agent.stdout || "").trim().split(/\r?\n/).filter(Boolean);
  console.log("uia-agent said:", said.join(" | ").slice(0, 600));
  if (agent.error || agent.status !== 0) { console.error("uia-agent did not exit cleanly:", agent.error || agent.status, agent.signal || ""); process.exit(1); }
  let answers;
  try { answers = said.map((l) => JSON.parse(l)); } catch { console.error("uia-agent wrote a line that is not JSON"); process.exit(1); }
  const [ping, snap] = answers;
  if (answers.length !== 2
    || !ping || ping.id !== 1 || ping.ok !== true || ping.pong !== true
    || !snap || snap.id !== 2 || typeof snap.ok !== "boolean"
    || (snap.ok ? (snap.scale !== "pixels" || !Array.isArray(snap.elements)) : typeof snap.error !== "string")) {
    console.error("uia-agent's answers are not the shapes uiaDriver.js reads");
    process.exit(1);
  }
  console.log(`the UIA agent answers (snapshot: ${snap.ok ? snap.elements.length + " elements, app " + JSON.stringify(snap.app && snap.app.name) : snap.error})`);
} else {
  console.error("usage: node nativeCheck.js win|mac|winagent");
  process.exit(2);
}
