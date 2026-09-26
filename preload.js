// Bridge between the hidden recorder / overlay windows and the main process.
// contextIsolation is on, so renderers only see this tiny, explicit API.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tailzu", {
  // main → recorder
  onStart: (cb) => ipcRenderer.on("start-recording", (_e, cfg) => cb(cfg)),
  onStop: (cb) => ipcRenderer.on("stop-recording", () => cb()),
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
  setSession: (v) => ipcRenderer.invoke("app:setSession", v),
  openExternal: (url) => ipcRenderer.send("app:openExternal", url),
  dictate: () => ipcRenderer.send("app:dictate"),
  // The window owns auth; the tray needs a live token to read the account's
  // tone, so the window hands one over rather than the main process learning
  // to refresh sessions as well.
  token: (t) => ipcRenderer.send("app:token", t),
  changed: () => ipcRenderer.send("app:changed"),
  // Every bootstrap the window receives — its labels and flags, which carry
  // `desktop.shell` (the tray's and the notifications' copy) and every knob.
  // The main process fetches its own too; this only ever makes it fresher.
  boot: (v) => ipcRenderer.send("app:boot", v),
  // The knobs the main process holds (its cached bootstrap), so the window's
  // first paint uses the server's words even before its own bootstrap lands.
  knobs: () => ipcRenderer.invoke("app:knobs"),
  onKnobs: (cb) => ipcRenderer.on("knobs", (_e, k) => cb(k)),
  // The main process asking the window to show a screen — the paywall, when
  // dictation is refused for being out of words.
  onNavigate: (cb) => ipcRenderer.on("app:navigate", (_e, screenId) => cb(screenId)),
  // Apple / Google. The renderer cannot open a window or hold the PKCE
  // secret, so it asks and gets back a session or an error string.
  oauth: (provider) => ipcRenderer.invoke("app:oauth", provider),
});
