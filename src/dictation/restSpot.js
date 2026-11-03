// Where Blip rests between dictations, and when (main process). The rest window (rest/) draws him.
//
// After a while with no command (desktop.rest.afterMs) he rests against the right edge of the screen, a little below the middle: clear of the menu bar, the Dock and
// the taskbar, the screen's corners, and where notifications come up (top right on a Mac, bottom right on Windows,
// top middle on Ubuntu). Over an app only his antenna shows, and every few seconds his head peeks out. He ducks out
// of sight when the pointer comes near, and he is in no screen share or recording (the window's content protection).
"use strict";

const REST_W = 96;
const REST_H = 120;
/** How far down the work area his middle is. */
const REST_AT = 0.58;
/** Closer than this (px, to the window's box) and he ducks. */
const NEAR_PX = 90;

/** The rest window's bounds on a work area: against its right edge, its middle REST_AT of the way down. */
function restBounds(workArea, o = {}) {
  const w = o.w || REST_W, h = o.h || REST_H, at = o.at == null ? REST_AT : o.at;
  const top = workArea.y, bottom = workArea.y + workArea.height - h;
  const y = Math.round(Math.max(top, Math.min(bottom, workArea.y + workArea.height * at - h / 2)));
  return { x: Math.round(workArea.x + workArea.width - w), y, width: w, height: h };
}

/** The pointer is near enough to the window's box that he should get out of its way. */
function pointerNear(p, b, px = NEAR_PX) {
  if (!p || !b) return false;
  const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.width));
  const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.height));
  return Math.hypot(dx, dy) < px;
}

/** He rests at the edge now: switched on, the pill shown and at rest, and at rest for afterMs (idleMs, no command
 *  since). A dictation or a question takes the pill out of rest, and the wait starts again after it. */
function restsNow(s) {
  return !!(s && s.on && s.pillOn && s.pillState === "rest" && (s.idleMs == null || s.idleMs >= (s.afterMs || 0)));
}

module.exports = { restBounds, pointerNear, restsNow, REST_W, REST_H, REST_AT, NEAR_PX };
