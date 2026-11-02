// BACK FROM SYSTEM SETTINGS. The Ask setup card's Allow sends the person to a
// Mac settings page, and coming back to this window is when the answer may
// have changed. The main process pushes on focus too; asking here as well
// costs one local call and keeps the row honest if a push is missed.
window.addEventListener("focus", () => {
  if (ASK_LISTENING && CURRENT_SCREEN && findNode(CURRENT_SCREEN.root, "DeskAskSetup")) askSetupRead();
  micFollow();
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
document.addEventListener("visibilitychange", () => { if (!document.hidden) axFollow(); });

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
  return run(blocked ? (action.onBlocked || action.onDenied) : action.onDenied);
}
