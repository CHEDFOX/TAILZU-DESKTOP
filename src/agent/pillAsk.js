// A question grows out of the pill: its halves part, and the guide's thread
// rises from the gap to the card (pill/ "ask", guide/ dock). These two
// are main.js's rules for that (pillAsk), kept here, without Electron, so
// they can be tested.

const PILL_PHASES = new Set(["listening", "thinking", "showing", "closing"]);

/**
 * What a question may do with the pill, given what the pill is doing now
 * (`now`: { state: main's pill state, recording, first }). `first`: this
 * is a question's first phase (its card's show).
 *
 * DICTATION ALWAYS WINS THE PILL. While one records or writes, nothing
 * changes. Closing, and giving it back (null), touch only a pill that is
 * still the question's: a dictation that started meanwhile owns it, and
 * putting it back to rest under that dictation would hide it listening.
 *
 *   null     leave it as it is
 *   "rest"   give it back
 *   "ask"    the next phase of the question that has it
 *   "take"   the first phase: put on the display under the cursor first
 *
 * A new question asked while the last card is still up or folding finds the
 * pill already "ask", and is still a first phase: it is put under the cursor
 * again, or the new card opened on the display the last one was on, while
 * they looked at another.
 */
function pillAskMove(phase, now) {
  const o = now || {};
  if (o.recording || o.state === "listening" || o.state === "writing") return null;
  if (phase == null) return o.state === "ask" ? "rest" : null;
  if (!PILL_PHASES.has(phase)) return null;
  if (o.state === "ask") return o.first && phase !== "closing" ? "take" : "ask";
  return phase === "closing" ? null : "take";
}

/**
 * The pill's capsule in screen DIP, for a pill window whose bounds are `b`:
 * centred across it, its bottom desktop.pill.bottomPad above the window's,
 * exactly where pill/ draws it, from the same knobs pill/ reads. The
 * small pill's size when the capsule look is off, or the Bots look is on.
 */
function capsuleRect(b, K, dx = 0) {
  if (!b || ![b.x, b.y, b.width, b.height].every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  // The Bots look (bots.app) has no capsule: the small white pill (pill/bots.js botsTargets).
  const capsule = !K.bool("bots.app", false) && K.bool("desktop.pill.split", true) && K.bool("desktop.pill.capsule", true);
  const w = capsule ? K.num("desktop.pill.capsuleWidth", 40) : K.num("desktop.pill.restWidth", 46);
  const h = capsule ? K.num("desktop.pill.capsuleHeight", 16) : K.num("desktop.pill.restHeight", 14);
  // dx: where the pill is along its window, from the middle (the Bots look's pill is wherever Blip stands).
  return { x: b.x + b.width / 2 + (Number.isFinite(dx) ? dx : 0) - w / 2, y: b.y + b.height - K.num("desktop.pill.bottomPad", 14) - h, w, h };
}

module.exports = { pillAskMove, capsuleRect };
