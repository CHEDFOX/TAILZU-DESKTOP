/**
 * The desktop app window — the same server-drawn app the phones render.
 *
 * WHY THIS IS A RENDERER AND NOT A SECOND APP
 *
 * Every screen in Tailzu is JSON from /v1/app/screen: the tabs, the copy, the
 * charts, the paywall, which nodes exist and what they do. The phones ship a
 * renderer for that JSON and nothing else. So the desktop needs a renderer for
 * that JSON and nothing else — and a screen added to the catalog appears here
 * without a desktop release, exactly as it does on iOS and Android.
 *
 * WHY IT NEEDS A REAL SIGN-IN
 *
 * The tray's dictation runs on a static bearer token, which the backend
 * resolves to a stable synthetic user ("static-…"). That is fine for
 * transcription, which needs no history. It is useless for everything else:
 * a synthetic id is not a UUID, it matches no row in any table, so stats,
 * history, voices and entitlement all come back empty. The window signs in
 * properly — email OTP against Supabase, the same account as the phone — and
 * every screen then holds the same data the phone shows.
 *
 * Supabase's REST auth is two POSTs, so there is no SDK here. The anon key is
 * the public client credential; the tokens it returns are stored by the main
 * process, never by this renderer.
 */

/* eslint-env browser */

const SUPABASE_URL = "https://merzyohecmyfvlyahxaz.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1lcnp5b2hlY215ZnZseWFoeGF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyMjU1MzAsImV4cCI6MjA5NzgwMTUzMH0.scDhHeRU20wRIgKBFL8GouIEp8bJG8w8aIsySUkePHY";

const SCHEMA_VERSION = 1;

/** Node types this renderer draws. Sent in the capability handshake, so the
 *  server never emits a node the window cannot handle — the same contract the
 *  phones use, honoured honestly rather than claimed. */
const COMPONENTS = [
  "Screen", "Stack", "Spacer", "Text", "Image", "Icon", "Button", "TextField",
  "Chip", "Card", "List", "Divider", "Row", "Overline", "Heading", "Paragraph",
  "Quote", "Badge", "KeyValue", "Hero", "Switch", "SegmentedControl",
  "StatCard", "BarChart", "LineChart", "Sparkline", "PieChart", "DonutChart",
  "ProgressRing", "Gauge", "WordMeter", "Video", "Audio", "Grid",
  // Drawn here as well as on the phones. Every one of these was falling
  // through to `default`, which renders a node's CHILDREN and drops the node —
  // so a Gradient, an SVG or a scrim simply did not appear, and the window was
  // not a smaller version of the app but the app with its icons, its scrims
  // and its one button missing.
  "SVG", "Gradient", "BlurBackground", "FlipText", "Modal", "ProgressBar",
  "SwipeAction", "NeuralField",
  // The Train tab, in full. The conversation is a real repeater here now, and
  // the mic records in the page rather than through the tray's global hotkey —
  // so the refine screen is the same screen it is on a phone, not a notice
  // saying it needs an update.
  "ChatThread", "VoiceToggle", "VoiceButton",
  // The spoken session: a socket to the same transcribe stream the tray uses,
  // the same converse endpoint, and the browser's own synthesiser for the
  // reply. The phone version spends half its length on audio-session
  // categories so the reply leaves the speaker rather than the earpiece; a
  // window has neither, so none of that exists here.
  "VoiceSession",
  // THE DESK. A window-shaped Tailzu rather than a phone's screens in a
  // frame: a masthead instead of a rail, pages that run the width of the
  // window, the said line above the written one. Declared so the server sends
  // those pages only to a build that can draw them; an older installer keeps
  // the rail and the phone screens it has always had.
  "DeskShell", "Keys",
  // A NeuralField the window can actually show on a page with a ground of its
  // own (groundView). A build without it drew the field behind the sheet, so
  // the server keeps the field off the desk's pages for those.
  "DeskField",
  // THE ONBOARDING: a stage that glides one step out and the next in, and the
  // empty spot where Blip stands in each step. Declaring them also promises the
  // optional props that ship in the same release (the field sign-in, the code
  // boxes, the labelled Google and Apple buttons, a held mic, a style value
  // that follows state). The server sends the new onboarding only to a build
  // that says both; an older installer is served the one it has always had.
  "OnboardStage", "BlipSpot",
];
// Declared only by a copy that can put an update in place of itself (the main
// process knows: updater.js). The server then sends the one-click update card;
// a copy that cannot gets the download link.
const SELF_UPDATE = "DeskSelfUpdate";
/** The note-taker is here: the server sends the Notes tab and its pages. */
const NOTES = "DeskNotes";
/** A Mac that can open the computer's-sound permission from a note. */
const SYSTEM_AUDIO = "DeskSystemAudio";
/** Ask is on in this copy (the main process says so: env.askSetup), so the
 *  server may send its one-time setup card, which this window draws with the
 *  permission states only the main process can read. */
const ASK_SETUP_CARD = "DeskAskSetup";
/** The allowed-folders row under Ask (Settings): which folders Ask may work in,
 *  kept by the main process (localfiles.js createFolderSettings). Declared with
 *  the setup card, in the same copies that have Ask. */
const FOLDERS_CARD = "DeskFolders";
/** This window shows the assistant's side: Connected apps in Settings, the
 *  Tasks page, and the connector.connect action that signs an app in. The
 *  server sends them only while connected apps are switched on there. */
const CONNECTORS_CAN = "DeskConnectors";
// NOT declared: ScreenHoldTouches. The window does not implement it, and
// claiming a component to unlock a layout is how a capability list stops
// meaning anything. The backend reaches the same conclusion from
// `formFactor: "desktop"` and for the true reason — the flag exists because a
// scroll view steals the touches of a child being DRAGGED, and nothing here is
// dragged: the pill is a click, because a mouse has no thumb to rest.
const ACTIONS = [
  "navigate", "back", "switchTab", "callEndpoint", "setState", "toggleState",
  "toggleInArray", "refresh", "openUrl", "toast", "haptic", "sequence",
  "delay", "reloadScreen",
  // navigateBack is the important one: the catalog names it fifteen times and
  // this renderer knew only "back", so every back control in the window was
  // drawn, clickable, and did nothing.
  "navigateBack", "dismiss", "clearState", "appendState", "condition",
  // Buying. There is no store on a desktop, so these open RevenueCat's Web
  // Billing checkout in the user's browser and then ask the server again.
  // Declared, because a capability list that omits them is the server being
  // told this window cannot take a payment — and it now can.
  "iap.subscribe", "iap.showPaywall", "iap.restore",
  // What only a desktop has: a clipboard to put a note back on, settings that
  // live on this computer (the pill, the shortcut), a microphone started from
  // a page, and a way out of the account from the settings page itself.
  "copyText", "desktop.config", "dictate", "signOut",
  // Start or stop the note-taker from the Notes page.
  "notes.toggle",
  // A note's Allow button (macOS): the computer's-sound permission.
  "notes.allowSystemAudio",
  // The update card's button: download, check and install the new build here.
  "installUpdate",
  // The Ask setup card's buttons. The two settings pages are Mac only and
  // fixed addresses the main process holds: the window names which, never
  // where. picturesAll takes `on` (true or false); relaunch restarts Tailzu,
  // which macOS can need before a new Screen Recording grant takes.
  "ask.openAccessibility", "ask.openScreenRecording", "ask.picturesAll", "ask.relaunch",
  // The folders row: add one (the system's chooser), take one out (`i`, its
  // place in the list), or go back to the usual three.
  "ask.folderAdd", "ask.folderRemove", "ask.folderReset",
  // Connect an app from Settings: POST /v1/connectors/:id/connect, then the
  // sign-in page it answers with opens in the browser (connectApp).
  "connector.connect",
];

/**
 * The server's knobs (knobs.js, loaded before this file). Every literal this
 * renderer used to decide for itself — a toast's words, how long a slow load
 * waits before saying so, a switch's size — is read through these, with the
 * old literal as the fallback. Fed every bootstrap this window receives, and
 * the main process's cached copy before the first one lands.
 */
const K = window.TailzuKnobs;

let ENV = null;          // baseUrl, tone, language, appVersion, launchCount, knobs
let SESSION = null;      // { access_token, refresh_token, expires_at }
let BOOT = null;
let TABS = [];
let STACK = [];          // [{ screenId, params }]
/**
 * Flip lines waiting for their ticker.
 *
 * Collected while a screen renders and started once it is in the DOM —
 * rendering returns a string here, so there is no element to attach to until
 * the paint lands. Cleared on every paint so a screen that is gone cannot keep
 * turning words over in a document that no longer holds it.
 */
let FLIPS = [];
let FLIP_TIMERS = [];
let STATE = {};          // per-screen state, replaced on every navigation
let TAB_ID = "";
// The desk: set when the server says this window gets its own pages (the
// masthead, the width of the window) rather than the phone's.
let DESK = false;
// Settings that live on this computer — the pill, pausing, the keys that are
// bound — read from the main process and put under `state.desktop` on every
// screen, so a page can show them and a switch can change them.
let LOCAL = {};

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * A FAILURE, WORDED FOR THE PERSON AT THE WINDOW.
 *
 * Errors here used to carry "/v1/app/bootstrap → 500", the browser's own
 * "Failed to fetch" or Supabase's "invalid_grant", and the gate and the voice
 * screens showed a thrown message as it stood. Now a failure this file words
 * on purpose is marked `worded` (with the raw detail beside it for the log),
 * and anything else is logged and replaced by the caller's sentence. The
 * words for a refused request are the phones' (labels error.*), so one edit
 * on the server changes both.
 */
function worded(message, detail) {
  const e = new Error(message);
  e.worded = true;
  if (detail) e.detail = detail;
  return e;
}

function statusText(status) {
  if (status === 401 || status === 403) return K.txt("error.unauthorized", "Your session has expired. Sign in again to continue.");
  if (status === 404) return K.txt("error.notFound", "That isn't available right now.");
  if (status === 429) return K.txt("error.rateLimited", "Too many requests. Wait a moment, then try again.");
  if (status >= 500) return K.txt("error.server", "Something went wrong on our side. Try again in a moment.");
  return K.txt("error.generic", "Something went wrong. Try again.");
}

/** What to show for a caught failure; the raw detail goes to the console. */
function userText(err, fallback) {
  if (err && err.worded) {
    if (err.detail) console.warn("[tailzu]", err.detail);
    return err.message;
  }
  console.warn("[tailzu]", err);
  // fetch rejects with a TypeError when the network is not there at all.
  if (err instanceof TypeError) return K.txt("error.network", "Couldn't reach Tailzu. Check your connection and try again.");
  return fallback;
}

async function sbFetch(path, body) {
  const res = await fetch(SUPABASE_URL + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Supabase's own words ("Token has expired or is invalid", "invalid_grant")
    // are for the log. A refused code is the one case with its own sentence.
    const detail = path + " → " + res.status + " " + (json.error_description || json.msg || json.error || "");
    if (res.status === 429 || res.status >= 500) throw worded(statusText(res.status), detail);
    if (path.indexOf("/verify") !== -1) {
      throw worded(K.txt("desktop.gate.codeWrong", "That code didn't work. Check it and try again."), detail);
    }
    throw worded(K.txt("desktop.gate.authFailed", "Couldn't sign you in. Try again."), detail);
  }
  return json;
}

/**
 * A valid access token, renewed when the stored one has expired.
 *
 * Null when nobody is signed in, and the request then goes out with no
 * Authorization header at all. There used to be a static fallback token here,
 * which the backend resolves to a synthetic user — so a signed-out window
 * asked for things as somebody nobody is.
 *
 * THE MAIN PROCESS RENEWS IT, not this window. Supabase rotates the refresh
 * token on every use, and this window used to renew with its own copy after
 * the tray's timer had already spent it — which signed the account out
 * everywhere. The main process holds the only refresh token and answers with
 * a live access token (or none, once the account is really gone).
 */
async function bearer() {
  if (!SESSION) return null;
  const now = Math.floor(Date.now() / 1000);
  if (SESSION.expires_at && SESSION.expires_at - K.num("desktop.auth.refreshSkewSec", 60) <= now) {
    SESSION = (await window.tailzuApp.session()) || null;
    if (!SESSION) { render(); return null; }
  }
  return SESSION.access_token;
}

/** Signed in (a Supabase session) or out (null). The main process keeps it
 *  and hands back the part this window holds. */
async function setSession(raw) {
  SESSION = (await window.tailzuApp.setSession(raw || null)) || null;
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

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
      ENV && ENV.askSetup ? [ASK_SETUP_CARD, FOLDERS_CARD] : [], [CONNECTORS_CAN]),
    actions: ACTIONS,
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
  // A path, never an address: "…tailzu.space" + ".evil.com/x" is another host,
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

// ---------------------------------------------------------------------------
// Theme, labels, conditions
// ---------------------------------------------------------------------------

function applyTheme(theme) {
  if (!theme || !theme.color) return;
  const c = theme.color, root = document.documentElement.style;
  const set = (k, v) => { if (v) root.setProperty(k, v); };
  set("--bg", c.bg); set("--card", c.card); set("--input", c.inputBg);
  set("--border", c.border); set("--text", c.text); set("--body", c.body);
  set("--muted", c.muted); set("--label", c.label); set("--danger", c.danger);
  // The accent was the one colour this window kept to itself — a literal in the
  // stylesheet — so the brand could be retuned on the phones and this stayed
  // the old amber, with nothing to show that it had.
  set("--accent", c.primary || c.accent);
}

/**
 * THE SERVER'S TYPOGRAPHY, HERE TOO.
 *
 * Every size, weight, tracking and colour in this window was written into this
 * file by hand, while the backend was already sending the whole system —
 * `theme.font.roles`, the same 50-odd roles the phones resolve. So the two
 * surfaces drifted by construction: retuning a heading on the phone did
 * nothing here, and nobody could see that from either side.
 *
 * A role resolves to CSS. `family: "display"` is a slot, not a face — the
 * phone maps it to a downloaded serif, and a window under a font-src 'self'
 * policy cannot fetch that, so it maps to the platform serif instead. Same
 * intent, whatever is installed.
 *
 * SCALE, because a phone column is 393pt and this one is 640. Sizes are
 * carried at a ratio rather than re-chosen, so the rhythm between them — the
 * thing that makes it read as one product — survives the change of surface.
 */
// The scale and the two stacks are knobs; read per call so a new bootstrap
// retunes the next paint.
//
// Escaped, because this lands in a double-quoted style attribute: a
// "Segoe UI" in there closed the attribute early and cut off everything
// role() wrote after it — including the node's own style, so every Text lost
// its margins and colours from the tree ("0words"). css() does the same.

function role(name, extra) {
  const theme = (BOOT && BOOT.theme) || {};
  const f = theme.font || {};
  const r = (f.roles && f.roles[name]) || null;
  if (!r) return extra || "";
  const c = theme.color || {};
  const out = [];
  const scale = K.num("desktop.type.scale", 1.08);
  const px = (v) => Math.round(v * scale * 10) / 10 + "px";
  if (r.size != null) out.push("font-size:" + px(r.size));
  if (r.weight) out.push("font-weight:" + r.weight);
  if (r.lineHeight != null) out.push("line-height:" + px(r.lineHeight));
  if (r.letterSpacing != null) out.push("letter-spacing:" + r.letterSpacing + "px");
  if (r.italic) out.push("font-style:italic");
  if (r.transform) out.push("text-transform:" + r.transform);
  if (r.align) out.push("text-align:" + r.align);
  if (r.color) out.push("color:" + (c[r.color] || r.color));
  out.push("font-family:" + (r.family === "display"
    ? K.str("desktop.font.serif", "Georgia,'Times New Roman',serif")
    : K.str("desktop.font.sans", "-apple-system,'Segoe UI',system-ui,sans-serif")));
  if (r.marginTop != null) out.push("margin-top:" + r.marginTop + "px");
  if (r.marginBottom != null) out.push("margin-bottom:" + r.marginBottom + "px");
  if (r.marginVertical != null) {
    out.push("margin-top:" + r.marginVertical + "px", "margin-bottom:" + r.marginVertical + "px");
  }
  return esc(out.join(";") + (extra ? ";" + extra : ""));
}

function label(v) {
  if (typeof v === "string" && v[0] === "@") {
    const k = v.slice(1);
    return (BOOT && BOOT.labels && BOOT.labels[k]) || k;
  }
  return v;
}

function tok(v) {
  if (typeof v !== "string" || v[0] !== "$") return v;
  let o = BOOT && BOOT.theme;
  for (const part of v.slice(1).split(".")) { if (o == null) return undefined; o = o[part]; }
  return o;
}

function stateAt(path) {
  let o = STATE;
  for (const part of String(path).replace(/^state\./, "").split(".")) {
    if (o == null) return undefined;
    o = o[part];
  }
  return o;
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v === true || v === "true" || (typeof v === "number" && v !== 0) || (typeof v === "string" && v.length > 0);
}

function lookup(ref) {
  if (typeof ref !== "string") return ref;
  if (ref.indexOf("state.") === 0) return stateAt(ref);
  if (ref.indexOf("flags.") === 0) return BOOT && BOOT.flags && BOOT.flags[ref.slice(6)];
  return stateAt(ref);
}

/**
 * The catalog's conditions — the same set the phones evaluate.
 *
 * A condition this window does not know is FALSE, not true: a node gated on
 * something unrecognised stays hidden rather than appearing for everybody. And
 * a malformed one (an operand missing) is false too, rather than a throw that
 * blanks the whole screen — the rule the phone renderer follows.
 */
function visible(c) {
  if (!c) return true;
  const flags = (BOOT && BOOT.flags) || {};
  const same = (a, b) => String(a) === String(b);
  try {
    // The tree the server sends this window is the iOS one (see capabilities),
    // and a condition can also name the desktop outright.
    if (c.platform) return c.platform === "ios" || c.platform === "desktop";
    if (c.flag) return truthy(flags[c.flag]);
    if (c.truthy) return truthy(lookup(c.truthy));
    if (c.falsy) return !truthy(lookup(c.falsy));
    if (c.eq) return same(lookup(c.eq[0]), c.eq[1]);
    if (c.neq) return !same(lookup(c.neq[0]), c.neq[1]);
    if (c.gt) return Number(lookup(c.gt[0])) > Number(c.gt[1]);
    if (c.gte) return Number(lookup(c.gte[0])) >= Number(c.gte[1]);
    if (c.lt) return Number(lookup(c.lt[0])) < Number(c.lt[1]);
    if (c.lte) return Number(lookup(c.lte[0])) <= Number(c.lte[1]);
    if (c.in) return Array.isArray(c.in[1]) && c.in[1].some((x) => same(x, lookup(c.in[0])));
    if (c.contains) {
      // An ARRAY is tested for membership, not for a substring of its joined
      // form — ["hinglish"] does not contain "hi". A string keeps substring
      // semantics.
      const v = lookup(c.contains[0]);
      return Array.isArray(v)
        ? v.some((x) => same(x, c.contains[1]))
        : String(v == null ? "" : v).indexOf(String(c.contains[1])) !== -1;
    }
    if (c.startsWith) return String(lookup(c.startsWith[0]) ?? "").indexOf(String(c.startsWith[1])) === 0;
    if (c.endsWith) {
      const v = String(lookup(c.endsWith[0]) ?? ""), end = String(c.endsWith[1]);
      return v.length >= end.length && v.slice(v.length - end.length) === end;
    }
    // Entitlement lives on the account, and the server already folds it into
    // the boot flags; there is no store on this machine to ask.
    if (c.entitled) return truthy(flags["quota.entitled"]) || truthy(flags["billing.entitled"]);
    if (c.not) return !visible(c.not);
    if (c.all) return c.all.every(visible);
    if (c.any) return c.any.some(visible);
  } catch {
    return false;
  }
  return false;
}

/** Style keys → CSS. The SDUI names come first, then the RN-flavoured aliases
 *  the newer screens author with; both are in the tree and both must resolve. */
// Properties that take a bare number in CSS. LINE-HEIGHT IS NOT ONE OF THEM
// here: CSS reads a bare line-height as a MULTIPLE of the font size, and the
// catalog writes it the way React Native does — in points. So `lineHeight: 15`
// on a 10.5px line became a 157px line box, and the consent notice under the
// sign-in pills had its two lines a third of a screen apart. Every screen that
// sets one was affected; it was only obvious where the text wrapped.
const NUMERIC_OK = /opacity|flex|flex-grow|flex-shrink|z-index|font-weight|aspect-ratio/;
const MAP = {
  direction: "flex-direction", align: "align-items", justify: "justify-content",
  radius: "border-radius", background: "background-color", gap: "gap",
};
const ALIGN = { start: "flex-start", end: "flex-end", center: "center", between: "space-between", around: "space-around", stretch: "stretch", baseline: "baseline" };

/**
 * REACT NATIVE SHORTHANDS THAT CSS HAS NEVER HEARD OF.
 *
 * `paddingHorizontal` became `padding-horizontal`, which every browser drops
 * without a word. The catalog writes these constantly — the paywall's rows,
 * the You tab's cards, the auth screen's margins — so the window had been
 * quietly rendering a large part of the app with no padding at all, and it
 * looked like a slightly cramped design rather than a bug.
 *
 * Each expands to the pair it means, written BEFORE the rest of the style so
 * an explicit `paddingLeft` alongside one still wins, exactly as it does on
 * the phones.
 */
const RN_PAIRS = {
  paddingHorizontal: ["padding-left", "padding-right"],
  paddingVertical: ["padding-top", "padding-bottom"],
  marginHorizontal: ["margin-left", "margin-right"],
  marginVertical: ["margin-top", "margin-bottom"],
};

/**
 * A STYLE VALUE THAT FOLLOWS STATE: `{<condition>, then, else}`.
 *
 * The phones resolve one on every redraw, and the onboarding leans on it (a
 * language chip's border and fill, the card the cleaned words land in). This
 * printed it as "[object Object]", which no browser reads, so the chip never
 * lit. The condition is the tree's own (visible()). An object that is not one
 * is no value, rather than a word in a style attribute.
 */
function styleValue(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
  if (!("then" in v)) return undefined;
  const cond = Object.assign({}, v);
  delete cond.then; delete cond.else;
  return visible(cond) ? v.then : v.else;
}

function css(st) {
  if (!st) return "";
  const out = [];
  // A border with a width and no style is no border in CSS; on the phones it
  // is a solid one. Said here for the onboarding, whose cards and chips lean
  // on it, and written first so an explicit borderStyle still wins. Nowhere
  // else: a screen drawn without borders for years does not grow them now.
  if (IN_STAGE) {
    for (const k of Object.keys(st)) {
      const m = /^border(Top|Right|Bottom|Left)?Width$/.exec(k);
      if (m && Number(styleValue(st[k])) > 0) out.push("border" + (m[1] ? "-" + m[1].toLowerCase() : "") + "-style:solid");
    }
  }
  // The pairs first, so a specific side named alongside one overrides it.
  for (const k of Object.keys(RN_PAIRS)) {
    const v = tok(styleValue(st[k]));
    if (v == null) continue;
    const val = typeof v === "number" ? v + "px" : String(v);
    for (const prop of RN_PAIRS[k]) out.push(prop + ":" + val);
  }
  for (const k of Object.keys(st)) {
    if (RN_PAIRS[k]) continue;
    let v = tok(styleValue(st[k]));
    if (v == null) continue;
    let prop = MAP[k] || k.replace(/[A-Z]/g, (ch) => "-" + ch.toLowerCase());
    if (prop === "align-items" || prop === "justify-content" || prop === "align-self") v = ALIGN[v] || v;
    // The onboarding's two faces are Latin only; a line in Hindi or Tamil is
    // set in a face that has it, not in the browser's default serif.
    if (IN_STAGE && prop === "font-family") v = v + ",var(--f-ui),var(--f-deva)";
    if (typeof v === "number" && !NUMERIC_OK.test(prop)) v = v + "px";
    out.push(prop + ":" + v);
  }
  // Every caller puts this in a double-quoted style attribute, where a quote
  // in a value (a font name, a url) would end the attribute.
  return esc(out.join(";"));
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

let handlers = [];        // [{ id, action }] — bound after innerHTML lands
let SUBMITS = [];         // actions an Enter in a desk field runs, by 1-based index

/**
 * THE KEYS THIS COMPUTER HAS BOUND, drawn as keys.
 *
 * Only the main process knows them — the server cannot, and a page that said
 * "Ctrl twice" to someone who moved it to Alt would be wrong in the one place
 * it is trying to teach. So the node names which binding to draw and the keys
 * come from `state.desktop`, as keycaps.
 */
function keysNode(p, s) {
  const d = LOCAL || {};
  const tap = d.tap !== false && Array.isArray(d.tapKeys) && d.tapKeys.length;
  const keys = p.source === "notes" ? String(d.notesHotkey || "Ctrl+Alt+N").split("+").map((k) => k.trim()).filter(Boolean)
    : p.source !== "hotkey" && tap ? [d.tapKeys[0], d.tapKeys[0]]
    : String(d.hotkey || "Ctrl+Shift+Space").split("+").map((k) => k.trim()).filter(Boolean);
  const small = /(^|\s)d-keys-small(\s|$)/.test(String(p.cls || "")) ? " d-keys-small" : "";
  return '<span class="d-keys' + small + '" style="' + s + '">' +
    keys.map((k) => '<span class="d-keycap">' + esc(k) + "</span>").join("") + "</span>";
}

/**
 * LET ASK SEE WHAT YOU SEE: the one-time setup card.
 *
 * The server sends the words (props: eyebrow, title, titleEm, lede, rows,
 * on, allow, turnOff, restart, restartButton, foot, policyLabel, policyUrl)
 * and where the card is (place: "home" or "settings"). Whether each row is
 * done it cannot know: Accessibility and Screen Recording are this Mac's
 * answers, and "look without asking" is a flag on this computer. So the
 * main process reports them (tailzuApp.askSetup, pushed again on onAskSetup)
 * and the rows are drawn from that:
 *
 *   { platform, read: on|off|na, see: on|off|restart|na, pictures: on|off|never }
 *
 * Until it has answered the home card stays away: an Allow that turns into
 * "On" a moment later is a button that moved under the pointer.
 */
let ASK_SETUP = null;     // the main process's last answer, or null until it gives one
let ASK_LISTENING = false;
// The home card was up with something left to do on this visit. When the last
// row turns on while it is in view it stays, every row ticked, until the next
// page: a card that vanished under the click read as the click going wrong.
let ASK_HOLD = false;
// When the card last sent a press. A double-click on the picture row's Allow
// landed its second click on the Turn off drawn in Allow's place, and the yes
// was taken back in the same breath; a double-click on Restart would ask for
// two relaunches. A second press inside the moment of a double-click is the
// same press.
let ASK_PRESSED_AT = 0;

/** Which button each kind of row has while it is off, and what turns it off
 *  again. Only these keys are drawn: a row the window has no state for has
 *  no honest way to say whether it is on. */
const ASK_ROWS = {
  read: { allow: { kind: "ask.openAccessibility" } },
  see: { allow: { kind: "ask.openScreenRecording" } },
  pictures: { allow: { kind: "ask.picturesAll", on: true }, off: { kind: "ask.picturesAll", on: false } },
};

/**
 * What each row shows, from the server's rows and the main process's state.
 * `mode` is one of on, allow, restart, never and wait (no state yet); `done`
 * puts the green tick in the disc. "na" is a permission this computer does
 * not have (Windows asks for neither), so the row is simply on.
 */
function askSetupRows(p, st) {
  const rows = Array.isArray(p && p.rows) ? p.rows : [];
  return rows.filter((r) => r && typeof r === "object" && Object.hasOwn(ASK_ROWS, r.key)).map((r, i) => {
    const kind = ASK_ROWS[r.key];
    const v = st ? String(st[r.key] || "") : "";
    const out = { key: r.key, n: i + 1, title: label(r.title) || "", sub: label(r.sub) || "", mode: "wait", done: false, action: null, off: null };
    if (v === "on" || v === "na") {
      out.mode = "on";
      out.done = true;
      // Only the picture row is this app's own switch; the Mac's two are
      // turned off where they were turned on, in System Settings.
      if (v === "on" && kind.off) out.off = kind.off;
    } else if (v === "off") {
      out.mode = "allow";
      out.action = kind.allow;
    } else if (v === "restart" && r.key === "see") {
      out.mode = "restart";
      out.action = { kind: "ask.relaunch" };
    } else if (v === "never" && r.key === "pictures") {
      // The server has pictures off for everyone: nothing here can allow it.
      out.mode = "never";
    }
    return out;
  });
}

/** Nothing on the card is left for the person to do: every row is on, or
 *  (pictures "never") is not theirs to change. */
const askSettled = (rows) => rows.every((r) => r.done || r.mode === "never");

function askSetupNode(p, s) {
  const rows = askSetupRows(p, ASK_SETUP);
  if (!rows.length) return "";
  const home = p.place !== "settings";
  if (home) {
    if (!ASK_SETUP) return "";
    const settled = askSettled(rows);
    if (settled && !ASK_HOLD) return "";
    if (!settled) ASK_HOLD = true;
  }
  const t = (v) => esc(label(v) || "");
  const tick = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.4 6.6 11.4 12.6 4.8"/></svg>';
  const btn = (action, words, quiet, title) => '<button type="button" class="d-ask-btn' + (quiet ? " d-ask-quiet" : "") + '"' +
    bind(action) + ' aria-label="' + esc(String(words) + ": " + title) + '">' + esc(words) + "</button>";
  const body = rows.map((r) => {
    let act = "";
    if (r.mode === "on") {
      act = '<span class="d-ask-state">' + tick + t(p.on) + "</span>" + (r.off ? btn(r.off, label(p.turnOff) || "", true, r.title) : "");
    } else if (r.mode === "allow") {
      act = btn(r.action, label(p.allow) || "", false, r.title);
    } else if (r.mode === "restart") {
      act = btn(r.action, label(p.restartButton) || "", false, r.title);
    } else if (r.mode === "never") {
      act = '<span class="d-ask-state d-ask-never">' + esc(K.txt("desktop.askSetup.never", "Off")) + "</span>";
    }
    return '<div class="d-ask-row" data-ask="' + esc(r.key) + '" data-mode="' + r.mode + '"' + (r.done ? ' data-done="1"' : "") + ">" +
      '<span class="d-ask-n" aria-hidden="true">' + (r.done ? tick : r.n) + "</span>" +
      '<div class="d-ask-text"><div class="d-ask-t">' + esc(r.title) + '</div><div class="d-ask-s">' + esc(r.sub) + "</div>" +
      (r.mode === "restart" ? '<div class="d-ask-note"><i></i>' + t(p.restart) + "</div>" : "") + "</div>" +
      '<div class="d-ask-act">' + act + "</div></div>";
  }).join("");
  // The server places the card with its own d- classes and style (a d-page
  // on the home page, say), on the outside; the column inside keeps the
  // card's own measure whatever the page around it is.
  const more = String(p.cls || "").split(/\s+/).filter((c) => /^d-[a-z0-9-]+$/.test(c));
  const policy = typeof p.policyUrl === "string" && /^https:\/\//.test(p.policyUrl) && label(p.policyLabel)
    ? ' <button type="button" class="d-ask-link"' + bind({ kind: "openUrl", url: p.policyUrl }) + ">" + t(p.policyLabel) + "</button>"
    : "";
  return '<section class="' + ["d-ask"].concat(more).join(" ") + '" data-place="' + (home ? "home" : "settings") + '"' +
    ' aria-label="' + esc([label(p.title), label(p.titleEm)].filter(Boolean).join(" ")) + '" style="' + s + '"><div class="d-ask-in">' +
    // In Settings the section's own heading names it, so the card is its
    // rows and the line under them; the headline is the home page's.
    (home
      ? (p.eyebrow ? '<div class="d-ask-eyebrow"><i></i>' + t(p.eyebrow) + "</div>" : "") +
        '<h2 class="d-ask-title">' + t(p.title) + (p.titleEm ? " <em>" + t(p.titleEm) + "</em>" : "") + "</h2>"
      : "") +
    (p.lede ? '<p class="d-ask-lede">' + t(p.lede) + "</p>" : "") +
    '<div class="d-ask-card">' + body + "</div>" +
    (p.foot || policy ? '<p class="d-ask-foot">' + t(p.foot) + policy + "</p>" : "") +
    "</div></section>";
}

/** Start following the states. Once, as soon as env() says Ask is on, so the
 *  first page that carries the card already has them. */
function askSetupWatch() {
  if (ASK_LISTENING || !ENV || !ENV.askSetup) return;
  ASK_LISTENING = true;
  try { window.tailzuApp.onAskSetup((st) => askSetupTook(st)); } catch { /* an older main process */ }
  askSetupRead();
}

function askSetupRead() {
  try { Promise.resolve(window.tailzuApp.askSetup()).then(askSetupTook, () => {}); } catch { /* an older main process */ }
}

/** A new answer from the main process. Redrawn only when something changed
 *  and only when the page on screen carries the card; the button that had the
 *  keyboard's focus keeps it, since a repaint replaces every element. */
function askSetupTook(st) {
  if (!st || typeof st !== "object") return;
  const next = {
    platform: String(st.platform || ""), read: String(st.read || ""),
    see: String(st.see || ""), pictures: String(st.pictures || ""),
  };
  if (ASK_SETUP && JSON.stringify(next) === JSON.stringify(ASK_SETUP)) return;
  ASK_SETUP = next;
  if (!CURRENT_SCREEN || !findNode(CURRENT_SCREEN.root, "DeskAskSetup")) return;
  const had = document.activeElement && document.activeElement.closest && document.activeElement.closest("[data-ask]");
  const key = had ? had.getAttribute("data-ask") : "";
  repaint();
  if (key) {
    const again = document.querySelector('#view [data-ask="' + key + '"] button');
    if (again) again.focus();
  }
}

/** A button on the card. The main process checks the kind and pushes the
 *  new state back. The picture switch is this computer's own flag, so it is
 *  drawn at once rather than after the round trip; the push confirms it. */
function askAction(kind, on) {
  // A clock set back reads as a long gap, never as a card that stops answering.
  const now = Date.now(), gap = now - ASK_PRESSED_AT;
  if (gap >= 0 && gap < K.num("desktop.askSetup.repeatMs", 500)) return;
  ASK_PRESSED_AT = now;
  try { window.tailzuApp.askSetupAction(kind, on); } catch { return; /* an older main process */ }
  if (kind === "picturesAll" && ASK_SETUP && ASK_SETUP.pictures !== "never") {
    askSetupTook(Object.assign({}, ASK_SETUP, { pictures: on ? "on" : "off" }));
  }
}

// ---- the folders Ask may use (DeskFolders) ----------------------------------------

/** The main process's last answer: { custom, folders: [{ label, path }], error }, or null until it gives one. */
let FOLDERS = null;
let FOLDERS_LISTENING = false;

function foldersWatch() {
  if (FOLDERS_LISTENING || !ENV || !ENV.askSetup) return;
  FOLDERS_LISTENING = true;
  try { window.tailzuApp.onFolders((st) => foldersTook(st)); } catch { /* an older main process */ }
  foldersRead();
}
function foldersRead() {
  try { Promise.resolve(window.tailzuApp.folders()).then(foldersTook, () => {}); } catch { /* an older main process */ }
}
function foldersTook(st) {
  if (!st || typeof st !== "object") return;
  FOLDERS = {
    custom: st.custom === true,
    error: typeof st.error === "string" ? st.error.slice(0, 160) : "",
    folders: (Array.isArray(st.folders) ? st.folders : []).slice(0, 12)
      .map((f) => ({ label: String((f && f.label) || "").slice(0, 80), path: String((f && f.path) || "").slice(0, 240) }))
      .filter((f) => f.label),
  };
  if (CURRENT_SCREEN && findNode(CURRENT_SCREEN.root, "DeskFolders")) repaint();
}
function foldersAction(kind, i) {
  try { window.tailzuApp.foldersAction(kind, Number.isInteger(i) ? i : -1); } catch { /* an older main process */ }
}

/** The row: each allowed folder with a button to take it out, then Add a folder and, once the list is the person's own, Back to the usual three. Rows reuse the setup card's look. */
function foldersNode(p, s) {
  if (!FOLDERS) return "";
  const t = (v) => esc(label(v) || "");
  const tick = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.4 6.6 11.4 12.6 4.8"/></svg>';
  const btn = (action, words, quiet, title) => '<button type="button" class="d-ask-btn' + (quiet ? " d-ask-quiet" : "") + '"' +
    bind(action) + ' aria-label="' + esc(String(words) + ": " + title) + '">' + esc(words) + "</button>";
  const rows = FOLDERS.folders.map((f, i) =>
    '<div class="d-ask-row" data-folder="' + i + '" data-done="1"><span class="d-ask-n" aria-hidden="true">' + tick + "</span>" +
    '<div class="d-ask-text"><div class="d-ask-t">' + esc(f.label) + '</div><div class="d-ask-s">' + esc(f.path) + "</div></div>" +
    '<div class="d-ask-act">' + btn({ kind: "ask.folderRemove", i: i }, label(p.remove) || "", true, f.label) + "</div></div>").join("") ||
    '<div class="d-ask-row"><span class="d-ask-n" aria-hidden="true">·</span><div class="d-ask-text"><div class="d-ask-s">' + t(p.none) + "</div></div></div>";
  const policy = typeof p.policyUrl === "string" && /^https:\/\//.test(p.policyUrl) && label(p.policyLabel)
    ? ' <button type="button" class="d-ask-link"' + bind({ kind: "openUrl", url: p.policyUrl }) + ">" + t(p.policyLabel) + "</button>"
    : "";
  const more = String(p.cls || "").split(/\s+/).filter((c) => /^d-[a-z0-9-]+$/.test(c));
  return '<section class="' + ["d-ask", "d-folders"].concat(more).join(" ") + '" data-place="settings" aria-label="' + esc(label(p.title) || "") + '" style="' + s + '"><div class="d-ask-in">' +
    (p.lede ? '<p class="d-ask-lede">' + t(p.lede) + "</p>" : "") +
    '<div class="d-ask-card">' + rows + "</div>" +
    '<p class="d-ask-foot d-folders-act">' + btn({ kind: "ask.folderAdd" }, label(p.add) || "", false, label(p.title) || "") +
    (FOLDERS.custom ? " " + btn({ kind: "ask.folderReset" }, label(p.reset) || "", true, label(p.title) || "") : "") + "</p>" +
    (FOLDERS.error ? '<p class="d-ask-foot" role="alert">' + t(p.refused) + " " + esc(FOLDERS.error) + "</p>" : "") +
    (p.foot || policy ? '<p class="d-ask-foot">' + t(p.foot) + policy + "</p>" : "") +
    "</div></section>";
}

function bind(action) {
  if (!action) return "";
  const id = "h" + handlers.length;
  handlers.push({ id, action: STATE && STATE.item !== undefined ? withItem(action) : action });
  return ' data-h="' + id + '"';
}

/**
 * A ROW'S ACTION REMEMBERS ITS ROW.
 *
 * A List draws each item with `state.item` set, and unsets it when the row is
 * drawn. Clicks come later — so "copy this note" or "delete this word",
 * written as `$state.item.text`, would read an item that no longer exists and
 * act on nothing. The references to the item are filled in when the row is
 * drawn; everything else in the action is left for the click.
 */
function withItem(v) {
  const ITEM = /\$state\.item\.[A-Za-z0-9_.]+/g;
  if (typeof v === "string") {
    if (/^\$state\.item\.[A-Za-z0-9_.]+$/.test(v)) return stateAt(v.slice(7));
    return v.replace(ITEM, (m) => { const x = stateAt(m.slice(7)); return x == null ? "" : String(x); });
  }
  if (Array.isArray(v)) return v.map(withItem);
  if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v)) o[k] = withItem(v[k]); return o; }
  return v;
}

/** The desk's own classes, by name. Only `d-` names get through: a class is a
 *  stylesheet rule in app.html, and a server that could name any class could
 *  reach styles this window never meant to hand out. */
function cls(p) {
  const list = String((p && p.cls) || "").split(/\s+/).filter((c) => /^d-[a-z0-9-]+$/.test(c));
  return list.length ? ' class="' + list.join(" ") + '"' : "";
}

function node(n) {
  if (!n) return "";
  if (!visible(n.visibleIf)) return n.fallback ? node(n.fallback) : "";
  // The onboarding stage draws the one step it is on, not all of them.
  if (n.type === "OnboardStage") return stageNode(n);
  const p = n.props || {}, st = n.style || {}, s = css(st);
  const kids = (n.children || []).map(node).join("");
  const press = n.on && (n.on.onPress || n.on.onChange || n.on.onSubmit);
  const txt = esc(label(p.content != null ? p.content : p.label));

  switch (n.type) {
    case "Screen":
      // A desk page runs the width of the window and brings its own margins;
      // a phone screen keeps the centred column it was designed for.
      if (p.layout === "full") return '<div' + cls({ cls: "d-screen " + (p.cls || "") }) + ' style="' + s + '">' + kids + "</div>";
      return '<div class="pad" style="' + s + '">' + kids + "</div>";

    case "Row":
      // A SETTINGS ROW, as the phones draw it: the label on the left, a value
      // and a chevron on the right, a hairline under. This window read every
      // Row as a horizontal stack and drew the children it does not have —
      // so Settings was a heading over nothing, and the server's fallback
      // Button never applied because the window had said it could draw a
      // Row. A Row with no label is still the layout row, below.
      if (p.label != null || p.value != null) {
        const chevron = p.chevron !== false;
        return '<div' + bind(press) + ' style="display:flex;align-items:center;padding:' +
          K.num("desktop.row.paddingV", 17) + 'px 0;' +
          (p.divider === false ? "" : "border-bottom:1px solid var(--border);") +
          (press ? "cursor:pointer;" : "") + s + '">' +
          '<span style="flex:1;' + role("row", "font-size:" + K.num("desktop.row.fontSize", 16) + "px;color:" +
            (p.danger ? "var(--danger)" : "var(--text)")) + '">' + esc(p.label || "") + "</span>" +
          (p.value ? '<span style="' + role("rowValue", "font-size:" + K.num("desktop.row.valueSize", 15) + "px;color:var(--muted)") +
            (chevron ? ";margin-right:" + K.num("desktop.row.valueGap", 8) + "px" : "") + '">' + esc(p.value) + "</span>" : "") +
          (chevron ? '<span style="' + role("rowChevron", "font-size:" + K.num("desktop.row.chevronSize", 20) + "px;color:var(--muted)") +
            ';margin-top:-2px">›</span>' : "") +
          "</div>";
      }
      // falls through
    case "Stack": case "SafeArea": case "MorphOut": case "PullToRefresh": case "Grid":
      // A Grid with columns is a grid. It was a column of its children, which
      // is a long way from three apps across.
      if (n.type === "Grid" && Number(p.columns) > 0) {
        return '<div' + bind(press) + rolePress(press) + cls(p) + ' style="position:relative;display:grid;grid-template-columns:repeat(' +
          Math.floor(Number(p.columns)) + ",minmax(0,1fr));gap:" + (Number(p.gap) || 0) + "px" + (press ? ";cursor:pointer" : "") + ";" + s + '">' + kids + "</div>";
      }
      // POSITION:RELATIVE, AND IT IS LOAD-BEARING.
      //
      // React Native paints children in the order they are written. CSS does
      // not: a POSITIONED element paints above a static one however early it
      // comes. So the shape the catalog uses for every full-bleed screen —
      // absolute art, absolute scrim, then the content — put the art and the
      // scrim ON TOP of the content here. The paywall rendered its plans,
      // centred and correctly placed, entirely underneath its own backdrop.
      //
      // Making every in-flow stack relative restores the order the tree
      // means. It also fixes the containing block: an absolutely-positioned
      // child now measures against its own parent, which is what it does on
      // the phones and not what it was doing here.
      return '<div' + bind(press) + rolePress(press) + cls(p) + ' style="' +
        (st.position ? "" : "position:relative;") + "display:flex;flex-direction:" +
        (st.direction === "row" || n.type === "Row" ? "row" : "column") +
        (press ? ";cursor:pointer" : "") + ";" + s + '">' + kids + "</div>";

    case "Card":
      return '<div' + bind(press) + ' style="background:var(--card);border:1px solid var(--border);' +
        "border-radius:" + K.num("desktop.card.radius", 18) + "px;padding:" + K.num("desktop.card.padding", 16) +
        "px;margin-bottom:" + K.num("desktop.card.marginBottom", 13) + "px" + (press ? ";cursor:pointer" : "") + ";" + s + '">' +
        kids + (txt ? "<div>" + txt + "</div>" : "") + "</div>";

    case "Spacer":
      // minHeight is what keeps a flexible spacer from closing up completely
      // (the onboarding's, which pushes its button to the foot of the window).
      return '<div style="height:' + esc(st.height || K.num("desktop.spacer.height", 8)) + "px;flex:" + esc(st.flex || 0) +
        (st.minHeight != null ? ";min-height:" + esc(Number(st.minHeight) || 0) + "px" : "") + '"></div>';

    case "Divider":
      return '<div style="height:1px;background:var(--border);margin:' + K.num("desktop.divider.margin", 12) + 'px 0"></div>';

    case "Heading":
      return '<h2 style="margin:0;' + role("heading", "color:var(--text)") + ";" + s + '">' + txt + "</h2>";

    case "Hero":
      return '<div style="margin-bottom:16px"><div style="' + role("h1", "color:var(--text)") + '">' +
        esc(label(p.title)) + '</div><div style="margin-top:4px;' + role("muted") + '">' +
        esc(label(p.subtitle)) + "</div></div>";

    case "Overline":
      return '<div style="' + role("overline", "color:var(--label)") + ";" + s + '">' + txt + "</div>";

    case "Paragraph": case "Quote":
      return '<p style="margin:0;' + role(n.type === "Quote" ? "quoteBlock" : "paragraph", "color:var(--body)") +
        ";" + s + '">' + txt + "</p>";

    case "Text":
      // `variant` names a role — the same switch the phone makes.
      //
      // WHITE-SPACE: PRE-WRAP, because React Native keeps the spaces a string
      // was written with and HTML does not. It collapses a run of them, and
      // trims them entirely at the edges of a flex item — so the consent line,
      // which is one sentence split into parts because two of its words are
      // links, rendered as "our Terms and" with the spaces eaten and the words
      // jammed together. pre-wrap keeps them and still wraps, which is what
      // the phones do with the same tree.
      // A desk line takes its face from its class, and its words from state
      // when it is bound to them — the keys this computer has bound, a note's
      // two lines — so one template can draw every row of a list.
      if (p.cls) {
        const bound = n.bind && n.bind.content ? stateAt(n.bind.content) : undefined;
        const words = bound != null ? esc(String(bound)) : txt;
        return '<span' + bind(press) + cls(p) + ' style="' + s + '">' + words + "</span>";
      }
      // In the onboarding a line can be drawn from state (a language's name, an
      // app's, the words the mic wrote), as the phones do; the server sends no
      // words for it, so it is never put through a translator.
      const live = IN_STAGE && n.bind && n.bind.content ? stateAt(n.bind.content) : undefined;
      return '<span' + bind(press) + rolePress(press) + ' style="white-space:pre-wrap;' +
        role(p.variant || "body", "color:var(--text)") + ";" +
        (press ? "cursor:pointer;" : "") + s + '">' + (live != null ? esc(String(live)) : txt) + "</span>";

    case "Badge": case "Chip":
      return '<span' + bind(press) + ' style="display:inline-block;border:1px solid var(--border);border-radius:999px;' +
        'padding:5px 11px;' + role(n.type === "Badge" ? "badge" : "chip", "color:var(--body)") + ";" + (press ? "cursor:pointer;" : "") + s + '">' + txt + "</span>";

    case "Button": {
      // A desk control is a link or an ink button, drawn by its class.
      if (p.cls) return '<button type="button"' + bind(press) + cls(p) + ' style="' + s + '">' + txt + "</button>";
      const primary = p.variant !== "secondary" && p.variant !== "ghost";
      return '<button' + bind(press) + ' style="display:block;width:100%;border:0;cursor:pointer;' +
        (primary ? "background:var(--accent);color:" + K.color("desktop.button.primaryText", "#000")
                 : "background:transparent;color:var(--text);border:1px solid var(--border)") +
        ";border-radius:" + K.num("desktop.button.radius", 14) + "px;padding:" + K.str("desktop.button.padding", "14px 18px") +
        ";margin:" + K.str("desktop.button.margin", "6px 0") + ";" + role(primary ? "button" : "buttonSecondary") + ";" + s + '">' +
        (txt || esc(K.txt("desktop.button.label", "Continue"))) + "</button>";
    }

    case "Row2": case "KeyValue":
      return '<div' + bind(press) + ' style="display:flex;justify-content:space-between;gap:14px;padding:12px 0;' +
        "border-bottom:1px solid var(--border)" + (press ? ";cursor:pointer" : "") + '">' +
        '<span style="' + role("row", "color:var(--label)") + '">' + esc(label(p.label)) + "</span>" +
        '<span style="' + role("rowValue", "color:var(--text)") + '">' + esc(label(p.value)) + "</span></div>";

    case "StatCard":
      return '<div style="background:var(--card);border-radius:14px;padding:15px;flex:1;min-width:0;' + s + '">' +
        '<div style="' + role("label", "color:var(--label);text-transform:uppercase") + '">' + esc(label(p.label)) + "</div>" +
        '<div style="margin-top:5px;' + role("h1", "color:var(--text)") + '">' + esc(p.value) + "</div></div>";

    case "TextField": {
      const path = (n.bind && n.bind.value) || "";
      const val = path ? (stateAt(path) || "") : "";
      const multi = p.multiline === true;
      if (p.cls && !multi) {
        const submit = n.on && n.on.onSubmit ? ' data-s="' + SUBMITS.push(n.on.onSubmit) + '"' : "";
        return '<input value="' + esc(val) + '" data-bind="' + esc(path) + '"' + submit + cls(p) +
          ' placeholder="' + esc(label(p.placeholder) || "") + '" aria-label="' + esc(label(p.placeholder) || "") + '" style="' + s + '">';
      }
      const common = ' data-bind="' + esc(path) + '" placeholder="' + esc(label(p.placeholder) || "") +
        '" style="width:100%;background:var(--input);border:1px solid var(--border);border-radius:13px;' +
        "padding:13px 14px;color:var(--text);font:inherit;outline:none;" + s + '"';
      return multi
        ? "<textarea rows=\"4\"" + common + ">" + esc(val) + "</textarea>"
        : '<input value="' + esc(val) + '"' + common + ">";
    }

    case "Switch": {
      const path = (n.bind && n.bind.value) || "";
      const on = truthy(path ? stateAt(path) : p.value);
      if (p.cls) {
        return '<button type="button" role="switch" aria-checked="' + on + '"' + cls(p) +
          (n.on && n.on.onChange ? bind(n.on.onChange) : ' data-toggle="' + esc(path) + '"') +
          ' aria-label="' + esc(label(p.accessibilityLabel || p.label || "")) + '" style="' + s + '"></button>';
      }
      const sw = K.obj("desktop.switch", {
        width: 50, height: 30, knob: 24, inset: 3, offBackground: "rgba(255,255,255,.16)", knobColor: "#fff",
      });
      return '<button' + bind(n.on && n.on.onChange ? n.on.onChange : press) +
        ' data-toggle="' + esc(path) + '" aria-pressed="' + on + '"' +
        ' style="width:' + sw.width + "px;height:" + sw.height + "px;flex:none;border:0;border-radius:" + (sw.height / 2) +
        "px;cursor:pointer;position:relative;background:" + (on ? "var(--accent)" : esc(sw.offBackground)) + '">' +
        '<span style="position:absolute;top:' + sw.inset + "px;left:" + (on ? sw.width - sw.knob - sw.inset : sw.inset) +
        "px;width:" + sw.knob + "px;height:" + sw.knob + "px;border-radius:50%;background:" + esc(sw.knobColor) + '"></span></button>';
    }

    case "List": {
      const items = Array.isArray(p.items) ? p.items : [];
      if (!items.length) {
        const empty = label(p.emptyLabel);
        return empty ? '<p style="color:var(--muted);text-align:center;padding:26px 0">' + esc(empty) + "</p>" : "";
      }
      const tpl = p.itemTemplate;
      return items.map((it) => {
        const saved = STATE;
        STATE = Object.assign({}, STATE, { item: it });
        const html = tpl ? node(tpl) : '<div style="padding:10px 0">' + esc(it.title || it.output || "") + "</div>";
        STATE = saved;
        return html;
      }).join("");
    }

    case "Image": case "Video": {
      const src = p.source && (p.source.url || p.source.uri);
      if (!src) return "";
      // The PARENT usually owns the box. A hero is a Stack carrying the aspect
      // ratio and the clipping, holding a media node whose only instruction is
      // "fill me" — so a percentage has to survive as a percentage. Appending
      // "px" to it produced `height:100%px`, which the browser drops, and the
      // fallback 160px then collapsed a full-bleed hero into a strip.
      const dim = (v, fb) => (v == null ? fb : typeof v === "number" ? v + "px" : String(v));
      const fills = String(st.height) === "100%";
      const box =
        "width:" + dim(st.width, "100%") + ";" +
        (st.aspectRatio ? "aspect-ratio:" + st.aspectRatio + ";"
                        : "height:" + dim(st.height, K.num("desktop.image.height", 160) + "px") + ";") +
        "min-height:0;" +
        // Filling a parent means the parent draws the corners and the spacing.
        "border-radius:" + (st.borderRadius != null ? st.borderRadius : fills ? 0 : K.num("desktop.image.radius", 16)) + "px;" +
        "object-fit:" + (p.contentFit === "contain" ? "contain" : "cover") + ";" +
        "display:block;" + (fills ? "margin:0;" : "margin:0 auto " + K.num("desktop.image.marginBottom", 14) + "px;");
      return n.type === "Video"
        ? '<video src="' + esc(src) + '" autoplay muted loop playsinline style="' + esc(box) + '"></video>'
        : '<img src="' + esc(src) + '" alt="" style="' + esc(box) + '">';
    }

    case "Keys": return keysNode(p, s);

    // Where Blip stands in this step: an empty box the size of his figure, that
    // says in which pose and with what words. The one Blip who walks the
    // onboarding (blip.js createWalker) finds it and goes there.
    case "BlipSpot": return blipSpotNode(p, s);

    case "DeskAskSetup": return askSetupNode(p, s);
    case "DeskFolders": return foldersNode(p, s);

    case "WordMeter": return wordMeter(p);
    case "PieChart": case "DonutChart": return pie(p);
    case "BarChart": return bars(p);
    case "Sparkline": case "LineChart": return bars({ series: p.series || p.data, color: p.color });
    case "ProgressRing": case "Gauge":
      return '<div style="height:' + K.num("desktop.progress.height", 6) + "px;border-radius:" +
        (K.num("desktop.progress.height", 6) / 2) + 'px;background:var(--border);overflow:hidden;margin:8px 0">' +
        '<div style="width:' + Math.max(0, Math.min(100, Number(p.value) || 0)) + '%;height:100%;background:var(--accent)"></div></div>';

    // ---- what the phones draw that a window can draw too -----------------
    //
    // These were all falling through to `default`, which renders a node's
    // CHILDREN and drops the node itself. For a Gradient or an SVG that means
    // nothing appears at all; for the greeting it meant no word; for the way
    // into training it meant no control. The desktop was not a smaller version
    // of the app, it was the app with its scrims, its icons, its chevrons and
    // its one button missing.

    case "SVG": {
      // One path, viewBox and all, straight through. Every chevron, arrow,
      // cross and tab glyph in the catalog is one of these.
      const vb = esc(p.viewBox || "0 0 24 24");
      const fill = p.fill && p.fill !== "none" ? esc(tok(p.fill)) : "none";
      const stroke = p.stroke ? esc(tok(p.stroke)) : "none";
      return '<svg viewBox="' + vb + '" style="' + s + ';display:block' + (IN_STAGE ? ";flex:none" : "") + '" ' +
        'fill="' + fill + '" stroke="' + stroke + '" ' +
        'stroke-width="' + (Number(p.strokeWidth) || K.num("desktop.svg.strokeWidth", 2)) + '" ' +
        'stroke-linecap="' + esc(p.strokeLinecap || "round") + '" ' +
        'stroke-linejoin="' + esc(p.strokeLinejoin || "round") + '">' +
        '<path d="' + esc(p.d || "") + '"></path></svg>';
    }

    case "Gradient": {
      const cols = (p.colors || []).map((c) => tok(c));
      const locs = p.locations || [];
      const stops = cols.map((c, i) =>
        esc(c) + (locs[i] != null ? " " + Math.round(locs[i] * 100) + "%" : "")).join(",");
      const dir = p.direction === "horizontal" ? "to right" : "to bottom";
      return '<div style="' + s + ';background:linear-gradient(' + dir + "," + stops + ')"></div>';
    }

    case "BlurBackground":
      // A real backdrop blur — the one thing a browser does better than the
      // phones, and for free.
    {
      // The phones' intensity is 0..100; a CSS blur radius a third of it
      // matches what they draw.
      const blur = Math.round((Number(p.intensity) || K.num("desktop.blur.intensity", 60)) /
        K.num("desktop.blur.divisor", 3));
      return '<div style="' + s + ';backdrop-filter:blur(' + blur + 'px);-webkit-backdrop-filter:blur(' +
        blur + 'px)">' + kids + "</div>";
    }

    case "ProgressBar":
      return '<div style="' + s + ";height:" + K.num("desktop.progressBar.height", 3) +
        'px;border-radius:2px;background:var(--border);overflow:hidden">' +
        '<div class="tz-indet" style="height:100%;background:var(--accent)"></div></div>';

    case "FlipText": {
      // The greeting. Same words, same interval, same idea — one turns into
      // the next and nothing else on the line moves.
      const words = (p.words || []).map((w) => esc(String(w)));
      if (!words.length) return "";
      const id = "flip" + (node._n = (node._n || 0) + 1);
      FLIPS.push({
        id: id, words: words,
        ms: Math.max(K.num("desktop.flip.minMs", 900), Number(p.intervalMs) || K.num("desktop.flip.intervalMs", 2600)),
      });
      return '<span id="' + id + '" style="' + s + ";transition:opacity " +
        (K.num("desktop.flip.fadeMs", 250) / 1000) + 's">' + words[0] + "</span>";
    }

    case "Modal":
      // Open state lives in the screen's own state, exactly as on the phone.
      if (!truthy(stateAt((n.bind && n.bind.open) || ""))) return "";
      return '<div class="tz-modal"><div class="tz-sheet" style="' + s + '">' + kids + "</div></div>";

    case "SwipeAction": {
      // THE WAY IN. On a phone it is dragged, because a live microphone
      // deserves a held intention. A mouse has no thumb to rest, so here it is
      // the same object as a button — same label, same colours, same pale far
      // end — and a click commits it. The gesture was never the point; the
      // deliberateness was, and a click on a pill this size is deliberate.
      const d = K.obj("desktop.swipeAction", {
        height: 58, radius: 999, background: "#0B0B0D", color: "#fff", fontSize: 12, weight: 700,
        tracking: 1.8, disc: 46, target: "#F3E2C6",
      });
      const h = Number(p.height) || d.height;
      const disc = Number(p.disc) || d.disc;
      return '<button class="tz-press" data-ev="onComplete" style="' + s +
        ";position:relative;height:" + h + "px;border-radius:" + (Number(p.radius) || d.radius) + "px" +
        ";background:" + esc(tok(p.background || d.background)) +
        ";border:" + (p.borderWidth ? p.borderWidth + "px solid " + esc(tok(p.borderColor)) : "none") +
        ";color:" + esc(tok(p.color || d.color)) +
        ";font-size:" + (Number(p.fontSize) || d.fontSize) + "px;font-weight:" + (p.weight || d.weight) +
        ";letter-spacing:" + (Number(p.tracking) || d.tracking) + 'px;width:100%;cursor:pointer">' +
        esc(label(p.label || "")) +
        '<span style="position:absolute;right:6px;top:50%;transform:translateY(-50%);width:' +
        disc + "px;height:" + disc +
        "px;border-radius:50%;background:" + esc(tok(p.targetBackground || d.target)) +
        ';opacity:.45"></span></button>';
    }

    case "NeuralField": {
      // The page it draws is HTML and canvas. This IS a browser — it needs no
      // bridge, no WebView and no stand-in; the same file the phone loads
      // renders here natively.
      //
      // WITH THE SAME NUMBERS. It used to load the file bare, and the file is
      // generated with `growth` absent — which the page reads as 1. So the
      // window drew a fully grown network for everybody, on day one and month
      // six alike, and the claim this screen makes (that the thing inside gets
      // bigger every time you talk to it) was false in the one place it is
      // visible. alpha went the same way: the field sat at full strength on a
      // screen that wanted it dimmed behind the copy.
      //
      // Those two are per screen and per person, and retune the field in
      // place. EVERYTHING ELSE THE SERVER SENDS goes too — regions, colours,
      // bloom, focal length — as one `cfg` parameter the page lays over the
      // geometry it has baked in, so a retune on the server reaches the window
      // the way it reaches the phones, and a node that sends none of it gets
      // the baked field exactly as before. The live values (state, level,
      // training) are messages, not config, and stay out of the address.
      const geo = {};
      Object.keys(p).forEach((k) => {
        if (FIELD_LIVE.indexOf(k) === -1 && p[k] != null) geo[k] = p[k];
      });
      const q = "?alpha=" + encodeURIComponent(Number(p.alpha != null ? p.alpha : 1)) +
        "&growth=" + encodeURIComponent(Number(p.growth != null ? p.growth : 1)) +
        (Object.keys(geo).length ? "&cfg=" + encodeURIComponent(JSON.stringify(geo)) : "");
      FIELD_BINDS = n.bind || null;
      FIELD_PROPS = p;
      // A PLACEHOLDER, not the iframe itself. Every repaint replaces this
      // view's innerHTML, and an iframe written into that string is a NEW
      // iframe: the page reloads, forty thousand curves are baked again, and
      // the animation restarts from nothing. The Train tab repaints on every
      // phase of a live session, so the one screen where the field is supposed
      // to react was the one screen where it kept starting over.
      //
      // The real iframe is created once and moved in here after each paint.
      return '<div data-field="' + esc(q) + '" class="tz-field" style="' + s + '"></div>';
    }

    // THE CONVERSATION. SDUI has no repeater, so the Train tab's thread is one
    // node that reads an array out of state and draws it — the same contract
    // the phones implement, and the reason the server can append a row and
    // have both surfaces show it.
    //
    // This window used to fall through to `default` and draw the node's
    // fallback: a line saying the conversation needed an update, on a build
    // that was perfectly capable of holding one.
    case "ChatThread":
      return chatThread(n, p, s);

    // The mic, in the page. Not the tray's: that one records globally and
    // pastes into whatever app has focus, which is the wrong verb entirely for
    // a control that is supposed to fill the field beside it. The window has
    // its own microphone permission, so it records here and writes the
    // transcript into the bound path, exactly as the phones do.
    //
    // VoiceToggle and VoiceButton differ on the phones by how they are held.
    // A mouse has no hold, so both are a click, and the catalog's fallback
    // from one to the other costs nothing.
    case "VoiceToggle":
    case "VoiceButton":
      return voiceButton(n, p, s);

    // The spoken session. Renders nothing — it owns the audio loop and writes
    // what it knows into the screen's state, so everything around it stays
    // ordinary backend JSON. Started on the first paint that contains it.
    case "VoiceSession":
      startSession(n);
      return "";

    // ── the sign-in screen ────────────────────────────────────────────────
    // The gate was the last hand-built screen in this window: its own markup,
    // its own buttons, its own arrangement, while the phones drew theirs from
    // `auth.screen` in the boot flags. So the first screen of the product was
    // the one screen that looked like a different product, and every change to
    // it was a change to an installer.
    case "AuthPhase":
      return (n.props?.phases || []).indexOf(AUTH.phase) === -1 ? "" : kids;

    case "Rise":
      return riseNode(n, p, s, kids);

    case "SwipePill":
      return swipePill(p, s);

    case "CodeEntry":
      return codeEntry(p, s);

    case "AppleSignIn":
      return socialButton("apple", p, s);

    case "GoogleSignIn":
      return socialButton("google", p, s);

    // Everything the phones draw natively and this window has no business
    // imitating — the keyboard preview (there is no keyboard to configure
    // here), the mic toggle and the spoken session (this app records through
    // its own tray hotkey, not an in-page control). Their children still
    // render, so a card built around one is not lost, and a node that shipped
    // a fallback gets it — the same rule the phone renderer follows, so the
    // server can keep emitting one tree for both.
    default:
      return kids || (n.fallback ? node(n.fallback) : "");
  }
}

/**
 * The Train tab's conversation.
 *
 * Every visual value is a prop with a default, so the server moves all of it
 * without a build — the same rule the phone component follows, and the reason
 * `colors` can arrive half-filled and still land.
 *
 * Rows, whatever the server appended:
 *   { role: "ask",      text }            what the app asked
 *   { role: "mine",     text }            what the user answered
 *   { role: "note",     text }            a centred aside ("Learned: dry")
 *   { role: "variants", options: [...] }  three readings to choose between
 */
/** The thread's defaults — under the node's own `colors`, over nothing. A
 *  knob as a whole, so the server can move any of them for every screen at
 *  once; the sizes ride along with the colours. */
function chatDefaults() {
  return K.obj("desktop.chat.style", {
    askBg: "rgba(255,255,255,0.06)", askBorder: "rgba(255,255,255,0.09)",
    askText: "rgba(255,255,255,0.9)", mineBg: "#FFFFFF", mineText: "#000000",
    noteText: "#F3E2C6", noteBg: "rgba(243,226,198,0.1)", noteBorder: "rgba(243,226,198,0.26)",
    variantBg: "rgba(255,255,255,0.05)", variantBorder: "rgba(255,255,255,0.1)",
    variantText: "rgba(255,255,255,0.92)", angleText: "rgba(255,255,255,0.4)",
    pickedBg: "rgba(243,226,198,0.13)", pickedBorder: "#F3E2C6",
    labelText: "rgba(255,255,255,0.38)", radius: 16, gap: 11,
    tail: 5, fontSize: 14.5, mineLineHeight: 21, askLineHeight: 22, noteSize: 11,
    optionRadius: 14, optionSize: 14, optionLineHeight: 21, labelSize: 10.5,
  });
}

/** Which option was taken in which row, for the screen currently painted.
 *  Keyed by row index: a thread only ever grows, so an index is stable. */
let CHAT_PICKED = {};

function chatThread(n, p, s) {
  const c = { ...chatDefaults(), ...(p.colors || {}) };
  const rows = (() => { const r = stateAt((n.bind && n.bind.thread) || ""); return Array.isArray(r) ? r : []; })();
  const pickLabel = label(p.pickLabel) || K.txt("desktop.chat.pickLabel", "Tap the one that sounds like you");

  const bubble = (r, i) => {
    if (r.role === "mine") {
      return '<div style="align-self:flex-end;max-width:82%;background:' + esc(tok(c.mineBg)) +
        ";padding:10px 14px;border-radius:" + c.radius + "px;border-bottom-right-radius:" + c.tail + "px" +
        ";font-size:" + c.fontSize + "px;line-height:" + c.mineLineHeight + "px;color:" + esc(tok(c.mineText)) + '">' +
        esc(r.text || "") + "</div>";
    }
    if (r.role === "note") {
      return '<div style="align-self:center;background:' + esc(tok(c.noteBg)) + ";border:1px solid " +
        esc(tok(c.noteBorder)) + ";border-radius:999px;padding:5px 11px;font-size:" + c.noteSize + "px;letter-spacing:.5px;color:" +
        esc(tok(c.noteText)) + '">' + esc(r.text || "") + "</div>";
    }
    if (r.role === "variants") {
      const options = Array.isArray(r.options) ? r.options.filter((o) => o && o.text) : [];
      if (!options.length) return "";
      const chose = CHAT_PICKED[i];
      const opts = options.map((o, j) => {
        const isPicked = chose === j;
        const dimmed = chose != null && !isPicked;
        return '<button class="tz-press" data-pick="' + i + ":" + j + '"' +
          (chose != null ? " disabled" : "") +
          ' style="display:block;width:100%;text-align:left;cursor:' + (chose != null ? "default" : "pointer") +
          ";background:" + esc(tok(isPicked ? c.pickedBg : c.variantBg)) +
          ";border:1px solid " + esc(tok(isPicked ? c.pickedBorder : c.variantBorder)) +
          ";border-radius:" + c.optionRadius + "px;padding:11px 13px;opacity:" + (dimmed ? ".3" : "1") + '">' +
          (o.angle
            ? '<div style="font-size:10px;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;color:' +
              esc(tok(isPicked ? c.pickedBorder : c.angleText)) + '">' + esc(o.angle) + "</div>"
            : "") +
          '<div style="font-size:' + c.optionSize + "px;line-height:" + c.optionLineHeight + "px;color:" + esc(tok(c.variantText)) + '">' +
          esc(o.text) + "</div></button>";
      }).join("");
      return '<div style="display:flex;flex-direction:column;gap:7px">' +
        '<div style="font-size:' + c.labelSize + "px;letter-spacing:1.4px;text-transform:uppercase;color:" +
        esc(tok(c.labelText)) + '">' + esc(r.label || pickLabel) + "</div>" + opts + "</div>";
    }
    // Anything else is something the app said.
    return '<div style="align-self:flex-start;max-width:88%;background:' + esc(tok(c.askBg)) +
      ";border:1px solid " + esc(tok(c.askBorder)) + ";padding:12px 14px;border-radius:" + c.radius +
      "px;border-bottom-left-radius:" + c.tail + "px;font-size:" + c.fontSize + "px;line-height:" + c.askLineHeight + "px;color:" +
      esc(tok(c.askText)) + '">' + esc(r.text || "") + "</div>";
  };

  return '<div data-chat="1" style="' + s + ";flex:1;min-height:0;overflow-y:auto;display:flex" +
    ";flex-direction:column;gap:" + c.gap + 'px;padding-bottom:10px">' +
    rows.map(bubble).join("") + "</div>";
}

/**
 * The in-page microphone.
 *
 * Click to start, click again to stop. The clip goes to the same
 * /v1/transcribe-clean the tray uses, the text is written into the bound path,
 * and `onChange` fires — which is the moment the server's action refines it.
 * A failure fires `onError` with the real reason, because a permission denial
 * and a dead connection are not the same problem and must not read alike.
 */
let MIC = null;   // { rec, stream, path, node } while a capture is open

function voiceButton(n, p, s) {
  const size = Number(p.size) || K.num("desktop.voice.buttonSize", 44);
  // Held to speak, let go to stop: the onboarding's.
  if (p.hold === true) return holdMicButton(n, p, s, size);
  const on = !!(MIC && MIC.path === ((n.bind && n.bind.value) || ""));
  return '<button class="tz-press" data-mic="' + esc((n.bind && n.bind.value) || "") + '"' +
    ' aria-pressed="' + on + '" title="' +
    esc(on ? K.txt("desktop.voice.stop", "Stop and transcribe") : K.txt("desktop.voice.record", "Record")) + '"' +
    ' style="' + s + ";flex:none;width:" + size + "px;height:" + size + "px;border-radius:50%;cursor:pointer" +
    ";border:0;display:flex;align-items:center;justify-content:center;background:" +
    // Amber ONLY while it is recording — the one live thing; pale ink at rest.
    esc(tok(on ? K.color("desktop.voice.liveBackground", "#E8A23C")
               : (p.background || K.color("desktop.voice.background", "#F3E2C6")))) + '">' +
    // A filled circle while live, the mic glyph at rest. Drawn rather than
    // loaded: the phones use an uploaded icon, and a window that waited on
    // that upload would show an empty button until somebody made one.
    (on
      ? '<span style="width:' + Math.round(size * 0.34) + "px;height:" + Math.round(size * 0.34) +
        'px;border-radius:3px;background:#fff"></span>'
      : '<svg width="' + Math.round(size * 0.46) + '" height="' + Math.round(size * 0.46) +
        '" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round">' +
        '<rect x="9" y="2" width="6" height="12" rx="3" fill="#000" stroke="none"/>' +
        '<path d="M5 11a7 7 0 0 0 14 0M12 18v4"/></svg>') +
    "</button>";
}

/**
 * HOLD TO SPEAK, as the phones' button is held: press to start, let go to stop.
 * A window has a mouse, which can hold, so the onboarding's mic is the same
 * gesture it is on the phone. The disc is the node's size and colours; the
 * glyph on it is this window's own (the phones draw a child node there).
 */
const MIC_PATH = "M9 6a3 3 0 0 1 6 0v5a3 3 0 0 1-6 0zM5 11a7 7 0 0 0 14 0M12 18v3";
function holdMicButton(n, p, s, size) {
  const path = (n.bind && n.bind.value) || "";
  const on = !!(MIC && MIC.path === path);
  const bg = cssv(tok(on ? (p.recordingBackground || p.background) : p.background), "#1C1A17");
  const words = label(p.label) || K.txt("desktop.voice.hold", "Hold to speak");
  return '<button type="button" class="tz-press ob-mic" data-mic="' + esc(path) + '" data-hold="1" aria-pressed="' + on + '" aria-label="' + esc(words) + '"' +
    ' style="' + s + ";flex:none;width:" + size + "px;height:" + size + "px;border-radius:" + okNum(p.radius, size / 2, 0, size) +
    "px;border:0;cursor:pointer;display:flex;align-items:center;justify-content:center;background:" + bg + '">' +
    '<svg width="' + Math.round(size * 0.43) + '" height="' + Math.round(size * 0.43) + '" viewBox="0 0 24 24" fill="none" stroke="' +
    cssv(tok(p.glyphColor), "#FCFBF8") + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + MIC_PATH + '"/></svg></button>';
}

/** What the microphone is asked for — the same knob the tray's recorder reads. */
const micConstraints = () =>
  K.obj("desktop.mic.constraints", { echoCancellation: true, noiseSuppression: true, autoGainControl: true });

async function micStart(path, n) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
  const mime = K.list("desktop.mic.mimeTypes", ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"])
    .find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  // A node that names a state path is told what the mic is doing there:
  // "recording", "busy" (turning it into text) and "idle". The onboarding
  // changes Blip's pose and its captions with it.
  const sk = n.bind && n.bind.state;
  const mood = (v) => { if (sk) setStatePath(sk, v); };
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    MIC = null;
    if (sk) { mood("busy"); repaint(); }
    try {
      if (!chunks.length) throw worded(K.txt("desktop.mic.noAudio", "no audio captured"));
      const type = rec.mimeType || "audio/webm";
      const fd = new FormData();
      fd.append("audio", new Blob(chunks, { type }), "audio." + (type.indexOf("ogg") !== -1 ? "ogg" : "webm"));
      fd.append("targetApp", "Desktop");
      fd.append("language", String(n.props?.language || "auto"));
      const tok = await bearer();
      const res = await fetch(ENV.baseUrl + "/v1/transcribe-clean", {
        method: "POST",
        headers: tok ? { Authorization: "Bearer " + tok } : {},
        body: fd,
      });
      if (!res.ok) throw worded(statusText(res.status), "transcribe → " + res.status);
      const j = await res.json();
      // The written text only: an empty cleanedText is the server deciding
      // there was nothing to write, and the raw transcript in its place was
      // the invented or unwritten words it had just withheld.
      const text = String(j.cleanedText || "").trim();
      if (!text) throw worded(K.txt("desktop.mic.noSpeech", "no speech detected"));
      if (path) setStatePath(path, text);
      mood("idle");
      repaint();
      const ch = n.on && n.on.onChange;
      if (ch) await run(ch, text);
    } catch (err) {
      mood("idle");
      repaint();
      const eh = n.on && n.on.onError;
      const msg = userText(err, K.txt("desktop.mic.transcribeFailed", "Couldn't turn that into text. Try again."));
      if (eh) await run(eh, msg); else toast(msg);
    }
  };
  rec.start();
  MIC = { rec, stream, path, node: n };
  mood("recording");
  repaint();
}

/**
 * A SPOKEN CONVERSATION, the same loop the phones run.
 *
 * Renders nothing. It owns the audio and writes what it knows into the screen's
 * state, so the screen around it stays ordinary backend JSON — a bubble bound
 * to `level`, a line bound to `line`, a button that posts `$state.turns`.
 *
 * One turn at a time:
 *
 *   listening   a socket to /v1/transcribe-stream fills in text as you talk.
 *               A pause of silenceMs with something said ends the turn, and
 *               the mic closes — it must be shut while the app talks, or it
 *               transcribes its own voice.
 *   thinking    the conversation so far goes to `path`; a reply comes back.
 *   speaking    the browser says it. When it finishes, listening resumes.
 *
 * Turn-based, not full duplex — you cannot talk over it — which is the same
 * limit the phones have, for the same reason.
 *
 * The phone version spends half its length on AVAudioSession categories, so
 * the reply comes out of the speaker rather than the earpiece. A window has no
 * earpiece and no categories, and all of that simply does not exist here.
 */
let SESSION_RUN = null;   // the live loop, or null

function startSession(n) {
  if (SESSION_RUN) return;                 // already running for this screen
  const p = deepResolve(n.props || {});
  // How the level bubble moves: how often it decays, how far a word lifts it,
  // where it rests, and where it sits while the app thinks and speaks.
  const LV = K.obj("desktop.voice.level", {
    tickMs: 90, onSpeech: 0.8, floor: 0.15, decay: 0.86, thinking: 0.12, speaking: 0.5,
  });
  const r = {
    alive: true,
    endpoint: String(p.path || K.str("desktop.voice.endpoint", "/v1/train/converse")),
    silenceMs: Math.max(K.num("desktop.voice.minSilenceMs", 600), Number(p.silenceMs) || K.num("desktop.voice.silenceMs", 1500)),
    maxTurns: Math.max(K.num("desktop.voice.minTurns", 2), Number(p.maxTurns) || K.num("desktop.voice.maxTurns", 40)),
    language: p.language ? String(p.language) : "auto",
    // The locale the built-in voice should use when the server's cannot be
    // had: the catalog's speakLanguage ("en-IN" for Hinglish), never the raw
    // dictation setting, which is not a locale ("hinglish").
    speakLanguage: p.speakLanguage ? String(p.speakLanguage) : "",
    statePath: String(p.statePath || "sessionState"),
    levelPath: String(p.levelPath || "level"),
    linePath: String(p.linePath || "line"),
    turnsPath: String(p.turnsPath || "turns"),
    greeting: String(p.greeting || "").trim(),
    node: n, turns: [], committed: "", partial: "",
    ws: null, stream: null, ctx: null, proc: null, src: null, tts: null,
    decay: null, silence: null, level: 0,
  };
  SESSION_RUN = r;

  const put = (path, v) => { if (path) setStatePath(path, v); };
  const setState_ = (v) => { put(r.statePath, v); repaint(); };
  const setLevel = (v) => { r.level = v; put(r.levelPath, v); };
  const say = (role, text) => {
    r.turns = r.turns.concat([{ role, text }]);
    put(r.turnsPath, r.turns);
    put(r.linePath, text);
    repaint();
  };
  const fail = (m) => {
    if (!r.alive) return;
    r.alive = false;
    closeMic(r);
    setState_("error");
    const eh = n.on && n.on.onError;
    if (eh) void run(eh, m); else toast(m);
  };

  const armSilence = () => {
    clearTimeout(r.silence);
    r.silence = setTimeout(() => {
      const said = (r.committed + " " + r.partial).trim();
      // A pause with nothing in it is a pause, not a turn. Keep listening.
      if (!said) { armSilence(); return; }
      closeMic(r);
      say("user", said);
      void respond();
    }, r.silenceMs);
  };
  const heard = () => { setLevel(LV.onSpeech); armSilence(); };

  async function listen(warmed) {
    if (!r.alive) return;
    if (r.turns.length >= r.maxTurns * 2) { setState_("idle"); setLevel(0); return; }
    r.committed = ""; r.partial = "";
    setState_("listening");
    setLevel(LV.floor);
    // The level has no amplitude behind it — the socket hands over text, not
    // PCM. So it rises on the arrival of words and decays between them, which
    // is a true signal about speech even though it is not loudness.
    r.decay = setInterval(() => {
      if (r.level > LV.floor) setLevel(Math.max(LV.floor, r.level * LV.decay));
    }, LV.tickMs);
    try {
      // The microphone opened behind the greeting, when there was one. A
      // warm-up that failed falls through to asking again, so a denial is
      // still reported by the same path rather than silently.
      r.stream = (warmed ? await warmed : null) ||
        await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
      const token = await bearer();
      // Either wait can outlast the screen; a socket opened after that is one
      // nothing will ever close.
      if (!r.alive) { closeMic(r); return; }
      r.ws = new WebSocket(ENV.baseUrl.replace(/^http/, "ws") + "/v1/transcribe-stream");
      r.ws.binaryType = "arraybuffer";
      // A browser socket cannot set an Authorization header; the protocol
      // carries the token in the start frame, which the server accepts.
      r.ws.onopen = () => r.ws && r.ws.send(JSON.stringify({
        type: "start", token, targetApp: "Desktop", language: r.language,
        sampleRate: 16000, encoding: "pcm_s16le", channels: 1,
      }));
      r.ws.onmessage = (ev) => {
        if (!r.alive) return;
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === "partial") { r.partial = m.text || ""; heard(); }
        else if (m.type === "final") {
          if (m.text && m.text.trim()) r.committed = (r.committed + " " + m.text.trim()).trim();
          r.partial = ""; heard();
        } else if (m.type === "error") {
          // The server's sentence, except its sign-in refusal: that keeps
          // the keyboards' old wording ("invalid or missing token") because
          // they match on it, so it is said here.
          if (m.message) console.warn("[voice] stream error " + (m.code || "") + ": " + m.message);
          fail(m.code === "unauthorized"
            ? K.txt("error.unauthorized", "Your session has expired. Sign in again to continue.")
            : (m.message || K.txt("desktop.voice.micStopped", "The microphone stopped.")));
        }
      };
      r.ws.onerror = () => { /* onclose follows */ };
      // The socket went away under a live microphone (the server closed it, the
      // network dropped). Nothing else would ever notice: the silence timer
      // keeps re-arming on nothing said, and the mic stays open. Our own
      // closes detach this first (closeMic).
      r.ws.onclose = () => fail(K.txt("desktop.voice.micStopped", "The microphone stopped."));
      r.ctx = new AudioContext();
      r.src = r.ctx.createMediaStreamSource(r.stream);
      r.proc = r.ctx.createScriptProcessor(4096, 1, 1);
      r.src.connect(r.proc);
      r.proc.connect(r.ctx.destination);
      const inRate = r.ctx.sampleRate;
      // The level follows the voice itself as well as the words: the words
      // arrive a beat late, and a field that sits still while someone talks
      // reads as a microphone that is not on.
      const VL = K.obj("desktop.voice.inputLevel", { gate: 0.012, gain: 6 });
      r.proc.onaudioprocess = (e) => {
        if (!r.alive || !r.ws || r.ws.readyState !== 1) return;
        const f32 = e.inputBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < f32.length; i += 4) sum += f32[i] * f32[i];
        const rms = Math.sqrt(sum / Math.ceil(f32.length / 4));
        if (rms > VL.gate) setLevel(Math.max(r.level, Math.min(1, LV.floor + rms * VL.gain)));
        r.ws.send(pcm16k(f32, inRate));
      };
      armSilence();
    } catch (err) {
      fail(err && err.name === "NotAllowedError"
        ? K.txt("desktop.voice.micBlocked", "microphone blocked — allow it in your system settings")
        : userText(err, K.txt("desktop.voice.startFailed", "Couldn't start listening.")));
    }
  }

  async function respond() {
    if (!r.alive) return;
    setState_("thinking");
    setLevel(LV.thinking);
    try {
      const res = await api(r.endpoint, { turns: r.turns, language: r.language });
      if (!r.alive) return;
      const reply = String((res && res.reply) || "").trim();
      if (!reply) { void listen(); return; }
      say("assistant", reply);
      setState_("speaking");
      setLevel(LV.speaking);
      // The server names the voice for this reply (speak: "bn-IN") from its
      // script: someone who switched to Bengali is answered in Bengali.
      speak(reply, () => { if (r.alive) void listen(); }, res && typeof res.speak === "string" ? res.speak : "");
    } catch (err) {
      fail(userText(err, K.txt("desktop.voice.replyFailed", "Couldn't reach the conversation.")));
    }
  }

  /**
   * OUT LOUD, IN THE VOICE THEY PICKED, then back to listening.
   *
   * This used to be the window's own synthesiser only, and that is the OS's
   * voices: a Windows install with no Indian English voice said a Hinglish
   * reply in nothing at all, and it was handed "hinglish" as a locale, which
   * no synthesiser has. The reply is now read by the server (/v1/speak, the
   * read-aloud voice chosen in Settings, which speaks whatever language the
   * text is in) and played through Web Audio — the page's media-src admits no
   * blob: URLs, and Web Audio needs none. Only if that fails does the built-in
   * voice say it, with a real locale.
   */
  function speak(text, then, voice) {
    // Once, whichever of the end, an error or the ceiling comes first. The
    // ceiling used to fire on its own schedule too: a long first reply's
    // timer ended the NEXT reply mid-sentence and opened a second microphone
    // over the first.
    let timer = null, over = false, fellBack = false;
    const done = () => { if (over) return; over = true; clearTimeout(timer); stopTts(r); then(); };
    const ceiling = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(done, Math.min(K.num("desktop.voice.ttsMaxMs", 30000), ms));
    };
    const builtIn = () => {
      if (over || fellBack || !r.alive) return;
      fellBack = true;
      try {
        const synth = window.speechSynthesis;
        if (!synth) { done(); return; }
        synth.cancel();
        const u = new SpeechSynthesisUtterance(text);
        const lang = voice || r.speakLanguage || (/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(r.language) && r.language !== "auto" ? r.language : "");
        if (lang) u.lang = lang;
        u.onend = done;
        u.onerror = done;
        synth.speak(u);
        // Some engines drop an utterance silently. A ceiling proportional to
        // the reply keeps a dead synthesiser from ending the conversation.
        ceiling(K.num("desktop.voice.ttsBaseMs", 2000) + text.length * K.num("desktop.voice.ttsPerCharMs", 90));
      } catch { done(); }
    };
    if (!K.bool("desktop.voice.serverTts", true)) { builtIn(); return; }
    // The fetch and the decode get a ceiling of their own; past it, the
    // built-in voice says it rather than the room going quiet.
    timer = setTimeout(() => { if (!r.tts || !r.tts.src) { stopTts(r); builtIn(); } }, K.num("desktop.voice.serverTtsWaitMs", 8000));
    void (async () => {
      try {
        const tok = await bearer();
        const res = await fetch(ENV.baseUrl + "/v1/speak", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(tok ? { Authorization: "Bearer " + tok } : {}) },
          body: JSON.stringify({ text, format: "mp3" }),
        });
        if (!res.ok) throw new Error("speak " + res.status);
        const bytes = await res.arrayBuffer();
        if (over || fellBack || !r.alive) return;
        const ac = new AudioContext();
        r.tts = { ctx: ac, src: null };
        const buf = await ac.decodeAudioData(bytes);
        if (over || fellBack || !r.alive || !r.tts || r.tts.ctx !== ac) { try { ac.close(); } catch {} return; }
        const src = ac.createBufferSource();
        src.buffer = buf;
        src.connect(ac.destination);
        src.onended = done;
        r.tts.src = src;
        src.start();
        // The audio says how long it is; a second over that, it is over.
        ceiling(buf.duration * 1000 + 1000);
      } catch (err) {
        if (over || fellBack) return;
        console.warn("[voice] server voice unavailable, using the built-in one: " + ((err && err.message) || err));
        stopTts(r);
        clearTimeout(timer);
        builtIn();
      }
    })();
  }

  /**
   * THE WARM-UP HAPPENS BEHIND THE GREETING, NOT BEFORE IT.
   *
   * This used to open by listening, so asking for the microphone and opening
   * the socket happened in silence with the screen already up — and the first
   * thing the app said arrived only after the user had spoken into that
   * silence and waited out a round trip. That reads as broken, not as
   * thinking.
   *
   * The greeting arrives written, composed by the server from the name and
   * what has actually been learned, so it is said at once and the warm-up goes
   * underneath it. A window has no audio-session category to fight, so here
   * the microphone itself can be opened early: by the time the sentence ends
   * the stream is live and the handover is a state change rather than a wait.
   */
  if (r.greeting) {
    r.turns = [{ role: "assistant", text: r.greeting }];
    put(r.turnsPath, r.turns);
    put(r.linePath, r.greeting);
    setState_("speaking");
    setLevel(LV.speaking);
    // Not awaited. The point is that it opens WHILE the sentence is spoken.
    const warm = navigator.mediaDevices
      .getUserMedia({ audio: micConstraints() })
      .catch(() => null);
    speak(r.greeting, () => {
      if (!r.alive) { void warm.then((st) => st && st.getTracks().forEach((t) => t.stop())); return; }
      void listen(warm);
    });
  } else {
    void listen();
  }
}

/** Stop the server voice mid-sentence, if it is speaking. */
function stopTts(r) {
  const t = r && r.tts;
  if (!t) return;
  r.tts = null;
  try { t.src && (t.src.onended = null, t.src.stop()); } catch {}
  try { t.ctx && t.ctx.close(); } catch {}
}

/** Close the microphone and its socket, leaving the loop able to open another. */
function closeMic(r) {
  clearInterval(r.decay); r.decay = null;
  clearTimeout(r.silence); r.silence = null;
  try { r.proc && (r.proc.onaudioprocess = null, r.proc.disconnect()); } catch {}
  try { r.src && r.src.disconnect(); } catch {}
  try { r.ctx && r.ctx.close(); } catch {}
  r.proc = r.src = r.ctx = null;
  if (r.ws) { r.ws.onmessage = r.ws.onclose = r.ws.onerror = null; try { r.ws.close(); } catch {} r.ws = null; }
  if (r.stream) { r.stream.getTracks().forEach((t) => t.stop()); r.stream = null; }
}

/** End the conversation for good. Called when the screen goes away — a loop
 *  that outlives its screen keeps a live microphone open behind a window the
 *  user believes they have left. */
function stopSession() {
  if (!SESSION_RUN) return;
  SESSION_RUN.alive = false;
  closeMic(SESSION_RUN);
  stopTts(SESSION_RUN);
  try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch {}
  SESSION_RUN = null;
}

/** Float samples at the device rate → 16 kHz signed 16-bit, which is what the
 *  transcribe socket expects. Linear interpolation; the same routine the tray
 *  recorder uses, so both paths sound identical to the server. */
function pcm16k(f32, inRate) {
  const ratio = inRate / 16000;
  const outLen = Math.floor(f32.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const idx = i * ratio, i0 = Math.floor(idx), i1 = Math.min(i0 + 1, f32.length - 1);
    const frac = idx - i0;
    let v = f32[i0] * (1 - frac) + f32[i1] * frac;
    v = Math.max(-1, Math.min(1, v));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out.buffer;
}

// ---------------------------------------------------------------------------
// Paying
// ---------------------------------------------------------------------------

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

// THE DATA TABS STAY FRESH, as they do on the phone. A dictation happens in
// another app (the pill pastes there), so by the time the window is in front
// again its numbers are stale. Today and Insights (and Words/Voices) re-fetch
// when you return to the window or switch to them, and again a moment after a
// dictation lands — never over a live capture, and throttled by refreshMs so
// alt-tabbing is not a request storm. Train (a live canvas) and Notes (often
// mid-edit) keep their own refresh and are left alone.
const LIVE_TABS = new Set(["desk_today", "desk_insights", "desk_words", "desk_voices", "desk_tasks"]);
function onLiveTab() {
  const top = STACK[STACK.length - 1];
  return DESK && !!top && STACK.length === 1 && LIVE_TABS.has(top.screenId);
}
let lastLiveRefresh = 0;
function refreshLiveTab() {
  if (!SESSION || MIC || document.hidden || !onLiveTab()) return;
  const now = Date.now();
  if (now - lastLiveRefresh < Math.max(800, K.num("desktop.desk.refreshMs", 1500))) return;
  lastLiveRefresh = now;
  void paint(true);
}
window.addEventListener("focus", refreshLiveTab);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshLiveTab(); });

// BACK FROM SYSTEM SETTINGS. The Ask setup card's Allow sends the person to a
// Mac settings page, and coming back to this window is when the answer may
// have changed. The main process pushes on focus too; asking here as well
// costs one local call and keeps the row honest if a push is missed.
window.addEventListener("focus", () => {
  if (ASK_LISTENING && CURRENT_SCREEN && findNode(CURRENT_SCREEN.root, "DeskAskSetup")) askSetupRead();
});

// ---------------------------------------------------------------------------
// The onboarding stage
// ---------------------------------------------------------------------------

/**
 * ONE FRIEND BESIDE YOU THROUGH THE WHOLE ONBOARDING.
 *
 * Blip is not a node in any screen. Drawn inside one, he would be torn down
 * and drawn again at the two moments that matter most: when the gate gives way
 * to the app after the code, and between any two screens. So he is one canvas
 * (#blipStage), drawn by blip.js, for the life of the window, and a step only
 * says where he should stand: a BlipSpot, an empty box with a pose and a few
 * words. The stage (OnboardStage) holds the steps, shows the one it is on and
 * glides the next in; the bar, the bubble and the walker stay where they are.
 *
 * TWO STAGES, because signing in comes before there is an account: Welcome,
 * Sign in and Code are the server's auth tree, drawn by paintGate() into the
 * gate; everything after is the screen `onboard`, drawn by repaint() into the
 * view. In between, the gate goes and the screen is fetched, and Blip HOLDS:
 * the paper, the bar and he himself stay, standing where he last stood, until
 * the next stage mounts and he walks to its spot. html[data-onboard] is that
 * hold. He is let go (faded out) only when a screen that is not a stage is
 * painted.
 */
const OB_STEP = {};       // the furthest step each stage has reached, by id
let IN_STAGE = 0;         // above zero while a stage's step is being drawn
const OBS = {
  walker: null,
  look: null,             // the stage's look (ground, bar, bubble, Blip's colours, glide)
  key: "",                // where Blip was last sent: stage, step and spot
  lastId: "",             // the last stage drawn, so the next one glides in
  watch: null,            // the ResizeObserver on the step on show
  landT: 0, burstT: 0, hideT: 0, scrollRaf: 0,
};
const GLIDE_EASE = "cubic-bezier(.32,.72,0,1)";

/**
 * A STAGE: only the step it is on is drawn, inside a box that scrolls on its
 * own (a short window must not cut a step off), with the stage's look riding
 * along as data for the bar and Blip to read.
 *
 * THE STEP IS NEVER LOST ON A REFETCH. A screen fetched again (an app was
 * connected, or someone went to pick more languages and came back) starts its
 * state over, and the step with it. The furthest step a stage has reached is
 * kept by id, and a rebuilt state is raised to it. Going back is not a thing a
 * stage does; the flow is a line, and each step knows its way to the next.
 *
 * The sign-in flow can pick the step as well: while it is in a phase named in
 * `phaseStep` (the code was sent), that step shows, whatever the stage was on.
 * That phase is not remembered: "Change it" returns the flow to the entry and
 * the step with it.
 */
function stageNode(n) {
  const p = n.props || {}, kids = n.children || [];
  if (!kids.length) return "";
  const id = String(p.id || "stage");
  const at = (i) => Math.max(0, Math.min(kids.length - 1, Math.floor(Number(i)) || 0));
  OB_STEP[id] = Math.max(at(OB_STEP[id]), at(stateAt((n.bind && n.bind.step) || "step")));
  const phased = p.phaseStep && typeof p.phaseStep === "object" ? p.phaseStep[AUTH.phase] : undefined;
  const step = Number.isInteger(phased) ? at(phased) : OB_STEP[id];
  const kid = kids[step];
  let inner;
  IN_STAGE++;
  try { inner = node(kid); } finally { IN_STAGE--; }
  const look = { ground: p.ground, progress: p.progress, bubble: p.bubble, blip: p.blip, glide: p.glide };
  return '<div class="ob-stage" data-stage="' + esc(id) + '" data-step="' + step +
    '" data-first="' + (Math.floor(Number(p.first)) || 0) + '" data-of="' + (Math.floor(Number(p.of)) || kids.length) +
    '" data-step-id="' + esc((kid && kid.props && kid.props.stepId) || "") + '" data-look="' + esc(JSON.stringify(look)) + '">' +
    '<div class="ob-step"><div class="ob-content">' + inner + "</div></div></div>";
}

/** A pressable box in the onboarding is a button to the keyboard as well. */
function rolePress(press) {
  return press && IN_STAGE ? ' role="button" tabindex="0"' : "";
}

/**
 * WHERE BLIP STANDS. The box is as big as his figure (a little wider than it
 * is tall, with room for the bubble to start beside it), so the step lays
 * itself out around where he will be; the walker finds the box and goes to its
 * foot. What he says and how he looks while he says it ride along as data.
 */
function blipSpotNode(p, s) {
  const h = Math.max(24, Math.min(400, Number(p.h) || 100));
  const said = label(p.say);
  const spot = {
    pose: /^[a-z]{2,10}$/.test(String(p.pose)) ? String(p.pose) : "present",
    h, say: said == null ? "" : String(said),
    bubble: p.bubble === "corner" ? "corner" : "side",
    burst: p.burst === true,
  };
  return '<span class="bs" aria-hidden="true" data-blip="' + esc(JSON.stringify(spot)) + '" style="width:' +
    Math.ceil(h * 1.4) + "px;height:" + Math.ceil(h * 1.16 + 4) + "px;" + s + '"></span>';
}

/** The last of several spots on show. A step shows one at a time (the server sees to it); if two ever do, the last in the document is the one he goes to. */
function lastSpot(spots) {
  return spots && spots.length ? spots[spots.length - 1] : null;
}

// What the server sends for the look is data into style attributes and a
// canvas, so each value is checked on the way in and falls back to the
// design's own.
const OB_COLOR = /^(#[0-9a-f]{3,8}|rgba?\([0-9., %]+\)|transparent)$/i;
const okColor = (v, fb) => (typeof v === "string" && OB_COLOR.test(v.trim()) ? v.trim() : fb);
const okFont = (v, fb) => (typeof v === "string" && /^[A-Za-z0-9 _-]{1,40}$/.test(v) ? v : fb);
const okNum = (v, fb, lo, hi) => { const x = Number(v); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : fb; };

function stageLook(el) {
  let raw = {};
  try { raw = JSON.parse(el.getAttribute("data-look") || "{}") || {}; } catch { raw = {}; }
  const pg = raw.progress || {}, bb = raw.bubble || {}, bl = raw.blip || {}, gl = raw.glide || {};
  return {
    ground: okColor(raw.ground, "#EFEDE8"),
    progress: { on: okColor(pg.on, "#1C1A17"), off: okColor(pg.off, "rgba(28,26,23,0.13)"), height: okNum(pg.height, 4, 1, 12), gap: okNum(pg.gap, 4, 0, 16) },
    bubble: {
      background: okColor(bb.background, "#FCFBF8"), border: okColor(bb.border, "#1C1A17"), ink: okColor(bb.ink, "#1C1A17"),
      font: okFont(bb.font, "Tailzu Hand"), size: okNum(bb.size, 19, 10, 40), bigSize: okNum(bb.bigSize, 22, 10, 48),
    },
    blip: { dot: okColor(bl.dot, "#F3E2C6"), sticker: okColor(bl.sticker, "#151311"), glow: okColor(bl.glow, "#39FF14") },
    glide: { slide: okNum(gl.slide, 26, 0, 80), outMs: okNum(gl.outMs, 230, 0, 1000), inMs: okNum(gl.inMs, 320, 0, 1500), inDelayMs: okNum(gl.inDelayMs, 60, 0, 500) },
  };
}

function glideOut(el, dir, slide, ms, done) {
  if (typeof el.animate !== "function") { done(el); return; }
  const cs = getComputedStyle(el), from = { opacity: cs.opacity, transform: cs.transform };
  el.getAnimations().forEach((a) => a.cancel());
  el.inert = true;
  const a = el.animate([from, { opacity: 0, transform: "translate3d(" + (-dir * slide) + "px,0,0)" }], { duration: ms, easing: GLIDE_EASE, fill: "forwards" });
  a.onfinish = () => { done(el); a.cancel(); };
}

function glideIn(el, dir, slide, ms, delay) {
  if (typeof el.animate !== "function") return;
  el.animate([{ opacity: 0, transform: "translate3d(" + (dir * slide) + "px,0,0)" }, { opacity: 1, transform: "translate3d(0,0,0)" }],
    { duration: ms, delay, easing: GLIDE_EASE, fill: "backwards" });
}

/** The stage that is up, in the gate before there is an account and in the view after. */
function activeStage() {
  const gate = $("gate");
  const host = gate && !gate.hidden ? $("gateForm") : $("view");
  return host ? host.querySelector(".ob-stage") : null;
}

/** Is the gate showing the sign-in stage? Its state changes (the step) are for it. */
function gateUp() {
  const gate = $("gate");
  return !!(gate && !gate.hidden && AUTH_TREE && AUTH_TREE.type === "OnboardStage");
}

/** Is a stage the screen on show? */
function stageUp() {
  return !!(CURRENT_SCREEN && CURRENT_SCREEN.root && CURRENT_SCREEN.root.type === "OnboardStage");
}

/**
 * WHAT IS UP NOW, taken before a paint replaces it: which stage, which step,
 * and the step itself, to be put back and glided away if the step changes.
 * The scroll is kept too: a repaint is a new document, and one that starts at
 * the top would throw a long step back up the moment a chip was tapped.
 */
function stageBefore(host) {
  const el = host && host.querySelector ? host.querySelector(".ob-stage") : null;
  const live = el ? el.querySelector(".ob-step:not([data-out])") : null;
  if (!el || !live) return null;
  return { id: el.getAttribute("data-stage"), step: Number(el.getAttribute("data-step")) || 0, el: live, scroll: live.scrollTop };
}

/**
 * AFTER A PAINT: gives back whether a stage is up. If it is, the page takes on
 * its ground, the bar fills to the step, the step glides in (and the one
 * before glides out) when it changed, and Blip goes to the spot.
 */
function stageAfter(host, before) {
  const el = host.querySelector ? host.querySelector(".ob-stage") : null;
  if (!el) return false;
  const look = stageLook(el);
  OBS.look = look;
  const id = el.getAttribute("data-stage"), step = Number(el.getAttribute("data-step")) || 0;
  const root = document.documentElement;
  root.dataset.onboard = "1";
  root.style.setProperty("--ob-ground", look.ground);
  stageSwap(el, before, look);
  OBS.lastId = id;
  stageBar(look, (Math.floor(Number(el.getAttribute("data-first"))) || 0) + step, Math.floor(Number(el.getAttribute("data-of"))) || 1);
  try {
    if (document.fonts && document.fonts.load) {
      document.fonts.load('800 26px "Tailzu Grotesk"').catch(() => {});
      document.fonts.load('400 19px "Tailzu Hand"').catch(() => {});
    }
  } catch { /* the faces arrive when the text asks for them */ }
  stageWatch(el);
  stageFollow();
  return true;
}

/**
 * THE GLIDE. Only a change of step glides: the one that was up is put back,
 * inert, over the new one and slides out as the new one slides in, both on
 * one curve, about 380 ms from the first move to the last. A repaint inside a
 * step (a chip lit, the mic held) is instant, as the rest of this window's
 * repaints are: the document is rebuilt on every state change, and an
 * animation on each would be a flicker on each. A stage that has just taken
 * over from another (the app after the code) brings its first step in from the
 * right, and a repaint of the same step keeps the scroll it had.
 */
function stageSwap(el, before, look) {
  const id = el.getAttribute("data-stage"), step = Number(el.getAttribute("data-step")) || 0;
  const live = el.querySelector(".ob-step");
  // Held still, nothing slides and the two just fade, a little slower.
  const gl = prefers("(prefers-reduced-motion: reduce)") ? { slide: 0, outMs: 260, inMs: 260, inDelayMs: 0 } : look.glide;
  if (before && before.id === id && before.step !== step) {
    const dir = step > before.step ? 1 : -1;
    const out = before.el;
    out.setAttribute("data-out", "1");
    out.setAttribute("aria-hidden", "true");
    out.inert = true;
    el.appendChild(out);
    out.scrollTop = before.scroll;
    glideOut(out, dir, gl.slide, gl.outMs, (e) => e.remove());
    glideIn(live, dir, gl.slide, gl.inMs, gl.inDelayMs);
  } else if (!before && OBS.lastId && OBS.lastId !== id) {
    glideIn(live, 1, gl.slide, gl.inMs, gl.inDelayMs);
  } else if (before && before.id === id && live) {
    live.scrollTop = before.scroll;
  }
}

/** The bar: one segment a step, filled up to the one you are on. */
function stageBar(look, upto, of) {
  const bar = $("blipProg");
  if (!bar) return;
  const count = Math.max(1, Math.min(40, of));
  if (bar.children.length !== count) bar.innerHTML = "<i></i>".repeat(count);
  const pg = look.progress;
  bar.style.setProperty("--pg-on", pg.on);
  bar.style.setProperty("--pg-off", pg.off);
  bar.style.setProperty("--pg-h", pg.height + "px");
  bar.style.setProperty("--pg-gap", pg.gap + "px");
  for (let i = 0; i < bar.children.length; i++) bar.children[i].classList.toggle("on", i <= upto);
  bar.classList.add("on");
}

/** The step's box scrolling, or its content changing size (a font arriving, a line wrapping), moves where he should stand. */
function stageWatch(el) {
  const live = el.querySelector(".ob-step:not([data-out])");
  if (!live) return;
  live.addEventListener("scroll", () => {
    if (OBS.scrollRaf) return;
    OBS.scrollRaf = requestAnimationFrame(() => { OBS.scrollRaf = 0; stageFollow(); });
  });
  try {
    if (typeof ResizeObserver === "function") {
      if (!OBS.watch) OBS.watch = new ResizeObserver(() => stageFollow());
      OBS.watch.disconnect();
      const c = live.querySelector(".ob-content");
      if (c) OBS.watch.observe(c);
    }
  } catch { /* a window that cannot watch still follows on resize */ }
}

const dprNow = () => Math.min(2, window.devicePixelRatio || 1);

function ensureWalker() {
  if (OBS.walker) return OBS.walker;
  const cv = $("blipStage"), T = window.TailzuBlip;
  if (!cv || !T || typeof T.createWalker !== "function" || !OBS.look) return null;
  const b = OBS.look.blip;
  OBS.walker = T.createWalker(cv, {
    dpr: dprNow(), reduced: prefers("(prefers-reduced-motion: reduce)"),
    raf: (f) => requestAnimationFrame(f), caf: (id) => cancelAnimationFrame(id),
    dot: b.dot, sticker: b.sticker, glow: b.glow, paper: OBS.look.bubble.background,
  });
  OBS.walker.size(window.innerWidth, window.innerHeight, dprNow());
  try {
    window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", (e) => { if (OBS.walker) OBS.walker.reduced(e.matches); });
  } catch { /* an old engine keeps what it started with */ }
  return OBS.walker;
}

/**
 * WHERE THE SPOT IS, in the window: its feet and its bubble's corner, worked
 * out from the offsets up to the step's content (which the glide's transform
 * does not move), plus the stage's own place, less the step's scroll. So he
 * stands where the step will rest, not where a glide has it for the moment,
 * and he rides along when a short window scrolls the step.
 */
function spotAt(stageEl, stepEl, b) {
  const content = stepEl.querySelector(".ob-content");
  const rel = (e0) => {
    let x = 0, y = 0;
    for (let e = e0; e && e !== content; e = e.offsetParent) { x += e.offsetLeft; y += e.offsetTop; }
    return { x, y };
  };
  let d = {};
  try { d = JSON.parse(b.getAttribute("data-blip") || "{}") || {}; } catch { d = {}; }
  const h = okNum(d.h, 100, 24, 400), o = rel(b), r = stageEl.getBoundingClientRect();
  const ox = r.left + content.offsetLeft, oy = r.top + content.offsetTop - stepEl.scrollTop;
  let bx, by;
  if (d.bubble === "corner" && b.parentElement) {
    // Welcome's and Done's: the bubble hangs from the top right of Blip's row.
    const c = b.parentElement, q = rel(c);
    bx = q.x + c.offsetWidth - 10; by = q.y + 6;
  } else {
    bx = o.x + b.offsetWidth - Math.round(h * .16); by = o.y + Math.round(h * .1);
  }
  return {
    x: ox + o.x + b.offsetWidth / 2, y: oy + o.y + b.offsetHeight - 2, h,
    pose: /^[a-z]{2,10}$/.test(String(d.pose)) ? d.pose : "present", say: typeof d.say === "string" ? d.say : "",
    mode: d.bubble === "corner" ? "corner" : "side", burst: d.burst === true, bx: ox + bx, by: oy + by,
  };
}

/** His words: placed beside him in the stage's own look. False when he has none to say. */
function sayPlace(sp) {
  const b = $("blipSay");
  if (!b || !OBS.look) return false;
  if (!sp.say) { b.classList.remove("on"); return false; }
  const bb = OBS.look.bubble, st = b.style;
  b.firstElementChild.textContent = sp.say;
  st.setProperty("--bs-bg", bb.background); st.setProperty("--bs-bd", bb.border);
  st.background = bb.background; st.borderColor = bb.border; st.color = bb.ink;
  st.fontFamily = '"' + bb.font + '",var(--f-deva),"Comic Sans MS",cursive';
  st.fontSize = (sp.mode === "corner" ? bb.bigSize : bb.size) + "px";
  st.top = Math.round(sp.by) + "px";
  if (sp.mode === "side") { st.left = Math.round(sp.bx) + "px"; st.right = "auto"; }
  else { st.right = Math.round(document.documentElement.clientWidth - sp.bx) + "px"; st.left = "auto"; }
  return true;
}

function sayHide() {
  const b = $("blipSay");
  if (b) b.classList.remove("on");
}

/** He has got there (or was there already): his words come up, and at the end the confetti goes. */
function stageLand(sp, key, kind) {
  if (OBS.key !== key) return;                    // he has been sent elsewhere since
  const b = $("blipSay");
  if (b && sayPlace(sp)) {
    const was = b.classList.contains("on");
    b.classList.add("on");
    // Same place, new words: the bubble says them again with a small start.
    if (kind === "pose" && was && !prefers("(prefers-reduced-motion: reduce)") && typeof b.animate === "function") {
      b.animate([{ transform: "rotate(-1.5deg) scale(.93)" }, { transform: "rotate(-1.5deg) scale(1)" }], { duration: 220, easing: GLIDE_EASE });
    }
  }
  clearTimeout(OBS.burstT);
  if (sp.burst) {
    OBS.burstT = setTimeout(() => {
      if (OBS.key !== key || !window.TailzuBlip) return;
      window.TailzuBlip.burst(document.body, sp.x, sp.y - sp.h * .75, { reduced: prefers("(prefers-reduced-motion: reduce)") });
    }, 250);
  }
}

/**
 * SEND BLIP TO THE SPOT THE STEP ON SHOW HAS, or keep him on it: called after
 * every paint, and again when the window is resized, the step is scrolled or
 * its content changes size. The same spot as last time is only a measure
 * (he is moved, with no walk); a new one is a journey, a re-pose or, when he
 * is not anywhere yet (the first, or the first after he was let go), a
 * simple arrival with a fade.
 */
function stageFollow() {
  const el = activeStage();
  if (!el || !OBS.look) return;
  const live = el.querySelector(".ob-step:not([data-out])");
  if (!live) return;
  const b = lastSpot(Array.prototype.slice.call(live.querySelectorAll(".bs")));
  if (!b) { sayHide(); return; }
  const w = ensureWalker();
  if (!w) return;
  const sp = spotAt(el, live, b);
  const key = el.getAttribute("data-stage") + ":" + el.getAttribute("data-step") + ":" + b.getAttribute("data-blip");
  if (OBS.key === key) {
    w.retarget(sp.x, sp.y, sp.h);
    const bubble = $("blipSay");
    if (bubble && bubble.classList.contains("on")) sayPlace(sp);
    return;
  }
  OBS.key = key;
  clearTimeout(OBS.hideT); clearTimeout(OBS.burstT);
  const cv = $("blipStage");
  if (cv) cv.classList.add("on");
  const how = w.go(sp.x, sp.y, sp.h, sp.pose, (kind) => stageLand(sp, key, kind));
  // On his way his words are down; they come up when he lands.
  if (how === "travel") sayHide();
}

window.addEventListener("resize", () => {
  if (OBS.walker) OBS.walker.size(window.innerWidth, window.innerHeight, dprNow());
  stageFollow();
});
try { document.fonts.addEventListener("loadingdone", () => stageFollow()); } catch { /* no font events here */ }

/**
 * LET HIM GO: a screen that is not a stage is up. The paper gives way, the bar
 * and the words fade, and he fades with them (the walker is told to stop
 * drawing once that has finished).
 */
function leaveOnboard() {
  const root = document.documentElement;
  if (root.dataset.onboard !== "1") return;
  delete root.dataset.onboard;
  root.style.removeProperty("--ob-ground");
  OBS.key = ""; OBS.lastId = ""; OBS.look = null;
  clearTimeout(OBS.burstT);
  const cv = $("blipStage"), bar = $("blipProg");
  if (cv) cv.classList.remove("on");
  if (bar) bar.classList.remove("on");
  sayHide();
  if (OBS.walker) {
    clearTimeout(OBS.hideT);
    OBS.hideT = setTimeout(() => { if (OBS.walker) OBS.walker.hide(); }, 240);
  }
}

// ---------------------------------------------------------------------------
// The sign-in screen
// ---------------------------------------------------------------------------

/**
 * THE GATE IS A SCREEN LIKE THE OTHERS NOW.
 *
 * It was the last one in this window that was not: its own markup in app.html,
 * its own tabs and its own big amber button, while the phones drew theirs from
 * `auth.screen` — the pills you swipe, the two round social buttons, the code
 * pill, the staggered rise. The first screen of the product was the one screen
 * that looked like a different product, and the only one whose wording and
 * arrangement still needed an installer.
 *
 * The same tree renders here. What differs is what a mouse can do: there is no
 * thumb to rest on a badge, so the pill commits on a click of its disc or on
 * Enter — the same rule SwipeAction already follows on the training tab. The
 * gesture was never the point; the deliberateness was.
 *
 * The auth LOGIC stays where it was, in the handlers below. These components
 * read this object and call into it; they do not know how to sign anybody in.
 */
const AUTH = {
  phase: "entry",         // entry | sending | verify | verifying
  method: "email",        // which pill was committed
  email: "",
  dial: "+1",
  phone: "",
  sentTo: "",
  code: "",
  codeLength: 6,
  codeError: false,
  /** Sending the code again is in flight / failed (the onboarding's code step says so). */
  resending: false,
  sendFailed: false,
  /** The dial code the server last asked a number to start with, so an edit to it is not undone. */
  dialFrom: "",
  error: "",
  /** Which pill is open for typing. Only one at a time: opening the second
   *  should close the first, or the screen has two carets in it. */
  open: "",
};

/** A row that flies in. The phones spring it; a window has no spring, so this
 *  is the same delay, the same travel and the same overshoot, in CSS. */
function riseNode(n, p, s, kids) {
  const delay = Number(p.delayMs) || 0;
  const from = Number(p.fromY) || 0;
  const scale = Number(p.scaleFrom) || 1;
  return '<div class="tz-rise" style="' + s +
    ";--rise-y:" + from + "px;--rise-s:" + scale +
    ";animation-delay:" + delay + 'ms">' + kids + "</div>";
}

/** The sign-in pills' defaults, under whatever the auth tree's props say —
 *  shared by the method pills, the code pill and the code pill's live border. */
function pillDefaults() {
  return K.obj("desktop.pill", {
    height: 56, fontSize: 15, background: "rgba(255,255,255,0.06)", border: "rgba(255,255,255,0.10)",
    text: "rgba(255,255,255,0.96)", badge: "rgba(255,255,255,0.10)", badgeBorder: "rgba(255,255,255,0.18)",
    target: "#F3E2C6", targetIcon: "#000000", codeFontSize: 17, codeSpacing: 8,
  });
}

/** One sign-in method. The pill IS the field: click it and the caret lands
 *  inside, type, then the disc at the right end commits. */
function swipePill(p, s) {
  const method = p.method === "phone" ? "phone" : "email";
  if (method === "phone" && !AUTH.phoneOn) return "";
  // The onboarding's: a field and a button, nothing to swipe.
  if (p.variant === "field") return fieldPill(method, p, s);
  const D = pillDefaults();
  const h = Number(p.height) || D.height;
  const open = AUTH.open === method;
  const value = method === "phone" ? AUTH.phone : AUTH.email;
  const ready = method === "phone" ? /^\+?\d{7,15}$/.test((AUTH.dial + value).replace(/[^\d+]/g, ""))
                                   : /.+@.+\..+/.test(value.trim());
  const badge = h - 10;
  const label = String((method === "phone" ? p.phoneLabel : p.emailLabel) ||
    (method === "phone" ? K.txt("desktop.gate.phoneLabel", "Phone number") : K.txt("desktop.gate.emailLabel", "Email address")));
  // The disc: at the left as a badge while the pill is closed; at the right
  // end the moment the pill opens — dim until there is something to send,
  // then the brand's amber with an arrow. It used to stay on the left until
  // the address was complete, which put it over the first letters of what
  // was being typed, and on the phone pill over the dial.
  // In flight: the row still draws, because the tree shows the same children
  // for "entry" and "sending" — but a second click would send a second code.
  const busy = AUTH.phase !== "entry";
  const disc = '<span class="tz-disc' + (busy ? " tz-busy" : "") + '" data-commit="' + method + '"' +
    ' role="button" tabindex="0" aria-label="' + esc(K.txt("desktop.gate.continue", "Continue")) + '"' +
    (busy ? ' aria-disabled="true"' : "") +
    ' style="width:' + badge + "px;height:" + badge + "px;" +
    (ready
      ? "right:5px;background:" + esc(tok(p.targetBackground || D.target)) +
        ";border-color:transparent;cursor:pointer"
      : (open ? "right:5px;" : "left:5px;") + "background:" + esc(tok(p.badgeBackground || D.badge)) +
        ";border-color:" + esc(tok(p.badgeBorderColor || D.badgeBorder))) + '">' +
    (ready
      ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="' +
        esc(tok(p.targetIconColor || D.targetIcon)) +
        '" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M5 12h13M12 5l7 7-7 7"/></svg>'
      : methodGlyph(method)) + "</span>";
  const dial = method === "phone" && open
    ? '<input class="tz-dial" data-dial="1" value="' + esc(AUTH.dial) + '" maxlength="5"' +
      ' inputmode="tel" aria-label="' + esc(K.txt("desktop.gate.countryCode", "Country code")) + '">'
    : "";
  return '<div class="tz-pill" style="' + s + ";height:" + h + "px;border-radius:" +
    (Number(p.radius) || h / 2) + "px;background:" + esc(tok(p.background || D.background)) +
    ";border:1px solid " + esc(tok(p.borderColor || D.border)) + '">' +
    disc + dial +
    '<input class="tz-pillin" data-pill="' + method + '"' +
    // TEXT, not email. Chromium refuses setSelectionRange on an email input,
    // and the caret has to be restored by hand after every repaint — so the
    // stricter type costs the field its cursor. inputmode still summons the
    // right keyboard and autocomplete still offers the right address.
    ' type="' + (method === "phone" ? "tel" : "text") + '"' +
    ' inputmode="' + (method === "phone" ? "tel" : "email") + '"' +
    ' placeholder="' + esc(label) + '" aria-label="' + esc(label) + '"' +
    ' autocomplete="' + (method === "phone" ? "tel" : "email") + '"' +
    ' spellcheck="false" value="' + esc(value) + '"' +
    ' style="padding-left:' + (open ? (method === "phone" ? 96 : 20) : h + 6) + "px" +
    ";padding-right:" + (open ? h + 6 : 18) + "px" +
    ";font-size:" + (Number(p.fontSize) || D.fontSize) + "px" +
    ";color:" + esc(tok(p.textColor || D.text)) + '"></div>';
}

function methodGlyph(method) {
  return method === "phone"
    ? '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.7)" stroke-width="1.8" stroke-linecap="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>'
    : '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.7)" stroke-width="1.8" stroke-linecap="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 6 10-6"/></svg>';
}

/** The code step: one pill, the digits spaced out, dots for what is missing. */
function codeEntry(p, s) {
  if (p.variant === "boxes") return codeBoxes(p, s);
  const D = pillDefaults();
  const h = Number(p.height) || D.height;
  const len = AUTH.codeLength;
  const shown = AUTH.code.padEnd(len, "·").split("").join(" ");
  const done = AUTH.code.length === len;
  return '<div class="tz-pill' + (AUTH.codeError ? " tz-shake" : "") + '" data-codebox="1" style="' + s +
    ";height:" + h + "px;border-radius:" + (h / 2) + "px;cursor:text" +
    ";background:" + esc(D.background) + ";border:1px solid " +
    (AUTH.codeError ? "var(--danger)" : done ? esc(tok(D.target)) : esc(D.border)) + '">' +
    // A real input, held invisible over the pill: the browser's own autofill
    // for a one-time code only offers itself to a field it can see.
    '<input data-code="1" inputmode="numeric" autocomplete="one-time-code"' +
    ' maxlength="' + len + '" value="' + esc(AUTH.code) + '" aria-label="' +
    esc(K.txt("desktop.gate.codeLabel", "Enter the code we sent you")) + '"' +
    ' style="position:absolute;inset:0;width:100%;height:100%;opacity:0;border:0;background:none">' +
    '<span style="width:100%;text-align:center;pointer-events:none;font-variant-numeric:tabular-nums' +
    ";letter-spacing:" + (Number(p.letterSpacing) || D.codeSpacing) + "px" +
    ";font-size:" + (Number(p.fontSize) || D.codeFontSize) + "px" +
    ";color:" + esc(D.text) + '">' + esc(shown) + "</span></div>";
}

/** Apple and Google, as the round icon buttons the phones draw — not the wide
 *  labelled rows this window used to have. */
function socialButton(provider, p, s) {
  // With words of its own it is the onboarding's wide button, not the round one.
  if (p.label) return wideSocial(provider, p, s);
  const size = Number(p.size) || K.num("desktop.gate.socialSize", 52);
  const mark = socialMark(provider, Math.round(size * (provider === "apple" ? 0.42 : 0.40)), "#fff");
  return '<button class="tz-social tz-press" data-oauth="' + provider + '"' +
    ' aria-label="' + esc(K.txt("desktop.gate.continueWith", "Continue with {provider}",
      { provider: provider === "apple" ? "Apple" : "Google" })) + '"' +
    ' style="' + s + ";width:" + size + "px;height:" + size + 'px">' + mark + "</button>";
}

// What the server writes into a style attribute of the onboarding's sign-in is
// a colour, a number or a short value; anything with a quote, a brace or a
// semicolon in it is not one, and falls back to the design's own.
const cssv = (v, fb) => (typeof v === "string" && /^[#a-zA-Z0-9(),.%\s-]{1,80}$/.test(v) ? v : fb);
const CHECK_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const CLOCK_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 12a8.5 8.5 0 1 0 17 0a8.5 8.5 0 1 0-17 0zM12 7.5V12l3 2"/></svg>';

/**
 * THE ONBOARDING'S SIGN-IN FIELD: a plain input and, under it, a button that
 * says what it does and lights up when the address (or the number) is good.
 *
 * Nothing to swipe and no disc to find. The pill is a gesture for a thumb; a
 * window has a keyboard, and "type it, then press the button that says what
 * happens" is how everyone signs in on one. The flow behind it is the same:
 * the button and Enter both go through commit(), the one door a code is sent
 * from, so the review address, the retries and the errors are all unchanged.
 */
function fieldPill(method, p, s) {
  const phone = method === "phone";
  // A number starts in the country the server names, once: a repaint must not
  // undo the person's own edit to it.
  if (phone && p.dial && AUTH.dialFrom !== String(p.dial)) { AUTH.dialFrom = String(p.dial); AUTH.dial = String(p.dial); }
  const value = phone ? AUTH.phone : AUTH.email;
  const ready = phone ? /^\+?\d{7,15}$/.test((AUTH.dial + value).replace(/[^\d+]/g, "")) : /.+@.+\..+/.test(value.trim());
  const busy = AUTH.phase !== "entry";
  const ask = label(p.placeholder) || (phone ? K.txt("desktop.gate.phoneLabel", "Phone number") : K.txt("desktop.gate.emailLabel", "Email address"));
  const go = label(p.submitLabel) || K.txt("desktop.gate.continue", "Continue");
  const vars = [
    "--f-h:" + okNum(p.height, 48, 32, 72) + "px", "--f-r:" + okNum(p.radius, 16, 0, 36) + "px", "--f-fs:" + okNum(p.fontSize, 17, 11, 28) + "px",
    "--f-bg:" + cssv(tok(p.background), "#FFFFFF"), "--f-bd:" + cssv(tok(p.borderColor), "#1C1A17"),
    "--f-tx:" + cssv(tok(p.textColor), "#1C1A17"), "--f-ph:" + cssv(tok(p.placeholderColor), "rgba(28,26,23,0.56)"),
    "--f-bbg:" + cssv(tok(p.buttonBackground), "#1C1A17"), "--f-btx:" + cssv(tok(p.buttonTextColor), "#FCFBF8"),
    "--f-bh:" + okNum(p.buttonHeight, 48, 32, 72) + "px", "--f-br:" + okNum(p.buttonRadius, 16, 0, 36) + "px",
    "--f-cbg:" + cssv(tok(p.countryBackground), "#FCFBF8"), "--f-cbd:" + cssv(tok(p.countryBorderColor), "rgba(28,26,23,0.13)"),
  ].join(";");
  const input = '<input class="ob-in" data-pill="' + method + '" data-field="1"' +
    // TEXT, not email, for the reason swipePill gives: the caret.
    ' type="' + (phone ? "tel" : "text") + '" inputmode="' + (phone ? "tel" : "email") + '"' +
    ' placeholder="' + esc(ask) + '" aria-label="' + esc(ask) + '" autocomplete="' + (phone ? "tel-national" : "email") + '"' +
    ' spellcheck="false" value="' + esc(value) + '">';
  const dial = '<input class="ob-dial" data-dial="1" value="' + esc(AUTH.dial) + '" maxlength="5" inputmode="tel" aria-label="' +
    esc(K.txt("desktop.gate.countryCode", "Country code")) + '">';
  return '<div class="ob-field" style="' + s + ";" + vars + '">' +
    (phone ? '<div class="ob-inrow">' + dial + input + "</div>" : input) +
    '<button type="button" class="ob-go" data-commit="' + method + '" data-field="1" data-ready="' + ready + '"' +
    (ready && !busy ? "" : " disabled") + (busy ? ' aria-busy="true"' : "") + ">" + esc(go) + "</button></div>";
}

/**
 * THE CODE, IN BOXES: one for each digit, the one to fill next lit, and under
 * them what is happening, a way to ask again and a way out to correct the
 * address. A real input is held invisibly over the boxes, so the browser can
 * offer a one-time code to it (autocomplete) and paste lands whole.
 *
 * Typing is drawn in place (liveCode), never by repainting: a repaint swaps
 * the input under the caret. Everything else repaints with the flow.
 */
function codeBoxes(p, s) {
  const len = AUTH.codeLength, code = AUTH.code;
  const done = code.length >= len || AUTH.phase === "verifying";
  const phone = AUTH.method === "phone";
  const vars = [
    "--bx-h:" + okNum(p.boxHeight, 60, 36, 90) + "px", "--bx-r:" + okNum(p.boxRadius, 14, 0, 30) + "px", "--bx-g:" + okNum(p.boxGap, 8, 0, 20) + "px",
    "--bx-bg:" + cssv(tok(p.boxBackground), "#FCFBF8"), "--bx-bd:" + cssv(tok(p.boxBorderColor), "rgba(28,26,23,0.13)"),
    "--bx-fbg:" + cssv(tok(p.boxFilledBackground), "#FFFFFF"), "--bx-fbd:" + cssv(tok(p.boxFilledBorderColor), "#1C1A17"),
    "--bx-ring:" + cssv(tok(p.boxActiveRing), "rgba(57,255,20,0.2)"), "--bx-dc:" + cssv(tok(p.digitColor), "#1C1A17"),
    "--bx-df:" + okFont(tok(p.digitFont), "Tailzu Grotesk") + ",system-ui", "--bx-ds:" + okNum(p.digitSize, 28, 14, 44) + "px",
    "--bx-tx:" + cssv(tok(p.textColor), "rgba(28,26,23,0.7)"), "--bx-lk:" + cssv(tok(p.linkColor), "#1C1A17"),
  ].join(";");
  // {to} and {len} are the flow's to fill; the rest of the line is the server's words, escaped.
  const sent = esc(label(p.sentTo) || "").replace(/\{len\}/g, () => String(len)).replace(/\{to\}/g, () => "<b>" + esc(AUTH.sentTo) + "</b>");
  const wait = String(label(p.waitLabel) || ""), ok = String(label(p.okLabel) || "");
  const shown = AUTH.sendFailed ? String(label(p.failLabel) || "") : done ? ok : wait;
  let cells = "";
  for (let i = 0; i < len; i++) {
    cells += '<div class="ob-box' + (i < code.length ? " f" : i === code.length ? " cur" : "") + '">' + esc(code[i] || "") + "</div>";
  }
  const stopped = AUTH.resending || AUTH.phase !== "verify";
  return '<div class="ob-code" style="' + s + ";" + vars + '">' +
    '<p class="ob-sent">' + sent + "</p>" +
    '<div class="ob-boxes' + (AUTH.codeError ? " tz-shake" : "") + '" data-codebox="1" data-variant="boxes">' +
    '<input data-code="1" inputmode="numeric" autocomplete="one-time-code" maxlength="' + len + '" value="' + esc(code) + '" aria-label="' +
    esc(K.txt("desktop.gate.codeLabel", "Enter the code we sent you")) + '">' + cells + "</div>" +
    '<div class="ob-status" data-status="1" data-wait="' + esc(wait) + '" data-ok="' + esc(ok) + '" data-fail="' + (AUTH.sendFailed ? "1" : "") +
    '" aria-live="polite"><span class="ob-ck"' + (done && !AUTH.sendFailed ? "" : " hidden") + ">" + CHECK_SVG + '</span><span class="ob-st">' + esc(shown) + "</span></div>" +
    '<button type="button" class="ob-link ob-resend" data-resend="1"' + (stopped ? " disabled" : "") + ">" + CLOCK_SVG + "<span>" + esc(label(p.resendLabel) || "") + "</span></button>" +
    '<div class="ob-wrong"><span>' + esc(label(phone ? p.wrongLabel : p.wrongEmailLabel) || "") + '</span> <button type="button" class="ob-link" data-back="1">' +
    esc(label(p.changeLabel) || "") + "</button></div></div>";
}

/** A digit typed or pasted: the boxes, the lit one and the status line, written in place. */
function liveCode(box) {
  const len = AUTH.codeLength, code = AUTH.code;
  box.querySelectorAll(".ob-box").forEach((cell, i) => {
    cell.textContent = code[i] || "";
    cell.className = "ob-box" + (i < code.length ? " f" : i === code.length ? " cur" : "");
  });
  const wrap = box.closest ? box.closest(".ob-code") : null;
  const st = wrap && wrap.querySelector("[data-status]");
  if (!st) return;
  const done = code.length >= len;
  st.querySelector(".ob-ck").hidden = !done;
  st.querySelector(".ob-st").textContent = (done ? st.getAttribute("data-ok") : st.getAttribute("data-wait")) || "";
}

/** Google's and Apple's own marks, drawn at `px`; Apple's takes the colour it is on. */
function socialMark(provider, px, apple) {
  return provider === "apple"
    ? '<svg width="' + px + '" height="' + px + '" viewBox="0 0 24 24"><path fill="' + apple + '" d="M16.365 1.43c0 1.14-.493 2.27-1.177 3.08-.744.9-1.99 1.57-2.987 1.57-.12 0-.23-.02-.3-.03-.01-.06-.04-.22-.04-.39 0-1.15.572-2.27 1.206-2.98.804-.94 2.142-1.64 3.248-1.68.03.13.05.28.05.43zm4.565 15.71c-.03.07-.46 1.58-1.51 3.14-.9 1.36-1.84 2.71-3.32 2.71-1.48 0-1.86-.88-3.56-.88-1.66 0-2.25.91-3.6.91-1.36 0-2.3-1.27-3.22-2.61-1.87-2.61-3.34-7.53-1.42-10.86.95-1.66 2.65-2.7 4.5-2.73 1.4-.03 2.72.95 3.58.95.85 0 2.45-1.18 4.12-1.01.7.03 2.67.28 3.93 2.13-.1.06-2.35 1.37-2.33 4.07.03 3.22 2.83 4.29 2.86 4.31z"/></svg>'
    : '<svg width="' + px + '" height="' + px + '" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
}

/**
 * GOOGLE AND APPLE AS A WIDE BUTTON WITH ITS WORDS, the onboarding's. The
 * round icon is the pill's company; this one stands alone above the email
 * field and says what it does. The look is the node's own props (the server
 * writes them once, for both sides of sign-in); ink on paper by default.
 */
function wideSocial(provider, p, s) {
  const h = okNum(p.size, 48, 32, 72), ink = cssv(tok(p.borderColor), "#1C1A17");
  const words = label(p.label) || K.txt("desktop.gate.continueWith", "Continue with {provider}", { provider: provider === "apple" ? "Apple" : "Google" });
  return '<button class="tz-social tz-press ob-social" data-oauth="' + provider + '" aria-label="' + esc(words) + '"' +
    ' style="' + s + ";width:100%;height:" + h + "px;border-radius:" + okNum(p.radius, 16, 0, 36) + "px;background:" + cssv(tok(p.background), "#FCFBF8") +
    ";border:" + okNum(p.borderWidth, 1.5, 0, 4) + "px solid " + ink + ";color:" + ink + '">' +
    socialMark(provider, 20, ink) + "<span>" + esc(words) + "</span></button>";
}

function wordMeter(p) {
  const base = +p.base || 0, earned = +p.earned || 0;
  const total = Math.max(1, base + earned);
  const used = Math.max(0, Math.min(total, +p.used || 0));
  const left = total - used;
  const tick = earned > 0 ? (base / total) * 100 : -1;
  const fill = esc(p.fillColor || "var(--accent)");
  const big = K.num("desktop.meter.bigSize", 28), small = K.num("desktop.meter.smallSize", 13);
  const tiny = K.num("desktop.meter.tinySize", 12), bar = K.num("desktop.meter.barHeight", 10);
  return '<div><div style="display:flex;justify-content:space-between;align-items:baseline">' +
    '<span style="color:var(--text);font-size:' + big + 'px;font-weight:700;letter-spacing:-.5px">' + left.toLocaleString() + "</span>" +
    '<span style="color:var(--label);font-size:' + small + 'px">' +
    esc(K.txt("desktop.meter.used", "{used} of {total} used", { used: used.toLocaleString(), total: total.toLocaleString() })) +
    "</span></div>" +
    '<div style="color:var(--label);font-size:' + small + 'px;margin-top:2px">' + esc(K.txt("desktop.meter.left", "words left")) + "</div>" +
    '<div style="height:' + bar + "px;border-radius:" + (bar / 2) +
    'px;background:var(--border);margin-top:12px;position:relative;overflow:hidden">' +
    '<div style="width:' + (used / total) * 100 + "%;height:100%;background:" + fill + '"></div>' +
    (tick >= 0 ? '<div style="position:absolute;top:0;bottom:0;left:' + tick + '%;width:2px;background:var(--bg)"></div>' : "") +
    '</div><div style="display:flex;gap:14px;margin-top:10px">' +
    '<span style="color:var(--label);font-size:' + tiny + 'px">' +
    esc(K.txt("desktop.meter.free", "{n} free", { n: base.toLocaleString() })) + "</span>" +
    (earned > 0 ? '<span style="color:' + esc(p.earnedColor || "var(--accent)") + ";font-size:" + tiny + 'px;font-weight:600">' +
      esc(K.txt("desktop.meter.earned", "+{n} earned", { n: earned.toLocaleString() })) + "</span>" : "") + "</div>" +
    (p.caption ? '<div style="color:var(--label);font-size:' + small + 'px;margin-top:12px">' + esc(p.caption) + "</div>" : "") + "</div>";
}

function pie(p) {
  const data = (p.data || []).filter((d) => (+d.value || 0) > 0);
  const total = data.reduce((n, d) => n + (+d.value || 0), 0);
  const size = p.size || K.num("desktop.pie.size", 150), r = size / 2;
  const inner = p.donut === false ? 0 : r - r * K.num("desktop.pie.ring", 0.26);
  const fallback = K.color("desktop.chart.color", "#E8A23C");
  const legendSize = K.num("desktop.pie.legendSize", 12.5);
  if (!total) return "";
  let a = -Math.PI / 2, paths = "";
  data.forEach((d) => {
    const frac = (+d.value) / total, a1 = a + frac * Math.PI * 2;
    const big = a1 - a > Math.PI ? 1 : 0;
    const x0 = r + r * Math.cos(a), y0 = r + r * Math.sin(a);
    const x1 = r + r * Math.cos(a1), y1 = r + r * Math.sin(a1);
    const ix1 = r + inner * Math.cos(a1), iy1 = r + inner * Math.sin(a1);
    const ix0 = r + inner * Math.cos(a), iy0 = r + inner * Math.sin(a);
    // One slice covering the whole circle cannot be drawn as a single arc:
    // start and end coincide and the path collapses. Draw a ring instead.
    paths += data.length === 1
      ? '<circle cx="' + r + '" cy="' + r + '" r="' + (r + inner) / 2 + '" fill="none" stroke="' +
        esc(d.color || fallback) + '" stroke-width="' + (r - inner) + '"/>'
      : '<path d="M ' + x0 + " " + y0 + " A " + r + " " + r + " 0 " + big + " 1 " + x1 + " " + y1 +
        " L " + ix1 + " " + iy1 + " A " + inner + " " + inner + " 0 " + big + " 0 " + ix0 + " " + iy0 +
        ' Z" fill="' + esc(d.color || fallback) + '"/>';
    a = a1;
  });
  const legend = p.legend === false ? "" :
    '<div style="display:flex;flex-direction:column;gap:6px;flex:1;min-width:0">' + data.map((d) =>
      '<div style="display:flex;align-items:center;gap:8px;min-width:0">' +
      '<span style="width:8px;height:8px;border-radius:50%;flex:none;background:' + esc(d.color || fallback) + '"></span>' +
      '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:' + legendSize + 'px">' +
      esc(d.label || "") + "</span>" +
      '<span style="color:var(--label);font-size:' + legendSize + 'px">' + Math.round(((+d.value) / total) * 100) +
      "%</span></div>").join("") + "</div>";
  const centre = p.centerValue != null
    ? '<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">' +
      '<div style="color:var(--text);font-size:' + K.num("desktop.pie.centerSize", 19) + 'px;font-weight:700">' +
      esc(p.centerValue) + "</div>" +
      '<div style="color:var(--label);font-size:' + K.num("desktop.pie.centerLabelSize", 11) + 'px">' +
      esc(p.centerLabel || "") + "</div></div>"
    : "";
  return '<div style="display:flex;align-items:center;gap:18px"><div style="position:relative;flex:none;width:' +
    size + "px;height:" + size + 'px"><svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + " " + size + '">' +
    paths + "</svg>" + centre + "</div>" + legend + "</div>";
}

function bars(p) {
  const vals = (p.series || []).map((x) => (typeof x === "number" ? x : +x.value || 0));
  if (!vals.length) return "";
  const max = Math.max.apply(null, vals.concat([1]));
  const minPct = K.num("desktop.bars.minPct", 2);
  return '<div style="display:flex;align-items:flex-end;gap:' + K.num("desktop.bars.gap", 4) +
    "px;height:" + K.num("desktop.bars.height", 110) + 'px">' + vals.map((v) =>
    '<div style="flex:1;border-radius:' + K.num("desktop.bars.radius", 3) + "px;background:" +
    esc(p.color || K.color("desktop.chart.color", "#E8A23C")) +
    ';height:' + Math.max(minPct, (v / max) * 100) + '%"></div>').join("") + "</div>";
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("on"), K.num("desktop.toast.ms", 2600));
}

/** What the control that fired the current action handed over.
 *
 *  The catalog writes "$event" where a handler needs it — the transcript a mic
 *  produced, the error a session raised — and this window resolved it to the
 *  literal string "$event". So a failed dictation toasted the word "$event" at
 *  the user instead of saying what went wrong. */
let EVENT = undefined;

function resolveValue(v) {
  if (typeof v === "string" && v.indexOf("$state.") === 0) return stateAt(v.slice(7));
  if (v === "$event") return EVENT;
  return v;
}

async function run(action, eventValue) {
  if (!action) return;
  if (arguments.length > 1) EVENT = eventValue;
  if (typeof action === "string") return run((CURRENT_ACTIONS || {})[action], ...(arguments.length > 1 ? [eventValue] : []));
  switch (action.kind) {
    case "navigate": go(action.screenId, action.params); return;
    // TWO NAMES FOR ONE THING, and only one was answered. The catalog says
    // "navigateBack" — fifteen times, on every back control in the four inside
    // screens — and this understood only "back". So every one of those arrows
    // was drawn, was clickable, and did nothing; an action this switch does not
    // know falls through in silence, which is how it stayed invisible.
    case "back": case "navigateBack": case "dismiss": back(); return;
    case "switchTab": switchTab(action.tabId); return;
    case "reloadScreen": case "refresh": await paint(true); return;
    case "setState": setStatePath(action.path, resolveValue(action.value)); repaint(); return;
    case "clearState": setStatePath(action.path, undefined); repaint(); return;
    case "appendState": {
      const cur = stateAt(action.path);
      const arr = Array.isArray(cur) ? cur.slice() : [];
      arr.push(resolveValue(action.value));
      setStatePath(action.path, arr);
      repaint();
      return;
    }
    // The same evaluator the tree's visibleIf uses, so a condition means the
    // same thing whether it gates a node or an action.
    case "condition": {
      const branch = visible(action.if) ? action.then : action.else;
      if (branch) await run(branch);
      return;
    }
    case "toggleState": setStatePath(action.path, !truthy(stateAt(action.path))); repaint(); return;
    case "toggleInArray": {
      const cur = stateAt(action.path);
      const list = Array.isArray(cur) ? cur.slice() : [];
      const v = resolveValue(action.value);
      const i = list.indexOf(v);
      if (i === -1) list.push(v); else list.splice(i, 1);
      setStatePath(action.path, list); repaint(); return;
    }
    // resolveValue, so "$event" is the error it carries and not the word.
    case "toast": { const m = resolveValue(action.message); toast(label(m == null ? "" : String(m)) || ""); return; }
    // A note back on the clipboard, as it was written.
    case "copyText": {
      const t = String(resolveValue(action.text) ?? "");
      try { await navigator.clipboard.writeText(t); toast(label(action.message) || K.txt("desktop.toast.copied", "Copied")); }
      catch { toast(K.txt("desktop.toast.copyFailed", "Couldn't copy that")); }
      return;
    }
    // A setting that lives on this computer. The main process checks the key
    // and the value, writes its own file, and answers with every setting again.
    case "desktop.config": {
      try {
        const v = action.value === "$toggle" ? !truthy(stateAt("desktop." + action.key)) : resolveValue(action.value);
        const next = await window.tailzuApp.setConfig(String(action.key || ""), v);
        if (next && typeof next === "object") LOCAL = next;
      } catch { toast(K.txt("desktop.toast.settingFailed", "Couldn't change that setting")); }
      STATE.desktop = Object.assign({}, LOCAL);
      repaint();
      return;
    }
    case "dictate":
      try { window.tailzuApp.dictate(); } catch { /* tray only */ }
      return;
    case "signOut":
      await signOutHere();
      return;
    case "haptic": return;                      // no equivalent, and none faked
    case "delay": await new Promise((r) => setTimeout(r, action.ms || 0)); return;
    case "openUrl": window.tailzuApp.openExternal(action.url); return;
    case "notes.toggle": try { window.tailzuApp.toggleNotes(); } catch { /* an older main process */ } return;
    case "notes.allowSystemAudio": try { window.tailzuApp.allowSystemAudio(); } catch { /* an older main process */ } return;
    case "installUpdate": return installUpdate(action);
    // The Ask setup card. The window names which setting, never an address;
    // the main process opens its own fixed pages and ignores any other kind.
    case "ask.openAccessibility": askAction("openAccessibility"); return;
    case "ask.openScreenRecording": askAction("openScreenRecording"); return;
    case "ask.picturesAll": askAction("picturesAll", action.on === true || action.on === "true"); return;
    case "ask.relaunch": askAction("relaunch"); return;
    case "ask.folderAdd": foldersAction("add"); return;
    case "ask.folderRemove": foldersAction("remove", Number(action.i)); return;
    case "ask.folderReset": foldersAction("reset"); return;
    case "connector.connect": return connectApp(action);

    // ── buying ────────────────────────────────────────────────────────────
    // Every row on the paywall fires one of these, and this window answered
    // none of them: the screen drew, the rows clicked, and nothing happened —
    // the same silence `navigateBack` used to fall into.
    //
    // RevenueCat has no desktop SDK, so there is no store to call. Web Billing
    // is its own checkout, opened in the user's browser, and the identity
    // already lines up — the app user id is the Supabase user id on both
    // sides, so paying here writes the same entitlements row a phone purchase
    // writes, and someone who paid on their phone is already entitled here.
    case "iap.subscribe":
    case "iap.showPaywall":
      return buyOnWeb();

    // NOTHING TO RESTORE FROM, and nothing that needs restoring. On a phone
    // this asks the store to re-attach a purchase made on another device. Here
    // the server already knows: entitlement is a row against this account, not
    // a receipt on this machine. So the honest action is to go and ask it.
    case "iap.restore":
      await refreshEntitlement(true);
      return;
    case "sequence":
      for (const a of action.actions || []) await run(a);
      return;
    case "callEndpoint": {
      try {
        const path = String(action.path || "").replace(/\$state\.[A-Za-z0-9_.]+/g, (m) => {
          const v = stateAt(m.slice(7));
          return v == null ? "" : encodeURIComponent(String(v));
        });
        const body = action.body != null ? deepResolve(action.body) : undefined;
        const res = await api(path, body, action.method || "POST");
        if (action.assignTo) { setStatePath(action.assignTo, res); repaint(); }
        await run(action.onSuccess);
        if (action.method && action.method.toUpperCase() !== "GET") {
          // Any write could have been the tone. Telling the tray to re-read is
          // cheaper, and more honest, than guessing which writes matter.
          try { window.tailzuApp.changed(); } catch { /* tray only */ }
          // The onboarding saves as it goes (a language, then the profile at
          // the end) and nothing it shows depends on the answer; a fetch here
          // would rebuild the step under the person's hand.
          if (!stageUp()) await paint(true);
        }
      } catch (err) {
        if (err && err.quota) { go(K.str("quota.screenId", "paywall")); return; }
        await run(action.onError);
      }
      return;
    }
    default: return;
  }
}

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

function deepResolve(v) {
  if (typeof v === "string") return resolveValue(v);
  if (Array.isArray(v)) return v.map(deepResolve);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = deepResolve(v[k]);
    return o;
  }
  return v;
}

function setStatePath(path, value) {
  const parts = String(path).replace(/^state\./, "").split(".");
  // A path is data from the tree; one that walks into a prototype would
  // write into every object in this window.
  if (parts.some((k) => k === "__proto__" || k === "constructor" || k === "prototype")) return;
  let o = STATE;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof o[parts[i]] !== "object" || o[parts[i]] === null) o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

let CURRENT_ACTIONS = {};

function go(screenId, params) {
  if (!screenId) return;
  STACK.push({ screenId, params });
  paint();
}

/**
 * A screen the MAIN PROCESS asked for — the paywall, when the hotkey was
 * refused for being out of words. The window may still be booting, so the
 * request waits for render() to lay the landing tab down and goes on top of
 * it; and a second request for the screen already showing is not a second
 * copy of it.
 */
let PENDING_SCREEN = null;
function navigateTo(screenId) {
  if (typeof screenId !== "string" || !screenId) return;
  if (!SESSION || !STACK.length) { PENDING_SCREEN = screenId; return; }
  const top = STACK[STACK.length - 1];
  if (top && top.screenId === screenId) return;
  // Coming back from connecting an app in the middle of onboarding: stay on
  // it, and read it again so the app shows as connected.
  if (top && top.screenId === "onboard") { paint(true); return; }
  go(screenId);
}
function back() {
  if (STACK.length > 1) { STACK.pop(); paint(); }
}
function switchTab(tabId) {
  const tab = TABS.find((t) => t.id === tabId);
  if (!tab) return;
  TAB_ID = tabId;
  STACK = [{ screenId: tab.screenId }];
  paint();
}

async function paint(force) {
  const cur = STACK[STACK.length - 1];
  if (!cur) return;
  paint._at = Date.now();
  // A LOOP THAT OUTLIVES ITS SCREEN HOLDS A LIVE MICROPHONE BEHIND A WINDOW
  // THE USER BELIEVES THEY HAVE LEFT. Ended here, before the next screen can
  // start one of its own.
  stopSession();
  if (MIC) { try { MIC.rec.stop(); } catch {} MIC = null; }
  const view = $("view");
  // THE SCREEN THAT IS UP STAYS UP UNTIL THE NEXT ONE IS READY.
  //
  // This used to blank the view to "Loading…" the instant a navigation began,
  // so every screen change was three frames the eye could count: the old
  // screen gone, grey text on black, the new screen. On slide-to-begin that
  // was the blink between the pill and the session. Now the old screen holds
  // while the next is fetched and is replaced in ONE frame when it lands.
  //
  // A GENUINELY SLOW FETCH IS NOT A BLACK SHEET. It used to swap the page
  // for "Loading…" on the legacy ground, which is black — on the desk's paper
  // that was a dark slab across the window until the screen arrived. Now the
  // page that is up stays up, quietened and out of reach, and a thin amber
  // line runs along the top until the next one lands (#main[data-wait]).
  // Its delay is desktop.screen.waitMs. The old knob, slowMs, still timed the
  // black sheet on builds before this one, so the server holds that one high
  // (a minute) and those builds simply keep the old page up instead.
  const seq = paint._seq = (paint._seq || 0) + 1;
  const fresh = force || !paint._last || paint._last !== cur.screenId;
  let slow = 0;
  const main = $("main");
  const settled = () => { delete main.dataset.wait; view.removeAttribute("aria-busy"); };
  if (!paint._last) {
    // tz-loading: held out of sight while the onboarding holds the window, so
    // Blip stands on paper and not over a grey word.
    view.innerHTML = '<div class="pad tz-loading" style="color:var(--label)">' + esc(K.txt("desktop.screen.loading", "Loading…")) + "</div>";
  } else if (fresh) {
    slow = setTimeout(() => {
      if (seq !== paint._seq) return;
      dropField();
      main.dataset.wait = "1";
      view.setAttribute("aria-busy", "true");
    }, K.num("desktop.screen.waitMs", 700));
  }
  // Another page: a setup card that finished while it was in view has been
  // seen ticked, and the home page drops it from here on.
  if (paint._last !== cur.screenId) ASK_HOLD = false;
  paint._last = cur.screenId;
  let screen;
  try {
    screen = await fetchScreen(cur.screenId, cur.params);
  } catch (err) {
    clearTimeout(slow);
    if (seq !== paint._seq) return;
    settled();
    // Out of words is not a broken screen: it is the one the server names
    // for it, in place of the one that was refused.
    const quotaScreen = K.str("quota.screenId", "paywall");
    if (err && err.quota && cur.screenId !== quotaScreen) {
      STACK[STACK.length - 1] = { screenId: quotaScreen };
      return paint(true);
    }
    dropField();
    // A bot standing over an error is no help: the onboarding lets go.
    leaveOnboard();
    // The second line says what to do when there is something to say (a
    // refused request, no network); the error itself goes to the console.
    const why = userText(err, "");
    view.innerHTML = '<div class="pad"><p style="color:var(--danger)">' +
      esc(K.txt("desktop.screen.loadFailed", "Couldn't load this screen.")) + "</p>" +
      (why ? '<p style="color:var(--label);font-size:13px">' + esc(why) + "</p>" : "") + "</div>";
    return;
  }
  clearTimeout(slow);
  // A newer navigation started while this one was in flight. Its screen is
  // the one that should land; this one would paint over it a moment later.
  if (seq !== paint._seq) return;
  settled();
  STATE = Object.assign({}, screen.state || {});
  STATE.desktop = Object.assign({}, LOCAL);
  // Picks belong to the thread that was on screen. A new screen has none.
  CHAT_PICKED = {};
  CURRENT_ACTIONS = screen.actions || {};
  $("title").textContent = label(screen.title) || "";
  $("back").hidden = STACK.length <= 1;
  applyChrome(screen);
  repaint(screen);
}

/**
 * A SCREEN THAT OWNS THE WINDOW.
 *
 * `hideChrome` and `hideHeader` are how the catalog says "this screen is the
 * whole surface" — the paywall says it, and so does the history view with its
 * own back chevron. Neither word appeared anywhere in this renderer, so the
 * paywall drew inside the rail and under the crumb: full-bleed art in a strip,
 * beside a nav bar it had asked not to have.
 *
 * Two more things a full-bleed screen needs that a padded column does not. Its
 * root asks for `flex: 1`, which means nothing inside a plain block — so the
 * view becomes a flex column for it and the root can actually fill. And it
 * scrolls no more: a screen the size of the window has nothing to scroll, and
 * an overflow container would let one stray absolute child add a scrollbar to
 * a screen with no content below the fold.
 */
function applyChrome(screen) {
  const bare = screen.hideChrome === true;
  const shell = $("shell"), view = $("view");
  shell.dataset.chrome = bare ? "0" : "1";
  $("crumb").hidden = bare || screen.hideHeader === true;
  view.dataset.full = bare ? "1" : "0";
}

/** Find a node by type anywhere in a tree. The chat and the mic need their own
 *  node back — for the paths the server named on it, and for its handlers —
 *  and the renderer returns strings, so there is nothing to close over. */
function findNode(n, type) {
  if (!n || typeof n !== "object") return null;
  if (n.type === type) return n;
  for (const c of n.children || []) { const r = findNode(c, type); if (r) return r; }
  return null;
}

/**
 * Picking a variant.
 *
 * Handled here rather than by the server, for the same reason the phones
 * handle it locally: the click has to answer instantly and a round trip
 * cannot. The choice is written to paths the SERVER names, then `onSelect`
 * fires — so the server still decides what a pick MEANS, it just does not have
 * to be present for the row to respond.
 */
function wireChat(view, sc) {
  const host = view.querySelector("[data-chat]");
  if (!host) return;
  const n = findNode(sc.root, "ChatThread");
  if (!n) return;
  const p = deepResolve(n.props || {});
  const rows = (() => { const r = stateAt((n.bind && n.bind.thread) || ""); return Array.isArray(r) ? r : []; })();

  view.querySelectorAll("[data-pick]").forEach((el) => {
    el.addEventListener("click", async () => {
      const [i, j] = el.getAttribute("data-pick").split(":").map(Number);
      const options = (rows[i] && rows[i].options || []).filter((o) => o && o.text);
      const taken = options[j];
      if (!taken) return;
      // Snapshot in the order the server's pick endpoint expects: what was
      // taken, then the two that were not.
      const others = options.filter((_, k) => k !== j);
      setStatePath(String(p.chosenPath || "_chosen"), taken.text || "");
      setStatePath(String(p.anglePath || "_angle"), taken.angle || "");
      setStatePath(String(p.rejectedAPath || "_rejA"), (others[0] && others[0].text) || "");
      setStatePath(String(p.rejectedBPath || "_rejB"), (others[1] && others[1].text) || "");
      CHAT_PICKED[i] = j;
      repaint();
      if (n.on && n.on.onSelect) await run(n.on.onSelect, taken.text || "");
    });
  });

  // A new row below the fold is a row nobody sees. After the paint, so the
  // rows have measured — scrolling before that lands short.
  requestAnimationFrame(() => { host.scrollTop = host.scrollHeight; });
}

/**
 * THE FIELD IS TOLD WHAT THE SCREEN IS DOING, and it only runs when somebody
 * is looking at it.
 *
 * Both were missing here. The iframe was loaded and then left alone, so the
 * network never reacted to a live session — it pulsed the same idle pattern
 * while the user was mid-sentence, where the phone's leans toward the centre
 * on "listening" and outward on "speaking". And it kept drawing at sixty
 * frames a second behind a window that had been put away, which on a tray app
 * is most of its life.
 *
 * The page takes both over the same channel the phones use: postMessage into
 * `window.tz`. Same message names, same quantising of the level — twenty steps
 * is finer than the eye and turns sixty messages a second into a trickle.
 */
/** NeuralField props that are sent as messages or as their own parameter,
 *  never inside the `cfg` the page bakes. */
const FIELD_LIVE = ["alpha", "growth", "state", "level", "training"];
let FIELD_BINDS = null;   // { state, level, training } paths the server named
let FIELD_PROPS = null;
let FIELD_LAST = "";

let FIELD_EL = null;      // the one iframe, kept across paints

function fieldSend(msg) {
  if (!FIELD_EL || !FIELD_EL.contentWindow) return;
  try { FIELD_EL.contentWindow.postMessage(msg, "*"); } catch { /* not loaded yet */ }
}

/** Whatever the screen currently says, in the page's vocabulary. */
function fieldState() {
  const b = FIELD_BINDS || {};
  const p = FIELD_PROPS || {};
  const at = (key) => (b[key] ? stateAt(b[key]) : p[key]);
  const lvl = Math.min(1, Math.max(0, Number(at("level")) || 0));
  return {
    state: String(at("state") || "idle"),
    level: Math.round(lvl * 20) / 20,
    training: at("training") === true || at("training") === "true",
  };
}

/** The screen that owned the field is gone, or going. Drop the iframe with it
 *  rather than keep a canvas alive for a screen nobody is on — and rather than
 *  leave it standing under whatever the view shows next. */
function dropField() {
  groundView(null);
  if (FIELD_TRACK) FIELD_TRACK();
  if (FIELD_EL) { try { FIELD_EL.remove(); } catch {} FIELD_EL = null; }
  FIELD_BINDS = FIELD_PROPS = null; FIELD_LAST = "";
}

/**
 * NOTHING BETWEEN THE FIELD AND THE VIEW MAY BE OPAQUE.
 *
 * On the phones the field is a child of the screen, so it paints over the
 * screen's own background, as a child does. Here it is a layer UNDER the whole
 * view — which is what keeps it from reloading on every paint — and that turns
 * the painting order over: the screen's background now sits on top of it. The
 * Train screen's root is solid black, so the field ran at full size, every
 * frame, behind a black sheet, and the only time anyone saw it was the instant
 * a tab change swapped the sheet out.
 *
 * So the order is put back by hand: every background between the slot and the
 * view is lifted off, and the one nearest the field — the one it would have
 * been drawn over on a phone — becomes the iframe's own ground. Siblings that
 * come after the field (the scrim, the copy, the button) still sit above it,
 * exactly as the tree says. Re-done on every paint, since every paint writes
 * the backgrounds back.
 */
function uncoverField(slot, view) {
  let ground = "";
  for (let el = slot.parentElement; el && el !== view; el = el.parentElement) {
    const bg = getComputedStyle(el).backgroundColor;
    if (!bg || bg === "transparent" || /rgba\([^)]*,\s*0\)$/.test(bg)) continue;
    if (!ground) ground = bg;
    el.style.backgroundColor = "transparent";
  }
  return ground;
}

/**
 * THE VIEW'S OWN GROUND GOES UNDER THE FIELD, NOT OVER IT.
 *
 * The field is a layer beneath #view, so whatever #view paints sits on top of
 * it. The desk gave #view a ground of its own — the sheet on the desk's pages,
 * --bg on the phone-shaped ones — and from then on the field ran behind an
 * opaque sheet on every screen: the live training screen was plain black.
 *
 * While a field is up the ground moves one level down, to #main, where it
 * paints beneath the layer, and the view goes clear. Same colour, right order.
 * Called with null when the field goes, which hands the ground back.
 */
function groundView(view) {
  const v = view || $("view");
  if (!v) return;
  const host = v.parentElement;
  v.style.background = "";
  if (host) host.style.backgroundColor = "";
  if (!view || !host) return;
  host.style.backgroundColor = getComputedStyle(v).backgroundColor;
  v.style.background = "transparent";
}

function wireField(view) {
  const slot = view.querySelector("[data-field]");
  if (!slot) { dropField(); return; }
  const q = slot.getAttribute("data-field") || "";
  // THE SAME FIELD, RETUNED, never a new one. A screen that wants it brighter
  // (the session, after the entry) or that knows the network has grown says
  // so over the same channel as the state, and the page eases or rebuilds in
  // place. Reloading the iframe for a new alpha was the black frame in the
  // middle of slide-to-begin.
  if (FIELD_EL && FIELD_EL.dataset.q !== q) {
    const was = new URLSearchParams(FIELD_EL.dataset.q || "");
    FIELD_EL.dataset.q = q;
    const qs = new URLSearchParams(q);
    if ((was.get("cfg") || "") !== (qs.get("cfg") || "")) {
      // Different GEOMETRY is a different drawing, and the page bakes its
      // geometry once — so this one reloads. It does not happen between the
      // screens of one catalog, which all send the same field.
      FIELD_EL.src = "neuralField.html" + q;
    } else {
      const tune = {};
      if (qs.has("alpha")) tune.alpha = Number(qs.get("alpha"));
      if (qs.has("growth")) tune.growth = Number(qs.get("growth"));
      fieldSend(tune);
    }
  }
  groundView(view);
  const ground = uncoverField(slot, view);
  if (!FIELD_EL) {
    // MOUNTED ONCE, OUTSIDE THE VIEW, AND NEVER MOVED.
    //
    // Reparenting an iframe reloads the document inside it in every browser
    // that matters, so "keep it and move it into the new markup" is the same
    // reload by another name. It lives beside the view instead, as a layer,
    // and the paint only tells it where to be.
    FIELD_EL = document.createElement("iframe");
    FIELD_EL.dataset.q = q;
    FIELD_EL.setAttribute(
      "style",
      "position:absolute;border:0;background:#000;pointer-events:none;z-index:0",
    );
    FIELD_EL.addEventListener("load", () => {
      FIELD_LAST = "";
      push();
      fieldSend({ run: !document.hidden });
    });
    FIELD_EL.src = "neuralField.html" + q;
    FIELD_EL.style.visibility = "hidden";   // until place() has measured the slot
    // FIRST child of #main, so it paints under #view (which carries z-index:1).
    // The field is the art behind the copy; appended last it would cover the
    // title and the button it exists to sit behind.
    const host = view.parentElement || document.body;
    host.insertBefore(FIELD_EL, host.firstChild);
  }
  // The screen's own colour under the field, as on the phones; the window's
  // ground when the screen names none.
  FIELD_EL.style.background = ground || "var(--bg)";
  place();

  /** Sit exactly where this paint put the slot. Measured against the layer's
   *  offset parent, so scrolling the view carries the field with it. */
  function place() {
    const host = FIELD_EL.offsetParent || document.body;
    const a = slot.getBoundingClientRect(), b = host.getBoundingClientRect();
    FIELD_EL.style.left = (a.left - b.left) + "px";
    FIELD_EL.style.top = (a.top - b.top) + "px";
    FIELD_EL.style.width = a.width + "px";
    FIELD_EL.style.height = a.height + "px";
    // A slot with no size yet means the paint has not laid out. Stay hidden
    // rather than flash a black rectangle in the corner.
    FIELD_EL.style.visibility = a.width && a.height ? "visible" : "hidden";
  }

  function push() {
    const msg = fieldState();
    const key = JSON.stringify(msg);
    if (key === FIELD_LAST) return;      // nothing changed; do not wake the page
    FIELD_LAST = key;
    fieldSend(msg);
  }
  push();

  // The slot moves when the view scrolls or the window is resized, and the
  // layer is not in the flow, so it has to be told. Replaced on every paint so
  // a listener never outlives the slot it measures.
  if (FIELD_TRACK) FIELD_TRACK();
  const onMove = () => place();
  view.addEventListener("scroll", onMove, { passive: true });
  window.addEventListener("resize", onMove);
  FIELD_TRACK = () => {
    view.removeEventListener("scroll", onMove);
    window.removeEventListener("resize", onMove);
    FIELD_TRACK = null;
  };
  requestAnimationFrame(place);   // after layout has settled
}
let FIELD_TRACK = null;

// A tray app spends most of its life put away. The page stops its loop outright
// and resumes where it was — the field is a simulation of state, not a
// timeline, so a pause costs it nothing.
document.addEventListener("visibilitychange", () => fieldSend({ run: !document.hidden }));

function wireMic(view, sc) {
  view.querySelectorAll("[data-mic]").forEach((el) => {
    if (el.hasAttribute("data-hold")) { wireHold(el, sc); return; }
    el.addEventListener("click", async () => {
      // Stop first: a second click on a live button is "stop", not "start
      // another one on top of the one already running".
      if (MIC) { try { MIC.rec.stop(); } catch { MIC = null; repaint(); } return; }
      const path = el.getAttribute("data-mic") || "";
      const n = findNode(sc.root, "VoiceToggle") || findNode(sc.root, "VoiceButton");
      try {
        await micStart(path, n || {});
      } catch (err) {
        MIC = null;
        repaint();
        const eh = n && n.on && n.on.onError;
        const msg = (err && err.name === "NotAllowedError")
          ? K.txt("desktop.voice.micBlocked", "microphone blocked — allow it in your system settings")
          : userText(err, K.txt("desktop.recorder.micError", "Couldn't start the microphone. Try again."));
        if (eh) await run(eh, msg); else toast(msg);
      }
    });
  });
}

/**
 * THE HELD MIC. Pressing starts, letting go stops, wherever the pointer is by
 * then: the button is redrawn on every state change (the mic going live is
 * one), so the release is listened for on the window, not on a button that
 * will already be a different element. Letting go while the permission prompt
 * or the device was still opening stops the take the moment it starts, rather
 * than leaving a microphone running behind a hand that has gone. The window
 * losing focus mid-hold is a let-go too: nothing else would ever say so.
 */
let HELD = false;
function wireHold(el, sc) {
  const path = el.getAttribute("data-mic") || "";
  const n = findNode(sc.root, "VoiceButton") || {};
  const ends = ["pointerup", "pointercancel", "keyup", "blur"];
  const release = () => {
    ends.forEach((t) => window.removeEventListener(t, release));
    HELD = false;
    if (MIC) { try { MIC.rec.stop(); } catch { MIC = null; if (n.bind && n.bind.state) setStatePath(n.bind.state, "idle"); repaint(); } }
  };
  const press = async () => {
    if (HELD || MIC) return;
    HELD = true;
    ends.forEach((t) => window.addEventListener(t, release));
    try {
      await micStart(path, n);
      if (!HELD && MIC) { try { MIC.rec.stop(); } catch { /* it ended on its own */ } }
    } catch (err) {
      ends.forEach((t) => window.removeEventListener(t, release));
      HELD = false;
      MIC = null;
      if (n.bind && n.bind.state) setStatePath(n.bind.state, "idle");
      repaint();
      // A blocked microphone is not "I couldn't hear that": it needs the
      // system's settings, and says so. Anything else is the node's own line.
      if (err && err.name === "NotAllowedError") toast(K.txt("desktop.voice.micBlocked", "microphone blocked — allow it in your system settings"));
      else if (n.on && n.on.onError) await run(n.on.onError, userText(err, K.txt("desktop.recorder.micError", "Couldn't start the microphone. Try again.")));
      else toast(userText(err, K.txt("desktop.recorder.micError", "Couldn't start the microphone. Try again.")));
    }
  };
  el.addEventListener("pointerdown", (e) => { if (e.button !== 0) return; e.preventDefault(); void press(); });
  el.addEventListener("keydown", (e) => { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); void press(); } });
}

/** First node in the tree carrying this event, and the action it names. */
function findEvent(n, name) {
  if (!n || typeof n !== "object") return null;
  if (n.on && n.on[name]) return n.on[name];
  for (const c of n.children || []) { const r = findEvent(c, name); if (r) return r; }
  return null;
}

let CURRENT_SCREEN = null;
function repaint(screen) {
  if (screen) CURRENT_SCREEN = screen;
  // The sign-in stage is up in the gate: a state change (its step) is for it.
  if (gateUp()) { paintGate(); return; }
  const sc = CURRENT_SCREEN;
  if (!sc) return;
  handlers = [];
  SUBMITS = [];
  // Whatever was turning words over belongs to the DOM about to be replaced.
  stopFlips();
  const html = sc.root ? node(sc.root) : '<div class="pad">' + (sc.blocks || []).map(node).join("") + "</div>";
  const view = $("view");
  // A desk page sits on the desk's own ground. A phone screen pushed from one
  // (the paywall, a live training session) keeps its own dark room.
  view.dataset.look = DESK && sc.look === "desk" ? "desk" : "legacy";
  const before = stageBefore(view);
  view.innerHTML = html;
  // A stage glides its own steps in; a fade of the whole stage on top of that
  // would be two entrances. Anything else ends the onboarding if it was on.
  const staged = stageAfter(view, before);
  if (!staged) leaveOnboard();
  // A NEW SCREEN ARRIVES, IT DOES NOT SNAP. The first paint of a screen fades
  // its content in over the field, which stays where it was; a repaint of the
  // same screen — a state change mid-session — is instant, as it must be.
  if (repaint._id !== sc.screenId && view.firstElementChild && !staged) {
    view.firstElementChild.classList.add("tz-swap");
  }
  repaint._id = sc.screenId;
  // A ROOT THAT ASKS TO FILL GETS SOMETHING TO FILL. The phones lay every
  // screen in a flex column, so a root with `flex: 1` is the height of the
  // screen there. In a plain block that number means nothing, and a root
  // whose children are all placed absolutely — the live session: the field,
  // the caption, the end button — has no height of its own and collapsed to
  // zero: black, and a field with nowhere to be. The view becomes a column
  // for such a root, and only for such a root; a padded page is left alone.
  const root = view.firstElementChild;
  view.dataset.flex = root && parseFloat(getComputedStyle(root).flexGrow) > 0 ? "1" : "0";
  startFlips();

  bindHandlers(view);
  view.querySelectorAll("[data-s]").forEach((el) => {
    const act = SUBMITS[Number(el.getAttribute("data-s")) - 1];
    if (act) el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); setStatePath(el.getAttribute("data-bind"), el.value); void run(act); } });
  });
  view.querySelectorAll("[data-bind]").forEach((el) => {
    const path = el.getAttribute("data-bind");
    if (!path) return;
    el.addEventListener("input", () => { setStatePath(path, el.value); });
  });
  // A committed pill. `onComplete` is the phones' name for it and the catalog
  // sends the same tree to both, so the name is honoured rather than renamed.
  view.querySelectorAll("[data-ev='onComplete']").forEach((el) => {
    const ref = (sc.root && findEvent(sc.root, "onComplete")) || null;
    if (ref) el.addEventListener("click", () => { void run(ref); });
  });
  view.querySelectorAll("[data-toggle]").forEach((el) => {
    const path = el.getAttribute("data-toggle");
    if (!path) return;
    el.addEventListener("click", () => { setStatePath(path, !truthy(stateAt(path))); repaint(); });
  });
  wireChat(view, sc);
  wireMic(view, sc);
  wireField(view);
  document.querySelectorAll("#tabs .tab, #mtabs .mtab").forEach((b) => {
    b.setAttribute("aria-current", String(b.dataset.tab === TAB_ID && STACK.length <= 1));
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/** Stop every flip line. Called before a paint replaces the DOM under them. */
function stopFlips() {
  FLIP_TIMERS.forEach(clearInterval);
  FLIP_TIMERS = [];
  FLIPS = [];
}

/**
 * Start the flip lines this paint produced.
 *
 * A crossfade rather than the phones' 3D turn: the turn there is a native
 * transform on a native text node, and a browser doing the same thing over a
 * blurred backdrop repaints the whole stacking context. The word still changes
 * language, which is the part anyone notices.
 */
function startFlips() {
  FLIPS.forEach((f) => {
    const el = document.getElementById(f.id);
    if (!el || f.words.length < 2) return;
    let i = 0;
    const fade = K.num("desktop.flip.fadeMs", 250);
    FLIP_TIMERS.push(setInterval(() => {
      el.style.opacity = "0";
      setTimeout(() => {
        i = (i + 1) % f.words.length;
        el.textContent = f.words[i];
        el.style.opacity = "1";
      }, fade);
    }, f.ms));
  });
  FLIPS = [];
}

function renderTabs() {
  const host = DESK ? $("mtabs") : $("tabs");
  const cl = DESK ? "mtab" : "tab";
  host.innerHTML = TABS.map((t) =>
    '<button class="' + cl + '" data-tab="' + esc(t.id) + '">' + esc(t.title) + "</button>").join("");
  host.querySelectorAll("." + cl).forEach((b) => {
    b.addEventListener("click", () => switchTab(b.dataset.tab));
  });
}

/**
 * THE MASTHEAD'S RIGHT-HAND SIDE: how many words are left, the way into
 * settings, and whose account this is. All three from what the window already
 * has — the boot's quota flags and the signed-in token — so nothing here is a
 * request of its own.
 */
function paintMast() {
  if (!DESK) return;
  const f = (BOOT && BOOT.flags) || {};
  const q = $("quota");
  if (q) {
    const paid = f["quota.entitled"] === true;
    const used = Number(f["quota.wordsUsed"]) || 0, of = Number(f["quota.wordsFree"]) || 0;
    q.querySelector("span").textContent = paid
      ? K.txt("desktop.mast.unlimited", "Unlimited")
      : K.txt("desktop.mast.words", "{used} / {of} words", { used: used.toLocaleString(), of: of.toLocaleString() });
    q.style.setProperty("--fill", paid ? "100%" : Math.min(100, of ? (used / of) * 100 : 0) + "%");
    q.setAttribute("aria-label", q.querySelector("span").textContent);
  }
  const me = $("me");
  if (me) {
    let who = "";
    try {
      const claims = JSON.parse(atob(String(SESSION.access_token).split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      who = (claims.user_metadata && (claims.user_metadata.full_name || claims.user_metadata.name)) || claims.email || claims.phone || "";
    } catch { /* no name to show */ }
    me.textContent = (String(who).trim()[0] || "·").toUpperCase();
    me.title = who;
  }
  applyLook(f["desktop.look"]);
  applyMast(f["desktop.mast"]);
}

/**
 * THE MASTHEAD'S PROPORTIONS, FROM THE SERVER: `desktop.mast` =
 * { logo: 19, brand: 18, tabs: "center" | "start" } — the mark's width and the
 * name's size in pixels, and which side the tabs sit on. Absent keys keep
 * app.html's own values; numbers outside a sane range are ignored.
 */
function applyMast(m) {
  const mast = $("mast");
  if (!mast || !m || typeof m !== "object") return;
  const root = document.documentElement.style;
  const px = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n + "px" : null; };
  const logo = px(m.logo, 10, 48), brand = px(m.brand, 10, 36);
  if (logo) root.setProperty("--m-logo", logo);
  if (brand) root.setProperty("--m-brand", brand);
  if (m.tabs === "start" || m.tabs === "center") mast.dataset.tabs = m.tabs;
}

/**
 * THE DESK'S COLOURS, FROM THE SERVER. app.html paints the first frame with
 * its own tokens; a `desktop.look` block ({ light: {...}, dark: {...} }, each a
 * map of token name to colour) retunes them without an installer. Only
 * `--d-` tokens, and only values that look like colours.
 */
let LOOK = null;
function applyLook(look) {
  if (look && typeof look === "object") LOOK = look;
  if (!LOOK) return;
  const dark = prefers("(prefers-color-scheme: dark)");
  const set = LOOK[dark ? "dark" : "light"] || {};
  const root = document.documentElement.style;
  Object.keys(set).forEach((k) => {
    const v = String(set[k]);
    if (/^d-[a-z0-9-]+$/.test(k) && /^(#[0-9a-f]{3,8}|rgba?\([0-9., ]+\))$/i.test(v)) root.setProperty("--" + k, v);
  });
}
try { window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyLook()); } catch { /* old engine */ }

/** Signing out, from the rail's link or the desk's settings page. */
async function signOutHere() {
  // The tray's session too: it is the same one, held by the main process.
  await setSession(null);
  location.reload();
}

/**
 * THE CHROME, FROM THE SERVER.
 *
 * The screens in this window were already server-drawn; the frame around them
 * was not. The gate's heading, its buttons, the rail down the left — all
 * literals in app.html, so correcting one word of them meant cutting an
 * installer and getting every user to run it.
 *
 * Every key is optional. A missing one leaves the markup's own word in place,
 * which is what a build older than a key, or newer than a deploy, will hit.
 */
function paintChrome(shell) {
  if (!shell) return;
  const text = (id, v) => {
    const el = $(id);
    if (el && typeof v === "string" && v.trim()) { el.textContent = v; CHROME_PAINTED.add(id); }
  };
  // The form itself is the server's auth.screen now — its labels are props on
  // that tree, not ids in this document. What is left here is the copy AROUND
  // it: the heading, and the line under everything.
  const g = shell.gate || {};
  text("gateTitle", g.title);       text("gateSub", g.subtitle);
  // The note is the one line that may be absent: shown only when the server
  // has something to say under the form, hidden rather than left as an empty
  // paragraph with a margin.
  text("gateNote", g.note);
  $("gateNote").hidden = !$("gateNote").textContent.trim();
  const r = shell.rail || {};
  text("railBrand", r.brand);       text("mastBrand", r.brand);       text("dictate", r.dictate);
  text("settingsLink", r.settings); text("signOut", r.signOut);
  text("back", r.back);
  applyGateLayout(shell.gateLayout);
}

/**
 * THE FIRST PAINT'S WORDS, FROM THE KNOBS.
 *
 * app.html carries its own copy of the chrome's words so the very first frame
 * has something in it. Those are only the fallbacks now: as soon as knobs are
 * known — the main process's cached bootstrap, before this window has asked
 * anything — each is replaced by the server's label. An element that
 * `desktop.shell` has already painted is left alone: that block is the more
 * specific answer, and it is the one the server has always sent.
 */
const CHROME_PAINTED = new Set();
function paintFirst() {
  const put = (id, v) => {
    const el = $(id);
    if (el && !CHROME_PAINTED.has(id) && typeof v === "string" && v.trim()) el.textContent = v;
  };
  document.title = K.txt("desktop.window.title", "Tailzu");
  put("gateTitle", K.txt("desktop.gate.title", "Tailzu"));
  put("gateSub", K.txt("desktop.gate.subtitle",
    "Sign in the same way you do on your phone — your voices, history and words come with you."));
  put("railBrand", K.txt("desktop.rail.brand", "Tailzu"));
  put("dictate", K.txt("desktop.rail.dictate", "Dictate now"));
  put("settingsLink", K.txt("desktop.rail.settings", "Settings"));
  put("signOut", K.txt("desktop.rail.signOut", "Sign out"));
  put("back", K.txt("desktop.rail.back", "← Back"));
}

/**
 * STAND BESIDE THE ART, NOT ON IT.
 *
 * The sign-in art places a mark and a headline, and the form was centred in
 * the window — which is exactly where both of those are. On a wide window the
 * form takes a column of its own instead, at a position the server names,
 * because the art is an upload and the next one may be composed the other way
 * round.
 *
 * Below `wideAt` there is no second column to take, so it re-centres. Nothing
 * here runs at all for a server that sends no block: the window keeps the
 * centred layout it had.
 */
let GATE_LAYOUT = null;

function applyGateLayout(l) {
  if (l && typeof l === "object") GATE_LAYOUT = l;
  const g = $("gate");
  if (!g || !GATE_LAYOUT) return;
  const L = GATE_LAYOUT;
  const wide = window.innerWidth >= (Number(L.wideAt) || K.num("desktop.gate.wideAt", 860));
  const twoCol = wide && (L.align === "right" || L.align === "left");
  g.dataset.cols = twoCol ? "1" : "0";
  if (twoCol) {
    const col = Math.min(0.95, Math.max(0.05, Number(L.column) || K.num("desktop.gate.column", 0.5)));
    // Mirrored for "left", so one number describes either side.
    g.style.setProperty("--gate-col", ((L.align === "left" ? 1 - col : col) * 100) + "%");
    g.style.setProperty("--gate-w", (Number(L.columnWidth) || K.num("desktop.gate.columnWidth", 300)) + "px");
  } else {
    g.style.removeProperty("--gate-col");
    g.style.removeProperty("--gate-w");
  }
  // The scrim belongs to the layout: it darkens where the FORM is, and the
  // form only sits there when there is room for two columns.
  const bg = $("gatebg");
  if (bg) {
    bg.dataset.scrim = twoCol && typeof L.scrim === "string" && L.scrim.trim() ? "1" : "0";
    if (bg.dataset.scrim === "1") bg.style.setProperty("--gate-scrim", L.scrim);
    else bg.style.removeProperty("--gate-scrim");
  }
  // The art in these uploads already says "Code sent." and "Say it right.", so
  // the window's own heading and subtitle would be the same words twice. An
  // explicit switch, not an empty string: blank means "keep what you have"
  // everywhere else in this block, and it has to keep meaning that.
  const hide = (id, show) => { const el = $(id); if (el) el.hidden = show === false; };
  hide("gateTitle", L.showTitle);
  hide("gateSub", L.showSubtitle);
}

// A window that is resized across `wideAt` changes which layout applies.
window.addEventListener("resize", () => applyGateLayout());

/**
 * THE LOOK THIS WINDOW HAD LAST TIME, before the server has said.
 *
 * The shell was revealed the moment a session existed and told which look to
 * wear only once bootstrap came back — so every open showed the old rail
 * ("Dictate now", "Sign out") on black for a round trip, then swapped. The
 * look is remembered, applied to the first frame, and the shell stays hidden
 * until the server's answer is in.
 */
const LOOK_KEY = "tz.look";
function rememberedLook() {
  try { return localStorage.getItem(LOOK_KEY) === "desk" ? "desk" : ""; } catch { return ""; }
}
if (rememberedLook() === "desk") {
  document.documentElement.dataset.look = "desk";
  const sh = document.getElementById("shell");
  if (sh) sh.dataset.look = "desk";
}

/**
 * WHERE THE WINDOW OPENS: the tab the server names, else the first. `onboard`
 * is the one landing that is no tab: where a new account starts, with the
 * whole window to itself (hideChrome), so it is taken as it is rather than
 * swapped for a tab the server did not ask for.
 */
function landingFor(boot, tabs) {
  if (boot && boot.initialScreenId === "onboard") return { tabId: "", screenId: "onboard", onboard: true };
  const tab = tabs.find((t) => (t.screenId || t.id) === (boot && boot.initialScreenId)) || tabs[0];
  return { tabId: tab ? tab.id : "", screenId: tab ? (tab.screenId || tab.id) : "home", onboard: false };
}

async function render() {
  const signedIn = !!(SESSION && SESSION.access_token);
  $("gate").hidden = signedIn;
  $("shell").hidden = true;
  if (!signedIn) {
    // Ask as a stranger, so the gate is drawn by the same server that draws
    // everything behind it. A failure here is not fatal: the markup already
    // carries every word, and someone signing in on a dead connection has a
    // bigger problem than the heading being one release old.
    // gateBoot() memoises it, and the art and the phone-method switch already
    // read the same answer — so this is the one request, not a second.
    // (The bootstrap itself already went to the knobs and on to the main
    // process as it arrived — see received().)
    const anon = await gateBoot();
    if (anon) {
      BOOT = anon;                 // role() resolves typography against it too
      applyTheme(anon.theme);
      paintChrome(anon.flags && anon.flags["desktop.shell"]);
    }
    return;
  }
  BOOT = await bootstrap();
  applyTheme(BOOT.theme);
  paintChrome(BOOT.flags && BOOT.flags["desktop.shell"]);
  DESK = !!(BOOT.flags && BOOT.flags["desktop.desk"] === true);
  $("shell").dataset.look = DESK ? "desk" : "rail";
  document.documentElement.dataset.look = DESK ? "desk" : "";
  try { localStorage.setItem(LOOK_KEY, DESK ? "desk" : "rail"); } catch { /* next open just waits */ }
  TABS = BOOT.navigation && BOOT.navigation.kind === "tabs" ? BOOT.navigation.tabs : [];
  renderTabs();
  paintMast();
  // WHERE THE SERVER SAYS, when the server says somewhere this window has.
  //
  // We report `formFactor: "desktop"` now, so the intro and the two setup
  // steps are not offered to us at all and `initialScreenId` is a tab. This
  // still checks, because a backend older than that field answers
  // `onboarding_keyboard` — and a window has no keyboard to enable, so
  // landing there would be a dead end with no way out. Anything that is not
  // one of our tabs falls back to the first one.
  //
  // The tab id is taken from the SAME tab, not from TABS[0]: a bar lighting
  // one tab while another's screen is drawn is worse than a bar that is
  // simply wrong, because the first tap on it does nothing.
  const landing = landingFor(BOOT, TABS);
  TAB_ID = landing.tabId;
  STACK = [{ screenId: landing.screenId }];
  // The paper goes up before the shell shows, so the rail does not flash for
  // the round trip to the first screen.
  if (landing.onboard) document.documentElement.dataset.onboard = "1";
  // A screen the main process asked for while this was booting goes on top
  // of the landing tab, so Back still leads somewhere.
  if (PENDING_SCREEN && PENDING_SCREEN !== STACK[0].screenId) STACK.push({ screenId: PENDING_SCREEN });
  PENDING_SCREEN = null;
  // Shown now, in the look the server chose, with its first page on the way.
  $("shell").hidden = false;
  await paint();
}

async function signIn(email) {
  await sbFetch("/auth/v1/otp", { email, create_user: true });
}
async function verify(email, token) {
  const r = await sbFetch("/auth/v1/verify", { email, token, type: "email" });
  await setSession(r);
}
// Phone is the same two calls with a different key and a different OTP type.
// It only appears when the backend says an SMS provider is actually wired up —
// a button that sends a code nobody can receive is worse than no button.
async function signInPhone(phone) {
  await sbFetch("/auth/v1/otp", { phone, create_user: true });
}
async function verifyPhone(phone, token) {
  const r = await sbFetch("/auth/v1/verify", { phone, token, type: "sms" });
  await setSession(r);
}

/**
 * The bootstrap the GATE needs, fetched once.
 *
 * Two things on the sign-in screen come from the server — whether phone
 * sign-in is on, and the art behind the form — and both are needed before
 * there is a session. That is exactly why they ride in the boot flags rather
 * than in a screen: bootstrap is the only channel that reaches an app with
 * nobody signed into it. It runs on the fallback token here, which is all
 * either of them needs.
 *
 * Cached because it used to be called per question, and two callers meant two
 * round trips to answer one screen.
 */
let preBoot = null;
function gateBoot() {
  // ASKED AS A STRANGER. This runs before there is an account, and it used to
  // go out under the static fallback token — which resolves to a synthetic
  // user, so every launch that never signed in was charged a bootstrap against
  // somebody. Auth is optional on the route, so it simply asks without one.
  if (!preBoot) preBoot = bootstrapAnon().catch(() => null);
  return preBoot;
}

/**
 * Dress the sign-in screen with the uploaded art.
 *
 * `auth.background` is what the phones draw, and this window showed nothing at
 * all — so the first screen of the product looked like a different product on
 * the desktop. Same key, same upload, no second asset to keep in step.
 *
 * The code step gets its own art when one has been uploaded and falls back to
 * the entry's when it has not, which is the rule the phones follow.
 */
async function dressGate(step) {
  const b = await gateBoot();
  const flags = (b && b.flags) || {};
  const spec = (step === "code" && flags["auth.background.code"]) || flags["auth.background"];
  const host = $("gatebg");
  if (!host) return;
  if (!spec || !spec.url) { host.innerHTML = ""; return; }
  const gate = $("gate");
  if (gate && spec.background) gate.style.background = spec.background;
  const fit = spec.fit === "contain" ? "contain" : "cover";
  const isVideo = /^video\//.test(String(spec.contentType || "")) ||
                  /\.(mp4|mov|m4v|webm)(\?|$)/i.test(spec.url);
  // Rebuilding the element on every step would restart the clip mid sign-in,
  // so a source that has not changed is left alone.
  if (host.dataset.src === spec.url) return;
  host.dataset.src = spec.url;
  host.innerHTML = isVideo
    ? '<video src="' + esc(spec.url) + '" autoplay muted loop playsinline style="object-fit:' + fit + '"></video>'
    : '<img src="' + esc(spec.url) + '" alt="" style="object-fit:' + fit + '">';
}

/**
 * Paint the sign-in screen from the server's tree, and wire what it drew.
 *
 * Called on every change to AUTH, which is the whole state machine: a phase, a
 * typed value, a code. Repainting the lot each time is cheap — it is six rows —
 * and it means there is exactly one description of what the screen looks like
 * at any moment, rather than a set of imperative edits that have to agree.
 *
 * The rise animation is the one thing a full repaint would ruin: rows would fly
 * in again on every keystroke. So it runs once per PHASE, and repaints within a
 * phase are marked so the CSS sits them still.
 */
let AUTH_TREE = null;
let AUTH_RISEN = "";

/** The gate's error line, written from outside the sign-in state machine.
 *  A launch that never reached the backend has no tree to paint, so this
 *  writes the line directly: paintGate() draws nothing without one, and
 *  "couldn't reach the backend" is the one sentence that screen has to be
 *  able to say. */
function fail(msg) {
  AUTH.error = String(msg || "");
  const el = $("gateErr");
  if (el) el.textContent = AUTH.error;
}

function paintGate() {
  const host = $("gateForm");
  if (!host || !AUTH_TREE) return;
  const fresh = AUTH_RISEN !== AUTH.phase;
  AUTH_RISEN = AUTH.phase;
  host.dataset.still = fresh ? "0" : "1";
  // `handlers` is a module-level list that node() appends to as it renders an
  // `on.onPress`. repaint() clears it before drawing a screen; this draws
  // outside repaint(), so it has to clear it too — or the gate accumulates a
  // screen's worth of stale entries and binds by an id that has moved.
  handlers = [];
  // If the tree is the onboarding's stage, the page takes on its paper and
  // Blip goes to the step's spot; a step change glides.
  const before = stageBefore(host);
  host.innerHTML = node(AUTH_TREE);
  $("gateErr").textContent = AUTH.error;
  bindHandlers(host);
  stageAfter(host, before);
  wireGate();
}

/**
 * Attach what node() registered while rendering.
 *
 * This only ever ran inside repaint(), so a press written into the SERVER'S
 * auth tree drew its attribute and got no listener — the consent line's Terms
 * and Privacy Policy would have been underlined, looked tappable, and done
 * nothing. Exactly the failure `navigateBack` used to be.
 */
function bindHandlers(root) {
  handlers.forEach((h) => {
    const el = root.querySelector('[data-h="' + h.id + '"]');
    if (!el) return;
    el.addEventListener("click", () => { void run(h.action); });
    // A pressable box in the onboarding is a button to the keyboard as well.
    if (el.getAttribute("role") === "button") {
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void run(h.action); } });
    }
  });
}

function wireGate() {
  const host = $("gateForm");

  // Typing. The pill is the field, so its input writes straight into AUTH —
  // WITHOUT a repaint, which would take the caret with it. The disc's position
  // is the only thing that depends on the value, so it is moved by hand.
  host.querySelectorAll("[data-pill]").forEach((el) => {
    const m = el.getAttribute("data-pill");
    el.addEventListener("focus", () => {
      if (AUTH.open === m) return;
      // The onboarding's field is already open: nothing to redraw, which would
      // only cost it the caret.
      if (el.hasAttribute("data-field")) { AUTH.open = m; AUTH.error = ""; $("gateErr").textContent = ""; return; }
      AUTH.open = m; AUTH.error = "";
      paintGate();
      const again = host.querySelector('[data-pill="' + m + '"]');
      if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
    });
    el.addEventListener("input", () => {
      if (m === "phone") AUTH.phone = el.value; else AUTH.email = el.value;
      refreshDisc(m);
    });
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") void commit(m); });
  });
  const dial = host.querySelector("[data-dial]");
  if (dial) {
    dial.addEventListener("input", () => { AUTH.dial = dial.value; refreshDisc("phone"); });
    dial.addEventListener("keydown", (e) => { if (e.key === "Enter") void commit("phone"); });
  }

  host.querySelectorAll("[data-commit]").forEach((el) => {
    const m = el.getAttribute("data-commit");
    el.addEventListener("click", () => { void commit(m); });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void commit(m); }
    });
  });

  const box = host.querySelector("[data-codebox]");
  const codeIn = host.querySelector("[data-code]");
  if (box && codeIn) {
    box.addEventListener("click", () => codeIn.focus());
    codeIn.addEventListener("input", () => {
      AUTH.code = codeIn.value.replace(/\D/g, "").slice(0, AUTH.codeLength);
      codeIn.value = AUTH.code;
      AUTH.codeError = false;
      AUTH.error = "";
      // DRAWN BY HAND, NOT REPAINTED. A repaint replaced the input under the
      // caret with a fresh one, focused with its caret at the front — so the
      // next digit landed before the last, and the code read backwards; and
      // the focus did not always survive the swap, so every digit could cost
      // a click on the pill. The digits, the border and the error line are
      // the only things that change, and each is written in place.
      box.classList.remove("tz-shake");
      if (box.getAttribute("data-variant") === "boxes") {
        liveCode(box);
      } else {
        const shown = box.querySelector("span");
        if (shown) shown.textContent = AUTH.code.padEnd(AUTH.codeLength, "\u00b7").split("").join(" ");
        const D = pillDefaults();
        box.style.borderColor = AUTH.code.length === AUTH.codeLength ? tok(D.target) : D.border;
      }
      $("gateErr").textContent = "";
      codeIn.setSelectionRange(AUTH.code.length, AUTH.code.length);
      // Six digits is the whole answer — there is nothing else to press.
      if (AUTH.code.length === AUTH.codeLength) void submitCode();
    });
    codeIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && AUTH.code.length === AUTH.codeLength) void submitCode();
    });
    // The caret belongs here the moment the step opens — this IS the step.
    setTimeout(() => { const c = $("gateForm").querySelector("[data-code]"); if (c) c.focus(); },
      K.num("desktop.gate.codeFocusMs", 320));
  }

  host.querySelectorAll("[data-oauth]").forEach((el) => {
    el.addEventListener("click", () => { void oauth(el.getAttribute("data-oauth")); });
  });

  // The code boxes' two ways out: ask again, or correct the address.
  host.querySelectorAll("[data-resend]").forEach((el) => { el.addEventListener("click", () => { void resendCode(); }); });
  host.querySelectorAll("[data-back]").forEach((el) => { el.addEventListener("click", gateBack); });
}

/**
 * THE WAY BACK FROM THE CODE STEP.
 *
 * The phones have a corner arrow and a swipe from the left edge. This tree
 * carries neither, and a window has the gesture everybody already uses to back
 * out of anything: Escape. Without it a typo in the address was a dead end —
 * the code never arrives and there is nothing on the screen to press.
 *
 * The typed address is kept. Coming back to correct one character should not
 * clear the field.
 */
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") gateBack();
});

/** Back from the code to the address. Escape does it, and so does the code step's own "Change it". */
function gateBack() {
  const gate = $("gate");
  if ((gate && gate.hidden) || AUTH.phase !== "verify") return;
  AUTH.phase = "entry";
  AUTH.code = "";
  AUTH.codeError = false;
  AUTH.sendFailed = false;
  AUTH.error = "";
  paintGate();
  void dressGate("entry");
}

/**
 * SEND THE CODE AGAIN, to the address it first went to. The phase stays
 * "verify": it is the same step asked a second time, so Blip does not move and
 * nothing glides. A press while one is in flight is the same press. The old
 * code is spent the moment a new one is sent, so what was typed is cleared; and
 * a send that fails says so on the step (sendFailed), where the person is
 * looking, and not only in the line at the foot of the window.
 */
async function resendCode() {
  if (AUTH.phase !== "verify" || AUTH.resending || !AUTH.sentTo) return;
  AUTH.resending = true;
  AUTH.sendFailed = false;
  AUTH.error = "";
  paintGate();
  try {
    if (AUTH.method === "phone") await signInPhone(AUTH.sentTo); else await signIn(AUTH.sentTo);
    AUTH.code = "";
    AUTH.codeError = false;
  } catch (e) {
    userText(e, "");            // for the log; the step says it in its own words
    AUTH.sendFailed = true;
  } finally {
    AUTH.resending = false;
    paintGate();
  }
}

/**
 * Send the code. The phones swipe a badge to get here; a mouse has no thumb to
 * rest, so the disc is clicked and Enter does the same — the rule SwipeAction
 * already follows on the training tab.
 */
async function commit(method) {
  if (AUTH.phase !== "entry") return;   // already sending
  AUTH.error = "";
  AUTH.sendFailed = false;
  try {
    let to;
    if (method === "phone") {
      to = (AUTH.dial + AUTH.phone).replace(/[^\d+]/g, "");
      if (!/^\+\d{7,15}$/.test(to)) {
        throw worded(K.txt("desktop.gate.badPhone", "Enter a number with its country code, like +1 555 000 1234."));
      }
    } else {
      to = AUTH.email.trim();
      if (!/.+@.+\..+/.test(to)) throw worded(K.txt("desktop.gate.badEmail", "Enter your email address."));
    }
    AUTH.phase = "sending";
    paintGate();
    if (method === "phone") await signInPhone(to); else await signIn(to);
    AUTH.method = method;
    AUTH.sentTo = to;
    AUTH.code = "";
    AUTH.codeError = false;
    AUTH.phase = "verify";
    paintGate();
    void dressGate("code");
  } catch (e) {
    AUTH.phase = "entry";
    AUTH.error = userText(e, K.txt("desktop.gate.authFailed", "Couldn't sign you in. Try again."));
    paintGate();
  }
}

/** Answer with whichever address the code actually went to. */
async function submitCode() {
  if (AUTH.phase !== "verify") return;
  AUTH.phase = "verifying";
  AUTH.error = "";
  paintGate();
  try {
    if (AUTH.method === "phone") await verifyPhone(AUTH.sentTo, AUTH.code);
    else await verify(AUTH.sentTo, AUTH.code);
    await render();
  } catch (e) {
    // The code was wrong, not the screen. Stay on the step, say so, shake it,
    // and clear it — retyping six digits over six wrong ones is worse than
    // starting them again.
    AUTH.phase = "verify";
    AUTH.codeError = true;
    AUTH.code = "";
    AUTH.error = userText(e, K.txt("desktop.gate.codeWrong", "That code didn't work. Check it and try again."));
    paintGate();
  }
}

/** Apple / Google. The main process owns the window, the PKCE secret and the
 *  code exchange; this only asks and reacts. */
async function oauth(provider) {
  AUTH.error = "";
  const host = $("gateForm");
  host.querySelectorAll("[data-oauth]").forEach((b) => { b.disabled = true; });
  try {
    const r = await window.tailzuApp.oauth(provider);
    if (!r || !r.ok) {
      // Closing the window is a decision, not a failure worth shouting about.
      if (r && r.error === "cancelled") return;
      // The main process's reason ("no authorization code", Supabase's
      // own) is for the log; the person gets the phones' sentence.
      throw worded(provider === "apple"
        ? K.txt("auth.apple.errorBody", "Apple sign-in didn't go through. Try again, or use your email.")
        : K.txt("auth.google.errorBody", "Google sign-in didn't go through. Try again, or use your email."),
      (r && r.error) || "no session");
    }
    SESSION = r.session;
    location.reload();
  } catch (e) {
    AUTH.error = userText(e, K.txt("desktop.gate.signInFailed", "Sign-in failed."));
    paintGate();
  } finally {
    const again = $("gateForm");
    if (again) again.querySelectorAll("[data-oauth]").forEach((b) => { b.disabled = false; });
  }
}

/** The disc alone, so typing does not repaint the caret out of the field. */
function refreshDisc(method) {
  const host = $("gateForm");
  const el = host && host.querySelector('[data-commit="' + method + '"]');
  if (!el) return;
  const ready = method === "phone"
    ? /^\+?\d{7,15}$/.test((AUTH.dial + AUTH.phone).replace(/[^\d+]/g, ""))
    : /.+@.+\..+/.test(AUTH.email.trim());
  if (el.dataset.ready === String(ready)) return;
  el.dataset.ready = String(ready);
  // The onboarding's button only lights or dims; nothing is redrawn, so the
  // caret stays where it is.
  if (el.hasAttribute("data-field")) { el.disabled = !ready || AUTH.phase !== "entry"; return; }
  // Re-rendered rather than restyled: at the right end it is an arrow, at the
  // left it is the method's own glyph, and those are different drawings.
  paintGate();
  const again = $("gateForm").querySelector('[data-pill="' + method + '"]');
  if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
}

(async function start() {
  // Listen before asking, so nothing sent in between is missed: the main
  // process pushes new knobs whenever it adopts a bootstrap, and asks for a
  // screen when it refuses the hotkey for being out of words.
  try { window.tailzuApp.onKnobs((k) => { K.setKnobs(k); paintFirst(); }); } catch { /* tray only */ }
  try { window.tailzuApp.onNavigate((id) => navigateTo(id)); } catch { /* tray only */ }
  // A dictation just landed. Today is a list of them, so it redraws — after a
  // moment, so the note is in history before the page asks for it.
  try {
    window.tailzuApp.onDictated(() => {
      if (onLiveTab()) setTimeout(() => { lastLiveRefresh = Date.now(); void paint(true); }, K.num("desktop.desk.refreshMs", 1500));
    });
  } catch { /* an older main process */ }
  // A note was organised: the Notes pages redraw to show it.
  try {
    window.tailzuApp.onNotes(() => {
      const top = STACK[STACK.length - 1];
      if (DESK && top && (top.screenId === "desk_notes" || top.screenId === "desk_note")) void paint(true);
    });
  } catch { /* an older main process */ }

  ENV = await window.tailzuApp.env();
  SESSION = ENV.session || null;
  // The main process's cached bootstrap: the server's words and numbers for
  // this first paint, before this window has asked the server anything.
  if (ENV.knobs) K.setKnobs(ENV.knobs);
  paintFirst();
  if (ENV.navigate) PENDING_SCREEN = ENV.navigate;
  // Ask's permission states, asked now so the first page that carries the
  // setup card has them rather than drawing it twice.
  askSetupWatch();
  foldersWatch();

  $("dictate").addEventListener("click", () => {
    window.tailzuApp.dictate();
    toast(K.txt("desktop.toast.listening", "Listening — {key} stops",
      { key: ENV.hotkey || K.txt("desktop.toast.yourHotkey", "your hotkey") }));
  });
  $("settingsLink").addEventListener("click", () => go("settings"));
  $("back").addEventListener("click", back);
  $("signOut").addEventListener("click", () => { void signOutHere(); });
  // The masthead's settings and word count both open the settings page the
  // server names for the desk.
  const openSettings = () => go(K.str("desktop.desk.settingsScreenId", "desk_settings"));
  $("gear").addEventListener("click", openSettings);
  $("quota").addEventListener("click", openSettings);
  // This computer's own settings. An older main process has no such call;
  // the pages then show the defaults the server wrote next to each switch.
  try { LOCAL = (await window.tailzuApp.config()) || {}; } catch { LOCAL = {}; }

  if (!SESSION) {
    const b = await gateBoot();
    const flags = (b && b.flags) || {};
    AUTH.phoneOn = flags["auth.enablePhone"] === true || flags["auth.enablePhone"] === "true";
    AUTH_TREE = flags["auth.screen"] || null;
    // The onboarding's own conditions ask the boot flags too (its phone field is
    // behind auth.enablePhone), and BOOT is where visible() looks. Only for
    // that tree: the one before it was drawn with no BOOT, and is left as it was.
    if (b && AUTH_TREE && AUTH_TREE.type === "OnboardStage") BOOT = b;
    paintGate();
    void dressGate("entry");
  }

  try {
    await render();
  } catch (e) {
    // A failed bootstrap must not leave a blank window with no way out.
    $("gate").hidden = false;
    $("shell").hidden = true;
    fail(userText(e, K.txt("desktop.gate.offline", "Couldn't reach Tailzu. Check your connection and try again.")));
  }
})();
