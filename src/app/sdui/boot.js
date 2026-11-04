// Boot: where the window lands, the first render once signed in, and the
// start that wires the window to the main process.

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
  const pending = PENDING_SCREEN && typeof PENDING_SCREEN === "object" ? PENDING_SCREEN : PENDING_SCREEN ? { screenId: PENDING_SCREEN } : null;
  if (pending && (pending.params || pending.screenId !== STACK[0].screenId)) STACK.push(pending.params ? { screenId: pending.screenId, params: pending.params } : { screenId: pending.screenId });
  PENDING_SCREEN = null;
  // Shown now, in the look the server chose, with its first page on the way.
  $("shell").hidden = false;
  await paint();
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
  // A note was organised: the Notes pages redraw to show it (in the Bots app, Notes' pages and Home's Notes tile).
  try {
    window.tailzuApp.onNotes(() => {
      const top = STACK[STACK.length - 1];
      if (!top) return;
      if ((DESK && (top.screenId === "desk_notes" || top.screenId === "desk_note")) || /^bots\.(notes|note|home)$/.test(top.screenId)) void paint(true);
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
    fail(userText(e, K.txt("desktop.gate.offline", "Couldn't reach X0 Bot. Check your connection and try again.")));
  }
})();
