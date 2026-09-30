// node --test
//
// What the pause meter must call a voice, and what it must not. The sounds are
// made here rather than recorded: a vowel is pulses at a pitch through three
// formants; a breath, a fan, a keyboard, a rumble and mains hum are what sat
// next to real dictations and were uploaded as if they were speech.

const test = require("node:test");
const assert = require("node:assert");
const { createSpeechMeter } = require("./speechMeter.js");

// ---- sounds ------------------------------------------------------------------
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const gauss = (r) => { let u = 0; for (let i = 0; i < 6; i++) u += r(); return (u - 3) / Math.SQRT2; };
function scale(o, rms) { let s = 0; for (const v of o) s += v * v; const k = rms / Math.sqrt(s / o.length || 1); for (let i = 0; i < o.length; i++) o[i] *= k; return o; }
function peak(o, p) { let m = 0; for (const v of o) m = Math.max(m, Math.abs(v)); for (let i = 0; i < o.length; i++) o[i] *= p / (m || 1); return o; }
const len = (sr, s) => Math.round(sr * s);

function vowel(sr, s, f0, rms, seed = 1) {
  const r = rng(seed), o = new Float32Array(len(sr, s));
  const res = [700, 1200, 2600].map((f, i) => { const R = Math.exp(-Math.PI * (80 + 40 * i) / sr); return { a1: 2 * R * Math.cos(2 * Math.PI * f / sr), a2: -R * R, y1: 0, y2: 0 }; });
  let ph = 0;
  for (let i = 0; i < o.length; i++) {
    ph += f0 * (1 + 0.03 * Math.sin(2 * Math.PI * 5 * i / sr) + 0.01 * gauss(r)) / sr;
    let src = 0.02 * gauss(r);
    if (ph >= 1) { ph -= 1; src += 1; }
    for (const q of res) { const v = src + q.a1 * q.y1 + q.a2 * q.y2; q.y2 = q.y1; q.y1 = v; o[i] += v; }
  }
  return scale(o, rms);
}
/** Syllables: 180 ms vowels at a wandering pitch with 70 ms gaps, as a sentence. */
function sentence(sr, s, rms, f0 = 140) {
  const o = new Float32Array(len(sr, s)), syl = len(sr, 0.18), gap = len(sr, 0.07);
  for (let t = 0, k = 0; t + syl < o.length; t += syl + gap, k++) o.set(vowel(sr, 0.18, f0 * (1 + 0.15 * Math.sin(k)), rms, k + 1), t);
  return o;
}
function noise(sr, s, rms, seed = 2) { const r = rng(seed), o = new Float32Array(len(sr, s)); for (let i = 0; i < o.length; i++) o[i] = gauss(r); return scale(o, rms); }
function breath(sr, s, rms, seed = 3) {
  const r = rng(seed), o = new Float32Array(len(sr, s)); let px = 0, py = 0;
  for (let i = 0; i < o.length; i++) { const x = gauss(r); py = x - px + 0.9 * py; px = x; o[i] = py * Math.sin(Math.PI * i / o.length); }
  return scale(o, rms);
}
function fan(sr, s, rms, seed = 4) { const r = rng(seed), o = new Float32Array(len(sr, s)); let y = 0; for (let i = 0; i < o.length; i++) { y = 0.97 * y + 0.03 * gauss(r); o[i] = y; } return scale(o, rms); }
/** Keys: a click, a ring at a few kHz, and a thump at 100–250 Hz, `rate` a second. */
function typing(sr, s, p, rate, seed = 5) {
  const r = rng(seed), o = new Float32Array(len(sr, s));
  for (let t = len(sr, 0.02); t < o.length; t += len(sr, (0.6 + 0.8 * r()) / rate)) {
    const fh = 1500 + 4500 * r(), fl = 100 + 150 * r();
    for (let k = 0; k < sr * 0.05 && t + k < o.length; k++) {
      const u = k / sr;
      o[t + k] += (u < 0.002 ? gauss(r) : 0) + 0.8 * Math.exp(-u / 0.005) * Math.sin(2 * Math.PI * fh * u) + 0.6 * Math.exp(-u / 0.015) * Math.sin(2 * Math.PI * fl * u);
    }
  }
  return peak(o, p);
}
function tone(sr, s, rms, ...freqs) { const o = new Float32Array(len(sr, s)); for (let i = 0; i < o.length; i++) for (const f of freqs) o[i] += Math.sin(2 * Math.PI * f * i / sr); return scale(o, rms); }
function join(...parts) { const o = new Float32Array(parts.reduce((a, p) => a + p.length, 0)); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; }
function mix(a, b) { const o = Float32Array.from(a); for (let i = 0; i < Math.min(a.length, b.length); i++) o[i] += b[i]; return o; }

/** Meter `sig` the way the recorder does, in 120 ms reads. */
function meter(sig, sr = 48000, opts = {}) {
  const m = createSpeechMeter(Object.assign({ sampleRate: sr, level: 0.012, voicing: 0.5 }, opts));
  let voicedMs = 0, loudMs = 0;
  for (let i = 0, step = len(sr, 0.12); i < sig.length; i += step) {
    const r = m.feed(sig.subarray(i, i + step)); voicedMs += r.voicedMs; loudMs += r.loudMs;
  }
  return { voicedMs: Math.round(voicedMs), loudMs: Math.round(loudMs) };
}

// ---- a voice -------------------------------------------------------------------
test("a held vowel is voice, from a low man's pitch to a child's", () => {
  for (const f0 of [70, 100, 140, 200, 280, 380, 450]) {
    assert.ok(meter(vowel(48000, 1, f0, 0.05, f0)).voicedMs >= 900, "f0 " + f0);
  }
});

test("a sentence is mostly voice, at every common sample rate", () => {
  for (const sr of [16000, 44100, 48000]) {
    const { voicedMs } = meter(sentence(sr, 3, 0.05), sr);
    assert.ok(voicedMs >= 1200, sr + " Hz: " + voicedMs);
  }
});

test("a quiet voice over a fan, or with typing under it, is still a voice", () => {
  assert.ok(meter(mix(sentence(48000, 3, 0.03), fan(48000, 3, 0.01))).voicedMs >= 1000);
  assert.ok(meter(mix(sentence(48000, 3, 0.05), typing(48000, 3, 0.3, 8))).voicedMs >= 1000);
});

test("how the audio is chunked changes nothing", () => {
  const sig = join(sentence(48000, 2, 0.05), noise(48000, 1, 0.05));
  const whole = createSpeechMeter({ sampleRate: 48000, level: 0.012, voicing: 0.5 }).feed(sig);
  assert.deepStrictEqual(meter(sig), { voicedMs: Math.round(whole.voicedMs), loudMs: Math.round(whole.loudMs) });
});

// ---- not a voice -------------------------------------------------------------------
test("breath, hiss, a fan and a keyboard are loud but not voice", () => {
  const cases = {
    breath: join(breath(48000, 0.8, 0.08, 7), breath(48000, 1, 0.05, 8), breath(48000, 0.6, 0.1, 9)),
    hiss: noise(48000, 2, 0.2),
    fan: fan(48000, 2, 0.05),
    "typing 5/s": typing(48000, 3, 0.9, 5, 14),
    "typing 8/s": typing(48000, 3, 0.4, 8),
    "typing 12/s": typing(48000, 3, 0.4, 12, 13),
  };
  for (const [name, sig] of Object.entries(cases)) {
    const r = meter(sig);
    assert.ok(r.loudMs >= 800, name + " should be loud: " + r.loudMs);
    assert.strictEqual(r.voicedMs, 0, name);
  }
});

test("rumble and mains hum repeat, but not at a voice's pitch", () => {
  assert.strictEqual(meter(tone(48000, 2, 0.05, 22, 37)).voicedMs, 0);
  assert.strictEqual(meter(tone(48000, 2, 0.05, 50)).voicedMs, 0);
  assert.strictEqual(meter(tone(48000, 2, 0.05, 60)).voicedMs, 0);
});

test("a machine's steady tone at a voice's pitch is taken back once it holds", () => {
  for (const freqs of [[150], [50, 150], [60, 180], [100, 200, 300], [220]]) {
    const r = meter(tone(48000, 3, 0.05, ...freqs));
    assert.ok(r.loudMs >= 2900, String(freqs));
    assert.strictEqual(r.voicedMs, 0, String(freqs));
  }
  // …and a voice speaking over the buzz is still heard.
  assert.ok(meter(mix(sentence(48000, 3, 0.06), tone(48000, 3, 0.01, 50, 150))).voicedMs >= 1000);
});

test("a monotone speaker is not a machine: syllables rise and fall", () => {
  // One pitch throughout, no gaps between syllables, only the loudness
  // moving at a speaking rate of four syllables a second.
  const v = vowel(48000, 4, 120, 0.05, 21);
  for (let i = 0; i < v.length; i++) v[i] *= 0.35 + 0.65 * Math.abs(Math.sin(Math.PI * 4 * i / 48000));
  assert.ok(meter(v).voicedMs >= 2000);
});

test("a click-short sound is not a word", () => {
  const blip = join(noise(48000, 0.3, 0.0005), vowel(48000, 0.06, 150, 0.05), noise(48000, 0.3, 0.0005));
  assert.strictEqual(meter(blip).voicedMs, 0);
});

test("the room, and a microphone with a DC offset, are quiet", () => {
  assert.deepStrictEqual(meter(noise(48000, 2, 0.0005)), { voicedMs: 0, loudMs: 0 });
  assert.deepStrictEqual(meter(noise(48000, 2, 0.0005).map((v) => v + 0.05)), { voicedMs: 0, loudMs: 0 });
  assert.deepStrictEqual(meter(new Float32Array(96000)), { voicedMs: 0, loudMs: 0 });
});

test("voicing 0 is the old meter: every loud stretch counts", () => {
  assert.ok(meter(noise(48000, 2, 0.05), 48000, { voicing: 0 }).voicedMs >= 1900);
});
