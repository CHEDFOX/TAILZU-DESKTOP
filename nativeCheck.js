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
  console.log("the field's AppleScript compiles");
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
    if (lines.length !== 2) { console.error("expected two answers, got:", JSON.stringify(out)); process.exit(1); }
    const [app, field] = lines.map((l) => JSON.parse(l));
    console.log("app:", JSON.stringify(app));
    console.log("field:", JSON.stringify(field), "→", JSON.stringify(fa.windowsField(field, 500)));
    if (!("app" in app) || !("ok" in field)) { console.error("answers are not the shapes frontApp.js reads"); process.exit(1); }
  });
  ps.stdin.write("q\nf500\n");
  ps.stdin.end();
} else {
  console.error("usage: node nativeCheck.js win|mac");
  process.exit(2);
}
