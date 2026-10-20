// A stand-in for build/tzax (native/tzax.swift) that speaks the same line
// protocol, so axDriver.test.js can run the driver anywhere: one JSON command
// per line in, one JSON answer per line out, carrying the command's id.
//
// It also misbehaves on cue, the ways the real helper might:
//   press e<N>      answers after N ms (so two presses can finish out of order)
//   press e999      never answers (the driver's timeout)
//   key "die"       exits without answering
//   key "hang"      stays alive and never answers anything again
//   open "noshape"  answers with no "ok" in it
//   snapshot        is preceded by junk lines and written in two pieces
//   snapshot max 2  has a window without a title (an older helper)
//   snapshot max 3  has a window title longer than 200 characters
//   snapshot max 4  has no window at all
// Every answer carries `got` (the command as received) and `pid`, so a test
// can see what was sent and whether the helper was started again.
const readline = require("readline");

let hung = false;
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

const SNAPSHOT = {
  ok: true,
  app: { name: "Fake", pid: 4242, bundleId: "space.tailzu.fake" },
  window: { frame: [100, 80, 800, 600], title: "Q3 plan.txt — Fake" },
  focused: "e2",
  selection: "",
  scale: "points",
  elements: [
    { id: "e1", role: "menu", label: "File", frame: [40, 0, 36, 24] },
    { id: "e2", role: "field", label: "Search", value: "", frame: [120, 100, 300, 28], focused: true },
    { id: "e3", role: "button", label: "Export", frame: [700, 100, 80, 28] },
  ],
  truncated: false,
  ms: 3,
};

function answer(req) {
  const base = { id: req.id, got: req, pid: process.pid };
  switch (req.cmd) {
    case "ping":
      return send({ ...base, ok: true, pong: true });
    case "trusted":
      return send({ ...base, ok: true, trusted: true });
    case "snapshot": {
      // Lines the driver must step over without losing the real answer.
      process.stdout.write("not json at all\n");
      process.stdout.write("[1,2,3]\n");
      process.stdout.write("null\n");
      process.stdout.write('{"id":-7,"ok":true}\n');
      process.stdout.write('{"ok":true,"elements":[]}\n');
      process.stdout.write("\n");
      const snap = { ...SNAPSHOT };
      if (req.max === 2) snap.window = { frame: SNAPSHOT.window.frame };
      if (req.max === 3) snap.window = { ...SNAPSHOT.window, title: "Private Browsing — " + "x".repeat(300) };
      if (req.max === 4) delete snap.window;
      const line = JSON.stringify({ ...base, ...snap }) + "\n";
      const cut = Math.floor(line.length / 2);
      process.stdout.write(line.slice(0, cut));
      setTimeout(() => process.stdout.write(line.slice(cut)), 15);
      return;
    }
    case "press": {
      const n = Number(String(req.el || "").slice(1));
      if (n === 999) return;
      setTimeout(() => send({ ...base, ok: true, how: "AXPress" }), Math.min(n, 2000));
      return;
    }
    case "key":
      if (req.chord === "die") process.exit(3);
      if (req.chord === "hang") { hung = true; return; }
      return send({ ...base, ok: true });
    case "open":
      if (req.app === "noshape") return send({ id: req.id, nope: 1 });
      return send({ ...base, ok: true });
    case "click":
    case "setValue":
    case "focus":
    case "scroll":
      return send({ ...base, ok: true });
    default:
      return send({ ...base, ok: false, error: "unknown_command" });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (hung || !line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return send({ id: null, ok: false, error: "bad_json" }); }
  if (!req || typeof req !== "object" || Array.isArray(req)) return send({ id: null, ok: false, error: "bad_json" });
  answer(req);
});
// Like the real helper: stdin closing means the app is gone.
rl.on("close", () => { if (!hung) process.exit(0); });
