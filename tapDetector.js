// Double-tap on a modifier, without the false positives that make one unusable.
//
// Ctrl is a modifier before it is anything else, so "count the presses" fires
// dictation on Ctrl+C Ctrl+V — the commonest pair of keystrokes there is. Three
// guards stand between a press and a gesture, and every one of them was put
// here by a way the key misfired:
//
//   clean      any other key going down while this one is held means it was a
//              chord, not a tap.
//   hold       a press longer than a moment was someone holding the modifier,
//              even if they never pressed a second key.
//   repeat     AND THE ONE THAT COSTS YOU THE KEY ENTIRELY. Windows repeats a
//              held key, and the hook reports each repeat as another press and
//              release — each one short, each one clean. Two of them inside the
//              pair window is a double-tap by every test above, so holding Ctrl
//              for a second started dictation, and holding it again stopped it.
//              A finger cannot press a key again thirty milliseconds after
//              letting go of it; the machine can only do it that fast. So a
//              press that follows its own release faster than a hand could is
//              not a tap, and it kills the whole train it belongs to rather
//              than only itself.
//
// Split out of main.js to be testable: the misfire above is a sequence of
// events with timings, which is the one thing a global key hook cannot be
// asked to reproduce on demand.

/** A tap is this short. Longer and the key was being HELD — as a modifier. */
const TAP_MAX_HOLD_MS = 350;
/** Two taps this close are one gesture. Comfortably slower than a deliberate
 *  double-tap, far faster than two separate uses of the key. */
const TAP_GAP_MS = 400;
/** And this far apart at the very least. Below it, the key is repeating: the
 *  fastest deliberate double-tap is around a tenth of a second, and a key
 *  repeating under Windows comes back roughly every thirty milliseconds. */
const TAP_MIN_GAP_MS = 70;

/**
 * @param {object} opts
 * @param {string[]} opts.names       group names to watch ("Ctrl", "Alt")
 * @param {(name: string) => void} opts.onPair  called once per double-tap
 * @param {() => number} [opts.now]   injectable clock, for the tests
 */
function createTapDetector(opts) {
  const onPair = opts.onPair;
  const now = opts.now || Date.now;
  const maxHold = opts.maxHoldMs == null ? TAP_MAX_HOLD_MS : opts.maxHoldMs;
  const gap = opts.gapMs == null ? TAP_GAP_MS : opts.gapMs;
  const minGap = opts.minGapMs == null ? TAP_MIN_GAP_MS : opts.minGapMs;

  // One state per name, so a pair is always the SAME key twice. One shared
  // timer would fire on Ctrl-then-Alt, which is not a gesture anyone is making
  // on purpose.
  const state = new Map(
    opts.names.map((n) => [n, { lastTapAt: 0, downAt: 0, upAt: 0, clean: false, repeating: false }]),
  );

  /** @param {string|null} name  null for any key that is not being watched. */
  function keyDown(name) {
    if (!name) {
      // Something else went down. Every key in flight was part of a chord, not
      // a tap — including the one on the OTHER watcher, because Alt+Ctrl+T must
      // not leave either half half-armed.
      for (const s of state.values()) s.clean = false;
      return;
    }
    const s = state.get(name);
    if (!s) return;
    const t = now();
    if (s.upAt && t - s.upAt < minGap) {
      // The key is repeating under a finger that never lifted. Everything until
      // it is genuinely released is the same press.
      s.repeating = true;
      s.lastTapAt = 0;
    } else if (!s.downAt) {
      s.repeating = false;
    }
    if (!s.downAt) {
      s.downAt = t;
      s.clean = true;
    }
  }

  /** @param {string|null} name */
  function keyUp(name) {
    const s = name ? state.get(name) : null;
    if (!s) return;
    const t = now();
    // A release with no press behind it — the hook missed one, or the key went
    // down while another window had the hook. It is not a tap either way.
    const held = s.downAt ? t - s.downAt : Infinity;
    s.downAt = 0;
    s.upAt = t;
    if (s.repeating || !s.clean || held > maxHold) {
      s.lastTapAt = 0;
      return;
    }
    if (s.lastTapAt && t - s.lastTapAt <= gap) {
      s.lastTapAt = 0;
      onPair(name);
      return;
    }
    s.lastTapAt = t;
    // A tap on one key is not half a pair on another.
    for (const [other, o] of state) if (other !== name) o.lastTapAt = 0;
  }

  return { keyDown, keyUp };
}

module.exports = { createTapDetector, TAP_MAX_HOLD_MS, TAP_GAP_MS, TAP_MIN_GAP_MS };
