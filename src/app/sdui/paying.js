// Paying and updating: the checkout and the subscription pages on the web,
// the entitlement read again on coming back, and the one-click update.

/**
 * Who this is, for the checkout link.
 *
 * The Supabase access token is a JWT and `sub` is the user id. Read without
 * verifying, deliberately: this is used to address a checkout page, never to
 * authorise anything. Every request that matters still carries the token
 * itself and is verified by a server that has the key.
 */
function userId() {
  const t = SESSION && SESSION.access_token;
  if (!t) return "";
  try {
    const body = t.split(".")[1];
    const json = atob(body.replace(/-/g, "+").replace(/_/g, "/"));
    return String(JSON.parse(json).sub || "");
  } catch { return ""; }
}

/**
 * Open RevenueCat's Web Billing checkout, in the user's own browser.
 *
 * Not in this window. A checkout is a place people expect to recognise — a
 * real address bar, a padlock, a saved card — and an app-shaped frame around
 * somebody's card details is the shape of every phishing page ever built. It
 * is also the only way the browser's own autofill and 3-D Secure work.
 *
 * The id goes in the path because that is how RevenueCat attributes a Web
 * Billing purchase to an app user, which is what makes the entitlement follow
 * the account instead of the machine.
 */
/**
 * WHERE THE USER ID GOES IN THE LINK, and why this is not guessed here.
 *
 * RevenueCat has more than one shape of purchase link, and they do not carry
 * the app user id the same way: a hosted paywall link takes it as a trailing
 * path segment, a Web Purchase Link takes it as an `app_user_id` query
 * parameter, and which one you have depends on the billing engine behind it.
 *
 * Getting it wrong is the worst possible failure, because it LOOKS like
 * success. The checkout opens, the card is charged, the webhook arrives, and
 * the server logs `no Supabase user id on the event` — money taken, nothing
 * granted. The entitlements code names that case explicitly for a reason.
 *
 * So the shape is part of the configured link rather than an assumption in
 * this file. Put `{app_user_id}` wherever it belongs and it is substituted
 * there. Without a placeholder it is appended as the query parameter, which is
 * what RevenueCat documents for a Web Purchase Link — and which survives a URL
 * that already carries a query, where blind path-appending would not.
 */
function withUser(url, uid) {
  const id = encodeURIComponent(uid);
  if (url.indexOf("{app_user_id}") !== -1) return url.replace(/\{app_user_id\}/g, id);
  return url + (url.indexOf("?") === -1 ? "?" : "&") + "app_user_id=" + id;
}

/** What to call the place a subscription lives, by the flag that says it
 *  lives there. */
function manageAt() {
  return {
    "billing.manage.apple": K.txt("desktop.billing.storeApple", "the App Store"),
    "billing.manage.google": K.txt("desktop.billing.storeGoogle", "Google Play"),
    "billing.manage.web": K.txt("desktop.billing.storeWeb", "the web"),
  };
}

/**
 * The update card's button. The main process downloads, checks and installs;
 * this only keeps the card's line honest while it does — the server sent the
 * words for each step, and the percentage is filled in here. On success the
 * app quits and the new build opens, so there is no "done" to show.
 */
let updateListening = false, updatePaintAt = 0;
async function installUpdate(action) {
  const words = action.words || {};
  const say = (key, vars) => String(words[key] || "").replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] != null ? String(vars[k]) : ""));
  const show = (busy, line) => { setStatePath("upd.busy", busy); setStatePath("upd.line", line || undefined); repaint(); };
  if (!updateListening) {
    updateListening = true;
    window.tailzuApp.onUpdateProgress((p) => {
      if (!p) return;
      const now = Date.now();
      // Every percent would repaint the page a hundred times; a few a second is enough to read.
      if (p.phase === "downloading" && now - updatePaintAt < 200 && p.pct < 99) return;
      updatePaintAt = now;
      show(true, p.phase === "installing" ? say("installing") : say("downloading", { pct: p.pct || 0 }));
    });
  }
  show(true, say("downloading", { pct: 0 }));
  let r;
  try { r = await window.tailzuApp.installUpdate({ url: action.url, version: action.version, sha512: action.sha512 }); }
  catch { r = { ok: false, reason: "failed" }; }
  if (r && r.ok) return;
  if (r && r.reason === "unsupported") {
    window.tailzuApp.openExternal(action.url);
    show(false, say("manual"));
    return;
  }
  show(false, say("failed"));
}

function buyOnWeb() {
  const flags = (BOOT && BOOT.flags) || {};
  // A SECOND SUBSCRIPTION IS THE ONE MISTAKE THIS WINDOW CAN MAKE WITH
  // SOMEBODY'S MONEY.
  //
  // One account reaches a phone and a window, and the two stores cannot see
  // each other: buying here while an App Store subscription is live bills them
  // twice for one entitlement, and neither store notices or refunds it. The
  // Settings row that offers this is already hidden from a subscriber — but a
  // hidden row is not a guard. The paywall is also reached by running out of
  // words, by a screen the server sends, and by a BOOT that went stale while
  // the window sat open, and every one of those ends here.
  //
  // NOT A BLOCK ON EVERY SUBSCRIBER, though. Moving from the monthly plan to
  // the annual one is the same purchase on the same store, and the store
  // handles the swap and the proration itself — refusing that would leave
  // somebody stuck on the plan they are trying to spend more on. The line is
  // the STORE, not the subscription.
  //
  // AND IT SENDS THEM THERE RATHER THAN DESCRIBING IT. They clicked a button
  // that means "change my plan"; answering with the route to somebody else's
  // settings screen leaves them to do the finding, which is the part that
  // becomes a support email. The server sends the address, so the click still
  // ends where changing a plan is possible.
  if (flags["billing.entitled"] && !flags["billing.manage.web"]) {
    const stores = manageAt();
    const key = Object.keys(stores).find((k) => flags[k]);
    const url = String(flags["billing.manage.url"] || "");
    if (key && url) {
      window.tailzuApp.openExternal(url);
      toast(K.txt("desktop.billing.opening", "Your subscription is with {store} — opening it. It covers every device.",
        { store: stores[key] }));
    } else {
      toast(key
        ? K.txt("desktop.billing.elsewhere",
          "Your subscription is with {store}. Change or cancel it there — it covers every device.", { store: stores[key] })
        : K.txt("desktop.billing.alreadyActive", "This account already has an active subscription."));
    }
    return;
  }
  const base = String(flags["paywall.web.url"] || "").trim();
  const uid = userId();
  if (!base || !uid) {
    // Said plainly rather than swallowed. A dead button is the bug this whole
    // case exists to fix, and a silent failure here would just move it.
    toast(base ? K.txt("desktop.billing.signInFirst", "Sign in first to subscribe.")
               : K.txt("desktop.billing.unavailable", "Subscriptions aren't set up for the desktop app yet."));
    return;
  }
  window.tailzuApp.openExternal(withUser(base, uid));
  toast(flags["billing.entitled"]
    ? K.txt("desktop.billing.changeInBrowser", "Change your plan in the browser — this window updates when you're back.")
    : K.txt("desktop.billing.finishInBrowser", "Finish in your browser — this window updates when you're back."));
  // They are about to leave. The answer arrives by webhook while they are
  // gone, so the moment they come back is the moment to ask again.
  WATCH_ENTITLEMENT = true;
}

/**
 * Ask the server whether this account is paid, and repaint if it changed.
 *
 * The server is the only thing that knows — the entitlement is a row against
 * the account, written by RevenueCat's webhook. A client that decided this for
 * itself would be a client anyone could edit into a subscriber.
 */
let WATCH_ENTITLEMENT = false;
async function refreshEntitlement(loud) {
  const was = !!(BOOT && BOOT.flags && BOOT.flags["quota.entitled"]);
  try {
    BOOT = await bootstrap();
  } catch {
    if (loud) toast(K.txt("desktop.billing.offline", "Couldn't reach the backend."));
    return;
  }
  const now = !!(BOOT.flags && BOOT.flags["quota.entitled"]);
  if (now && !was) {
    WATCH_ENTITLEMENT = false;
    toast(K.txt("desktop.billing.subscribed", "You're subscribed. Thank you."));
    await paint(true);
  } else if (loud) {
    toast(now ? K.txt("desktop.billing.active", "Your subscription is active.")
              : K.txt("desktop.billing.none", "No subscription found on this account."));
  }
}

// BACK FROM THE BROWSER. The purchase completes somewhere else entirely and
// tells the server, not this window — so returning to it is the only signal
// there is that the answer may have changed. Only after a checkout was opened:
// re-bootstrapping on every focus would be a request every time somebody
// alt-tabs.
window.addEventListener("focus", () => {
  if (!WATCH_ENTITLEMENT || !SESSION) return;
  void refreshEntitlement(false);
});
