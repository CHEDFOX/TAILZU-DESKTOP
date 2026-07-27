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
