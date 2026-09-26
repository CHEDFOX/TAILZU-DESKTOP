// Tailzu desktop — Electron main process.
//
// The whole point of going desktop: none of the iOS keyboard walls exist here.
// We record the mic directly, send it to the SAME Tailzu backend the mobile app
// uses, get cleaned text back, and paste it into whatever app is focused.
//
// Modes:
//   toggle (default)  press hotkey → record… → press again → paste
//   double-tap        tap Ctrl twice, or Alt twice → talk → tap twice → paste
//                     (the default; one finger, no chord, nothing to hold)
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
const crypto = require("crypto");
const { createTapDetector } = require("./tapDetector.js");
// The server's values for everything below that used to be a literal. Each
// call names its key and keeps the old literal as the fallback — see knobs.js.
const { setKnobs, txt, num, bool, str, color, list, obj } = require("./knobs.js");

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

// ---- The bootstrap, in this process too ---------------------------------------
// THE MAIN PROCESS ASKS THE SERVER ITSELF.
//
// It used to learn what the backend said only when the window relayed it — and
// this is a tray app, so for most launches (every login-item start among them)
// there is no window. Everything this process decides — the hotkey it falls
// back to, how a tap is timed, what a notification says, whether dictation is
// out of words — is a knob now, and a knob only the window could fetch would
// be a knob that holds only after someone opens the window.
//
// So it POSTs /v1/app/bootstrap at launch and on a timer, caches the answer
// beside config.json, and reads that cache before anything else in this file
// runs: the second launch starts with the server's values, offline or not.
const bootPath = path.join(app.getPath("userData"), "bootstrap.json");
// What this install remembers about itself: how many times it has launched
// (the server's onboarding and prompts count launches, as on the phones) and
// which update it has already announced.
const localStatePath = path.join(app.getPath("userData"), "desktop-state.json");

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}
function writeJson(p, v) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(v, null, 2));
  } catch { /* a cache that will not persist still works for this run */ }
}

let BOOT = readJson(bootPath);
setKnobs(BOOT);
const localState = readJson(localStatePath) || {};
function saveLocalState() { writeJson(localStatePath, localState); }

/** The knobs as the windows need them: the last bootstrap's labels and flags. */
function knobsPayload() {
  return { labels: (BOOT && BOOT.labels) || {}, flags: (BOOT && BOOT.flags) || {} };
}

// ---- Server-drawn chrome -----------------------------------------------------
// THE WINDOW'S SCREENS WERE SERVER-DRAWN. EVERYTHING AROUND THEM WAS NOT.
//
// The tray menu and the notifications were literals in this file, so changing a
// word of them meant cutting an installer — and on desktop a release is a
// download the user has to notice, accept past SmartScreen, and run. Copy in the
// binary is copy that can never be fixed.
//
// So the backend sends it (`flags["desktop.shell"]`) and this renders it. Three
// things make that safe in a process that starts before any network:
//
//   1. DEFAULTS below. The tray is built during `ready`, long before a bootstrap
//      can have answered, and a first run offline still needs words in it.
//   2. A CACHE on disk, so the second launch opens with the last answer rather
//      than the built-in one.
//   3. A DEEP MERGE, so a server that sends half the keys — an older deploy, or
//      a new key this build has never heard of — leaves the rest intact instead
//      of blanking the menu.
const shellPath = app.isPackaged
  ? path.join(app.getPath("userData"), "shell.json")
  : path.join(__dirname, "shell.json");

const SHELL_DEFAULTS = {
  tray: {
    dictate: "Dictate",
    listening: "◉ Listening — {key} stops",
    signInToDictate: "Sign in to dictate…",
    open: "Open Tailzu",
    tone: "Tone",
    toneThisDevice: "this device",
    liveCaptions: "Live captions while dictating",
    startAtLogin: "Start at login",
    hotkey: "Hotkey",
    holdToTalk: "Hold-to-talk: hold",
    holdUnavailable: "unavailable",
    holdOff: "Hold-to-talk: off (set \"hold\": true in config)",
    tapToTalk: "Double-tap {key} to dictate",
    tapOff: "Double-tap: off (set \"tap\": true in config)",
    backend: "Backend",
    signedIn: "Signed in — dictation lands on your account",
    editConfig: "Edit config…",
    quit: "Quit Tailzu",
    tooltipReady: "Tailzu — ready",
    tooltipListening: "Tailzu — listening…",
    tooltipSignIn: "Tailzu — sign in to dictate",
  },
  notify: {
    title: "Tailzu",
    signIn: "Sign in to dictate — your words belong to your account.",
    holdUnavailable: "Hold-to-talk unavailable (uiohook-napi didn't load) — using the toggle hotkey.",
    micBlockedWindows: "microphone blocked — Settings → Privacy & security → Microphone → let desktop apps access",
    micBlockedMac: "microphone blocked — System Settings → Privacy & Security → Microphone → Tailzu",
    micMissing: "no microphone found — plug one in, then try again",
    micBusy: "microphone is in use by another app",
    noSpeech: "no speech detected — check your microphone",
    unknownHoldKey: "Unknown holdKey \"{key}\" — use a key name like F9, F10, F12.",
    tapUnavailable: "Double-tap unavailable (uiohook-napi didn't load) — using the hotkey.",
    unknownTapKey: "Unknown tapKey \"{key}\" — use Ctrl, Alt, Shift or Meta.",
    dictationFailed: "Dictation failed: {message}",
    hotkeyTaken: "{taken} is taken by another app, so dictation is on {bound}. Change it under Edit config.",
    noHotkey: "No hotkey could be registered. Use Dictate in the tray menu, and set a free one under Edit config.",
  },
};

/** Defaults under the server's answer, one level into each section — EVERY
 *  section the server sends, not only the two this process draws (gate, rail
 *  and gateLayout ride in the same block). A string wins only when it is not
 *  blank: a key the server omits, or sends blank, keeps the built-in word
 *  rather than painting an empty menu row. Anything else the server sends (a
 *  number, a switch) is taken as it is, unless it would replace a word. */
function mergeShell(base, incoming) {
  const out = {};
  const from = incoming && typeof incoming === "object" ? incoming : {};
  const sections = new Set(Object.keys(base).concat(Object.keys(from)));
  for (const section of sections) {
    const defaults = base[section] || {};
    out[section] = { ...defaults };
    const src = from[section];
    if (!src || typeof src !== "object" || Array.isArray(src)) continue;
    for (const [k, v] of Object.entries(src)) {
      if (typeof v === "string") { if (v.trim()) out[section][k] = v; }
      else if (v != null && typeof defaults[k] !== "string") out[section][k] = v;
    }
  }
  return out;
}

/** The `desktop.shell` block out of a bootstrap, if it carries one. */
function shellOf(boot) {
  const s = boot && boot.flags && boot.flags["desktop.shell"];
  return s && typeof s === "object" ? s : null;
}

// The cached bootstrap first; shell.json is the cache an older build wrote,
// read only so the first launch after an upgrade is not a launch with none.
let SHELL = mergeShell(SHELL_DEFAULTS, shellOf(BOOT) || readJson(shellPath));

/** One string, by "section.key". Unknown keys return "" rather than throwing —
 *  a menu built from a typo should be missing a word, not missing a menu. */
function t(pathStr) {
  const [section, key] = String(pathStr).split(".");
  return (SHELL[section] && SHELL[section][key]) || "";
}

/** The same string with {placeholders} filled in. A variable the server did
 *  not leave a slot for is simply not shown — better a sentence missing a
 *  detail than a sentence with "{bound}" in it. */
function fmt(pathStr, vars) {
  return t(pathStr).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** The bound hotkey as a person reads it. The accelerator is Electron's
 *  spelling, and "CommandOrControl+Shift+F12" is not a key anyone looks for
 *  — and the key in use is often not the one in the config, because the
 *  first choice was taken and a fallback took its place. Wherever the app
 *  says "press the hotkey", it names this. */
function prettyKey(accel) {
  return String(accel || "").replace("CommandOrControl", process.platform === "darwin" ? "⌘" : "Ctrl")
    .replace("Command", "⌘").replace("Control", "Ctrl");
}

/** Every native notification goes through here, so the title is server-drawn
 *  once rather than at nine call sites. `onClick`, when given, is what a click
 *  on it does (an update notice opens the download). */
const clickable = new Set();   // held so a click handler is not collected before it fires
function notify(body, onClick) {
  if (!body) return;
  const n = new Notification({ title: t("notify.title") || txt("desktop.notify.title", "Tailzu"), body });
  if (onClick) {
    clickable.add(n);
    n.on("click", () => { clickable.delete(n); onClick(); });
    n.on("close", () => clickable.delete(n));
  }
  n.show();
}

/**
 * A new bootstrap — fetched here, or handed over by the window. Cached for the
 * next launch, pointed at by the knobs, and everything that reads them is
 * brought up to date without a restart: the chrome, the config defaults, the
 * tray, the other windows, and whether this build is still one the server
 * wants running.
 */
function adoptBoot(boot) {
  if (!boot || typeof boot !== "object") return;
  BOOT = boot;
  setKnobs(boot);
  SHELL = mergeShell(SHELL_DEFAULTS, shellOf(boot));
  writeJson(bootPath, boot);
  reloadConfigFromKnobs();
  refreshTray();
  broadcastKnobs();
  checkForUpdate();
}

/** The knobs, to every window of ours that is up. A window still loading asks
 *  for them itself once it has (app:knobs), so none is skipped for long. */
function broadcastKnobs() {
  const k = knobsPayload();
  for (const w of [appWin, recorderWin, overlayWin]) {
    if (w && !w.isDestroyed() && !w.webContents.isLoading()) w.webContents.send("knobs", k);
  }
}

/** POST /v1/app/bootstrap as this desktop, with the account's token when
 *  there is one. One request at a time; a failure keeps the cache. */
let bootInFlight = null;
function refreshBoot() {
  if (bootInFlight) return bootInFlight;
  bootInFlight = (async () => {
    try {
      adoptBoot(await apiJson("/v1/app/bootstrap", {
        method: "POST",
        body: JSON.stringify({
          capabilities: {
            platform: "web",
            appVersion: app.getVersion(),
            device: { formFactor: "desktop", os: process.platform },
          },
          launchCount: Number(localState.launchCount) || 1,
        }),
      }));
    } catch { /* offline, or the server hiccupped: the cached answer stands */ }
    finally { bootInFlight = null; }
  })();
  return bootInFlight;
}

/** Ask again on the server's own schedule. Re-read every time, so a changed
 *  interval takes effect on the next round; zero or less switches it off. */
let bootTimer = null;
function scheduleBootRefresh() {
  clearTimeout(bootTimer);
  const every = num("desktop.bootstrap.refreshMs", 600000);
  if (!(every > 0)) return;
  bootTimer = setTimeout(() => { void refreshBoot().then(scheduleBootRefresh); }, every);
}

// ---- Updates ---------------------------------------------------------------
// There is no auto-updater, so the server says which build is current and
// which is the oldest it still supports, and this says so to the user.

/** Dotted numbers, compared as numbers: 0.1.10 is newer than 0.1.9. A part
 *  that is not a number counts as 0, so "1.2" equals "1.2.0". */
function compareVersions(a, b) {
  const pa = String(a || "").split("."), pb = String(b || "").split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = parseInt(pa[i], 10) || 0, y = parseInt(pb[i], 10) || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

let requiredAnnounced = "";   // once per launch: a required update keeps asking
function checkForUpdate() {
  const u = obj("desktop.update", { latest: "", min: "", url: "", notes: "" });
  const current = app.getVersion();
  const latest = String(u.latest || ""), min = String(u.min || "");
  const url = typeof u.url === "string" && /^https?:\/\//i.test(u.url) ? u.url : "";
  const open = url ? () => { shell.openExternal(url).catch(() => {}); } : null;
  const vars = { current, latest: latest || min, min, notes: String(u.notes || "") };
  if (min && compareVersions(current, min) < 0) {
    if (requiredAnnounced === min) return;
    requiredAnnounced = min;
    notify(txt("desktop.notify.updateRequired",
      "This version of Tailzu ({current}) is no longer supported. Click to download the update.", vars), open);
    return;
  }
  // Gentler, and once per version: someone who has seen that 0.2.0 is out
  // does not need telling again every ten minutes.
  if (latest && compareVersions(current, latest) < 0 && localState.updateAnnounced !== latest) {
    localState.updateAnnounced = latest;
    saveLocalState();
    notify(txt("desktop.notify.updateAvailable", "Tailzu {latest} is available. Click to download it.", vars), open);
  }
}

let configError = null; // surfaced as a notification once the app is ready
function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    // Distinguish "no config yet" (fine — env/defaults) from "config EXISTS but
    // is broken JSON" — silently falling back to defaults on a typo made a
    // client-side problem undiagnosable. Surface it loudly instead.
    if (fs.existsSync(configPath)) {
      configError = txt("desktop.notify.configInvalid", "config.json is invalid JSON: {error}", { error: err.message });
    }
  }
  // A key the user wrote in config.json wins; a key they did not is the
  // server's default (a knob), which is the old literal until it says otherwise.
  const flag = (v, key) => (typeof v === "boolean" ? v : key);
  return {
    baseUrl: (process.env.TAILZU_BASE_URL || file.baseUrl || "https://api.tailzu.space").trim(),
    language: process.env.TAILZU_LANGUAGE || file.language || str("desktop.language.default", "auto"),
    // Electron accelerator string. CommandOrControl = ⌘ on macOS, Ctrl on Win/Linux.
    hotkey: process.env.TAILZU_HOTKEY || file.hotkey || str("desktop.hotkey.default", "CommandOrControl+Shift+Space"),
    // Refine tone sent with every dictation. Same ids the mobile app uses.
    tone: (file.tone || str("desktop.tone.default", "none")).toLowerCase(),
    // Live captions: stream audio and show partials in an overlay while talking.
    live: flag(file.live, bool("desktop.live.default", false)),
    // Flush on a pause instead of ending on one. A thinking pause and a
    // finished sentence look identical to a level meter, so nothing here
    // tries to tell them apart: a pause writes out what was said and the
    // mic stays open. Pausing costs nothing, which is what makes it safe.
    pauseFlush: flag(file.pauseFlush, bool("desktop.pauseFlush.default", true)),
    // Hold-to-talk: hold `holdKey`, release to finish. Uses a low-level key hook.
    hold: flag(file.hold, bool("desktop.hold.default", false)),
    holdKey: file.holdKey || str("desktop.hold.key", "F9"),
    // DOUBLE-TAP TO DICTATE, and the default way in.
    //
    // The chord was CommandOrControl+Shift+Space: three keys, both pinkies,
    // and on macOS one key away from Spotlight. Dictation is the thing this
    // app does, so reaching for it should cost one finger.
    //
    // A double-tap cannot collide with anything, which is why it is safe to
    // put on a key every shortcut already uses: no application binds "Ctrl
    // twice, quickly, with nothing in between", and the guards below make
    // sure Ctrl+C never looks like one.
    tap: flag(file.tap, bool("desktop.tap.default", true)),
    // MORE THAN ONE, AND EACH ON ITS OWN. Whichever hand is free should be
    // able to start dictation, so both are live and neither is a chord —
    // Ctrl twice, or Alt twice. Ctrl then Alt is not a gesture: a pair has to
    // be the SAME key, or two unrelated modifier presses would start
    // recording.
    //
    // A single string still works, so an existing config.json keeps meaning
    // what it meant.
    tapKeys: (Array.isArray(file.tapKeys) ? file.tapKeys
      : file.tapKey ? [file.tapKey]
      : list("desktop.tap.keys", ["Ctrl", "Alt"])).map(String),
    // Launch Tailzu when you log in (applies to the installed app).
    autoStart: flag(file.autoStart, bool("desktop.autoStart.default", false)),
  };
}
let cfg = loadConfig();

/** The config again, after the server's defaults moved. What was WIRED at
 *  startup — the registered hotkey and the key hook's keys — stays as it was
 *  bound, or the tray would name keys that do not do anything until restart. */
function reloadConfigFromKnobs() {
  const wired = { hotkey: cfg.hotkey, hold: cfg.hold, holdKey: cfg.holdKey, tapKeys: cfg.tapKeys };
  cfg = Object.assign(loadConfig(), wired);
}

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

/** The tones the tray offers, as { id, label } — the id is what is stored and
 *  sent, the label is what the menu shows. A bare string from the server is
 *  its own label. */
function tones() {
  return list("desktop.tones", [
    { id: "none", label: "none" },
    { id: "formal", label: "formal" },
    { id: "casual", label: "casual" },
    { id: "very-casual", label: "very-casual" },
    { id: "excited", label: "excited" },
  ]).map((x) => (typeof x === "string" ? { id: x, label: x } : x))
    .filter((x) => x && typeof x.id === "string" && x.id)
    .map((x) => ({ id: x.id, label: typeof x.label === "string" && x.label ? x.label : x.id }));
}
function toneLabel(id) {
  const hit = tones().find((x) => x.id === id);
  return hit ? hit.label : id;
}

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
  return exp <= 0 || exp - num("desktop.auth.refreshSkewSec", 60) <= Math.floor(Date.now() / 1000);
}

/** Signed in, as far as this process can tell. */
function signedIn() { return !!(authSession && authSession.access_token); }

/**
 * The token to send right now, without awaiting anything.
 *
 * Dictation calls this on the hotkey path, where a network round-trip would
 * cost the user the first word of their sentence. Freshness is kept by
 * refreshSession() running ahead of time, not by blocking here.
 *
 * Null when nobody is signed in. There is no static fallback any more: a
 * request without an account goes out with no Authorization header at all,
 * rather than as a synthetic user whose history nobody can read.
 */
function tokenNow() {
  return (authSession && authSession.access_token) || null;
}

/** Swap in a new session (from a refresh, or from the window signing in). */
function adoptSession(raw) {
  authSession = raw && raw.access_token
    ? {
        access_token: raw.access_token,
        refresh_token: raw.refresh_token || (authSession && authSession.refresh_token) || null,
        expires_at: raw.expires_at ||
          Math.floor(Date.now() / 1000) + (raw.expires_in || num("desktop.auth.tokenLifetimeSec", 3600)),
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
  const send = () => {
    const headers = { "Content-Type": "application/json" };
    const tok = tokenNow();
    if (tok) headers.Authorization = "Bearer " + tok;
    return fetch(cfg.baseUrl + path, Object.assign({ headers }, init || {}));
  };
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

// ---- Apple / Google ---------------------------------------------------------
//
// The phone signs in with Apple and Google natively: the OS hands the app an
// identity token and Supabase trades it for a session. A desktop has no such
// OS service, so this is the web flow — the provider's own consent page, in a
// window we own, with PKCE so the authorization code is useless to anyone who
// intercepts it.
//
// Nothing is caught by loading the redirect. The moment the browser tries to
// GO to it we read the code off the URL and cancel the request, so the page at
// the redirect URL is never fetched and does not have to exist. It only has to
// be on the provider's allow-list, which is why it is a real https URL on a
// domain that is ours rather than a localhost port or a custom scheme.
function redirectUrl() { return str("desktop.oauth.redirectUrl", "https://tailzu.space/auth/callback"); }

// GOOGLE WILL NOT SIGN YOU IN INSIDE A WINDOW WE OWN.
//
// Their policy is disallowed_useragent: an OAuth consent screen loaded in an
// embedded browser is refused, by design, because the app hosting it can read
// everything typed into it. Apple is less strict but heading the same way. So
// the window above works for one provider and fails for the other, and the
// failure arrives as Google's own "this browser may not be secure" page, which
// reads as our bug.
//
// The way a desktop app is supposed to do this: send the person to their REAL
// browser, where they are probably already signed in, and catch the redirect on
// a loopback address only this machine can reach.
//
// Google never sees this address. The provider redirects to Supabase, and
// Supabase redirects to `redirect_to` — so the only allow-list this has to be
// on is Supabase's own, under URL Configuration.
function loopbackPort() { return num("desktop.oauth.loopbackPort", 8788); }
function loopbackUrl() { return "http://127.0.0.1:" + loopbackPort() + "/cb"; }

const escHtml = (s) =>
  String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** The page the browser shows once it has handed the code over. */
function closePage() {
  return "<!doctype html><meta charset=utf-8><title>" + escHtml(txt("desktop.oauth.pageTitle", "Tailzu")) + "</title>" +
    "<body style=\"margin:0;height:100vh;display:flex;align-items:center;justify-content:center;" +
    "background:" + escHtml(color("desktop.oauth.pageBg", "#0b0b0f")) +
    ";color:" + escHtml(color("desktop.oauth.pageText", "rgba(255,255,255,.85)")) +
    ";font:15px -apple-system,Segoe UI,system-ui,sans-serif\">" +
    "<p>" + escHtml(txt("desktop.oauth.pageBody", "Signed in. You can close this tab and go back to Tailzu.")) + "</p>";
}

/**
 * The system-browser half of the flow. Resolves with the authorization code.
 *
 * One request, then the server is gone. It binds to 127.0.0.1 rather than
 * 0.0.0.0 so nothing off this machine can reach it even for the seconds it is
 * up, and it times out rather than listening forever for a person who wandered
 * off mid sign-in.
 */
function awaitLoopbackCode(openUrl) {
  const http = require("http");
  const port = loopbackPort();
  const base = "http://127.0.0.1:" + port + "/cb";
  return new Promise((resolve, reject) => {
    let settled = false;
    const server = http.createServer((req, res) => {
      let u;
      try { u = new URL(req.url, base); } catch { u = null; }
      if (!u || u.pathname !== "/cb") { res.writeHead(404).end(); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(closePage());
      const err = u.searchParams.get("error_description") || u.searchParams.get("error");
      const code = u.searchParams.get("code");
      done(err ? new Error(err) : code ? null : new Error(txt("desktop.oauth.noCode", "no authorization code")), code);
    });
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { server.close(); } catch { /* already closing */ }
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(
      () => done(new Error(txt("desktop.oauth.timedOut", "timed out waiting for the browser"))),
      num("desktop.oauth.timeoutMs", 300000));
    server.on("error", (e) => done(e));
    server.listen(port, "127.0.0.1", () => {
      shell.openExternal(openUrl).catch((e) => done(e));
    });
  });
}

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Run one provider sign-in. Resolves with a Supabase session, or throws. */
function authorizeUrl(provider, challenge, redirect) {
  return SUPABASE_URL + "/auth/v1/authorize" +
    "?provider=" + encodeURIComponent(provider) +
    "&redirect_to=" + encodeURIComponent(redirect) +
    "&code_challenge=" + challenge +
    "&code_challenge_method=s256";
}

async function oauthSignIn(provider) {
  if (provider !== "apple" && provider !== "google") {
    throw new Error(txt("desktop.oauth.unsupported", "unsupported provider"));
  }
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());

  // The real browser first, for both providers. It is the one Google accepts,
  // and it is the one where the person is already signed in.
  try {
    const code = await awaitLoopbackCode(authorizeUrl(provider, challenge, loopbackUrl()));
    return await exchangeCode(code, verifier);
  } catch (err) {
    // A port we cannot bind is the only failure worth retrying differently —
    // anything else (cancelled, denied, timed out) is an answer, and asking
    // again in a window Google refuses would only replace it with a worse one.
    const portBusy = err && (err.code === "EADDRINUSE" || err.code === "EACCES");
    if (!portBusy) throw err;
  }
  return oauthEmbedded(provider, verifier, challenge);
}

/** The old path: our own window. Kept for the case where the loopback port is
 *  taken, where it is better than nothing — and it still works for Apple. */
function oauthEmbedded(provider, verifier, challenge) {
  const redirect = redirectUrl();
  const url = authorizeUrl(provider, challenge, redirect);
  return new Promise((resolve, reject) => {
    // Its own partition, wiped on close: a sign-in window that keeps cookies
    // is a sign-in window that silently reuses whoever signed in last, with no
    // way to pick a different account.
    const part = "oauth-" + Date.now();
    const ses = session.fromPartition(part, { cache: false });
    const win = new BrowserWindow({
      width: num("desktop.oauth.width", 480), height: num("desktop.oauth.height", 680),
      title: txt("desktop.oauth.title", "Sign in"),
      backgroundColor: color("desktop.window.background", "#000000"),
      autoHideMenuBar: true, parent: appWin && !appWin.isDestroyed() ? appWin : undefined,
      modal: false,
      webPreferences: { partition: part, contextIsolation: true, nodeIntegration: false },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      try { ses.clearStorageData(); } catch { /* best effort */ }
      if (!win.isDestroyed()) win.destroy();
      err ? reject(err) : resolve(value);
    };

    // Read the code the instant the browser reaches for the redirect, and stop
    // the request there.
    ses.webRequest.onBeforeRequest({ urls: [redirect + "*"] }, (details, cb) => {
      cb({ cancel: true });
      let u;
      try { u = new URL(details.url); } catch { return finish(new Error(txt("desktop.oauth.badRedirect", "bad redirect"))); }
      const err = u.searchParams.get("error_description") || u.searchParams.get("error");
      if (err) return finish(new Error(err));
      const code = u.searchParams.get("code");
      if (!code) return finish(new Error(txt("desktop.oauth.noCode", "no authorization code")));
      exchangeCode(code, verifier).then((r) => finish(null, r), (e) => finish(e));
    });

    win.on("closed", () => finish(new Error("cancelled")));
    win.loadURL(url).catch((e) => finish(e));
  });
}

/** Trade the authorization code for a session. PKCE: the verifier proves the
 *  code came back to the same process that asked for it. */
async function exchangeCode(code, verifier) {
  const res = await fetch(SUPABASE_URL + "/auth/v1/token?grant_type=pkce", {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(json.error_description || json.msg || json.error || txt("desktop.oauth.failed", "sign-in failed"));
  }
  return json;
}

let tray = null;
let recorderWin = null;
let overlayWin = null;
let recording = false;
let holdActive = false;
let tapActive = false;
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
// A screen the window should show as soon as it can — set when the main
// process asks for one (the paywall, when dictation is out of words) before
// the page is there to be told. Handed over by app:env or on load.
let pendingScreen = null;
// Quitting, as opposed to closing the window: the close handler below hides
// the window instead of closing it, and a hide in the middle of app.quit()
// cancels the quit — which left "Quit Tailzu" doing nothing once the window
// had been opened.
let quitting = false;
app.on("before-quit", () => { quitting = true; });

/** Show the window; with a screen id, on that screen. Menu items call this
 *  with a MenuItem, so only a string counts as a screen. */
function openAppWindow(screenId) {
  const target = typeof screenId === "string" && screenId ? screenId : null;
  if (appWin && !appWin.isDestroyed()) {
    appWin.show(); appWin.focus();
    if (target) {
      if (appWin.webContents.isLoading()) pendingScreen = target;
      else appWin.webContents.send("app:navigate", target);
    }
    return;
  }
  if (target) pendingScreen = target;
  appWin = new BrowserWindow({
    // Wide enough for the sign-in art and the form to stand side by side. At
    // 980 the art's own rule and a 300px form were fighting over the same
    // eighty pixels; the layout still re-centres below `wideAt` for anyone who
    // drags it narrower.
    width: num("desktop.window.width", 1120), height: num("desktop.window.height", 780),
    minWidth: num("desktop.window.minWidth", 380), minHeight: num("desktop.window.minHeight", 520),
    title: txt("desktop.window.title", "Tailzu"),
    backgroundColor: color("desktop.window.background", "#000000"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  hardenWindow(appWin);
  // "hide" puts it away and keeps its boot (a tray app's close means that);
  // "close" really closes it, and the tray builds a fresh one next time.
  appWin.on("close", (e) => {
    if (quitting || str("desktop.window.closeAction", "hide") === "close") return;
    e.preventDefault();
    appWin.hide();
  });
  // A screen asked for while the page was loading, and not yet collected by
  // app:env, goes over as soon as the page can hear it.
  appWin.webContents.on("did-finish-load", () => {
    if (!pendingScreen || !appWin || appWin.isDestroyed()) return;
    const id = pendingScreen;
    pendingScreen = null;
    appWin.webContents.send("app:navigate", id);
  });
  appWin.loadFile("app.html");
}

/** Deny navigation + popups on our local windows — they only ever load our own
 *  files, so anything else is a bug or an injection attempt. */
function hardenWindow(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // A reload is a navigation to the page's own URL, and the guard was
  // swallowing it too — so "Sign out", which clears the session and reloads
  // the window to land on the gate, cleared the session and did nothing
  // anyone could see. The page may go back to itself; nowhere else.
  win.webContents.on("will-navigate", (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault();
  });
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
  const w = num("desktop.overlay.width", 560), h = num("desktop.overlay.height", 84);
  overlayWin = new BrowserWindow({
    width: w, height: h,
    x: Math.round(wa.x + (wa.width - w) / 2),
    y: wa.y + wa.height - num("desktop.overlay.bottomOffset", 120),
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
    const size = num("desktop.tray.iconSize", 18);
    return process.platform === "darwin" ? img.resize({ width: size, height: size }) : img;
  }
  return nativeImage.createEmpty();
}

function refreshTray() {
  if (!tray) return;
  tray.setToolTip(recording ? t("tray.tooltipListening")
    : signedIn() ? t("tray.tooltipReady") : t("tray.tooltipSignIn"));
  tray.setContextMenu(buildMenu());
}

function buildMenu() {
  return Menu.buildFromTemplate([
    // Says what the press will actually do. A plain "Dictate" on a signed-out
    // machine promises something the click cannot deliver.
    {
      label: recording ? fmt("tray.listening", { key: prettyKey(cfg.hotkey) })
        : signedIn() ? t("tray.dictate") : t("tray.signInToDictate"),
      click: toggleDictation,
    },
    { label: t("tray.open"), click: () => openAppWindow() },
    { type: "separator" },
    {
      label: `${t("tray.tone")}: ${toneLabel(currentTone())}${signedIn() ? "" : ` (${t("tray.toneThisDevice")})`}`,
      // The account's tone may be a voice the user created, which is not in
      // this list — include it so the menu can show it selected rather than
      // showing five unticked rows and implying none is active.
      submenu: (() => {
        const rows = tones();
        if (accountTone && !rows.some((x) => x.id === accountTone)) rows.push({ id: accountTone, label: accountTone });
        return rows.map((x) => ({
          label: x.label, type: "radio", checked: currentTone() === x.id,
          click: () => { void setAccountTone(x.id); },
        }));
      })(),
    },
    {
      label: t("tray.liveCaptions"),
      type: "checkbox", checked: cfg.live,
      click: (item) => saveConfig({ live: item.checked }),
    },
    {
      label: t("tray.startAtLogin"),
      type: "checkbox", checked: cfg.autoStart,
      click: (item) => {
        saveConfig({ autoStart: item.checked });
        // Registering the dev electron binary as a login item is useless noise;
        // only meaningful for the installed app.
        if (app.isPackaged) {
          app.setLoginItemSettings({ openAtLogin: item.checked, args: ["--hidden"] });
        }
      },
    },
    { type: "separator" },
    // The double-tap first, because it is the way in now and the chord is the
    // fallback. A row that says the gesture is unavailable matters more than
    // one naming a key that works.
    // A switch, not a notice: the gesture lives on the most-used key on the
    // board, and whoever it gets in the way of needs to turn it off from here,
    // not from a config file.
    {
      label: `${fmt("tray.tapToTalk", { key: cfg.tapKeys.join(txt("desktop.tray.keyJoiner", " or ")) })}${tapActive ? "" : ` (${t("tray.holdUnavailable")})`}`,
      type: "checkbox", checked: cfg.tap && tapActive, enabled: tapActive,
      click: (item) => saveConfig({ tap: item.checked }),
    },
    { label: `${t("tray.hotkey")}: ${prettyKey(cfg.hotkey)}`, enabled: false },
    {
      label: cfg.hold
        ? `${t("tray.holdToTalk")} ${cfg.holdKey}${holdActive ? "" : ` (${t("tray.holdUnavailable")})`}`
        : t("tray.holdOff"),
      enabled: false,
    },
    { label: `${t("tray.backend")}: ${cfg.baseUrl}`, enabled: false },
    // Which credential is ACTUALLY in use — ends the "which token is it using"
    // guessing when auth fails. Signed in, that is the account; signed out
    // there is none, because there is no static token to fall back on.
    {
      label: signedIn() ? t("tray.signedIn") : txt("desktop.tray.signedOut", "Not signed in"),
      enabled: false,
    },
    { label: t("tray.editConfig"), click: openConfig },
    { type: "separator" },
    { label: t("tray.quit"), click: () => app.quit() },
  ]);
}

function openConfig() {
  if (!fs.existsSync(configPath)) {
    // seed from the example so first-time users have something to edit
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.copyFileSync(path.join(__dirname, "config.example.json"), configPath);
    } catch {
      fs.writeFileSync(configPath, JSON.stringify({ baseUrl: cfg.baseUrl, hotkey: cfg.hotkey }, null, 2));
    }
  }
  shell.openPath(configPath);
}

// ---- What the app window is allowed to ask for -------------------------------
// Narrow on purpose: the renderer gets the backend URL, the session, and the
// ability to store one. It never gets fs, and it never gets the config file
// path — a renderer that can write arbitrary paths is a renderer that can be
// talked into writing arbitrary paths.
ipcMain.handle("app:env", () => {
  const navigate = pendingScreen;
  pendingScreen = null;
  return {
    baseUrl: cfg.baseUrl,
    session: authSession,
    tone: cfg.tone,
    language: cfg.language,
    // The key that is actually bound, so the window can name it rather than
    // say "your hotkey" to someone whose first choice was taken.
    hotkey: prettyKey(cfg.hotkey),
    // Which desktop this is. The server draws Sign in with Apple on a Mac and
    // leaves it out on the others; the window only reports, it never decides.
    os: process.platform === "darwin" ? "mac" : process.platform === "win32" ? "windows" : "linux",
    // What the window reports in its own bootstrap: the build (package.json's
    // version, which the page cannot read) and how many times this install
    // has launched, counted once per launch here so both surfaces agree.
    appVersion: app.getVersion(),
    launchCount: Number(localState.launchCount) || 1,
    // The cached knobs, so the first paint is already the server's.
    knobs: knobsPayload(),
    // A screen the main process asked for before the page could hear it.
    navigate,
  };
});
ipcMain.handle("app:knobs", () => knobsPayload());
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
// Apple / Google. The window asks; the main process owns the browser window,
// the PKCE secret and the code exchange, and hands back only the session.
ipcMain.handle("app:oauth", async (_e, provider) => {
  try {
    const raw = await oauthSignIn(String(provider || ""));
    adoptSession(raw);
    refreshTray();
    void refreshAccountTone();
    return { ok: true, session: authSession };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});
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
// Every bootstrap the window receives — labels and flags, `desktop.shell`
// among them. Newer than this process's own fetch more often than not.
ipcMain.on("app:boot", (_e, v) => {
  if (!v || typeof v !== "object") return;
  const labels = v.labels && typeof v.labels === "object" ? v.labels : {};
  const flags = v.flags && typeof v.flags === "object" ? v.flags : {};
  // Over the cached response, so what only this process's fetch carries
  // (theme, navigation, media) is not dropped from the cache.
  adoptBoot(Object.assign({}, BOOT || {}, { labels, flags }));
});

// ---- Dictation toggle --------------------------------------------------------

/** DICTATION NEEDS AN ACCOUNT, exactly as it does on the phones.
 *
 *  Every path into recording comes through toggleDictation — the hotkey,
 *  hold-to-talk, the tray item, the window's "Dictate now" — so this is the one
 *  place that has to ask.
 *
 *  It was open, because a static fallback token authenticated a signed-out
 *  machine against a synthetic user. That made the desktop the one surface
 *  where you could dictate without registering, and put the words somewhere
 *  their owner could never read them: a history no account owns. (That
 *  fallback is gone entirely now; this is still the one place that asks.)
 *
 *  Refusing silently would be worse than the hole. A hotkey that does nothing
 *  reads as a broken hotkey, so this says what is wrong and opens the one
 *  window that can fix it. */
let lastSignInNudge = 0;
function requireAccount() {
  if (signedIn()) return true;
  openAppWindow();          // lands on the gate — render() shows it when there is no session
  // ONCE, NOT ONCE PER KEY REPEAT. Hold-to-talk calls this from `keydown`,
  // which auto-repeats for as long as the key is down — so an unthrottled
  // notification here would answer a two-second hold with a stack of twenty
  // identical toasts.
  const now = Date.now();
  if (now - lastSignInNudge > num("desktop.notify.nudgeThrottleMs", 5000)) {
    lastSignInNudge = now;
    notify(t("notify.signIn"));
  }
  return false;
}

/** OUT OF WORDS IS ANSWERED BEFORE THE MIC OPENS, not after the upload.
 *
 *  The server already says so in the bootstrap (`quota.exceeded`). Recording
 *  anyway meant talking for a minute and then being told, by a 429, that none
 *  of it would be written — so the answer comes first: the window opens on the
 *  screen the server names for it, and a notification says why. Throttled like
 *  the sign-in nudge, for the same key-repeat reason. */
let lastQuotaNudge = 0;
function requireWords() {
  if (!bool("quota.exceeded", false)) return true;
  const now = Date.now();
  if (now - lastQuotaNudge > num("desktop.notify.nudgeThrottleMs", 5000)) {
    lastQuotaNudge = now;
    openAppWindow(str("quota.screenId", "paywall"));
    notify(txt("desktop.notify.wordsOut", "You're out of words this month."));
  } else {
    openAppWindow();
  }
  return false;
}

/** Hand the recorder a token that is actually alive.
 *
 *  tokenNow() is synchronous by design — the hotkey path cannot afford a
 *  round-trip on every press — but a machine left alone overnight wakes with a
 *  spent access token, and spending it costs the whole dictation: you speak,
 *  and the answer is "HTTP 401" after the fact.
 *
 *  So the refresh happens only when the token is actually stale, which is once
 *  an hour at worst and never on a press that follows another. The session id
 *  is re-checked after the await: a second press can arrive while the POST is
 *  in flight, and starting a capture the user has already cancelled would leave
 *  the mic open with the tray saying "ready". */
async function startRecording(sid) {
  if (tokenStale()) await refreshSession();
  // Superseded while we waited — either stopped, or replaced by a newer press.
  if (!recording || sid !== activeSession) return;
  // The refresh may have failed, which means the session is gone rather than
  // merely old. Stop instead of recording into a void.
  if (!signedIn()) {
    recording = false;
    hideOverlay();   // toggleDictation already raised it for a live session
    refreshTray();
    requireAccount();
    return;
  }
  sendToRecorder("start-recording", {
    // The account's token, always: dictation requires one, so there is no
    // longer a fallback path that writes to a user nobody can read.
    baseUrl: cfg.baseUrl, token: tokenNow(), language: cfg.language,
    tone: currentTone(), live: cfg.live, session: sid,
    // Was never forwarded, so the recorder read it as absent — and absent
    // means on. Turning it off in config.json did nothing.
    pauseFlush: cfg.pauseFlush,
    // The sentences it shows when capture fails. Sent with the session rather
    // than read from a file over there: the recorder is a page with no disk of
    // its own, and this way it always has the copy this launch resolved.
    strings: SHELL.notify,
    // And every other number and word it uses (thresholds, mic constraints,
    // error copy) — the knobs as of this press.
    knobs: knobsPayload(),
  });
}

function toggleDictation() {
  // Only the START is gated. A stop must always go through, or a refusal that
  // arrives mid-dictation (a session expiring while the mic is open) would
  // strand the recorder running with no way to end it.
  if (!recording && !requireAccount()) return;
  if (!recording && !requireWords()) return;
  if (!recorderWin || recorderWin.isDestroyed()) createRecorderWindow();
  recording = !recording;
  if (recording) {
    activeSession = ++sessionSeq;
    // Overlay BEFORE the start call: when the token is fresh startRecording
    // runs to completion synchronously, and a failure inside it hides an
    // overlay that this line had not raised yet.
    if (cfg.live) { showOverlay(); overlayText(""); }
    void startRecording(activeSession);
  } else {
    sendToRecorder("stop-recording", { session: activeSession });
  }
  refreshTray();
}

// ---- Hold-to-talk (low-level key hook) ---------------------------------------
// globalShortcut has no key-up events, so hold-to-talk needs uiohook-napi. It's
// an optional native dep with prebuilt binaries; if it fails to load we degrade
// to the toggle hotkey and say so once.

/** Both the left and right key for a side-agnostic name ("Ctrl" → either one).
 *  Nobody thinks of them as different keys, and which one is under the hand
 *  depends on what the other hand is doing. */
function tapCodes(name, UiohookKey) {
  const exact = UiohookKey[name];
  const right = UiohookKey[`${name}Right`];
  return [exact, right].filter((c) => typeof c === "number");
}

function setupKeyHook() {
  let uIOhook, UiohookKey;
  try {
    ({ uIOhook, UiohookKey } = require("uiohook-napi"));
  } catch {
    if (cfg.hold) notify(t("notify.holdUnavailable"));
    if (cfg.tap) notify(t("notify.tapUnavailable"));
    return;
  }

  if (cfg.hold) {
    const code = UiohookKey[cfg.holdKey];
    if (!code) {
      notify(fmt("notify.unknownHoldKey", { key: cfg.holdKey }));
    } else {
      // keydown auto-repeats while held; the !recording / recording guards make
      // start fire once on press and stop once on release.
      uIOhook.on("keydown", (e) => { if (e.keycode === code && !recording) toggleDictation(); });
      uIOhook.on("keyup", (e) => { if (e.keycode === code && recording) toggleDictation(); });
      holdActive = true;
    }
  }

  // THE DOUBLE-TAP IS WATCHED WHENEVER THE HOOK LOADS, and gated on cfg.tap at
  // the moment of each pair, so the tray can switch it off and on without a
  // restart. A gesture that misfires needs an off switch within reach.
  {
    // Each name becomes its own watcher with its own pair-timer, so a pair is
    // always the same key twice. One shared timer would fire on Ctrl-then-Alt,
    // which is not a gesture anyone is making on purpose.
    const groups = cfg.tapKeys
      .map((name) => ({ name, codes: tapCodes(name, UiohookKey) }))
      .filter((g) => {
        if (g.codes.length) return true;
        if (cfg.tap) notify(fmt("notify.unknownTapKey", { key: g.name }));
        return false;
      });
    const codes = groups.flatMap((g) => g.codes);
    if (!codes.length) {
      /* every name was unknown — each already said so */
    } else {
      // The guards, and what each of them is for, live in tapDetector.js —
      // split out because the way this key misfires is a sequence of events
      // with timings, and a global key hook cannot be asked to reproduce one
      // on demand. It can be tested; this file cannot.
      const nameFor = (keycode) => {
        const g = groups.find((x) => x.codes.includes(keycode));
        return g ? g.name : null;
      };
      // The timings are the server's, read on every tap rather than once here,
      // so retuning one does not wait for a restart.
      const taps = createTapDetector({
        names: groups.map((g) => g.name),
        onPair: () => { if (cfg.tap) toggleDictation(); },
        maxHoldMs: () => num("desktop.tap.maxHoldMs", 350),
        gapMs: () => num("desktop.tap.gapMs", 400),
        minGapMs: () => num("desktop.tap.minGapMs", 70),
        otherKeyTtlMs: () => num("desktop.tap.otherKeyTtlMs", 8000),
      });
      uIOhook.on("keydown", (e) => taps.keyDown(nameFor(e.keycode), e.keycode));
      uIOhook.on("keyup", (e) => taps.keyUp(nameFor(e.keycode), e.keycode));
      // Ctrl+click and Ctrl+wheel are the commonest uses of the key that press
      // no other key at all. To the detector the mouse is another key.
      uIOhook.on("mousedown", () => taps.other());
      uIOhook.on("wheel", () => taps.other());
      tapActive = true;
    }
  }

  try {
    uIOhook.start();
    uiohookRef = uIOhook;
  } catch {
    holdActive = false;
    tapActive = false;
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
    title: txt("desktop.notify.accessibilityTitle", "Tailzu needs Accessibility"),
    body: txt("desktop.notify.accessibilityBody",
      "Text was copied. To auto-paste, enable Tailzu under System Settings → Privacy & Security → Accessibility."),
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
  setTimeout(pasteIntoFocusedApp, num("desktop.paste.delayMs", 120));
});

// A chunk of a session that is still running: paste it and leave the mic open.
// settleSession is deliberately NOT called — that is the entire difference
// between flushing on a pause and stopping on one.
ipcMain.on("dictation-segment", (_e, payload) => {
  const { session, text, failed } = payload || {};
  if (failed) {
    notify(fmt("notify.dictationFailed", { message: txt("desktop.notify.segmentLost", "segment lost — still listening") }));
    return;
  }
  const t = (text || "").trim();
  if (!t) return;
  clipboard.writeText(t);
  setTimeout(pasteIntoFocusedApp, num("desktop.paste.delayMs", 120));
  if (session === activeSession && cfg.live) overlayText("");
});

// Nobody said anything for a long time. Close the mic rather than leave it
// open on a desk somebody walked away from.
ipcMain.on("dictation-idle", (_e, payload) => {
  const { session } = payload || {};
  if (session === activeSession && recording) toggleDictation();
});

ipcMain.on("dictation-error", (_e, payload) => {
  const { session, message } = payload || {};
  settleSession(session);
  notify(fmt("notify.dictationFailed", { message }));
  // The server refused for words: the cached `quota.exceeded` was stale, so
  // ask again, and the next press is answered before the mic opens.
  if (String(message || "").indexOf("quota_exceeded") !== -1) void refreshBoot();
});

// Live partials from the recorder → overlay captions (current session only).
ipcMain.on("live-partial", (_e, payload) => {
  const { session, text } = payload || {};
  if (session === activeSession) overlayText(text);
});

// ---- App lifecycle -----------------------------------------------------------
// ONE TAILZU, NOT AS MANY AS THE ICON IS CLICKED.
//
// There was no instance lock, and this app has no window. So double-clicking
// the desktop shortcut while it was already in the tray started a SECOND copy
// that drew nothing — and the first symptom of that is not a duplicate, it is
// the hotkey: the second copy asks Windows for the same accelerator, Windows
// says it is taken, and the notification blames "another app". The other app
// was Tailzu.
//
// From the outside both halves look like a broken shortcut: click, nothing
// opens, and a warning about a key that worked yesterday.
//
// Now a second launch hands the click to the copy that is already running, and
// that copy opens the window — which is the only sensible answer to someone
// who just asked for the app and is looking at a desktop.
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    try { openAppWindow(); } catch { /* the tray is still there either way */ }
  });
}

/** Started by Windows at login rather than by a person clicking something. */
function startedHidden() {
  if (process.argv.includes("--hidden")) return true;
  try { return app.getLoginItemSettings().wasOpenedAtLogin === true; } catch { return false; }
}

app.whenReady().then(() => {
  // WHO THE NOTIFICATIONS ARE FROM.
  //
  // Windows titles a notification with the app's user-model id, and an
  // Electron app that never sets one is announced as "electron.app.Tailzu" —
  // which reads as a developer's leftover rather than as the product. Packaged
  // builds get this from the installer; saying it here covers the unpackaged
  // run too, and costs nothing when it is already right.
  if (process.platform === "win32") app.setAppUserModelId("space.tailzu.desktop");
  // Menu-bar / tray-only app — no dock icon on macOS.
  if (process.platform === "darwin" && app.dock) app.dock.hide();

  // THE WINDOW ANSWERS TO NO KEYS BUT ITS OWN.
  //
  // With no menu set, Electron installs its default one, and every shortcut in
  // it stays live in the app window even with the bar hidden: Ctrl+R reloads
  // the page and drops whatever screen was open, Ctrl+Shift+I opens developer
  // tools on a signed-in session, Ctrl+plus and minus zoom a layout drawn at
  // one size, Ctrl+W closes the window, F11 goes full screen — and Alt, one of
  // the two double-tap keys, shows and hides a File/Edit/View bar every time
  // it is tapped. None of that is this app.
  //
  // macOS keeps two things: the app menu, for ⌘Q, and an Edit menu — copy and
  // paste into a text field go through the menu there, and without it an email
  // address cannot be pasted into the sign-in box. Windows and Linux edit text
  // natively and need neither.
  //
  // TAILZU_DEVTOOLS=1 keeps Electron's menu, for whoever is building this.
  if (process.env.TAILZU_DEVTOOLS !== "1") {
    Menu.setApplicationMenu(process.platform === "darwin"
      ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }])
      : null);
  }

  // Auto-grant mic to our own local pages ONLY. Scoping to file:// means any
  // future remote content loaded by mistake can never inherit silent mic access.
  session.defaultSession.setPermissionRequestHandler((wc, permission, done) => {
    const local = (wc?.getURL() || "").startsWith("file://");
    done(local && (permission === "media" || permission === "audioCapture"));
  });

  // One launch, counted once — here, where only the copy that holds the lock
  // gets to, and before anything reports it.
  if (primaryInstance) {
    localState.launchCount = (Number(localState.launchCount) || 0) + 1;
    saveLocalState();
  }

  createRecorderWindow();

  tray = new Tray(trayIcon());
  refreshTray();

  // ASK THE SERVER NOW, window or no window. A login-item start never opens
  // one, and it is the launch that most needs the server's current answer —
  // it may run for days. The cache already answered for the moments before
  // this lands, and the timer keeps asking after it.
  void refreshBoot().then(scheduleBootRefresh);
  try { checkForUpdate(); } catch { /* a notice the OS refuses is not a failed launch */ }

  // THE WINDOW OPENS BEFORE ANYTHING THAT CAN FAIL.
  //
  // This used to be the last line of the ready handler, after the hotkey
  // registration, a notification and a login-item write. Any of those throwing
  // rejects the promise and the line never runs — leaving a tray icon and no
  // window, which is indistinguishable from an app that failed to start and is
  // precisely how it keeps being reported.
  //
  // A launch is someone asking to see the app. That should not be contingent
  // on whether a hotkey was available or whether Windows felt like accepting a
  // notification.
  //
  // A login start still opens nothing — nobody asked for it then; that is what
  // the --hidden argument is for.
  if (!startedHidden()) {
    try { openAppWindow(); } catch { /* the tray is still a way in */ }
  }

  if (configError) {
    try {
      new Notification({ title: txt("desktop.notify.configTitle", "Tailzu — config problem"), body: configError }).show();
    } catch { /* a notification the OS refuses must not take the app down */ }
  }

  // A HOTKEY THAT DOES NOT REGISTER LEAVES NO APP AT ALL.
  //
  // There is no window here by design: the tray and the hotkey are the whole
  // surface. So when Windows says another process already owns
  // Ctrl+Shift+Space — an IME usually does — the app is running, invisible,
  // and unusable, and the only thing it said about it was a notification that
  // disappears in a few seconds telling you to edit a file you have never
  // opened.
  //
  // So: try the fallbacks. Each is chosen to be unlikely to be owned, and
  // whichever takes becomes the hotkey for this run and is written back to the
  // config so the next run starts where this one ended up.
  // Ctrl+Alt+Space is NOT on this list. Claude's desktop app takes it, and a
  // fallback that lands on another assistant's prompt bar is worse than no
  // fallback: the key appears to work and belongs to someone else.
  const candidates = [cfg.hotkey].concat(list("desktop.hotkey.fallbacks", [
    "CommandOrControl+Shift+F12", "CommandOrControl+Alt+Shift+Space", "CommandOrControl+Alt+D",
  ]));
  let bound = null;
  for (const key of candidates) {
    if (!key || typeof key !== "string") continue;
    try {
      if (globalShortcut.register(key, toggleDictation)) { bound = key; break; }
    } catch { /* an unparseable accelerator is just another failed candidate */ }
  }

  if (bound && bound !== cfg.hotkey) {
    const taken = cfg.hotkey;
    cfg.hotkey = bound;
    try { saveConfig({ hotkey: bound }); } catch { /* config we cannot write is not fatal */ }
    refreshTray();
    notify(fmt("notify.hotkeyTaken", { taken: prettyKey(taken), bound: prettyKey(bound) }));
  } else if (!bound) {
    // Nothing took. The tray is the only way in, so say that rather than
    // naming a key that does not work.
    notify(t("notify.noHotkey"));
  }

  setupKeyHook();

  // Come up already knowing who is signed in and what tone they chose, so the
  // first thing in the menu is right before the window has ever been opened.
  void refreshAccountTone();
  // Keep the access token ahead of the hotkey. Renewing on a timer means
  // tokenNow() is valid when a key is pressed; renewing on demand would spend
  // a network round-trip out of the start of someone's sentence.
  const keepFresh = setInterval(() => { void refreshSession(); }, num("desktop.auth.keepFreshMs", 600000));
  app.on("will-quit", () => { clearInterval(keepFresh); clearTimeout(bootTimer); });

  if (app.isPackaged && cfg.autoStart) {
    // Registry writes fail on locked-down machines. That is a setting not
    // taking effect, not a reason for the app to be missing.
    try {
      app.setLoginItemSettings({ openAtLogin: true, args: ["--hidden"] });
    } catch { /* autostart is a convenience; the app is not */ }
  }
});

app.on("window-all-closed", (e) => { e.preventDefault(); }); // stay alive in the tray
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  try { uiohookRef?.stop(); } catch { /* already stopped */ }
});
