// Talk mode's voice (talk.js): Blip's answer said out loud, a sentence at a
// time, in the computer's voice or the server's, as the guide says Ask's
// (agent/guide/speech.js). Main sends { say } and { hush }; each sentence
// said is reported back (pill:spoken), and main sends the next.
"use strict";

let voiceTts = null;   // { ctx, src } while the server's voice plays
// Which sentence is being said: one stopped by a hush or a newer one is not reported as said.
let voiceSaying = 0;
function hushVoice() {
  voiceSaying++;
  try { window.speechSynthesis && speechSynthesis.cancel(); } catch { /* none */ }
  if (voiceTts) { try { voiceTts.src && voiceTts.src.stop(); } catch { /* ended */ } try { voiceTts.ctx.close(); } catch { /* closed */ } voiceTts = null; }
}
function sayVoice(m) {
  hushVoice();
  const n = voiceSaying;
  let over = false;
  const done = () => { if (over || n !== voiceSaying) return; over = true; if (bridge && bridge.pillSpoken) bridge.pillSpoken(m.id); };
  // The server's voice, when main fetched it (/v1/speak), through Web Audio: no blob: URL.
  if (m.audio) {
    const ctxA = new AudioContext();
    const mine = voiceTts = { ctx: ctxA, src: null };
    const bytes = m.audio instanceof ArrayBuffer ? m.audio : new Uint8Array(m.audio).buffer;
    ctxA.decodeAudioData(bytes.slice(0)).then((buf) => {
      if (voiceTts !== mine) return;
      const src = ctxA.createBufferSource();
      src.buffer = buf; src.connect(ctxA.destination);
      src.onended = () => { if (voiceTts === mine) { try { ctxA.close(); } catch { /* closed */ } voiceTts = null; } done(); };
      mine.src = src; src.start();
    }).catch(() => { if (voiceTts === mine) { try { ctxA.close(); } catch { /* closed */ } voiceTts = null; } builtIn(); });
    return;
  }
  builtIn();
  function builtIn() {
    // The built-in voice, with a real locale; none for that locale, and the
    // answer is only shown, never said in the wrong voice.
    if (n !== voiceSaying) return;
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
    u.onend = u.onerror = done;
    speechSynthesis.speak(u);
  }
}
