// The tray's and the notifications' words (flags["desktop.shell"]): the
// built-in defaults a first launch offline still needs, and the merge that lays
// the server's answer over them. main.js keeps the live copy (SHELL) and reads
// it with t() and fmt().

const SHELL_DEFAULTS = {
  tray: {
    dictate: "Dictate",
    listening: "◉ Listening — {key} stops",
    signInToDictate: "Sign in to dictate…",
    open: "Open X0 Bot",
    tone: "Tone",
    toneThisDevice: "this device",
    liveCaptions: "Live captions while dictating",
    startAtLogin: "Start at login",
    hotkey: "Hotkey",
    holdToTalk: "Hold-to-talk: hold",
    holdUnavailable: "unavailable",
    holdOff: "Hold-to-talk: off (set \"hold\": true in config)",
    tapToTalk: "Double-tap {key} to dictate",
    backend: "Backend",
    signedIn: "Signed in — dictation lands on your account",
    editConfig: "Edit config…",
    quit: "Quit X0 Bot",
    tooltipReady: "X0 Bot — ready",
    tooltipListening: "X0 Bot — listening…",
    tooltipSignIn: "X0 Bot — sign in to dictate",
    notesStop: "◉ Taking notes {time} — click to stop",
    notesTooltip: "X0 Bot — taking notes, {time}",
  },
  notify: {
    title: "X0 Bot",
    signIn: "Sign in to dictate — your words belong to your account.",
    holdUnavailable: "Hold-to-talk unavailable (uiohook-napi didn't load) — using the toggle hotkey.",
    micBlockedWindows: "microphone blocked — Settings → Privacy & security → Microphone → let desktop apps access",
    micBlockedMac: "microphone blocked — System Settings → Privacy & Security → Microphone → X0 Bot",
    micMissing: "no microphone found — plug one in, then try again",
    micBusy: "microphone is in use by another app",
    noSpeech: "no speech detected — check your microphone",
    unknownHoldKey: "Unknown holdKey \"{key}\" — use a key name like F9, F10, F12.",
    tapUnavailable: "Double-tap unavailable (uiohook-napi didn't load) — using the hotkey.",
    unknownTapKey: "Unknown tapKey \"{key}\" — use Ctrl, Alt, Shift or Meta.",
    dictationFailed: "Dictation failed: {message}",
    hotkeyTaken: "{taken} is taken by another app, so dictation is on {bound}. Change it under Edit config.",
    noHotkey: "No hotkey could be registered. Use Dictate in the tray menu, and set a free one under Edit config.",
    notesStarted: "Taking notes. Nothing is typed anywhere. Press {key} to stop.",
    notesReady: "Notes ready: {title}",
    notesHotkeyTaken: "{taken} is taken by another app, so notes are on {bound}.",
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

module.exports = { SHELL_DEFAULTS, mergeShell, shellOf };
