// Speaking the answer out loud, in the computer's voice or the server's.
"use strict";

let tts = null;   // { ctx, src } while the server's voice plays
// Which sentence is being said. The main process sends the next one when
// this page says the last has been heard, so only the one still being said
// may say so: one stopped by a hush or by a newer sentence is told it was
// interrupted a moment later, and that would let the sentence after the
// newer one in at once and cut it off.
let saying = 0;
function stopSpeaking() {
  saying++;
  try { window.speechSynthesis && speechSynthesis.cancel(); } catch { /* none */ }
  if (tts) { try { tts.src && tts.src.stop(); } catch { /* ended */ } try { tts.ctx.close(); } catch { /* closed */ } tts = null; }
  blip.speaking(false);
}
function speak(m) {
  stopSpeaking();
  const n = saying;
  let over = false;
  const done = () => { if (over || n !== saying) return; over = true; blip.speaking(false); bridge.spoken(); };
  // The server's voice, when the main process fetched it (/v1/speak, the
  // read-aloud voice chosen in Settings, in whatever language the answer is
  // in), played through Web Audio as the desk plays it: no blob: URL.
  if (m.audio) {
    const ctxA = new AudioContext();
    const mine = tts = { ctx: ctxA, src: null };
    const bytes = m.audio instanceof ArrayBuffer ? m.audio : new Uint8Array(m.audio).buffer;
    ctxA.decodeAudioData(bytes.slice(0)).then((buf) => {
      if (tts !== mine) return;
      const src = ctxA.createBufferSource();
      src.buffer = buf; src.connect(ctxA.destination);
      src.onended = () => { if (tts === mine) { try { ctxA.close(); } catch { /* closed */ } tts = null; } done(); };
      mine.src = src; src.start();
      blip.speaking(true);
    }).catch(() => { if (tts === mine) { try { ctxA.close(); } catch { /* closed */ } tts = null; } builtIn(); });
    return;
  }
  builtIn();
  function builtIn() {
    // The built-in voice, with a real locale; none for that locale, and
    // the answer is only read, never said in the wrong voice. (Audio that
    // would not decode falls back to it, and by then a newer sentence may
    // be the one being said: this one is then not said at all.)
    if (n !== saying) return;
    if (!m.speak || !window.speechSynthesis) return done();
    const u = new SpeechSynthesisUtterance(m.text);
    if (m.locale) {
      const loc = String(m.locale).toLowerCase();
      const v = speechSynthesis.getVoices().find((x) => x.lang && x.lang.toLowerCase().replace("_", "-").startsWith(loc));
      if (!v && !loc.startsWith("en")) return done();
      u.lang = m.locale;
      if (v) u.voice = v;
    }
    u.rate = typeof m.rate === "number" ? m.rate : 1;
    u.onstart = () => { if (n === saying) blip.speaking(true); };
    u.onend = u.onerror = done;
    speechSynthesis.speak(u);
  }
}
