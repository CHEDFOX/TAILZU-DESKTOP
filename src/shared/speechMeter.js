/**
 * HOW MUCH OF A STRETCH WAS A VOICE, measured from the microphone's samples.
 *
 * The pause-flush meter used to ask one question: was the last 10 ms louder
 * than the room? It read a 512-sample snapshot every 120 ms, so it heard about
 * a tenth of the audio, and a breath into the mic, a key clicked beside it or
 * a chair scraping all counted as "speech", 120 ms per lucky snapshot. Enough
 * of those in one stretch and the stretch was uploaded on its own, and a
 * recogniser given only breath writes something anyway: "Thank you.", "Jhal",
 * "जिंदगी में." — pasted into whatever the person was writing.
 *
 * So every sample is read now, in 40 ms frames, and a frame is VOICE only
 * when it is both over the level floor and PERIODIC: a vowel repeats at the
 * pitch of the voice (65 to 500 Hz), in every language, while a breath, a
 * click, a rumble or a fan's hiss does not. Loudness alone is still counted
 * (`loudMs`), for whoever needs "was anything there at all".
 *
 * Plain JavaScript with no dependencies, like knobs.js: recorder.html loads it
 * as a <script> (window.TailzuSpeech), and node --test requires it.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.TailzuSpeech = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /**
   * The strongest repeat in `x[0..n)` at a lag between `lo` and `hi` samples:
   * the normalised autocorrelation, 1 for a perfect repeat, near 0 for noise.
   * Only a local peak counts. A slow rumble correlates with itself at every
   * short lag and falls away steadily, which has no peak inside the range,
   * so it is not mistaken for a very low voice. `r` is scratch space.
   */
  function periodicity(x, n, lo, hi, r) {
    if (hi + 2 >= n || lo < 2) return 0;
    // Prefix sums of x² give each lag's two energies without a second pass.
    const P = r.energy;
    P[0] = 0;
    for (let i = 0; i < n; i++) P[i + 1] = P[i] + x[i] * x[i];
    const c = r.corr;
    for (let t = lo - 1; t <= hi + 1; t++) {
      let s = 0;
      for (let i = 0, m = n - t; i < m; i++) s += x[i] * x[i + t];
      const e = P[n - t] * (P[n] - P[t]);
      c[t] = e > 0 ? s / Math.sqrt(e) : 0;
    }
    let best = 0;
    r.lag = 0;
    for (let t = lo; t <= hi; t++) {
      if (c[t] > best && c[t] >= c[t - 1] && c[t] >= c[t + 1]) { best = c[t]; r.lag = t; }
    }
    return best;
  }

  /** Two pitch periods that are the same note, or an octave apart (which of
   *  the two a tone's peaks wins can flip from frame to frame). */
  function samePitch(a, b) {
    const near = (p, q) => Math.abs(p - q) <= Math.max(1, q * 0.03);
    return near(a, b) || near(a, 2 * b) || near(2 * a, b);
  }

  /**
   * A meter for one microphone. Feed it samples in order, in any chunk size;
   * each call answers how many milliseconds of what it was given were voice
   * and how many were merely loud.
   *
   *   sampleRate  the audio context's rate (44.1 or 48 kHz, usually)
   *   level       RMS floor (0..1): quieter than this is the room
   *   voicing     periodicity floor (0..1); 0 or less counts every loud frame
   *               as voice, which is what the old meter did
   */
  function createSpeechMeter(opts) {
    const rate = opts.sampleRate > 0 ? opts.sampleRate : 48000;
    const level = opts.level > 0 ? opts.level : 0.012;
    const voicing = typeof opts.voicing === "number" ? opts.voicing : 0.5;
    // Pitch is read at about 12 kHz: plenty for 65–500 Hz, and a quarter of
    // the work of reading it at 48.
    const D = Math.max(1, Math.round(rate / 12000));
    const fs = rate / D;
    const frameMs = 40;
    const n = Math.max(8, Math.round(fs * frameMs / 1000));
    const raw = n * D;                           // samples of input per frame
    const ms = (raw / rate) * 1000;
    const lo = Math.max(2, Math.floor(fs / 500)), hi = Math.ceil(fs / 65);
    // The band a voice's pitch lives in, 60 Hz to 1 kHz: a DC blocker (one
    // pole), so an offset or a slow rumble does not repeat at every lag, and
    // a low-pass (a Butterworth biquad), so the ringing of a key or a glass,
    // a pure tone of a few kHz that repeats as well as any vowel, is gone
    // before the repeat is looked for.
    const R = Math.exp(-2 * Math.PI * 60 / fs);
    const w = 2 * Math.PI * Math.min(1000, fs / 4) / fs, al = Math.sin(w) / Math.SQRT2, cw = Math.cos(w);
    const b0 = (1 - cw) / 2 / (1 + al), b1 = (1 - cw) / (1 + al), a1 = -2 * cw / (1 + al), a2 = (1 - al) / (1 + al);
    let px = 0, py = 0, x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    // A voice puts most of its energy under 1 kHz; a breath, a hiss or a
    // click puts most of it above. Under this share, a frame is not a voice
    // however well it repeats.
    const lowShare = typeof opts.lowShare === "number" ? opts.lowShare : 0.25;
    // How much louder one half of a frame may be than the other and still
    // be a held sound.
    const steady = typeof opts.steady === "number" ? opts.steady : 4;

    const pend = new Float32Array(raw);
    let fill = 0;
    const x = new Float32Array(n);
    const scratch = { energy: new Float64Array(n + 1), corr: new Float64Array(hi + 2) };
    // A vowel lasts longer than one frame; a key's thump does not. A voiced
    // frame counts only beside another.
    let lastVoiced = false, lastCounted = false;
    // A voice never holds one pitch at one loudness for long: syllables rise
    // and fall by several dB a few times a second. A hum, a buzz or a fan's
    // whine holds both for ever. Sound that stays on one pitch, within 2 dB
    // and without a quiet moment, for this long is a machine: what it had
    // been counted as voice is taken back, and it is only loud from then on.
    const holdFrames = Math.ceil((opts.holdMs > 0 ? opts.holdMs : 1500) / ms);
    let anchor = 0, anchorRms = 0, held = 0, heldMs = 0, machine = false, frameRms = 0;

    /** 0 quiet, 1 loud, 2 voice. */
    function frame() {
      // Loudness about the frame's own mean, so a microphone with a DC
      // offset is not "loud" forever.
      let sum = 0;
      for (let i = 0; i < raw; i++) sum += pend[i];
      const mean = sum / raw;
      let sq = 0;
      for (let i = 0; i < raw; i++) { const d = pend[i] - mean; sq += d * d; }
      // Decimated and filtered every frame, loud or not, so the filters'
      // state is continuous and a loud frame does not start on a jump.
      let early = 0, late = 0;
      for (let j = 0; j < n; j++) {
        let s = 0;
        for (let k = j * D, e = k + D; k < e; k++) s += pend[k];
        const v = s / D;
        py = v - px + R * py; px = v;
        const y = b0 * py + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = py; y2 = y1; y1 = y;
        x[j] = y;
        if (j < n / 2) early += y * y; else late += y * y;
      }
      frameRms = Math.sqrt(sq / raw);
      if (frameRms <= level) return 0;
      if (voicing <= 0) return 2;
      const low = early + late;
      if (low / n < lowShare * (sq / raw)) return 1;
      // A vowel holds its level across 40 ms; a key's or a desk's thump rings
      // at a low pitch too, but dies within the frame.
      if (Math.min(early, late) * steady < Math.max(early, late)) return 1;
      return periodicity(x, n, lo, hi, scratch) >= voicing ? 2 : 1;
    }

    return {
      frameMs: ms,
      /** Read `samples` (a Float32Array, or any array of -1..1). `voicedMs`
       *  can be negative: a tone first counted as voice and then found to be
       *  a machine's is taken back from the total. */
      feed(samples) {
        let voicedMs = 0, loudMs = 0;
        for (let i = 0; i < samples.length; i++) {
          pend[fill++] = samples[i];
          if (fill !== raw) continue;
          fill = 0;
          let f = frame();
          if (f === 0 || voicing <= 0) { held = 0; heldMs = 0; machine = false; }
          else {
            const same = held > 0 && Math.abs(frameRms - anchorRms) <= anchorRms * 0.25 &&
              (f !== 2 || !anchor || samePitch(scratch.lag, anchor));
            if (same) held++;
            else { held = 1; heldMs = 0; machine = false; anchor = 0; anchorRms = frameRms; }
            if (f === 2 && !anchor) anchor = scratch.lag;
            if (held >= holdFrames && anchor && !machine) { machine = true; voicedMs -= heldMs; heldMs = 0; }
            if (machine) f = 1;
          }
          if (f) loudMs += ms;
          const v = f === 2;
          // The pair is counted when its second frame arrives, the first
          // one too unless it was already counted with the pair before.
          let add = 0;
          if (v && lastVoiced) { add = lastCounted ? ms : 2 * ms; lastCounted = true; }
          else lastCounted = false;
          lastVoiced = v;
          voicedMs += add;
          if (held) heldMs += add;
        }
        return { voicedMs, loudMs };
      },
    };
  }

  return { createSpeechMeter, periodicity };
});
