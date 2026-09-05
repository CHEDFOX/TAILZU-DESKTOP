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

// ---- Session ----------------------------------------------------------------
// The signed-in user's Supabase tokens, beside config.json in the same
// per-user directory. A SEPARATE file on purpose: config.json is something the
// user opens and edits by hand, and a refresh token rewritten under them every
// hour does not belong in a file they are reading.
const sessionPath = app.isPackaged
  ? path.join(app.getPath("userData"), "session.json")
  : path.join(__dirname, "session.json");

// The public client credential, same pair the window and the phones use. It is
// the anon key: safe in a distributable, useless without a user's own tokens.
const SUPABASE_URL = "https://merzyohecmyfvlyahxaz.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1lcnp5b2hlY215ZnZseWFoeGF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyMjU1MzAsImV4cCI6MjA5NzgwMTUzMH0.scDhHeRU20wRIgKBFL8GouIEp8bJG8w8aIsySUkePHY";

function loadSession() {
  try { return JSON.parse(fs.readFileSync(sessionPath, "utf8")); } catch { return null; }
}
function saveSession(v) {
  try {
    if (v) {
      fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
      fs.writeFileSync(sessionPath, JSON.stringify(v, null, 2), { mode: 0o600 });
    } else if (fs.existsSync(sessionPath)) {
      fs.unlinkSync(sessionPath);
    }
  } catch { /* a session that will not persist still works for this run */ }
}

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

// ---- Tone, once ------------------------------------------------------------
// The account's `personality.activeTone` is the tone. The phone keyboard reads
// it, the app writes it, and the tray now does both — because the alternative,
// which is what shipped, is two tones: one in config.json that the hotkey used
// and one on the account that the window showed, disagreeing silently and
// neither of them wrong from where it was standing.
//
// cfg.tone survives as the signed-out fallback. Dictation works without an
// account; it just cannot read a preference that lives on one.
//
// And the tray must do all of this with the window shut — that is the shape of
// this app, a hotkey and a menu bar. So the main process holds the session
// itself and refreshes it; it does not wait to be handed a token by a window
// the user may never open. The window still pushes its token when it has one,
// which only ever makes this fresher.
let authSession = loadSession();   // { access_token, refresh_token, expires_at }
let accountTone = null;            // last value read from the account
let refreshing = null;             // in-flight refresh, so N callers make 1 POST

/** True when the stored access token is spent (or about to be). An expiry we
 *  do not have counts as spent: guessing it is still good is how a tray ends
 *  up sending a dead token for an hour. */
function tokenStale() {
  if (!authSession || !authSession.access_token) return false;
  const exp = Number(authSession.expires_at || 0);
  return exp <= 0 || exp - 60 <= Math.floor(Date.now() / 1000);
}

/** Signed in, as far as this process can tell. */
function signedIn() { return !!(authSession && authSession.access_token); }

/**
 * The token to send right now, without awaiting anything.
 *
 * Dictation calls this on the hotkey path, where a network round-trip would
 * cost the user the first word of their sentence. Freshness is kept by
 * refreshSession() running ahead of time, not by blocking here.
 */
function tokenNow() {
  return (authSession && authSession.access_token) || cfg.token;
}

/** Swap in a new session (from a refresh, or from the window signing in). */
function adoptSession(raw) {
  authSession = raw && raw.access_token
    ? {
        access_token: raw.access_token,
        refresh_token: raw.refresh_token || (authSession && authSession.refresh_token) || null,
        expires_at: raw.expires_at || Math.floor(Date.now() / 1000) + (raw.expires_in || 3600),
      }
    : null;
  saveSession(authSession);
}

/** Renew the access token against Supabase when it has gone stale. One POST,
 *  no SDK. A refresh that fails means the session is gone, not merely old. */
async function refreshSession() {
  if (!tokenStale() || !authSession.refresh_token) return;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const res = await fetch(SUPABASE_URL + "/auth/v1/token?grant_type=refresh_token", {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
        body: JSON.stringify({ refresh_token: authSession.refresh_token }),
      });
      if (!res.ok) throw new Error("refresh " + res.status);
      adoptSession(await res.json());
    } catch {
      // Signed out for real: fall back to the device tone rather than keep
      // showing an account this process can no longer reach.
      adoptSession(null);
      accountTone = null;
      refreshTray();
    } finally { refreshing = null; }
  })();
  return refreshing;
}

async function apiJson(path, init) {
  await refreshSession();
  const send = () => fetch(cfg.baseUrl + path, Object.assign({
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + tokenNow(),
    },
  }, init || {}));
  let res = await send();
  // A 401 means the token is spent whatever its stated expiry said — a clock
  // that drifted, a session revoked elsewhere. Force one renewal and retry,
  // rather than leaving the tray permanently unable to read its own account.
  if (res.status === 401 && authSession && authSession.refresh_token) {
    authSession.expires_at = 0;   // tokenStale() reads this as spent
    await refreshSession();
    if (signedIn()) res = await send();
  }
  if (!res.ok) throw new Error(path + " → " + res.status);
  return res.json();
}

/** Read the account's tone, and redraw the tray if it moved. Silent on
 *  failure: a tray that cannot reach the backend still dictates. */
async function refreshAccountTone() {
  if (!signedIn()) return;
  try {
    const p = await apiJson("/v1/personality", { method: "GET" });
    const t = (p && (p.personality ? p.personality.activeTone : p.activeTone)) || null;
    if (t && t !== accountTone) { accountTone = t; refreshTray(); }
    else if (t) accountTone = t;
  } catch { /* leave the last known value */ }
}

async function setAccountTone(tone) {
  accountTone = tone;
  refreshTray();
  if (!signedIn()) { saveConfig({ tone }); return; }   // signed out: local only
  try {
    await apiJson("/v1/personality", { method: "PUT", body: JSON.stringify({ activeTone: tone }) });
  } catch {
    // The write failed, so the value we are showing is not the account's.
    // Re-read rather than leaving the menu asserting something untrue.
    void refreshAccountTone();
  }
}

/** What dictation should actually use. */
function currentTone() { return accountTone || cfg.tone; }

let tray = null;
let recorderWin = null;
let overlayWin = null;
let recording = false;
let holdActive = false;
let uiohookRef = null;
// Monotonic dictation-session id. Every start mints a new id; the renderer
// echoes it in result/error/partial. State (recording flag, overlay) only
// reacts to the CURRENT session's messages — a slow upload from a PREVIOUS
// session finishing mid-recording used to flip `recording` false, which made
// hold-to-talk's keyup guard skip the stop and left the mic hot forever.
// Text is still pasted whichever session it came from (late words are still
// the user's words); only STATE changes are gated.
let sessionSeq = 0;
let activeSession = 0;

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
  hardenWindow(recorderWin);
  recorderWin.loadFile("recorder.html");
}

// ---- The app window ---------------------------------------------------------
// Everything that is not dictation: Train, Stats, You, history, settings, the
// paywall. All of it is the same server-drawn JSON the phones render, so this
// window is a renderer, not a second app — a screen added to the catalog
// appears here without a desktop release.
//
// Created on demand and HIDDEN on close rather than destroyed: this is a tray
// app, closing the window means "put it away", and rebuilding it on every open
// would throw away the boot it already has.
let appWin = null;
function openAppWindow() {
  if (appWin && !appWin.isDestroyed()) { appWin.show(); appWin.focus(); return; }
  appWin = new BrowserWindow({
    width: 980, height: 760, minWidth: 380, minHeight: 520,
    title: "Tailzu",
    backgroundColor: "#000000",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  hardenWindow(appWin);
  appWin.on("close", (e) => { e.preventDefault(); appWin.hide(); });
  appWin.loadFile("app.html");
}

/** Deny navigation + popups on our local windows — they only ever load our own
 *  files, so anything else is a bug or an injection attempt. */
function hardenWindow(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
}

/** Send an IPC message to the recorder, deferring until the page has loaded.
 *  webContents.send on a still-loading window is silently dropped — that turned
 *  a first-ever hotkey press (window just created) into a dead cycle: tray said
 *  "listening", nothing recorded, and the next press no-op'd. */
function sendToRecorder(channel, payload) {
  if (!recorderWin || recorderWin.isDestroyed()) return;
  const wc = recorderWin.webContents;
  if (wc.isLoading()) {
    wc.once("did-finish-load", () => wc.send(channel, payload));
  } else {
    wc.send(channel, payload);
  }
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
  hardenWindow(overlayWin);
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
    { label: "Open Tailzu", click: openAppWindow },
    { type: "separator" },
    {
      label: `Tone: ${currentTone()}${signedIn() ? "" : " (this device)"}`,
      // The account's tone may be a voice the user created, which is not in
      // this list — include it so the menu can show it selected rather than
      // showing five unticked rows and implying none is active.
      submenu: Array.from(new Set(TONES.concat(accountTone ? [accountTone] : []))).map((t) => ({
        label: t, type: "radio", checked: currentTone() === t,
        click: () => { void setAccountTone(t); },
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
    // Which credential is ACTUALLY in use — ends the "which token is it using"
    // guessing when auth fails. Signed in, that is the account; saying "dev"
    // there sent people to edit a config.json that is not the thing being sent.
    {
      label: signedIn()
        ? "Signed in — dictation lands on your account"
        : `Token: ${cfg.token === "dev" ? "dev (no config!)" : cfg.token.slice(0, 8) + "…"}`,
      enabled: false,
    },
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

// ---- What the app window is allowed to ask for -------------------------------
// Narrow on purpose: the renderer gets the backend URL, the session, and the
// ability to store one. It never gets fs, and it never gets the config file
// path — a renderer that can write arbitrary paths is a renderer that can be
// talked into writing arbitrary paths.
ipcMain.handle("app:env", () => ({
  baseUrl: cfg.baseUrl,
  fallbackToken: cfg.token,
  session: authSession,
  tone: cfg.tone,
  language: cfg.language,
}));
ipcMain.handle("app:setSession", (_e, v) => {
  // The window signed in or out. The tray shares the session, so it adopts it
  // here rather than learning about it on the next token push.
  adoptSession(v || null);
  if (!signedIn()) accountTone = null;
  refreshTray();
  void refreshAccountTone();
  return true;
});
ipcMain.on("app:openExternal", (_e, url) => {
  // Only ever http(s). A renderer handing this a file:// or a shell scheme is
  // the whole reason this check exists.
  if (typeof url === "string" && /^https?:\/\//i.test(url)) shell.openExternal(url);
});
ipcMain.on("app:dictate", () => toggleDictation());
// The window owns the session and its refresh, so it hands the main process a
// live token rather than the main process parsing and refreshing one too.
ipcMain.on("app:token", (_e, t) => {
  const next = typeof t === "string" && t ? t : null;
  // Signing out has to drop the tone too. Keeping it would leave the tray
  // showing — and dictating with — the tone of an account nobody is signed
  // into any more, which is exactly the split this whole section removes.
  if (!next) {
    if (!signedIn() && !accountTone) return;
    adoptSession(null); accountTone = null; refreshTray();
    return;
  }
  // The window pushes on every request it makes, so most of these are the
  // same token again. Only a change is worth a read.
  if (authSession && authSession.access_token === next) return;
  // A token we did not have means the window refreshed. It carries no expiry
  // here, and the old one would mark this brand-new token as spent — assume a
  // full hour; the window's setSession lands the real expiry moments later.
  adoptSession({ access_token: next });
  void refreshAccountTone();
});
// Anything the window wrote could have been the tone. Cheaper to re-read than
// to have the window guess which of its writes mattered.
ipcMain.on("app:changed", () => { void refreshAccountTone(); });

// ---- Dictation toggle --------------------------------------------------------
function toggleDictation() {
  if (!recorderWin || recorderWin.isDestroyed()) createRecorderWindow();
  recording = !recording;
  if (recording) {
    activeSession = ++sessionSeq;
    sendToRecorder("start-recording", {
      // The account's token when there is one, so a dictation from the hotkey
      // lands in the same history the window shows instead of on the static
      // synthetic user the fallback token resolves to.
      baseUrl: cfg.baseUrl, token: tokenNow(), language: cfg.language,
      tone: currentTone(), live: cfg.live, session: activeSession,
    });
    if (cfg.live) { showOverlay(); overlayText(""); }
  } else {
    sendToRecorder("stop-recording", { session: activeSession });
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
// Clear recording state ONLY when the message belongs to the current session.
// A slow upload from a previous session finishing mid-recording must not flip
// state for the session that's still capturing.
function settleSession(session) {
  if (session !== activeSession) return;
  activeSession = 0;
  recording = false;
  hideOverlay();
  refreshTray();
}

ipcMain.on("dictation-result", (_e, payload) => {
  const { session, text } = payload || {};
  settleSession(session);
  // Paste regardless of session age — late-arriving words are still the
  // user's words and belong at the cursor.
  const t = (text || "").trim();
  if (!t) return;
  clipboard.writeText(t);
  // Small delay so the clipboard write settles before the paste keystroke.
  setTimeout(pasteIntoFocusedApp, 120);
});

ipcMain.on("dictation-error", (_e, payload) => {
  const { session, message } = payload || {};
  settleSession(session);
  new Notification({ title: "Tailzu", body: "Dictation failed: " + message }).show();
});

// Live partials from the recorder → overlay captions (current session only).
ipcMain.on("live-partial", (_e, payload) => {
  const { session, text } = payload || {};
  if (session === activeSession) overlayText(text);
});

// ---- App lifecycle -----------------------------------------------------------
app.whenReady().then(() => {
  // Menu-bar / tray-only app — no dock icon on macOS.
  if (process.platform === "darwin" && app.dock) app.dock.hide();

  // Auto-grant mic to our own local pages ONLY. Scoping to file:// means any
  // future remote content loaded by mistake can never inherit silent mic access.
  session.defaultSession.setPermissionRequestHandler((wc, permission, done) => {
    const local = (wc?.getURL() || "").startsWith("file://");
    done(local && (permission === "media" || permission === "audioCapture"));
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

  // Come up already knowing who is signed in and what tone they chose, so the
  // first thing in the menu is right before the window has ever been opened.
  void refreshAccountTone();
  // Keep the access token ahead of the hotkey. Renewing on a timer means
  // tokenNow() is valid when a key is pressed; renewing on demand would spend
  // a network round-trip out of the start of someone's sentence.
  const keepFresh = setInterval(() => { void refreshSession(); }, 10 * 60 * 1000);
  app.on("will-quit", () => clearInterval(keepFresh));

  if (app.isPackaged && cfg.autoStart) app.setLoginItemSettings({ openAtLogin: true });
});

app.on("window-all-closed", (e) => { e.preventDefault(); }); // stay alive in the tray
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  try { uiohookRef?.stop(); } catch { /* already stopped */ }
});
