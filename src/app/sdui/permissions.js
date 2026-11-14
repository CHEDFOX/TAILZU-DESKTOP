// BACK FROM SYSTEM SETTINGS. The Ask setup card's Allow sends the person to a
// Mac settings page, and coming back to this window is when the answer may
// have changed. The main process pushes on focus too; asking here as well
// costs one local call and keeps the row honest if a push is missed.
window.addEventListener("focus", () => {
  if (ASK_LISTENING && CURRENT_SCREEN && findNode(CURRENT_SCREEN.root, "DeskAskSetup")) askSetupRead();
  micFollow();
  camFollow();
  seeFollow();
  axFollow();
});

/**
 * THE MICROPHONE'S ANSWER, for a page that asks after it ($state.micGranted:
 * the Bots app's microphone card). The OS keeps it, outside this window, so
 * it is the main process that reads it (granted, denied, not-determined,
 * restricted); anything but "granted" is a no, except "unknown" (a system
 * with no such switch), which is nothing to ask for. Read when the page is
 * painted and again on coming back to the window (from System Settings).
 */
async function micReading() {
  try {
    const st = String(await window.tailzuApp.micStatus() || "unknown");
    return st === "granted" || st === "unknown";
  } catch { return null; }
}

function micFollow() {
  if (!micAskOn() || !CURRENT_SCREEN || !CURRENT_SCREEN.state || !Object.hasOwn(CURRENT_SCREEN.state, "micGranted")) return;
  const screen = CURRENT_SCREEN;
  micReading().then((on) => {
    if (on === null || CURRENT_SCREEN !== screen || STATE.micGranted === on) return;
    setStatePath("micGranted", on);
    repaint();
  });
}

/**
 * THE CAMERA'S ANSWER, read the same way as the microphone's, for a page that
 * asks after it ($state.camGranted: the window's permissions step). Nothing
 * opens the camera until the person turns it on in a call (docs/rooms.md).
 */
async function camReading() {
  try {
    const st = String(await window.tailzuApp.camStatus() || "unknown");
    return st === "granted" || st === "unknown";
  } catch { return null; }
}

function camFollow() {
  if (!camAskOn() || !CURRENT_SCREEN || !CURRENT_SCREEN.state || !Object.hasOwn(CURRENT_SCREEN.state, "camGranted")) return;
  const screen = CURRENT_SCREEN;
  camReading().then((on) => {
    if (on === null || CURRENT_SCREEN !== screen || STATE.camGranted === on) return;
    setStatePath("camGranted", on);
    repaint();
  });
}

/**
 * SCREEN RECORDING'S ANSWER, the same way, for a page that asks after it
 * ($state.seeGranted: the window's permissions step). Only a Mac keeps such an
 * answer; "unknown" is nothing to ask for. Read on coming back to the window
 * and on coming back to the front, which is when System Settings may have
 * turned it on.
 */
async function seeReading() {
  try {
    const st = String(await window.tailzuApp.seeStatus() || "unknown");
    return st === "granted" || st === "unknown";
  } catch { return null; }
}

function seeFollow() {
  if (!seeAskOn() || !CURRENT_SCREEN || !CURRENT_SCREEN.state || !Object.hasOwn(CURRENT_SCREEN.state, "seeGranted")) return;
  const screen = CURRENT_SCREEN;
  seeReading().then((on) => {
    if (on === null || CURRENT_SCREEN !== screen || STATE.seeGranted === on) return;
    setStatePath("seeGranted", on);
    repaint();
  });
}

/**
 * ACCESSIBILITY'S ANSWER, the same way, for a page that asks after it
 * ($state.axGranted: the arrival card's second step). The Mac keeps it, so the
 * main process reads it (isTrustedAccessibilityClient, without prompting):
 * "granted" is yes, "denied" no, "unknown" (a system with no such switch) is
 * nothing to ask for. Read when the page is painted and again on coming back
 * to the window or to the front, which is when System Settings may have
 * turned it on.
 */
async function axReading() {
  try {
    const st = String(await window.tailzuApp.axStatus() || "unknown");
    return st === "granted" || st === "unknown";
  } catch { return null; }
}

function axFollow() {
  if (!axAskOn() || !CURRENT_SCREEN || !CURRENT_SCREEN.state || !Object.hasOwn(CURRENT_SCREEN.state, "axGranted")) return;
  const screen = CURRENT_SCREEN;
  axReading().then((on) => {
    if (on === null || CURRENT_SCREEN !== screen || STATE.axGranted === on) return;
    setStatePath("axGranted", on);
    repaint();
  });
}
document.addEventListener("visibilitychange", () => { if (document.hidden) return; axFollow(); seeFollow(); });

/**
 * ASK FOR THE MICROPHONE: open it once, which is what makes the system ask
 * (macOS shows its prompt the first time), and close it at once. Allowed, the
 * page's onGranted; refused, onBlocked (the system's switch is off: only its
 * settings can turn it on) or onDenied.
 */
async function askMic(action) {
  let ok = false, blocked = false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    ok = true;
  } catch (err) {
    blocked = !!err && err.name === "NotAllowedError";
  }
  if (ok && micAskOn()) ok = (await micReading()) !== false;
  if (ok) return run(action.onGranted);
  // Refused for good (the system will not ask twice): the card says where the
  // switch is, which is more use than a line of toast. Only if it can be put
  // up — otherwise the page's own onBlocked still speaks.
  if (blocked && typeof permNeed === "function" && await permNeed("mic")) return;
  return run(blocked ? (action.onBlocked || action.onDenied) : action.onDenied);
}

/**
 * ASK FOR THE CAMERA, exactly as for the microphone: open it once, which is
 * what makes the system ask, and close it at once. Refused, the page's
 * onBlocked (only the system's settings can turn it back on).
 */
async function askCam(action) {
  let ok = false, blocked = false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    stream.getTracks().forEach((t) => t.stop());
    ok = true;
  } catch (err) {
    blocked = !!err && err.name === "NotAllowedError";
  }
  if (ok && camAskOn()) ok = (await camReading()) !== false;
  if (ok) return run(action.onGranted);
  if (blocked && typeof permNeed === "function" && await permNeed("cam")) return;
  return run(blocked ? (action.onBlocked || action.onDenied) : action.onDenied);
}
