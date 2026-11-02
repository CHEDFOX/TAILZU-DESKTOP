// The window's chrome: flip lines, the rail's tabs, the masthead, the look
// (rail or desk) and the first frame painted before the server answers.

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
  document.title = K.txt("desktop.window.title", "X0 Bot");
  put("gateTitle", K.txt("desktop.gate.title", "X0 Bot"));
  put("gateSub", K.txt("desktop.gate.subtitle",
    "Sign in the same way you do on your phone — your voices, history and words come with you."));
  put("railBrand", K.txt("desktop.rail.brand", "X0 Bot"));
  put("dictate", K.txt("desktop.rail.dictate", "Dictate now"));
  put("settingsLink", K.txt("desktop.rail.settings", "Settings"));
  put("signOut", K.txt("desktop.rail.signOut", "Sign out"));
  put("back", K.txt("desktop.rail.back", "← Back"));
}

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
