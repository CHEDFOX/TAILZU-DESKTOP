// Tailzu desktop — Electron main process.
//
// The whole point of going desktop: none of the iOS keyboard walls exist here.
// We record the mic directly, send it to the SAME Tailzu backend the mobile app
// uses, get cleaned text back, and paste it into whatever app is focused.
//
// Modes:
//   toggle (default)  press hotkey → record… → press again → paste
//   hold              hold cfg.holdKey (e.g. F9) → talk → release → paste
//                     (needs uiohook-napi; degrades to toggle if unavailable)
//   live: true        streams audio to /v1/transcribe-stream and shows live
//                     captions in a small overlay; final text still pastes once
//                     at the end (partials are never typed into the target app)

const {
  app, Tray, Menu, globalShortcut, BrowserWindow, screen,
  ipcMain, clipboard, Notification, nativeImage, session, shell,
} = require("electron");
const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");

// ---- Config -----------------------------------------------------------------
// Dev: desktop/config.json (next to this file). Packaged: the asar is read-only,
// so config lives in the per-user data dir (%APPDATA%/tailzu-desktop on Windows,
// ~/Library/Application Support/tailzu-desktop on macOS) — editable + writable,
// and the token is never baked into a distributable installer.
const configPath = app.isPackaged
  ? path.join(app.getPath("userData"), "config.json")
  : path.join(__dirname, "config.json");

let configError = null; // surfaced as a notification once the app is ready
function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    // Distinguish "no config yet" (fine — env/defaults) from "config EXISTS but
    // is broken JSON" — silently falling back to token "dev" on a typo made a
    // client-side 401 undiagnosable. Surface it loudly instead.
    if (fs.existsSync(configPath)) configError = "config.json is invalid JSON: " + err.message;
  }
  return {
    baseUrl: (process.env.TAILZU_BASE_URL || file.baseUrl || "https://api.tailzu.space").trim(),
    // trim: a token pasted with a stray space/newline fails auth invisibly.
    token: String(process.env.TAILZU_TOKEN || file.token || "dev").trim(),
    language: process.env.TAILZU_LANGUAGE || file.language || "auto",
    // Electron accelerator string. CommandOrControl = ⌘ on macOS, Ctrl on Win/Linux.
    hotkey: process.env.TAILZU_HOTKEY || file.hotkey || "CommandOrControl+Shift+Space",
    // Refine tone sent with every dictation. Same ids the mobile app uses.
    tone: (file.tone || "none").toLowerCase(),
    // Live captions: stream audio and show partials in an overlay while talking.
    live: file.live === true,
    // Hold-to-talk: hold `holdKey`, release to finish. Uses a low-level key hook.
    hold: file.hold === true,
    holdKey: file.holdKey || "F9",
    // Launch Tailzu when you log in (applies to the installed app).
    autoStart: file.autoStart === true,
  };
}
let cfg = loadConfig();

/** Merge a patch into config.json and reload cfg (tray writes settings here). */
function saveConfig(patch) {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch { /* start fresh */ }
  Object.assign(file, patch);
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(file, null, 2));
  } catch { /* read-only disk — keep in-memory value */ }
  configError = null;
  cfg = loadConfig();
  refreshTray();
}

const TONES = ["none", "formal", "casual", "very-casual", "excited"];

let tray = null;
let recorderWin = null;
let overlayWin = null;
let recording = false;
let holdActive = false;
let uiohookRef = null;

// ---- Hidden recorder window --------------------------------------------------
// getUserMedia + MediaRecorder/WebAudio live in a renderer (Chromium), so we
// host them in an invisible window. It never takes focus, so the paste still
// lands in the user's real target app.
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

// ---- Live-caption overlay ----------------------------------------------------
// A small always-on-top strip near the bottom of the screen that shows the
// words as you speak (live mode). Click-through + non-focusable so it can never
// steal the paste target.
function showOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) { overlayWin.show(); return; }
  const wa = screen.getPrimaryDisplay().workArea;
  overlayWin = new BrowserWindow({
    width: 560, height: 84,
    x: Math.round(wa.x + (wa.width - 560) / 2),
    y: wa.y + wa.height - 120,
    frame: false, transparent: true, alwaysOnTop: true,
    skipTaskbar: true, focusable: false, resizable: false, hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  overlayWin.setIgnoreMouseEvents(true);
  overlayWin.loadFile("overlay.html");
}
function hideOverlay() { if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide(); }
function overlayText(t) {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send("overlay-text", t);
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
    {
      label: `Tone: ${cfg.tone}`,
      submenu: TONES.map((t) => ({
        label: t, type: "radio", checked: cfg.tone === t,
        click: () => saveConfig({ tone: t }),
      })),
    },
    {
      label: "Live captions while dictating",
      type: "checkbox", checked: cfg.live,
      click: (item) => saveConfig({ live: item.checked }),
    },
    {
      label: "Start at login",
      type: "checkbox", checked: cfg.autoStart,
      click: (item) => {
        saveConfig({ autoStart: item.checked });
        // Registering the dev electron binary as a login item is useless noise;
        // only meaningful for the installed app.
        if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: item.checked });
      },
    },
    { type: "separator" },
    { label: `Hotkey: ${cfg.hotkey}`, enabled: false },
    {
      label: cfg.hold
        ? `Hold-to-talk: hold ${cfg.holdKey}${holdActive ? "" : " (unavailable)"}`
        : "Hold-to-talk: off (set \"hold\": true in config)",
      enabled: false,
    },
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
  if (!fs.existsSync(configPath)) {
    // seed from the example so first-time users have something to edit
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.copyFileSync(path.join(__dirname, "config.example.json"), configPath);
    } catch {
      fs.writeFileSync(configPath, JSON.stringify({ baseUrl: cfg.baseUrl, token: "", hotkey: cfg.hotkey }, null, 2));
    }
  }
  shell.openPath(configPath);
}

// ---- Dictation toggle --------------------------------------------------------
function toggleDictation() {
  if (!recorderWin || recorderWin.isDestroyed()) createRecorderWindow();
  recording = !recording;
  if (recording) {
    recorderWin.webContents.send("start-recording", {
      baseUrl: cfg.baseUrl, token: cfg.token, language: cfg.language,
      tone: cfg.tone, live: cfg.live,
    });
    if (cfg.live) { showOverlay(); overlayText(""); }
  } else {
    recorderWin.webContents.send("stop-recording");
  }
  refreshTray();
}

// ---- Hold-to-talk (low-level key hook) ---------------------------------------
// globalShortcut has no key-up events, so hold-to-talk needs uiohook-napi. It's
// an optional native dep with prebuilt binaries; if it fails to load we degrade
// to the toggle hotkey and say so once.
function setupHoldToTalk() {
  if (!cfg.hold) return;
  try {
    const { uIOhook, UiohookKey } = require("uiohook-napi");
    const code = UiohookKey[cfg.holdKey];
    if (!code) {
      new Notification({
        title: "Tailzu",
        body: `Unknown holdKey "${cfg.holdKey}" — use a key name like F9, F10, F12.`,
      }).show();
      return;
    }
    // keydown auto-repeats while held; the !recording / recording guards make
    // start fire once on press and stop once on release.
    uIOhook.on("keydown", (e) => { if (e.keycode === code && !recording) toggleDictation(); });
    uIOhook.on("keyup", (e) => { if (e.keycode === code && recording) toggleDictation(); });
    uIOhook.start();
    uiohookRef = uIOhook;
    holdActive = true;
  } catch {
    new Notification({
      title: "Tailzu",
      body: "Hold-to-talk unavailable (uiohook-napi didn't load) — using the toggle hotkey.",
    }).show();
  }
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
  hideOverlay();
  refreshTray();
  const t = (text || "").trim();
  if (!t) return;
  clipboard.writeText(t);
  // Small delay so the clipboard write settles before the paste keystroke.
  setTimeout(pasteIntoFocusedApp, 120);
});

ipcMain.on("dictation-error", (_e, msg) => {
  recording = false;
  hideOverlay();
  refreshTray();
  new Notification({ title: "Tailzu", body: "Dictation failed: " + msg }).show();
});

// Live partials from the recorder → overlay captions.
ipcMain.on("live-partial", (_e, text) => overlayText(text));

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

  setupHoldToTalk();

  if (app.isPackaged && cfg.autoStart) app.setLoginItemSettings({ openAtLogin: true });
});

app.on("window-all-closed", (e) => { e.preventDefault(); }); // stay alive in the tray
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  try { uiohookRef?.stop(); } catch { /* already stopped */ }
});
