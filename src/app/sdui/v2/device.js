// `device.*`: what this computer is, read-only, as the phone's device/facts.ts reads a phone (SPEC 2.9, B9).
//
// A window knows less than a phone and says so rather than guessing: there are no safe-area insets, no software
// keyboard, no camera permission to read and no way to ask which apps are installed. Those read 0, false or
// "unsupported", never a flattering default. No identifiers, ever: the list below is the whole of it.

let V2_FACTS = null;
let V2_FACTS_ON = false;
let V2_RESIZE = null;

/** The window's width in the three classes the phone uses, so one screen's layout rules work on both. */
function v2SizeClass(width) {
  return width < 600 ? "compact" : width < 840 ? "regular" : "large";
}

function v2Prefers(q) {
  try { return !!(window.matchMedia && window.matchMedia(q).matches); } catch { return false; }
}

/** Everything `device.*` holds. Read fresh for the things that are cheap; watched for the things that change. */
function v2ReadFacts() {
  const env = typeof ENV !== "undefined" && ENV ? ENV : {};
  const width = Number(window.innerWidth) || 0;
  const height = Number(window.innerHeight) || 0;
  return {
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
    keyboard: { visible: false, height: 0, enabled: false, ready: false },
    reduceMotion: v2Prefers("(prefers-reduced-motion: reduce)"),
    scheme: v2Prefers("(prefers-color-scheme: light)") ? "light" : "dark",
    locale: (typeof navigator !== "undefined" && navigator.language) || "en-US",
    fontScale: 1,
    width,
    height,
    sizeClass: v2SizeClass(width),
    online: typeof navigator === "undefined" || navigator.onLine !== false,
    appState: typeof document !== "undefined" && document.visibilityState === "hidden" ? "background" : "active",
    // A window reads the microphone's answer from the main process (it is the only side that can); everything else
    // a phone asks for has no equivalent here, and says so.
    perm: { mic: V2_FACTS && V2_FACTS.perm ? V2_FACTS.perm.mic : "unasked", camera: "unsupported", notifications: "unsupported", location: "unsupported", photos: "unsupported" },
    // Never a list of installed apps: a window cannot probe for one, and the server is never told.
    canOpen: {},
    platform: "desktop",
    appVersion: String(env.appVersion || ""),
    runtime: String(env.appVersion || ""),
    blocks: v2Declared(),
  };
}

/** The facts as they are now. Cheap: the watched ones are kept, the rest are read on the spot. */
function v2Facts() {
  if (!V2_FACTS) V2_FACTS = v2ReadFacts();
  return V2_FACTS;
}

/** Read again and paint if anything a screen can see has moved. */
function v2FactsChanged() {
  const was = V2_FACTS;
  V2_FACTS = v2ReadFacts();
  if (!was) return;
  let same = true;
  for (const key of Object.keys(V2_FACTS)) {
    const a = was[key], b = V2_FACTS[key];
    if (a === b) continue;
    if (a && b && typeof a === "object" && typeof b === "object" && JSON.stringify(a) === JSON.stringify(b)) continue;
    same = false;
    break;
  }
  if (same) return;
  if (V2.on && v2Has("device") && typeof repaint === "function") repaint();
}

/** Start watching, once, for a screen that reads `device.*`. Safe to call on every paint. */
function v2DeviceStart() {
  if (V2_FACTS_ON) return;
  V2_FACTS_ON = true;
  V2_FACTS = v2ReadFacts();
  const soon = () => { if (V2_RESIZE) clearTimeout(V2_RESIZE); V2_RESIZE = setTimeout(() => { V2_RESIZE = null; v2FactsChanged(); }, 120); };
  try {
    window.addEventListener("resize", soon);
    window.addEventListener("online", v2FactsChanged);
    window.addEventListener("offline", v2FactsChanged);
    document.addEventListener("visibilitychange", v2FactsChanged);
    for (const q of ["(prefers-reduced-motion: reduce)", "(prefers-color-scheme: light)"]) {
      const m = window.matchMedia && window.matchMedia(q);
      if (m && typeof m.addEventListener === "function") m.addEventListener("change", v2FactsChanged);
    }
  } catch { /* an older window: the first reading stands */ }
  // The microphone's answer comes from the main process, and only it can say.
  try {
    if (window.tailzuApp && typeof window.tailzuApp.micStatus === "function") {
      Promise.resolve(window.tailzuApp.micStatus()).then((s) => {
        const word = s === "granted" || s === "denied" || s === "blocked" ? s : "unasked";
        if (V2_FACTS) V2_FACTS.perm = Object.assign({}, V2_FACTS.perm, { mic: word });
        if (V2.on && v2Has("device") && typeof repaint === "function") repaint();
      }).catch(() => undefined);
    }
  } catch { /* the microphone stays unasked */ }
}
