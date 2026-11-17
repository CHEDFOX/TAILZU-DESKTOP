/**
 * "HEY X0": WHEN A HEARD WORD IS REALLY THEM, AND WHEN IT IS THE TELEVISION.
 *
 * The decision only. Nothing here opens a microphone, loads a model or touches
 * Electron: it is handed what a local listener thought it heard and what else is
 * going on, and it answers whether to start. So the hard part — which is the
 * policy, not the signal processing — can be read, argued with and tested.
 *
 *   const w = makeWake({ now, settings });
 *   w.context({ recording, askUp, callUp, locked, offLimits });  // arms or disarms
 *   w.heard(0.91)   -> "fire" | "waiting" | "ignored"
 *   w.speech()      -> "fire" | "ignored"
 *   w.tick()        -> "lapsed" | null
 *   w.state()       -> { on, phase, why }
 *
 * WHY A WORD IS NOT ENOUGH. Every always-listening word spotter fires when it
 * should not: a television, a podcast, somebody else's call, a name that sounds
 * near enough. A spotter that never false-fires also never hears a quiet person
 * in a room with a fan. So this takes the spotter's own confidence and decides:
 *
 *   • below `minHeard`            nothing happened. It is not even counted.
 *   • at or above `sureHeard`     them. Fire.
 *   • between the two            maybe. Wait `confirmMs` for SPEECH to follow,
 *                                because a person who says the name goes on to
 *                                ask for something, and a passing mention on a
 *                                television usually does not land in that gap.
 *
 * AND A BRAKE, because the television wins otherwise. More than `restAfter` hits
 * inside `watchMs` and it stops listening for `restMs` and says why. Without this
 * a programme that says the name every minute keeps the microphone open all
 * evening and drains the battery doing it.
 *
 * WHAT IT WILL NOT DO, and these are refusals rather than settings:
 *   • NOT while the microphone is already ours — a dictation running, Ask
 *     answering, a call up. One microphone, and a wake word that interrupted a
 *     dictation would write its own name into what was being said.
 *   • NOT in an app that is off limits (money, health, a password field, X0's
 *     own window: frontApp.offLimits). Listening there means holding audio of
 *     somebody reading out a card number, and no feature is worth that.
 *   • NOT while the machine is locked or the screen is asleep.
 *   • NOT at all unless the person turned it on. Asking for a microphone once is
 *     not permission to listen all day; that is its own switch and its own
 *     sentence, and it starts off.
 *
 * WHAT IS KEPT: nothing. This holds counters and a clock, never audio and never
 * a transcript. The listener is expected to do the same — it hears the word and
 * says so; what came before a fire never leaves the machine.
 *
 * WHAT THIS DOES NOT DO: hear. A local listener has to give it `heard(score)`,
 * and that is native work on each platform (on-device keyword spotting, the
 * microphone open with nothing written down). The interface it must meet is at
 * the foot of this file.
 *
 * Loaded by the main process and by node --test.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.TailzuWake = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  /** The settings, and what each is for. Every one of them is a knob (desktop.wake.*). */
  const DEFAULTS = {
    /** Below this, the listener was not confident enough to count as anything at all. */
    minHeard: 0.45,
    /** At or above this, it was them: fire without waiting. */
    sureHeard: 0.85,
    /** A middling hit waits this long for speech to follow it. */
    confirmMs: 1600,
    /** After a fire, hits are ignored this long, so "hey X0, hey X0" is one start. */
    cooldownMs: 2500,
    /** The brake: more than this many hits inside `watchMs`… */
    restAfter: 4,
    watchMs: 60000,
    /** …and it stops listening this long. */
    restMs: 600000,
  };

  const num = (v, def) => (typeof v === "number" && Number.isFinite(v) ? v : def);

  /** Why it is not listening, in a word, for the pill and the log. Never shown as an error. */
  const OFF = {
    off: "the person has not turned it on",
    recording: "a dictation has the microphone",
    ask: "Ask has the microphone",
    call: "a call has the microphone",
    locked: "the machine is locked",
    limits: "this app is off limits",
    resting: "too many false starts; resting",
  };

  function makeWake(o) {
    const opts = o && typeof o === "object" ? o : {};
    const now = typeof opts.now === "function" ? opts.now : Date.now;
    const s = Object.assign({}, DEFAULTS, opts.settings && typeof opts.settings === "object" ? opts.settings : {});
    for (const k of Object.keys(DEFAULTS)) s[k] = num(s[k], DEFAULTS[k]);

    /** What the rest of the app is doing. Everything here is a reason NOT to listen. */
    let ctx = { on: false, recording: false, askUp: false, callUp: false, locked: false, offLimits: false };
    /** "idle" (armed, nothing heard), "waiting" (a middling hit, waiting for speech), "cooling". */
    let phase = "idle";
    /** When the waiting window or the cooldown ends. */
    let until = 0;
    /** Hit times inside the watch window, for the brake. */
    let hits = [];
    /** When the brake's rest ends; 0 when it is not resting. */
    let restingUntil = 0;

    /** The reason it is not listening, or null when it is. Checked in the order that matters: the person's switch first. */
    function blocked(at) {
      if (!ctx.on) return "off";
      if (restingUntil > at) return "resting";
      if (ctx.recording) return "recording";
      if (ctx.askUp) return "ask";
      if (ctx.callUp) return "call";
      if (ctx.locked) return "locked";
      if (ctx.offLimits) return "limits";
      return null;
    }

    /** Forget a half-heard word: anything that was waiting is dropped, and the clock with it. */
    function clear() { phase = "idle"; until = 0; }

    return {
      /**
       * What else is going on. Called whenever any of it changes; a change that blocks listening also throws away a
       * word that was waiting, because by the time the person speaks the microphone belongs to something else.
       */
      context(next) {
        const n = next && typeof next === "object" ? next : {};
        for (const k of Object.keys(ctx)) if (typeof n[k] === "boolean") ctx[k] = n[k];
        if (blocked(now())) clear();
        return this.state();
      },

      /**
       * The listener thought it heard the word, `score` being how sure it was.
       * "fire" start now · "waiting" a middling hit, speech would confirm it · "ignored" nothing happens, and why is in state().
       */
      heard(score) {
        const at = now();
        const sure = num(score, 0);
        if (blocked(at)) return "ignored";
        // Too quiet to be anything. Not counted against the brake either: a brake fed by noise would rest all day.
        if (sure < s.minHeard) return "ignored";
        // The brake counts every hit that was loud enough to mean something.
        hits = hits.filter((t) => at - t < s.watchMs);
        hits.push(at);
        if (hits.length > s.restAfter) {
          restingUntil = at + s.restMs;
          hits = [];
          clear();
          return "ignored";
        }
        if (phase === "cooling" && until > at) return "ignored";
        if (sure >= s.sureHeard) { phase = "cooling"; until = at + s.cooldownMs; return "fire"; }
        phase = "waiting";
        until = at + s.confirmMs;
        return "waiting";
      },

      /**
       * Speech followed. It confirms a word that was waiting and means nothing otherwise — this is not a second way in,
       * so speech on its own can never start anything.
       */
      speech() {
        const at = now();
        if (phase !== "waiting") return "ignored";
        if (until <= at) { clear(); return "ignored"; }
        if (blocked(at)) { clear(); return "ignored"; }
        phase = "cooling";
        until = at + s.cooldownMs;
        return "fire";
      },

      /** The clock. "lapsed" when a word that was waiting gave up on speech; null otherwise. */
      tick() {
        const at = now();
        if (phase === "waiting" && until <= at) { clear(); return "lapsed"; }
        if (phase === "cooling" && until <= at) clear();
        return null;
      },

      /** Whether it is listening, what it is doing, and why not when it is not. */
      state() {
        const why = blocked(now());
        return { on: !why, phase: why ? "idle" : phase, why: why ? OFF[why] : null, reason: why };
      },

      /** The person turned it off and on again, or a sign-out: everything forgotten, including the brake's rest. */
      reset() { ctx.on = ctx.on; phase = "idle"; until = 0; hits = []; restingUntil = 0; return this.state(); },
    };
  }

  /**
   * WHAT A LISTENER MUST DO, for whoever writes the native half.
   *
   *   start(onHeard)  open the microphone and listen for the word ON THE MACHINE. Call onHeard(score) with 0..1 for how
   *                   sure it is. Never send audio anywhere. Never write audio or a transcript to disk.
   *   speaking()      say, through onSpeech, that somebody is talking: voice activity alone, not words.
   *   stop()          close the microphone. Called the moment anything above blocks listening, so it must be quick.
   *
   * macOS can do the spotting on the device (SFSpeechRecognizer with requiresOnDeviceRecognition, in a helper beside
   * audiotap.swift and tzkey.swift); Windows has Windows.Media.SpeechRecognition. Both want a small always-on process,
   * which is why the brake above matters: it is the difference between a quiet machine and a warm one.
   */
  const LISTENER = ["start", "speaking", "stop"];

  return { makeWake, DEFAULTS, OFF, LISTENER };
});
