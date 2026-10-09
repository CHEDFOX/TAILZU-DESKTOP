// CI ONLY: the halves of frontApp.js that only Windows and a Mac can run,
// run where they can be (build.yml). Not shipped.
//
//   node nativeCheck.js win   the PowerShell answers an app question and a
//                             field question, one JSON line each, in order
//   node nativeCheck.js mac   the field's AppleScript compiles (running it
//                             needs Accessibility, which a CI Mac lacks)
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
} else {
  console.error("usage: node nativeCheck.js win|mac");
  process.exit(2);
}
