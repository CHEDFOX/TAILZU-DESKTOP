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
    if (lines.length !== 3) { console.error("expected three answers, got:", JSON.stringify(out)); process.exit(1); }
    const [app, field, around] = lines.map((l) => JSON.parse(l));
    console.log("app:", JSON.stringify(app));
    console.log("field:", JSON.stringify(field), "→", JSON.stringify(fa.windowsField(field, 500)));
    console.log("around:", (around.parts || []).length, "parts →", JSON.stringify(fa.windowsSurroundings(around, 300)).slice(0, 200));
    if (!("app" in app) || !("ok" in field) || !("ok" in around)) { console.error("answers are not the shapes frontApp.js reads"); process.exit(1); }
  });
  ps.stdin.write("q\nf500\ns1000\n");
  ps.stdin.end();
} else {
  console.error("usage: node nativeCheck.js win|mac");
  process.exit(2);
}
