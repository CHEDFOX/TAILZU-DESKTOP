// Bridge between the hidden recorder window and the main process.
// contextIsolation is on, so the renderer only sees this tiny, explicit API.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tailzu", {
  // main → renderer
  onStart: (cb) => ipcRenderer.on("start-recording", (_e, cfg) => cb(cfg)),
  onStop: (cb) => ipcRenderer.on("stop-recording", () => cb()),
  // renderer → main
  result: (text) => ipcRenderer.send("dictation-result", text),
  error: (msg) => ipcRenderer.send("dictation-error", msg),
});
