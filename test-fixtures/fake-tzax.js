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
//   look            a window, three lines of text and a picture (none when
//                   asked for no text / no picture), like the real helper's
//   look maxSide 999  answers no_screen_permission (a Mac without the permission)
//   look maxSide 998  never answers
//   look maxSide 997  answers after 400 ms
//   look maxSide 996  answers with junk to be cleaned: bad lines, 350 lines,
//                     long text, odd confidences, no title, a picture that is not one
//   look maxSide 995  answers ok with no window
//   look maxSide 994  has a picture of several megabytes, written in pieces
//   look maxSide 993  is written in pieces with no newline in them, the
//                     newline coming last, in a piece with a stray answer
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

const LINES = [
  { text: "Export as PDF", frame: [180, 140, 240, 30], conf: 0.93 },
  { text: "x² + y² = 1", frame: [180, 326, 200, 24], conf: 0.7 },
  { text: "Q3 revenue", frame: [500, 326, 160, 24], conf: 0.88 },
];
// A 1×1 white JPEG: the picture is opaque to the driver, but it may as well be one.
const JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

function look(req, base) {
  const window = { frame: [100, 50, 800, 600], title: "Q3 plan.txt — Fake" };
  const good = {
    ...base, ok: true, app: { name: "Fake", pid: 4242 }, window, scale: "points",
    lines: req.ocr === false ? [] : LINES,
    image: req.image === false ? null : { mime: "image/jpeg", data: JPEG, width: 1600, height: 1200 },
    ms: 12,
  };
  switch (req.maxSide) {
    case 999: return send({ ...base, ok: false, error: "no_screen_permission" });
    case 998: return;
    case 997: return setTimeout(() => send(good), 400);
    case 996: {
      const junk = [
        null, 7, "text", { text: "no frame" }, { text: "short frame", frame: [1, 2, 3] },
        { text: "a string frame", frame: ["1", 2, 3, 4] }, { text: "negative size", frame: [1, 2, -3, 4] },
        { text: "   ", frame: [1, 2, 3, 4] }, { text: 42, frame: [1, 2, 3, 4] },
        { text: "y".repeat(500), frame: [1, 2, 3, 4], conf: 7 },
        { text: "no conf", frame: [5, 6, 7, 8] },
        { text: "odd conf", frame: [5, 6, 7, 8], conf: "high" },
      ];
      const many = Array.from({ length: 350 }, (_, i) => ({ text: "line " + i, frame: [0, i, 10, 1], conf: -1 }));
      return send({
        ...base, ok: true, window: { frame: [100, 50, 800, 600] }, scale: "weird",
        lines: [...junk, ...many], image: { mime: "text/html", data: "PGgxPg==", width: 1, height: 1 },
      });
    }
    case 995: return send({ ...base, ok: true, lines: LINES, image: null });
    case 994: {
      const line = JSON.stringify({ ...good, image: { ...good.image, data: "A".repeat(5 << 20) } }) + "\n";
      const step = 1 << 16;
      for (let i = 0; i < line.length; i += step) process.stdout.write(line.slice(i, i + step));
      return;
    }
    case 993: {
      const line = JSON.stringify(good);
      const cut = Math.floor(line.length / 3);
      process.stdout.write(line.slice(0, cut));
      setTimeout(() => process.stdout.write(line.slice(cut)), 10);
      setTimeout(() => process.stdout.write('\n{"id":-3,"ok":true}\n'), 25);
      return;
    }
    default: return send(good);
  }
}

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
    case "look":
      return look(req, base);
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
