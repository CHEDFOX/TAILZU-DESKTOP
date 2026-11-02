// The review page (pill.html?demo): a scripted run over a mock document.
"use strict";

if (DEMO) {
  const BARE = q.has("bare");   // the pill alone, over whatever the page behind it is
  if (!BARE) document.body.className = "demo";
  if (!BARE) document.body.insertAdjacentHTML("afterbegin", `<div class="doc"><div class="bar"><i style="left:14px"></i><i style="left:30px"></i><i style="left:46px"></i></div>
    <h4>Standup notes</h4><p>Design review moved to Thursday.</p><p id="line"><span id="typed"></span><span class="caret"></span></p></div>`);
  const SENT = "Can we push the call to four? The deck needs one more pass.";
  // Then a question (?demo=ask: only that): Ask's phases as ask.js sends
  // them, and rest again when main does, foldMs + 80 after the close.
  const ASK = [["askListening", 0], ["askThinking", 2.0], ["askShowing", 3.2], ["askClosing", 5.6], ["rest", 6.3]];
  const ONLY_ASK = q.get("demo") === "ask";
  const script = ONLY_ASK ? [[0, "rest"]].concat(ASK.map(([n, at]) => [0.8 + at, n]))
    : [[0, "rest"], [1.1, "hover"], [2.2, "listening"], [6.9, "writing"], [7.9, "done"], [9.4, "rest"], [10.6, "listening2"], [12.2, "error"]]
      .concat(ASK.map(([n, at]) => [15.2 + at, n]));
  const LOOP = ONLY_ASK ? 8 : 22.5;
  let step = -1;
  const speech = (t) => {           // syllables: bursts with gaps, as a voice has
    const syl = Math.max(0, Math.sin(t * 11.5)) * (0.55 + 0.45 * Math.sin(t * 2.3 + 1)) * (Math.sin(t * 0.9) > -0.6 ? 1 : 0.05);
    return syl;
  };
  window.__demo = (t) => {
    const s = script.reduce((k, [at], i) => (t >= at ? i : k), 0);
    if (s !== step) {
      step = s; const name = script[s][1];
      const typed = document.getElementById("typed");
      if (name === "rest") { setHover(false); onPill({ state: "rest", hint: "Tap Ctrl twice to talk", rest: true }); if (typed) typed.textContent = t > 9 ? SENT : ""; }
      if (name === "hover") { hovered = true; wake(); }
      if (name === "listening" || name === "listening2") { hovered = false; onPill({ state: "listening" }); }
      if (name === "writing") onPill({ state: "writing" });
      if (name === "done") { onPill({ state: "done", words: 12 }); }
      if (name === "error") onPill({ state: "error", label: "Didn't catch that" });
      if (name.startsWith("ask")) { setHover(false); onPill({ state: "ask", phase: name.slice(3).toLowerCase() }); }
    }
    const name = script[step][1];
    if (name === "listening") {
      // At the levels the recorder sends for a real voice (the loud bands sit
      // near 1 while someone talks), not a whisper: a review that showed the
      // thread barely moving was showing a voice nobody has.
      const lt = t - 2.2, v = lt > 0.4 && lt < 4.4 ? Math.min(1, 0.3 + 0.9 * speech(lt)) : 0.02;
      const b = []; for (let i = 0; i < 16; i++) b.push(clamp(v * (1 - i * 0.045) * (0.75 + 0.25 * Math.sin(lt * 17 + i * 1.7))));
      onLevel({ bands: b });
      if (Math.abs(lt - 2.6) < 0.02) { flashAt = clock(); }
    }
    if (name === "done") {
      const p = clamp((t - 7.9) / 0.9);
      const typed = document.getElementById("typed"); if (typed) typed.textContent = SENT.slice(0, Math.round(SENT.length * outCubic(p)));
    }
  };
  // The review page sets a state of its own (a route's label, say): window.__pill({ state: "routed", label, alt }).
  window.__pill = (m) => { step = 1e9; onPill(m); frame(); };
  window.__level = (b) => onLevel({ bands: b });
  if (CAPTURE) {
    window.__step = (ms) => { virtual += ms; if (step !== 1e9) window.__demo(virtual / 1000); frame(); };
    window.__ready = true;
    virtual = 0; last = 0; window.__demo(0); frame();
  } else {
    const t0 = performance.now();
    (function tick() { window.__demo(((performance.now() - t0) / 1000) % LOOP); requestAnimationFrame(tick); })();
  }
}
