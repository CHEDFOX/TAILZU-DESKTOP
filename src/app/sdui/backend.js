// The backend: the capability handshake, authorised requests, the bootstrap
// and fetching a screen.

/** A media query's answer, false where the window cannot say. */
function prefers(q) {
  try { return window.matchMedia(q).matches; } catch { return false; }
}

function capabilities() {
  return {
    schemaVersion: SCHEMA_VERSION,
    // The build, from package.json by way of the main process — the page
    // cannot read the file. It used to say "desktop", which told the server
    // which surface this was and nothing about which release.
    appVersion: String((ENV && ENV.appVersion) || ""),
    // The catalog branches on this. Desktop is closest to iOS in what it can
    // draw and shares none of the Android keyboard's constraints, so it takes
    // the iOS tree rather than inventing a third the server has never seen.
    //
    // WIDTH IS A SEPARATE QUESTION, and it is answered by device.width below.
    // Saying "ios" was true about what this can draw and silent about how much
    // room it has, so the server laid a phone column down the middle of a
    // window. It reads the viewport now.
    platform: "ios",
    components: COMPONENTS.concat(ENV && ENV.selfUpdate ? [SELF_UPDATE] : [], ENV && ENV.notes ? [NOTES] : [],
      ENV && ENV.systemAudioSettings ? [SYSTEM_AUDIO] : [], ENV && ENV.store ? ["DeskStore"] : [],
      ENV && ENV.askSetup ? [ASK_SETUP_CARD] : [], [CONNECTORS_CAN], micAskOn() ? [MIC_ASK] : [], axAskOn() ? [AX_STATE] : [],
      // A live page (liveView.js, where this window can make a webview) and the outbox (outbox.js), loaded after this file.
      typeof liveViewOn === "function" && liveViewOn() ? ["LiveView"] : [], typeof outboxRun === "function" ? ["Outbox"] : []),
    actions: ACTIONS.concat(typeof outboxRun === "function" ? ["outbox"] : []),
    templates: [],
    device: {
      // WHAT THIS IS, as opposed to what it can draw.
      //
      // `platform` above is a drawing question and answers "iOS". This is the
      // other one: there is no keyboard extension to add here, and the
      // microphone is granted by the OS outside the app, so the two setup
      // steps have nothing to ask a window. The server used to answer
      // `onboarding_keyboard` and this file quietly threw the answer away —
      // the renderer overruling the creator. It tells the truth instead and
      // gets the right screen back.
      formFactor: "desktop",
      // Which desktop, from the main process — a window cannot tell on its
      // own, and the gate's buttons depend on it.
      os: (ENV && ENV.os) || "",
      width: window.innerWidth, height: window.innerHeight, scale: window.devicePixelRatio || 1,
      // What the OS is actually set to, not what this window would like.
      colorScheme: prefers("(prefers-color-scheme: light)") ? "light" : "dark",
      locale: navigator.language || "en-US",
      reduceMotion: prefers("(prefers-reduced-motion: reduce)"),
      rtl: false,
    },
  };
}

async function api(path, body, method) {
  // A path, never an address: "…x0bot.com" + ".evil.com/x" is another host,
  // and the account's token would go with it.
  if (typeof path !== "string" || path[0] !== "/") throw new Error("not an API path: " + path);
  const tok = await bearer();
  const headers = { "Content-Type": "application/json" };
  if (tok) headers.Authorization = "Bearer " + tok;
  const res = await fetch(ENV.baseUrl + path, {
    method: method || "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 429 && text.indexOf("quota_exceeded") !== -1) {
      const e = worded(K.txt("error.quota", "You've used this month's free words."), text); e.quota = true; throw e;
    }
    throw worded(statusText(res.status), path + " → " + res.status);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.indexOf("application/json") !== -1 ? res.json() : res.text();
}

/** How many times this install has launched — counted by the main process,
 *  once per launch, so the window and the tray report the same number. */
const launchCount = () => Number(ENV && ENV.launchCount) || 1;

/**
 * EVERY BOOTSTRAP THIS WINDOW RECEIVES points the knobs at itself and goes on
 * to the main process — all of it, labels and flags, not only the tray's
 * `desktop.shell` block. The main process fetches its own as well; this only
 * ever makes its copy fresher.
 */
function received(boot) {
  if (boot && typeof boot === "object") {
    K.setKnobs(boot);
    try { window.tailzuApp.boot({ labels: boot.labels || {}, flags: boot.flags || {} }); } catch { /* tray only */ }
    // The faces the server supplies, beside the bundled ones (remoteFonts.js, loaded after this file).
    if (typeof deskLoadFonts === "function") deskLoadFonts(boot.fonts);
    // The bots' looks and moments: the server's catalog, when its version moved.
    btLooksSync(boot.flags && boot.flags["bots.looks"]);
    paintFirst();
  }
  return boot;
}

const bootstrap = () =>
  api("/v1/app/bootstrap", { capabilities: capabilities(), launchCount: launchCount() }).then(received);

/**
 * The same bootstrap, asked WITHOUT a credential.
 *
 * The gate is the one screen drawn before there is an account, so it was the
 * one screen whose words could not come from the server — leaving the sign-in
 * copy, and the theme it renders in, frozen in whatever installer you happen to
 * be running. The route takes auth as optional, so the window can simply ask as
 * a stranger and get back the theme and the chrome, with none of the user's
 * anything attached (there is no user to attach).
 *
 * Deliberately NOT sending the static fallback token. It resolves to a
 * synthetic account, and a launch that never signs in should not be billed a
 * bootstrap against somebody — even a somebody nobody is.
 */
async function bootstrapAnon() {
  const res = await fetch(ENV.baseUrl + "/v1/app/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ capabilities: capabilities(), launchCount: launchCount() }),
  });
  if (!res.ok) throw new Error("bootstrap → " + res.status);
  return received(await res.json());
}
const fetchScreen = (screenId, params) =>
  api("/v1/app/screen", {
    screenId, params, capabilities: capabilities(),
    tzOffsetMinutes: -new Date().getTimezoneOffset(),
  });
