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
//
// AND THE FIELD ITSELF (focusedField, below). The owner: "first the screen and
// app awareness". "Gmail" is the search box, the To line, the subject and the
// message at once, and only the message wants sentences. The focused field
// is asked of the system's accessibility layer, the same permission the
// paste already needs on a Mac: what kind it is (a search box, an address
// bar, a text area), its label or placeholder ("Search mail", "Subject"),
// and what is already written before the cursor, as the phone keyboards
// send it. A password field is never read and never described.

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

// ---- The field ------------------------------------------------------------------
/**
 * What kind of field it is, from the accessibility role ("field", "area",
 * "combo"), its subrole and its label, in the words the server takes
 * (search | url | email | message | text | longtext), "password" for a
 * password field, or null for anything that is not a text field.
 */
function kindOf(role, subrole, lbl) {
  const L = String(lbl || "");
  if (/secure|password/i.test(subrole || "")) return "password";
  if (/search/i.test(subrole || "")) return "search";
  if (role === "field" || role === "combo") {
    if (/\b(?:address and search|address bar|search or (?:type|enter) (?:a |web )?(?:address|url)|url)\b/i.test(L)) return "url";
    if (/\bsearch\b/i.test(L)) return "search";
    if (/\be-?mail(?: address)?\b/i.test(L) && !/\bmessage\b/i.test(L)) return "email";
    return "text";
  }
  if (role === "area") return /\b(?:message|reply|chat|comment)\b/i.test(L) ? "message" : "longtext";
  return null;
}

/** The field as it leaves this computer: its kind, its label (one short
 *  line) and, only when the cursor itself was read, what is before it. */
function fieldOf({ role, subrole, label: lbl, caret, before }, chars = 1000) {
  const kind = kindOf(role, subrole, lbl);
  if (!kind || kind === "password") return null;
  const out = { kind };
  const l = String(lbl || "").replace(/[\u0000-\u001f<>]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  if (l) out.label = l;
  // A guess at the cursor would put a capital or a space where none
  // belongs; no cursor, no text.
  if (caret && typeof before === "string") out.before = before.slice(-chars);
  return out;
}

const WIN_ROLES = { "ControlType.Edit": "field", "ControlType.Document": "area", "ControlType.ComboBox": "combo" };
/** UI Automation's answer (see PS, "f"), read. */
function windowsField(o, chars) {
  if (!o || !o.ok) return null;
  return fieldOf({
    role: WIN_ROLES[o.type], subrole: o.password ? "password" : "",
    label: o.name || o.help, caret: !!o.caret, before: o.before,
  }, chars);
}

const MAC_ROLES = { AXTextField: "field", AXTextArea: "area", AXComboBox: "combo", AXSearchField: "field" };
const RS = "\u001e";
/** System Events' answer (see macField), read. */
function macFieldOf(out, chars) {
  const [role, subrole, placeholder, description, title, caret, ...rest] = String(out || "").replace(/\r?\n$/, "").split(RS);
  if (!role) return null;
  return fieldOf({
    role: MAC_ROLES[role], subrole,
    label: placeholder || description || title,
    caret: caret === "yes", before: rest.join(RS),
  }, chars);
}

// ---- Windows ------------------------------------------------------------------
// One PowerShell, two questions: "q" is the app in front, "f<chars>" the
// field with the keyboard's focus (UI Automation: its control type, whether
// it is a password, its name, and the text before the caret through the
// TextPattern, no more than <chars> of it).
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
$uia = $false
try { Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes; $uia = $true } catch {}
function TzField([int]$chars) {
  $o = @{ ok = $false }
  if (-not $uia) { return $o }
  try {
    $el = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($el -eq $null) { return $o }
    $c = $el.Current
    $o.ok = $true
    $o.type = $c.ControlType.ProgrammaticName
    $o.password = [bool]$c.IsPassword
    $o.name = $c.Name
    $o.help = $c.HelpText
    if (-not $o.password) {
      $tp = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {
        $sel = $tp.GetSelection()
        if ($sel -and $sel.Length -gt 0) {
          $r = $sel[0].Clone()
          [void]$r.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::End, $sel[0], [System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start)
          [void]$r.MoveEndpointByUnit([System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start, [System.Windows.Automation.Text.TextUnit]::Character, -$chars)
          $o.before = $r.GetText($chars + 8)
          $o.caret = $true
        }
      }
    }
  } catch {}
  return $o
}
[Console]::OutputEncoding = [Text.Encoding]::UTF8
while ($true) {
  $q = [Console]::In.ReadLine()
  if ($q -eq $null) { break }
  if ($q.StartsWith('f')) {
    [int]$n = 1000
    [void][int]::TryParse($q.Substring(1), [ref]$n)
    [Console]::Out.WriteLine((ConvertTo-Json -Compress (TzField $n)))
    [Console]::Out.Flush()
    continue
  }
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
      // One answer per question, in the order asked: a late one still
      // settles the question it belongs to, never the next one's.
      const done = psWaiting.shift();
      if (!done) continue;
      try { done(JSON.parse(line)); } catch { done(null); }
    }
  });
  const fail = () => { ps = null; while (psWaiting.length) psWaiting.shift()(null); };
  ps.on("exit", fail);
  ps.on("error", fail);
  return ps;
}
function psAsk(q) {
  return new Promise((resolve) => {
    try { const p = psProcess(); psWaiting.push(resolve); p.stdin.write(q + "\n"); } catch { resolve(null); }
  });
}
function windowsApp() { return psAsk("q").then((o) => (o ? label(o.app, o.title) : null)); }

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

/**
 * The focused element of the app in front, asked of System Events. Electron
 * and Chromium apps (Slack, Chrome, VS Code) build their accessibility tree
 * only when asked to, so they are asked first (AXManualAccessibility, which
 * changes nothing else about them). A secure text field's value is never
 * read. The selection's start is the cursor; without it, no text.
 */
function macFieldScript(chars) {
  return `
on attr(el, nm)
  tell application "System Events"
    try
      set x to value of attribute nm of el
      if x is missing value then return ""
      return x as text
    end try
  end tell
  return ""
end attr
set RS to character id 30
tell application "System Events"
  set p to first application process whose frontmost is true
  try
    set value of attribute "AXManualAccessibility" of p to true
  end try
  set el to value of attribute "AXFocusedUIElement" of p
end tell
set r to attr(el, "AXRole")
set sr to attr(el, "AXSubrole")
set b to ""
set caret to "no"
if sr is not "AXSecureTextField" and r is in {"AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"} then
  set v to missing value
  set rng to missing value
  tell application "System Events"
    try
      set v to value of attribute "AXValue" of el
      set rng to value of attribute "AXSelectedTextRange" of el
    end try
  end tell
  -- Cut outside System Events, whose own words would read "text" as a UI element.
  try
    if v is missing value or rng is missing value then error "no cursor"
    set v to v as text
    set c to (item 1 of rng) - 1
    set n to count of v
    if c >= 0 and c <= n then
      set s0 to c - ${Math.max(1, chars | 0)}
      if s0 < 0 then set s0 to 0
      if c > 0 then set b to text (s0 + 1) thru c of v
      set caret to "yes"
    end if
  end try
end if
return r & RS & sr & RS & attr(el, "AXPlaceholderValue") & RS & attr(el, "AXDescription") & RS & attr(el, "AXTitle") & RS & caret & RS & b
`;
}
function macField(chars) {
  return new Promise((resolve) => {
    execFile("osascript", ["-e", macFieldScript(chars)], { timeout: 1500, maxBuffer: 1 << 20 }, (err, out) => resolve(err ? null : macFieldOf(out, chars)));
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

/**
 * The field with the keyboard's focus: { kind, label?, before? }, or null
 * (not a text field, a password field, no permission, Linux, or too slow).
 * Never waits more than `timeoutMs`.
 */
function focusedField({ chars = 1000, timeoutMs = 1200 } = {}) {
  const n = Math.max(0, Math.min(4000, chars | 0));
  const ask = process.platform === "win32" ? psAsk("f" + n).then((o) => windowsField(o, n))
    : process.platform === "darwin" ? macField(n)
    : Promise.resolve(null);
  return Promise.race([ask, new Promise((r) => setTimeout(() => r(null), timeoutMs))]).catch(() => null);
}

/** Started early, so the first press is not the one that waits for PowerShell. */
function warmUp() { if (process.platform === "win32") { try { psProcess(); } catch { /* asked again on the first press */ } } }
function shutDown() { if (ps) { try { ps.stdin.end(); ps.kill(); } catch { /* gone */ } ps = null; } }

module.exports = { frontApp, focusedField, warmUp, shutDown, label, siteOf, kindOf, fieldOf, windowsField, macFieldOf, macFieldScript, PS };
