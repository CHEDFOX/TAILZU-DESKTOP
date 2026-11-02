// How every window of ours is made and placed: its web preferences, the
// hardening each one gets, and the bounds of the floating ones (the caption
// overlay, the pill) on the display.

const { screen } = require("electron");
const path = require("path");
const { num, bool } = require("../../knobs.js");

/** What every window of ours runs with: the bridge in preload.js and nothing
 *  else — no Node, an isolated world, Chromium's sandbox. */
const webPrefs = (extra) => Object.assign({
  preload: path.join(__dirname, "preload.js"),
  contextIsolation: true, nodeIntegration: false, sandbox: true,
}, extra);

/** A window no bigger than the display it opens on, and placed inside it.
 *  Sizes are in points, and a 1080p laptop at Windows' recommended 150% has
 *  1280×720 of them, 672 above the taskbar — so the 1120×780 window opened
 *  with its foot below the screen's edge, and whatever sat there could not be
 *  reached. (Microsoft Store certification, policy 10.1.2.10, at 150%.) The
 *  display is the one the pointer is on, like the pill's. */
function fitToDisplay(width, height) {
  const margin = num("desktop.window.screenMargin", 24);
  let wa;
  try { wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea; } catch { wa = null; }
  if (!wa || !(wa.width > 0) || !(wa.height > 0)) return { width, height };
  const w = Math.max(320, Math.min(width, wa.width - margin));
  const h = Math.max(400, Math.min(height, wa.height - margin));
  return { width: w, height: h, x: Math.round(wa.x + (wa.width - w) / 2), y: Math.round(wa.y + (wa.height - h) / 2) };
}

/** Deny navigation + popups on our local windows — they only ever load our own
 *  files, so anything else is a bug or an injection attempt. */
function hardenWindow(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // A reload is a navigation to the page's own URL, and the guard was
  // swallowing it too — so "Sign out", which clears the session and reloads
  // the window to land on the gate, cleared the session and did nothing
  // anyone could see. The page may go back to itself; nowhere else.
  win.webContents.on("will-navigate", (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault();
  });
}

// A small always-on-top strip near the bottom of the screen that shows the
// words as you speak (live mode). Click-through + non-focusable so it can never
// steal the paste target.
/** Near the foot of the display the pointer is on, like the pill. It was
 *  always the primary display, wherever the person was writing. */
function overlayBounds() {
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const w = num("desktop.overlay.width", 560), h = num("desktop.overlay.height", 84);
  return { width: w, height: h, x: Math.round(wa.x + (wa.width - w) / 2),
    y: wa.y + wa.height - num("desktop.overlay.bottomOffset", 120) };
}

/** Bottom-centre of a display's work area, so above the taskbar or the Dock
 *  wherever they sit: by default the display the pointer is on, where the
 *  person is. */
function pillBounds(display) {
  const wa = (display || screen.getDisplayNearestPoint(screen.getCursorScreenPoint())).workArea;
  // AS WIDE AS THE SCREEN when the pill comes apart while it listens: ✕ to
  // one edge, ✓ to the other, the thread between (pill.js, pillSplit.js).
  // Transparent and click-through everywhere but the pill or its two halves,
  // so the strip it spans stays the app's below it. A cap keeps it from
  // reaching across an ultrawide; 0 is the whole work area.
  const cap = num("desktop.pill.splitMaxWidth", 0);
  const w = bool("desktop.pill.split", true) ? Math.round(cap > 0 ? Math.min(wa.width, cap) : wa.width)
    : num("desktop.pill.windowWidth", 420);
  const h = num("desktop.pill.windowHeight", 132);
  return { width: w, height: h, x: Math.round(wa.x + (wa.width - w) / 2),
    y: Math.round(wa.y + wa.height - h - num("desktop.pill.bottomOffset", 4)) };
}

/** setBounds, checked. On Windows a move between two monitors at different
 *  scaling (a laptop at 150% beside a monitor at 100%) can land the window
 *  at the size it had in the old monitor's pixels; asked again from the new
 *  monitor, it lands right. */
function setBoundsExactly(w, b) {
  try {
    w.setBounds(b);
    const got = w.getBounds();
    if (got.x !== b.x || got.y !== b.y || got.width !== b.width || got.height !== b.height) w.setBounds(b);
  } catch { /* keep its place */ }
}

module.exports = { webPrefs, fitToDisplay, hardenWindow, overlayBounds, pillBounds, setBoundsExactly };
