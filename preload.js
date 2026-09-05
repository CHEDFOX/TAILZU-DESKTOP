// Bridge between the hidden recorder / overlay windows and the main process.
// contextIsolation is on, so renderers only see this tiny, explicit API.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tailzu", {
  // main → recorder
  onStart: (cb) => ipcRenderer.on("start-recording", (_e, cfg) => cb(cfg)),
  onStop: (cb) => ipcRenderer.on("stop-recording", () => cb()),
  // recorder → main
  result: (text) => ipcRenderer.send("dictation-result", text),
  error: (msg) => ipcRenderer.send("dictation-error", msg),
  partial: (text) => ipcRenderer.send("live-partial", text),
  // main → overlay
  onOverlayText: (cb) => ipcRenderer.on("overlay-text", (_e, t) => cb(t)),
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
});
