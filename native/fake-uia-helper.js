// A tiny stand-in for uia-agent.ps1, for uiaDriver.test.js on any platform.
// It speaks the same JSON-lines protocol and can misbehave on purpose, so the
// Node driver can be tested against out-of-order answers, timeouts, a helper
// that dies, and lines that are not JSON — none of which a real PowerShell on
// Linux could produce here.
//
//   node fake-uia-helper.js <mode> [stateFile]
//
// Every mode answers `ping` at once, so the driver's warm-up resolves fast.
// The look modes: "slowlook" (a look answered late, everything else at once),
// "hanglook" (a look never answered), "biglook" (a 2 MB picture), "badlook"
// (a look that keeps to none of the contract), "nowindow" and "noframe".
const fs = require("fs");
const readline = require("readline");

const mode = process.argv[2] || "normal";
const stateFile = process.argv[3];

// "die" needs to know which spawn it is: the first dies, the second behaves.
let spawnNo = 1;
if (stateFile) {
  let n = 0;
  try { n = parseInt(fs.readFileSync(stateFile, "utf8"), 10) || 0; } catch { n = 0; }
  spawnNo = n + 1;
  try { fs.writeFileSync(stateFile, String(spawnNo)); } catch { /* best effort */ }
}

function write(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

function snapshotAnswer(msg) {
  return {
    id: msg.id, ok: true,
    app: { name: "Fake", pid: 42 },
    // The title is the device's alone (agent.js checks it, never sends it).
    window: { frame: [0, 0, 800, 600], title: "Fake window" },
    focused: null, selection: "", scale: "pixels",
    elements: [], truncated: false, ms: 1,
    echoMax: msg.max,   // echoed so a test can tell one snapshot's answer from another's
    echoBudget: msg.budgetMs,   // and so a test can see the walk's budget arrive
  };
}

// A look in the contract's shape (v2 §A). The picture's bytes are not a JPEG,
// only base64 of the right shape; "biglook" makes it as long as a real one of a
// large window, so the answer spans many reads on the driver's side.
function lookAnswer(msg) {
  const data = mode === "biglook" ? "A".repeat(2000000) : "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBD";
  return {
    id: msg.id, ok: true,
    window: { frame: [-1820, 50, 800, 600], title: "Fake window" },
    scale: "pixels",
    lines: [
      { text: "Export as PDF", frame: [-1800, 70, 94, 18] },
      { text: "x\u00b2 + 1 = 0", frame: [-1700, 350, 120, 30] },
    ],
    image: { mime: "image/jpeg", data, width: 800, height: 600 },
    ocr: "ok", ms: 4,
    // Echoed so a test can see the options arrive as the driver sent them.
    echo: { budgetMs: msg.budgetMs, maxSide: msg.maxSide, quality: msg.quality, ocr: msg.ocr, image: msg.image },
  };
}

// A look answer that keeps to nothing: lines without text or frames, far too
// many and too long, a picture with no data.
function badLookAnswer(msg) {
  const lines = [null, { text: 5, frame: [1, 2, 3, 4] }, { text: "no frame" }, { text: "   ", frame: [1, 2, 3, 4] },
    { text: "short frame", frame: [1, 2, 3] }];
  for (let i = 0; i < 400; i++) lines.push({ text: `line ${i} ` + "w".repeat(200), frame: [0, i * 10, 50, 9], conf: 0.5 });
  return {
    id: msg.id, ok: true,
    window: { frame: [0, 0, 800, 600], title: 42 },
    scale: "points",
    lines,
    image: { mime: "image/jpeg", data: "", width: 800, height: 600 },
    ms: "soon",
  };
}

function answer(msg) {
  if (msg.cmd === "ping") return { id: msg.id, ok: true, pong: true };
  if (msg.cmd === "snapshot") return snapshotAnswer(msg);
  if (msg.cmd === "look") {
    if (mode === "badlook") return badLookAnswer(msg);
    if (mode === "nowindow") return { id: msg.id, ok: false, error: "no_window" };
    if (mode === "noframe") return { ...lookAnswer(msg), window: { title: "x" } };
    return lookAnswer(msg);
  }
  return { id: msg.id, ok: true, cmd: msg.cmd };
}

const reorderBuf = [];

// "deaf" dies the slow way: it answers the warm-up ping, then stops reading
// (closes fd 0, so nothing reads the pipe any more) and exits only a little
// later. Every write the driver makes in between hits a pipe nobody reads,
// which is an EPIPE on the driver's side: it must be swallowed, and the exit
// must settle every call still waiting. The ping is read synchronously, before
// process.stdin exists, because Node never closes fd 0 under a stdin stream.
if (mode === "deaf") {
  let first = "";
  const b = Buffer.alloc(1);
  while (!first.endsWith("\n") && fs.readSync(0, b, 0, 1, null) === 1) first += b.toString("utf8");
  let msg = null;
  try { msg = JSON.parse(first); } catch { msg = null; }
  if (msg) write(answer(msg));
  fs.closeSync(0);
  setTimeout(() => process.exit(1), 600);
}

const rl = mode === "deaf" ? null : readline.createInterface({ input: process.stdin });
if (rl) rl.on("line", (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { write({ id: null, ok: false, error: "malformed" }); return; }

  // ping always answers immediately, whatever the mode.
  if (msg.cmd === "ping") { write(answer(msg)); return; }

  switch (mode) {
    case "reorder":
      // Collect two real commands, then answer them in reverse order; the
      // driver must still settle each by its id.
      reorderBuf.push(msg);
      if (reorderBuf.length >= 2) {
        const [a, b] = reorderBuf.splice(0, 2);
        write(answer(b));
        write(answer(a));
      }
      break;

    case "timeout":
      // Swallow everything but ping: the request must resolve on the driver's
      // own timeout, not here.
      break;

    case "late":
      // Answer, but only well after a short-timeout request has given up, to
      // prove a late answer is ignored rather than mis-settling anything.
      setTimeout(() => write(answer(msg)), 300);
      break;

    case "garbage":
      // A non-JSON line the driver must skip, then the real answer.
      process.stdout.write("this is not json\n");
      write(answer(msg));
      break;

    case "die":
      if (spawnNo === 1) { process.exit(1); }   // the first helper dies on the first command
      write(answer(msg));
      break;

    case "slowlook":
      // As the real helper does: a look is made on a thread of its own and
      // answered when done, while everything asked after it is answered at
      // once, ahead of it.
      if (msg.cmd === "look") setTimeout(() => write(answer(msg)), 400);
      else write(answer(msg));
      break;

    case "hanglook":
      // A look that never comes back; everything else answers.
      if (msg.cmd !== "look") write(answer(msg));
      break;

    case "normal":
    default:
      write(answer(msg));
      break;
  }
});
