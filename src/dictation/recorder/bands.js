// The voice, band by band, for the pill.
//
// Its own analyser on the same stream, separate from the pause meter, so
// the bars move whether or not pausing writes. Bands are spaced the way
// an ear hears (low voice in the first), each 0..1, sent a few dozen
// times a second and only while this session is the live one.
let bandCtx = null, bandTimer = null;
function startBands(sid, src) {
  if (!src || !window.tailzu.level) return;
  try {
    bandCtx = new (window.AudioContext || window.webkitAudioContext)();
    const an = bandCtx.createAnalyser();
    an.fftSize = K.num("desktop.pill.fftSize", 1024);
    an.smoothingTimeConstant = K.num("desktop.pill.smoothing", 0.55);
    bandCtx.createMediaStreamSource(src).connect(an);
    const bins = new Uint8Array(an.frequencyBinCount), hz = bandCtx.sampleRate / an.fftSize;
    const N = Math.max(4, Math.min(24, K.num("desktop.pill.bands", 12)));
    const lo = K.num("desktop.pill.lowHz", 90), hi = K.num("desktop.pill.highHz", 4200);
    const floor = K.num("desktop.pill.floorDb", 30), span = K.num("desktop.pill.spanDb", 150);
    const edges = Array.from({ length: N + 1 }, (_, i) => Math.round(lo * Math.pow(hi / lo, i / N) / hz));
    // Silence is sent once, not thirty times a second through two
    // processes: the pill lets bars fall by itself when the voice stops.
    let quiet = false;
    bandTimer = setInterval(() => {
      if (sid !== session) return;
      an.getByteFrequencyData(bins);
      const out = [];
      for (let b = 0; b < N; b++) {
        let m = 0; const a = edges[b], z = Math.max(a + 1, edges[b + 1]);
        for (let i = a; i < z && i < bins.length; i++) m = Math.max(m, bins[i]);
        out.push(Math.max(0, Math.min(1, (m - floor) / span)));
      }
      const silent = out.every((v) => v === 0);
      if (silent && quiet) return;
      quiet = silent;
      window.tailzu.level({ session: sid, bands: out });
    }, K.num("desktop.pill.levelMs", 33));
  } catch { stopBands(); }
}
function stopBands() {
  if (bandTimer) { clearInterval(bandTimer); bandTimer = null; }
  if (bandCtx) { try { bandCtx.close(); } catch {} bandCtx = null; }
}
