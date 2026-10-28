// The preload of a live page (liveViewMain.js gives it to every webview the app window makes; liveView.js draws them). It runs in
// the page's top frame only, in an isolated world, sandboxed, and gives the page one call: window.tailzuLive.post(obj), a message to
// the app window (a JSON object, 8 KB at most). The app treats every message as untrusted. Nothing else of Electron reaches the page.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tailzuLive", {
  post: (m) => {
    try {
      const s = JSON.stringify(m);
      if (typeof s === "string" && s.length <= 8192) ipcRenderer.sendToHost("tz-live", s);
    } catch { /* not data */ }
  },
});
