// Tailzu desktop — Electron main process.
//
// The whole point of going desktop: none of the iOS keyboard walls exist here.
// We record the mic directly, send it to the SAME Tailzu backend the mobile app
// uses (/v1/transcribe-clean), get cleaned text back, and paste it into whatever
// app is focused. No extension sandbox, no "can't open the app".
//
// Flow:
//   global hotkey (toggle) → tell the hidden recorder window to start/stop
//   recorder window records mic → POSTs to the backend → returns cleaned text
//   main: copy text to clipboard → synthesize a paste keystroke into the
//         currently-focused app (OS-native, no fragile native module)

const {
  app, Tray, Menu, globalShortcut, BrowserWindow,
  ipcMain, clipboard, Notification, nativeImage, session, shell,
} = require("electron");
const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");

// ---- Config -----------------------------------------------------------------
// Precedence: env vars > config.json (next to this file) > defaults.
// Copy config.example.json → config.json and fill in your token.
let configError = null; // surfaced as a notification once the app is ready
function loadConfig() {
  let file = {};
  const p = path.join(__dirname, "config.json");
  try {
    file = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (err) {
    // Distinguish "no config yet" (fine — env/defaults) from "config EXISTS but
    // is broken JSON" — silently falling back to token "dev" on a typo made a
    // client-side 401 undiagnosable. Surface it loudly instead.
    if (fs.existsSync(p)) configError = "config.json is invalid JSON: " + err.message;
  }
  return {
    baseUrl: (process.env.TAILZU_BASE_URL || file.baseUrl || "https://api.tailzu.space").trim(),
    // trim: a token pasted with a stray space/newline fails auth invisibly.
    token: String(process.env.TAILZU_TOKEN || file.token || "dev").trim(),
    language: process.env.TAILZU_LANGUAGE || file.language || "auto",
    // Electron accelerator string. CommandOrControl = ⌘ on macOS, Ctrl on Win/Linux.
    hotkey: process.env.TAILZU_HOTKEY || file.hotkey || "CommandOrControl+Shift+Space",
    // "clean" (transcribe + LLM cleanup) or "raw" (transcribe only) — the
    // backend endpoint is the same; kept here for a future toggle.
    mode: file.mode || "clean",
  };
}
const cfg = loadConfig();

let tray = null;
let recorderWin = null;
let recording = false;

// ---- Hidden recorder window --------------------------------------------------
// getUserMedia + MediaRecorder live in a renderer (Chromium), so we host them in
// an invisible window. It never takes focus, so the paste still lands in the
// user's real target app.
function createRecorderWindow() {
  recorderWin = new BrowserWindow({
    show: false,
    focusable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  recorderWin.loadFile("recorder.html");
}

// ---- Tray icon ---------------------------------------------------------------
function trayIcon() {
  const p = path.join(__dirname, "assets", "tray.png");
  if (fs.existsSync(p)) {
    const img = nativeImage.createFromPath(p);
    // macOS menu-bar icons render best resized to ~18pt.
    return process.platform === "darwin" ? img.resize({ width: 18, height: 18 }) : img;
  }
  return nativeImage.createEmpty();
}

function refreshTray() {
  if (!tray) return;
  tray.setToolTip(recording ? "Tailzu — listening…" : "Tailzu — ready");
  tray.setContextMenu(buildMenu());
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: recording ? "◉ Listening — press hotkey to stop" : "Dictate", click: toggleDictation },
    { type: "separator" },
    { label: `Hotkey: ${cfg.hotkey}`, enabled: false },
    { label: `Backend: ${cfg.baseUrl}`, enabled: false },
    // Which credential is ACTUALLY loaded — ends the "which token is it using"
    // guessing when auth fails. "dev" here means config.json wasn't read.
    { label: `Token: ${cfg.token === "dev" ? "dev (no config!)" : cfg.token.slice(0, 8) + "…"}`, enabled: false },
    { label: "Edit config…", click: openConfig },
    { type: "separator" },
    { label: "Quit Tailzu", click: () => app.quit() },
  ]);
}

function openConfig() {
  const p = path.join(__dirname, "config.json");
  if (!fs.existsSync(p)) {
    // seed from the example so first-time users have something to edit
    try {
      fs.copyFileSync(path.join(__dirname, "config.example.json"), p);
    } catch { fs.writeFileSync(p, JSON.stringify({ baseUrl: cfg.baseUrl, token: "", hotkey: cfg.hotkey }, null, 2)); }
  }
  shell.openPath(p);
}

// ---- Dictation toggle --------------------------------------------------------
function toggleDictation() {
  if (!recorderWin || recorderWin.isDestroyed()) createRecorderWindow();
  recording = !recording;
  if (recording) {
    recorderWin.webContents.send("start-recording", {
      baseUrl: cfg.baseUrl, token: cfg.token, language: cfg.language,
    });
  } else {
    recorderWin.webContents.send("stop-recording");
  }
  refreshTray();
}

// ---- Paste into the focused app (OS-native, no native module) ----------------
// Text is already on the clipboard; we synthesize the paste shortcut for the
// frontmost app. macOS needs Accessibility permission granted once.
function pasteIntoFocusedApp() {
  if (process.platform === "darwin") {
    execFile("osascript", ["-e", 'tell application "System Events" to keystroke "v" using command down'],
      (err) => { if (err) notifyAccessibility(); });
  } else if (process.platform === "win32") {
    const ps = "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')";
    execFile("powershell", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps], () => {});
  } else {
    // Linux (X11): xdotool. Wayland users may need wtype instead.
    execFile("xdotool", ["key", "--clearmodifiers", "ctrl+v"], () => {});
  }
}

let warnedAccessibility = false;
function notifyAccessibility() {
  if (warnedAccessibility) return;
  warnedAccessibility = true;
  new Notification({
    title: "Tailzu needs Accessibility",
    body: "Text was copied. To auto-paste, enable Tailzu under System Settings → Privacy & Security → Accessibility.",
  }).show();
}

// ---- IPC from the recorder window -------------------------------------------
ipcMain.on("dictation-result", (_e, text) => {
  recording = false;
  refreshTray();
  const t = (text || "").trim();
  if (!t) return;
  clipboard.writeText(t);
  // Small delay so the clipboard write settles before the paste keystroke.
  setTimeout(pasteIntoFocusedApp, 120);
});

ipcMain.on("dictation-error", (_e, msg) => {
  recording = false;
  refreshTray();
  new Notification({ title: "Tailzu", body: "Dictation failed: " + msg }).show();
});

// ---- App lifecycle -----------------------------------------------------------
app.whenReady().then(() => {
  // Menu-bar / tray-only app — no dock icon on macOS.
  if (process.platform === "darwin" && app.dock) app.dock.hide();

  // Auto-grant mic to our own hidden recorder window (it's us asking).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, done) => {
    done(permission === "media" || permission === "audioCapture");
  });

  createRecorderWindow();

  tray = new Tray(trayIcon());
  refreshTray();

  if (configError) {
    new Notification({ title: "Tailzu — config problem", body: configError }).show();
  }

  const ok = globalShortcut.register(cfg.hotkey, toggleDictation);
  if (!ok) {
    new Notification({
      title: "Tailzu",
      body: `Couldn't register the hotkey ${cfg.hotkey} (another app may own it). Change it in config.json.`,
    }).show();
  }
});

app.on("window-all-closed", (e) => { e.preventDefault(); }); // stay alive in the tray
app.on("will-quit", () => globalShortcut.unregisterAll());
