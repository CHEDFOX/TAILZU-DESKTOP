// Ask's one-time setup card in the app window ("Let Ask see what you see."):
// the main process's side of it (createAskSetup).

// The "ask" actions the card may ask for. Anything else is ignored.
const SETUP_KINDS = new Set(["openAccessibility", "openScreenRecording", "picturesAll", "relaunch"]);

/**
 * ASK'S ONE-TIME SETUP, the main process's side of it: "Let Ask see what you
 * see." in the app window (sdui/ DeskAskSetup), three rows, each with its
 * state and one button.
 *
 *   read      Accessibility on a Mac (the screen's buttons, fields and text);
 *             nothing to allow elsewhere ("na")
 *   see       Screen Recording on a Mac; "restart" when the Mac says it is
 *             granted but the helper's last look was still refused, which
 *             takes a restart of Tailzu
 *   pictures  look without asking each time, for every app (local state
 *             askPicturesAlwaysAll): ON by default, so "on" unless it was
 *             turned off (an explicit false, from this card or the tray's
 *             "Ask again for all of them"); "never" when the server has
 *             turned pictures off, which wins over everything
 *
 * The states are read here, on this computer, and nothing of them leaves it.
 * The window asks for them (app:askSetup) and is told again whenever they
 * may have changed ("ask-setup": its focus, each action, a look's answer).
 * Only the app window may ask or act (fromApp), and a button opens only its
 * own fixed page.
 *
 *   o.ipcMain, o.fromApp(e)
 *   o.platform             process.platform
 *   o.systemPreferences    Electron's (Mac: isTrustedAccessibilityClient, getMediaAccessStatus)
 *   o.knobs                { str }
 *   o.localState, o.saveLocalState
 *   o.screenDenied()       the last look was refused for want of Screen Recording
 *   o.openAccessibility()  the Mac's Accessibility page
 *   o.openScreenRecording()  the guide's Screen Recording path (main.js)
 *   o.relaunch()
 *   o.send(state)          to the app window, as "ask-setup"
 */
function createAskSetup(o) {
  const mac = o.platform === "darwin";
  const call = (f, fallback) => { try { return f(); } catch { return fallback; } };
  let axPrompted = false;   // macOS asked to list Tailzu under Accessibility, this launch

  function state() {
    let read = "na", see = "na";
    if (mac) {
      const sp = o.systemPreferences || {};
      read = call(() => sp.isTrustedAccessibilityClient(false), false) === true ? "on" : "off";
      if (call(() => sp.getMediaAccessStatus("screen"), "") === "granted") {
        see = call(() => o.screenDenied(), false) === true ? "restart" : "on";
      } else see = "off";
    }
    const never = o.knobs.str("desktop.agent.pictures", "ask") === "never";
    return {
      platform: mac ? "mac" : o.platform === "win32" ? "windows" : "linux",
      read, see,
      pictures: never ? "never" : o.localState.askPicturesAlwaysAll === false ? "off" : "on",
    };
  }
  /** The state, to the app window. */
  function push() {
    try { o.send(state()); } catch (e) { console.warn("[ask] the setup card could not be told:", (e && e.message) || e); }
  }

  /** One of the card's buttons. True when it was one it may ask for. */
  function act(p) {
    if (!p || typeof p !== "object" || !SETUP_KINDS.has(p.kind)) return false;
    if (p.kind === "openAccessibility" || p.kind === "openScreenRecording") {
      // A Mac's own settings pages; there is nothing to open elsewhere.
      if (!mac) return false;
      // ON A FRESH MAC TAILZU IS NOT IN THE ACCESSIBILITY LIST until it has
      // asked once, so the page opened on a list with nothing to switch on.
      // Asked here, once a launch and only while it is still off: macOS adds
      // Tailzu to the list (and shows its own prompt), then the page opens.
      if (p.kind === "openAccessibility" && !axPrompted) {
        const sp = o.systemPreferences || {};
        if (call(() => sp.isTrustedAccessibilityClient(false), false) !== true) {
          axPrompted = true;
          call(() => sp.isTrustedAccessibilityClient(true));
        }
      }
      call(() => (p.kind === "openAccessibility" ? o.openAccessibility() : o.openScreenRecording()));
      return true;
    }
    if (p.kind === "picturesAll") {
      if (typeof p.on !== "boolean") return false;
      o.localState.askPicturesAlwaysAll = p.on;
      call(() => o.saveLocalState());
      return true;
    }
    // relaunch: only when the card offers it ("Restart Tailzu to finish"). A
    // restart takes a dictation, a note and a question down with it, so a
    // window cannot ask for one at any other time.
    if (state().see !== "restart") return false;
    call(() => o.relaunch());
    return true;
  }

  o.ipcMain.handle("app:askSetup", (e) => (o.fromApp(e) ? state() : null));
  o.ipcMain.on("app:askSetupAction", (e, p) => {
    if (!o.fromApp(e)) return;
    if (act(p)) push();
  });
  return { state, push, act };
}

module.exports = { createAskSetup };
