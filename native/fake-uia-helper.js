// A tiny stand-in for uia-agent.ps1, for uiaDriver.test.js on any platform.
// It speaks the same JSON-lines protocol and can misbehave on purpose, so the
// Node driver can be tested against out-of-order answers, timeouts, a helper
// that dies, and lines that are not JSON — none of which a real PowerShell on
// Linux could produce here.
//
//   node fake-uia-helper.js <mode> [stateFile]
//
// Every mode answers `ping` at once, so the driver's warm-up resolves fast.
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
    window: { frame: [0, 0, 800, 600] },
    focused: null, selection: "", scale: "pixels",
    elements: [], truncated: false, ms: 1,
    echoMax: msg.max,   // echoed so a test can tell one snapshot's answer from another's
  };
}

function answer(msg) {
  if (msg.cmd === "ping") return { id: msg.id, ok: true, pong: true };
  if (msg.cmd === "snapshot") return snapshotAnswer(msg);
  return { id: msg.id, ok: true, cmd: msg.cmd };
}

const reorderBuf = [];

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
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

    case "normal":
    default:
      write(answer(msg));
      break;
  }
});
