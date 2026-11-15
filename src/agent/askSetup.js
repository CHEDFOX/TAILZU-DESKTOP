// Ask's one-time setup card in the app window ("Let Ask see what you see."):
// the main process's side of it (createAskSetup).

// The "ask" actions the card may ask for. Anything else is ignored.
// openMicrophone and openCamera are the two the person can only turn on in
// their own settings: a Mac that has already been told no (it never asks
// twice), and Windows, which has no prompt for an app to show at all.
const SETUP_KINDS = new Set(["openAccessibility", "openScreenRecording", "openMicrophone", "openCamera", "picturesAll", "relaunch"]);

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
 *   o.promptScreenRecording()  the system's own screen dialog, and nothing else
 *   o.openMediaSettings(w)  the microphone or camera page (a Mac's, or Windows')
 *   o.relaunch()
 *   o.send(state)          to the app window, as "ask-setup"
 */
function createAskSetup(o) {
  const mac = o.platform === "darwin";
  const call = (f, fallback) => { try { return f(); } catch { return fallback; } };
  let axPrompted = false;   // macOS asked to list Tailzu under Accessibility, this launch
  const asked = new Set();  // which of the Mac's two the person has pressed, so the second press opens the page

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
    if (p.kind === "openMicrophone" || p.kind === "openCamera") {
      // The microphone and the camera page, on the two systems that keep one.
      // Nothing to open on Linux, where neither is a permission.
      const what = p.kind === "openMicrophone" ? "microphone" : "camera";
      if (!mac && o.platform !== "win32") return false;
      return call(() => o.openMediaSettings(what), false) !== false;
    }
    if (p.kind === "openAccessibility" || p.kind === "openScreenRecording") {
      // A Mac's own, and nothing to ask for elsewhere.
      if (!mac) return false;
      // THE SYSTEM ASKS FIRST, IN THE APP. macOS has a dialog of its own for
      // each of these and shows it the FIRST time an app asks, over whatever
      // is in front: "X0 Bot would like to control this computer…". So the
      // first press is that dialog and nothing else — no page, no leaving the
      // app. macOS never shows it again, so the press after it opens the page
      // where the switch is, which is the only way it can be turned on (no
      // system lets an app grant these two itself).
      //
      // The asking also matters on a fresh Mac: until an app has asked once it
      // is not in that page's list at all, so the page would open on a list
      // with nothing to switch on.
      const first = !asked.has(p.kind);
      asked.add(p.kind);
      if (p.kind === "openAccessibility") {
        const sp = o.systemPreferences || {};
        if (call(() => sp.isTrustedAccessibilityClient(false), false) === true) return true;
        if (first && !axPrompted) {
          axPrompted = true;
          call(() => sp.isTrustedAccessibilityClient(true));
          return true;
        }
        call(() => o.openAccessibility());
        return true;
      }
      if (first) {
        call(() => (o.promptScreenRecording ? o.promptScreenRecording() : o.openScreenRecording()));
        return true;
      }
      call(() => o.openScreenRecording());
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
