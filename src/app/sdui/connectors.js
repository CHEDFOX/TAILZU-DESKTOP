// Connecting an app from the window (connector.connect), and the page redrawn
// when the browser's sign-in hands back.

/**
 * CONNECT AN APP. The window names which app (by the id the server gave the
 * row) and never an address: the one route is built here, and what it opens
 * is the sign-in page the API itself answered with, over https. An app that
 * takes a pasted link sends what the row's field holds (`urlPath`) instead.
 * Coming back to the window after the browser has had the sign-in is when the
 * row may have changed, so the next focus redraws the page once.
 */
const CONNECTOR_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
let CONNECT_PENDING = false;
async function connectApp(action) {
  const id = String(action.id || "");
  try {
    if (!CONNECTOR_ID.test(id)) throw new Error("not an app id");
    const pasted = action.urlPath ? String(stateAt(action.urlPath) == null ? "" : stateAt(action.urlPath)).trim() : "";
    const res = await api("/v1/connectors/" + id + "/connect", action.urlPath ? { url: pasted } : {}, "POST");
    const to = res && typeof res.authorizeUrl === "string" ? res.authorizeUrl : "";
    if (/^https:\/\//i.test(to)) {
      CONNECT_PENDING = true;
      window.tailzuApp.openExternal(to);
    } else if (!(res && res.connected === true)) {
      throw new Error("no sign-in page");
    }
    await run(action.onSuccess);
    if (res.connected === true) await paint(true);
  } catch {
    await run(action.onError);
  }
}
window.addEventListener("focus", () => {
  if (!CONNECT_PENDING) return;
  CONNECT_PENDING = false;
  if (SESSION) void paint(true);
});
// …and the onboarding's Connect apps step, which an app can finish signing in
// to after the window was last looked at (the sign-in page is in the browser
// and takes as long as it takes). Only that step: a fetch rebuilds the screen's
// state, and the words someone just spoke on Try it are not worth losing for
// an alt-tab. Not while the mic is held, and not twice for one return.
window.addEventListener("focus", () => {
  if (!SESSION || !CURRENT_SCREEN || CURRENT_SCREEN.screenId !== "onboard" || MIC || HELD || document.hidden) return;
  if (Date.now() - (paint._at || 0) < 800) return;
  const stage = activeStage();
  if (stage && stage.getAttribute("data-step-id") === "apps") void paint(true);
});
