/**
 * THE MAIN PROCESS'S HALF OF A LIVE PAGE (liveView.js draws them in the app window; the server's shared/types/sdui.ts 3e).
 *
 * The app window may make <webview>s (main.js turns the tag on for it, and for nothing else). Whatever a page asks for, every one of
 * them gets exactly this:
 *
 *   - a session of its own, "tz-live", in memory only: none of the app's cookies, storage or cache, nothing kept after quitting. The
 *     app's tokens live in this process and in the window's memory; a live page can reach neither.
 *   - no Node, context isolation, Chromium's sandbox, web security on, no insecure content, no plugins, and one preload of ours
 *     (liveViewGuest.js: window.tailzuLive.post, for messages to the app). Nothing the page attaches can change these.
 *   - only http(s), data: and about:blank to start from.
 *   - it stays where it was put: it may move within its own site; any other address (a link, a redirect to another scheme, a new
 *     window) is refused, and the window is told, so the node can OFFER it to the person (allowPopups; they say yes first).
 *   - every permission refused (camera, microphone, location, notifications, screen…), and nothing downloaded.
 *
 * A webview asked for by anything but the app window is refused.
 */
"use strict";

const LIVE_PARTITION = "tz-live";
const START = /^(about:blank$|https?:\/\/|data:)/i;
const LOADS = /^(https?:|data:|about:|blob:)/i;

function originOf(url) {
  const m = /^(https?):\/\/([^/?#]*)/i.exec(String(url || ""));
  return m && m[2] && m[2].indexOf("@") === -1 ? (m[1] + "://" + m[2]).toLowerCase() : null;
}

/** May the top of a live page go from `from` to `to`? Only within an http(s) site it is already on. */
function staysHome(from, to) {
  const a = originOf(from), b = originOf(to);
  return !!a && a === b;
}

/** The preferences a live page runs with, whatever it asked for (pure; liveView.test.js). */
function lockPrefs(wp, preload) {
  const zoom = typeof wp.zoomFactor === "number" ? wp.zoomFactor : undefined;
  for (const k of Object.keys(wp)) delete wp[k];
  Object.assign(wp, {
    preload, nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, contextIsolation: true, sandbox: true,
    webSecurity: true, allowRunningInsecureContent: false, plugins: false, experimentalFeatures: false, webviewTag: false,
    navigateOnDragDrop: false, spellcheck: false, partition: LIVE_PARTITION, javascript: true, images: true,
    // A new window is never made (setWindowOpenHandler denies every one), but the handler must hear it, to tell the window.
    disablePopups: false,
    ...(zoom ? { zoomFactor: zoom } : {}),
  });
  return wp;
}

/**
 * Wire it up. `isAppWindow(contents)` says whether a webContents is the app window's. Call once, before the window opens.
 */
function setupLiveViews({ app, session, path, isAppWindow }) {
  const preload = path.join(__dirname, "liveViewGuest.js");
  let sessionReady = false;
  const lockSession = () => {
    if (sessionReady) return;
    sessionReady = true;
    const ses = session.fromPartition(LIVE_PARTITION);
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on("will-download", (e) => e.preventDefault());
    if (typeof ses.setDisplayMediaRequestHandler === "function") ses.setDisplayMediaRequestHandler((_req, cb) => cb({}));
  };

  app.on("web-contents-created", (_e, contents) => {
    contents.on("will-attach-webview", (e, wp, params) => {
      if (!isAppWindow(contents) || !START.test(String((params && params.src) || ""))) { e.preventDefault(); return; }
      lockSession();
      lockPrefs(wp, preload);
      if (params) { params.partition = LIVE_PARTITION; delete params.preload; }
    });
    contents.on("did-attach-webview", (_e, guest) => {
      const tell = (url) => { try { if (!contents.isDestroyed()) contents.send("live:open", { guestId: guest.id, url: String(url || "").slice(0, 2000) }); } catch { /* the window went */ } };
      guest.setWindowOpenHandler(({ url }) => { tell(url); return { action: "deny" }; });
      guest.on("will-navigate", (ev, url) => { if (!staysHome(guest.getURL(), url)) { ev.preventDefault(); tell(url); } });
      guest.on("will-redirect", (ev, url) => { if (!LOADS.test(String(url || ""))) ev.preventDefault(); });
      guest.on("will-frame-navigate", (ev) => { if (!LOADS.test(String((ev && ev.url) || ""))) ev.preventDefault(); });
      // A live page never makes a page of its own.
      guest.on("will-attach-webview", (ev) => ev.preventDefault());
    });
  });
}

module.exports = { setupLiveViews, lockPrefs, staysHome, LIVE_PARTITION };
