// Bridge between our windows (the hidden recorder, the pill, the captions, the
// app window) and the main process. contextIsolation is on, so renderers only
// see this tiny, explicit API — and the main process checks which window sent
// each message, so a call exposed here to all four is answered for one.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tailzu", {
  // main → recorder
  onStart: (cb) => ipcRenderer.on("start-recording", (_e, cfg) => cb(cfg)),
  // With the session it is for: the recorder ignores a stop meant for one it
  // has already left (it used to be dropped here, so that check never ran).
  onStop: (cb) => ipcRenderer.on("stop-recording", (_e, p) => cb(p)),
  // recorder → main
  // A finished chunk of a session that is STILL RUNNING. Separate from
  // `result` because the main process must paste it without ending the
  // session — the whole point of flushing on a pause.
  segment: (text) => ipcRenderer.send("dictation-segment", text),
  // Nobody has said anything for a long time. The mic closes itself.
  idle: (p) => ipcRenderer.send("dictation-idle", p),
  result: (text) => ipcRenderer.send("dictation-result", text),
  error: (msg) => ipcRenderer.send("dictation-error", msg),
  partial: (text) => ipcRenderer.send("live-partial", text),
  // How loud the voice is, band by band, while the mic is open — for the pill.
  level: (p) => ipcRenderer.send("dictation-level", p),
  // main → recorder: throw this session away, nothing is written.
  onCancel: (cb) => ipcRenderer.on("cancel-recording", (_e, p) => cb(p)),
  // recorder → main: the account's access token as of now, renewed by the
  // main process (the one holder of the refresh token) when it is spent, or
  // at once with `renew` after the server refused the one sent.
  token: (renew) => ipcRenderer.invoke("recorder:token", !!renew),
  // main → pill: its state, and the voice's level while it listens.
  onPill: (cb) => ipcRenderer.on("pill", (_e, m) => cb(m)),
  onLevel: (cb) => ipcRenderer.on("pill-level", (_e, p) => cb(p)),
  // pill → main: the pointer is over it (take clicks) or not (let them
  // through), and what a click on it asks for: start, finish or cancel.
  pillHover: (on) => ipcRenderer.send("pill:hover", !!on),
  pillAction: (a) => ipcRenderer.send("pill:action", String(a || "")),
  // main → overlay
  onOverlayText: (cb) => ipcRenderer.on("overlay-text", (_e, t) => cb(t)),
  // The server's knobs ({ labels, flags } of the last bootstrap), for a page
  // that loads knobs.js. Pulled once on load, then pushed on every change.
  knobs: () => ipcRenderer.invoke("app:knobs"),
  onKnobs: (cb) => ipcRenderer.on("knobs", (_e, k) => cb(k)),
});

// The app window's own bridge, kept separate from the recorder's so neither
// surface can reach the other's calls. Everything here is a request the main
// process validates — the renderer never touches the filesystem or the shell.
contextBridge.exposeInMainWorld("tailzuApp", {
  env: () => ipcRenderer.invoke("app:env"),
  // This computer's own settings (the pill, pausing, start at login, the
  // bound keys), and a request to change one. The main process checks both.
  config: () => ipcRenderer.invoke("app:config"),
  setConfig: (key, value) => ipcRenderer.invoke("app:setConfig", key, value),
  // Signed in or out: the main process keeps the session and answers with
  // the part the window holds (the access token and its expiry).
  setSession: (v) => ipcRenderer.invoke("app:setSession", v),
  // The token again, renewed by the main process when it is spent. It alone
  // holds the refresh token: two holders of one rotating token sign out.
  session: () => ipcRenderer.invoke("app:session"),
  openExternal: (url) => ipcRenderer.send("app:openExternal", url),
  dictate: () => ipcRenderer.send("app:dictate"),
  // Start or stop taking notes, as the notes hotkey does.
  toggleNotes: () => ipcRenderer.send("app:notes"),
  // A note was organised (its id): the Notes pages can redraw.
  onNotes: (cb) => ipcRenderer.on("app:notes", (_e, id) => cb(id)),
  changed: () => ipcRenderer.send("app:changed"),
  // Every bootstrap the window receives — its labels and flags, which carry
  // `desktop.shell` (the tray's and the notifications' copy) and every knob.
  // The main process fetches its own too; this only ever makes it fresher.
  boot: (v) => ipcRenderer.send("app:boot", v),
  // The knobs the main process holds (its cached bootstrap) come with env();
  // every newer set is pushed here.
  onKnobs: (cb) => ipcRenderer.on("knobs", (_e, k) => cb(k)),
  // The main process asking the window to show a screen — the paywall, when
  // dictation is refused for being out of words.
  onNavigate: (cb) => ipcRenderer.on("app:navigate", (_e, screenId) => cb(screenId)),
  // A dictation was written (and pasted where the cursor was).
  onDictated: (cb) => ipcRenderer.on("app:dictated", () => cb()),
  // Apple / Google. The renderer cannot open a window or hold the PKCE
  // secret, so it asks and gets back a session or an error string.
  oauth: (provider) => ipcRenderer.invoke("app:oauth", provider),
  // The update card: install this build in place of the running one. The
  // main process checks the address and the checksum; progress comes back.
  installUpdate: (u) => ipcRenderer.invoke("app:installUpdate", u),
  onUpdateProgress: (cb) => ipcRenderer.on("app:updateProgress", (_e, p) => cb(p)),
});

// The note-taker's hidden window (notes.html). The main process answers these
// for that window only.
contextBridge.exposeInMainWorld("tailzuNotes", {
  onStart: (cb) => ipcRenderer.on("notes:start", (_e, cfg) => cb(cfg)),
  onStop: (cb) => ipcRenderer.on("notes:stop", () => cb()),
  // macOS: the computer's sound, as 16 kHz 16-bit PCM from the helper.
  onPcm: (cb) => ipcRenderer.on("notes:pcm", (_e, bytes) => cb(bytes)),
  token: (renew) => ipcRenderer.invoke("notes:token", !!renew),
  status: (p) => ipcRenderer.send("notes:status", p),
  done: (p) => ipcRenderer.send("notes:done", p),
});
