// WHICH APP THEY ARE DICTATING INTO.
//
// Every request from this computer used to say "Desktop", so the writer could
// not tell an email from a chat from a prompt for ChatGPT, and the Today page
// labelled every line DESKTOP. The owner: "it should show for all, and the
// desktop app also".
//
// Asked of the system at the moment dictation starts, while the app they are
// typing into is still the one in front:
//
//   Windows  one PowerShell kept open for the whole run, asked per press, so
//            the answer costs milliseconds rather than a PowerShell start.
//   Mac      System Events, the same route the paste already takes.
//   Linux    xdotool, when it is installed; nothing when it is not.
//
// WHAT LEAVES THIS COMPUTER IS A NAME, NOT A TITLE. A window title can hold an
// email subject or a document's name, so only the app is sent — and for a
// browser, the site, taken from the end of the tab's title ("…- Gmail"),
// because "Chrome" alone says nothing about where the words are going.

const { spawn, execFile } = require("child_process");

const BROWSERS = /^(?:google chrome|chrome|chromium|microsoft edge|msedge|edge|firefox|mozilla firefox|brave|brave browser|opera|vivaldi|arc|safari|zen)$/i;
const SHORT = { "google chrome": "Chrome", "microsoft edge": "Edge", "msedge": "Edge", "mozilla firefox": "Firefox", "brave browser": "Brave" };

/** The site a browser tab is on, from its title: the last part that is not the browser's own. */
function siteOf(title, app) {
  const skip = new RegExp(`^(?:${app}|google chrome|chrome|microsoft\\s*edge|edge|mozilla firefox|firefox|brave|safari|opera|vivaldi|arc|personal|work|profile \\d+|and \\d+ more pages?)$`, "i");
  const parts = String(title || "")
    .replace(/[​-‍﻿]/g, "")
    .split(/\s+[-–—|·]\s+/)
    .map((p) => p.replace(/^\(\d+\+?\)\s*/, "").trim())
    .filter((p) => p && !skip.test(p));
  // From the end: the site's name is last; skip anything that looks like an
  // address or an account, which is theirs and not a site.
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (/@|\d{4,}/.test(p) || p.length > 40) continue;
    return p;
  }
  return "";
}

/** "Chrome: Gmail", "Slack", "WhatsApp". At most 40 characters, one line. */
function label(app, title) {
  const raw = String(app || "").replace(/\.exe$/i, "").replace(/[\r\n<>]+/g, " ").trim();
  if (!raw) return null;
  const name = SHORT[raw.toLowerCase()] || raw;
  if (!BROWSERS.test(raw)) return name.slice(0, 40);
  const site = siteOf(title, raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return (site ? `${name}: ${site}` : name).slice(0, 40);
}

// ---- Windows ------------------------------------------------------------------
const PS = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class TzFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
'@
[Console]::OutputEncoding = [Text.Encoding]::UTF8
while ($true) {
  $q = [Console]::In.ReadLine()
  if ($q -eq $null) { break }
  $h = [TzFg]::GetForegroundWindow()
  [uint32]$procId = 0
  [void][TzFg]::GetWindowThreadProcessId($h, [ref]$procId)
  $sb = New-Object Text.StringBuilder 512
  [void][TzFg]::GetWindowText($h, $sb, 512)
  $name = ''
  $p = Get-Process -Id $procId
  if ($p) {
    $name = $p.ProcessName
    try { $d = $p.MainModule.FileVersionInfo.FileDescription; if ($d) { $name = $d } } catch {}
  }
  [Console]::Out.WriteLine((ConvertTo-Json -Compress @{ app = $name; title = $sb.ToString() }))
  [Console]::Out.Flush()
}
`;

let ps = null;
let psBuf = "";
const psWaiting = [];
function psProcess() {
  if (ps && !ps.killed && ps.exitCode === null) return ps;
  psBuf = "";
  ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", Buffer.from(PS, "utf16le").toString("base64")], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  ps.stdout.setEncoding("utf8");
  ps.stdout.on("data", (d) => {
    psBuf += d;
    let i;
    while ((i = psBuf.indexOf("\n")) >= 0) {
      const line = psBuf.slice(0, i).trim(); psBuf = psBuf.slice(i + 1);
      const done = psWaiting.shift();
      if (!done) continue;
      try { const o = JSON.parse(line); done(label(o.app, o.title)); } catch { done(null); }
    }
  });
  const fail = () => { ps = null; while (psWaiting.length) psWaiting.shift()(null); };
  ps.on("exit", fail);
  ps.on("error", fail);
  return ps;
}
function windowsApp() {
  return new Promise((resolve) => {
    try { const p = psProcess(); psWaiting.push(resolve); p.stdin.write("q\n"); } catch { resolve(null); }
  });
}

// ---- Mac ------------------------------------------------------------------------
function macApp() {
  const script = [
    'tell application "System Events"',
    "set p to first application process whose frontmost is true",
    "set n to name of p",
    'set t to ""',
    "try",
    "set t to name of front window of p",
    "end try",
    "end tell",
    "return n & linefeed & t",
  ];
  return new Promise((resolve) => {
    execFile("osascript", script.flatMap((l) => ["-e", l]), { timeout: 1500 }, (err, out) => {
      if (err) return resolve(null);
      const [app, ...rest] = String(out).split("\n");
      resolve(label(app, rest.join(" ")));
    });
  });
}

// ---- Linux ----------------------------------------------------------------------
function linuxApp() {
  return new Promise((resolve) => {
    execFile("xdotool", ["getactivewindow", "getwindowclassname"], { timeout: 800 }, (err, cls) => {
      if (err) return resolve(null);
      execFile("xdotool", ["getactivewindow", "getwindowname"], { timeout: 800 }, (e2, title) => resolve(label(String(cls).trim(), e2 ? "" : title)));
    });
  });
}

/** The app in front, as a short name, or null. Never waits more than 1.5 s. */
function frontApp() {
  const ask = process.platform === "win32" ? windowsApp() : process.platform === "darwin" ? macApp() : linuxApp();
  return Promise.race([ask, new Promise((r) => setTimeout(() => r(null), 1500))]).catch(() => null);
}

/** Started early, so the first press is not the one that waits for PowerShell. */
function warmUp() { if (process.platform === "win32") { try { psProcess(); } catch { /* asked again on the first press */ } } }
function shutDown() { if (ps) { try { ps.stdin.end(); ps.kill(); } catch { /* gone */ } ps = null; } }

module.exports = { frontApp, warmUp, shutDown, label, siteOf };
