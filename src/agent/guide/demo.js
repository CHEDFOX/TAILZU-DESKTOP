// The review page (guide.html?demo=<scene>): every state, scripted, on a mock
// app, for looking at the guide without Ask running.
"use strict";

if (DEMO) faces.then(() => runDemo(params.get("demo")));
function runDemo(scene) {
  document.body.classList.add("demo");
  if (params.has("dark")) document.body.classList.add("dark");
  // The review page's timers run on the page's clock: under ?capture they
  // wait for __step like everything else.
  const timers = [];
  const later = (fn, ms) => { if (!CAPTURE) return setTimeout(fn, ms); timers.push({ at: virtual + ms, fn }); };
  const every = (fn, ms) => { const tick = () => { fn(); later(tick, ms); }; later(tick, ms); };
  function runTimers() {
    for (;;) {
      let i = -1;
      for (let j = 0; j < timers.length; j++) if (timers[j].at <= virtual && (i < 0 || timers[j].at < timers[i].at)) i = j;
      if (i < 0) return;
      const [tm] = timers.splice(i, 1);
      tm.fn();
    }
  }
  const mock = document.createElement("div");
  mock.className = "mock";
  mock.innerHTML = `<div class="bar"><i></i><i></i><i></i><b>Q3 launch — Keynote</b></div>
      <div class="tools"><span>Share</span><span id="m-export">Export</span><span class="primary">Play</span></div>
      <div class="side"><p class="on" id="m-design"># design</p><p># launch</p><p># general</p><p>Priya</p><p>Anthony</p></div>
      <div class="page"><h2>Mockups, round two</h2><div class="ln" style="width:92%"></div><div class="ln" style="width:84%"></div><div class="ln" style="width:66%"></div>
        <div class="fig" id="m-fig"><span>&int;<sub>0</sub><sup>1</sup> x<sup>2</sup> dx = &#8531;</span></div></div>
      <div class="composer" id="m-composer">Message #design<em id="m-send">Send</em></div>`;
  document.body.insertBefore(mock, fx);
  // THE PILL, as main has it while a question is up (pill/ "ask"): its
  // halves parted at the seam, a bead in the gap, amber while it listens.
  // Over this window, as main keeps it, so it hides the tether's first
  // pixels. Drawn on this page's clock, from what the guide is doing.
  const pc = document.createElement("canvas");
  pc.id = "mockpill";
  fx.after(pc);
  const pg = pc.getContext("2d");
  const mp = { x: 0, v: 0, bead: 0, hot: 1, slow: 0 };
  const pillMode = params.get("pill");    // "seed": no pill (the guide's seed); "off": not docked at all
  const pillAt = () => ({ x: Math.round(W / 2 - 20), y: H - S.inset.bottom - 34, w: 40, h: 16 });
  // A dictation under way (?demo=peek, peekdoc): what pill/ shows while
  // it listens, the halves out at the screen's edges and the amber thread
  // the voice plucks between them, the words so far above it.
  const DICT = { on: false, state: "idle", words: "" };
  function dictationPill(t) {
    const P = pillAt(), cy = P.y + P.h / 2, x1 = 30, x2 = W - 30;
    pg.save();
    pg.lineCap = "round"; pg.lineJoin = "round";
    const trace = () => {
      pg.beginPath();
      for (let x = x1; x <= x2; x += 6) {
        const u = (x - x1) / (x2 - x1), env = Math.sin(Math.PI * u);
        const y = cy + PK.level * 9 * env * Math.sin(t * TAU * 5.5 + u * 9) + env * .5 * Math.sin(x * .7 + Math.floor(t * 12) * 3.1);
        if (x === x1) pg.moveTo(x, y); else pg.lineTo(x, y);
      }
    };
    trace(); pg.strokeStyle = "rgba(15,13,11,.12)"; pg.lineWidth = 3; pg.stroke();
    trace(); pg.strokeStyle = "#E8A23C"; pg.lineWidth = 1.6; pg.stroke();
    pg.shadowColor = "rgba(0,0,0,.3)"; pg.shadowBlur = 12; pg.shadowOffsetY = 3;
    pg.fillStyle = "#0F0D0B"; pg.beginPath(); pg.roundRect(x1 - 20, P.y, 20, 16, [8, 2.5, 2.5, 8]); pg.fill();
    pg.fillStyle = "#F3E2C6"; pg.beginPath(); pg.roundRect(x2, P.y, 20, 16, [2.5, 8, 8, 2.5]); pg.fill();
    pg.shadowColor = "transparent";
    // A cream hairline round the ink, so it holds over a dark app too.
    pg.strokeStyle = "rgba(243,226,198,.16)"; pg.lineWidth = 1; pg.beginPath(); pg.roundRect(x1 - 19.5, P.y + .5, 19, 15, [7.5, 2, 2, 7.5]); pg.stroke();
    if (DICT.words) {
      pg.font = '500 13px "Instrument Sans", -apple-system, "Segoe UI", system-ui, sans-serif';
      let w = DICT.words;
      while (w.length > 1 && pg.measureText("…" + w).width > 340) w = w.slice(1);
      if (w !== DICT.words) w = "…" + w.trimStart();
      const tw = pg.measureText(w).width, bx = Math.round(W / 2 - tw / 2 - 14), by = P.y - 46;
      pg.fillStyle = "rgba(21,18,16,.92)"; pg.beginPath(); pg.roundRect(bx, by, tw + 28, 28, 14); pg.fill();
      pg.strokeStyle = "rgba(243,226,198,.14)"; pg.lineWidth = 1; pg.beginPath(); pg.roundRect(bx + .5, by + .5, tw + 27, 27, 13.5); pg.stroke();
      pg.fillStyle = "#F3E2C6"; pg.textBaseline = "middle"; pg.fillText(w, bx + 14, by + 14.5);
    }
    pg.restore();
  }
  demoFrame = (t, dt) => {
    if (pc.width !== Math.round(W * dpr) || pc.height !== Math.round(H * dpr)) {
      pc.width = Math.round(W * dpr); pc.height = Math.round(H * dpr); pc.style.width = W + "px"; pc.style.height = H + "px";
    }
    pg.setTransform(dpr, 0, 0, dpr, 0, 0);
    pg.clearRect(0, 0, W, H);
    if (pillMode) return false;
    if (DICT.on) { dictationPill(t); return true; }
    const P = pillAt(), L = S.life, e = now() - L.at;
    // Open while a question is up; closing, held open while the thread
    // comes home (askCloseDelayMs), then shut on the split's springs.
    const open = S.shown || (!L.open && e < K.num("desktop.pill.askCloseDelayMs", 590));
    const target = open ? 1 : 0, out = target > mp.x;
    if (reduced) { mp.x += (target - mp.x) * (1 - Math.exp(-dt * 18)); mp.v = 0; }
    else { const k = out ? 120 : 240, c = out ? 24 : 16; mp.v += (k * (target - mp.x) - c * mp.v) * dt; mp.x += mp.v * dt; }
    mp.bead += ((open ? 1 : 0) - mp.bead) * (1 - Math.exp(-dt * (open ? 14 : 22)));
    mp.hot += ((S.shown && S.state === "listening" ? 1 : 0) - mp.hot) * (1 - Math.exp(-dt * 9));
    mp.slow += ((S.shown && S.state === "thinking" ? 1 : 0) - mp.slow) * (1 - Math.exp(-dt * 6));
    const gap = 9 * clamp(mp.x, 0, 1.3), cx = P.x + P.w / 2, cy = P.y + P.h / 2, sr = Math.min(2.5, gap / 3);
    pg.save();
    pg.globalAlpha = .8 + .2 * clamp(mp.x * 3);
    pg.shadowColor = "rgba(0,0,0,.3)"; pg.shadowBlur = 14; pg.shadowOffsetY = 4;
    pg.fillStyle = "#0F0D0B"; pg.beginPath(); pg.roundRect(cx - 20 - gap / 2, P.y, 20, 16, [8, sr, sr, 8]); pg.fill();
    pg.fillStyle = "#F3E2C6"; pg.beginPath(); pg.roundRect(cx + gap / 2, P.y, 20, 16, [sr, 8, 8, sr]); pg.fill();
    pg.shadowColor = "transparent";
    pg.strokeStyle = "rgba(243,226,198,.16)"; pg.lineWidth = 1; pg.beginPath(); pg.roundRect(cx - 19.5 - gap / 2, P.y + .5, 19, 15, [7.5, sr, sr, 7.5]); pg.stroke();
    pg.strokeStyle = "rgba(15,13,11,.3)"; pg.beginPath(); pg.roundRect(cx + gap / 2 + .5, P.y + .5, 19, 15, [sr, 7.5, 7.5, sr]); pg.stroke();
    // Under reduced motion it holds still, glow and all, as the pill's does.
    const breath = reduced ? 1 : .5 + .5 * Math.sin(t * TAU / 1.25), pulse = .5 - .5 * Math.cos(t * TAU / 1.8);
    const r = Math.min((gap - 2) / 2, 3.5 * mp.bead * (reduced ? 1 : 1 - .22 * mp.hot * (1 - breath) - .1 * mp.slow * (1 - pulse)));
    if (r > .3) {
      pg.shadowColor = `rgba(232,162,60,${(.3 + .45 * breath) * mp.hot})`; pg.shadowBlur = (4 + 5 * breath) * mp.hot;
      const c0 = [243, 226, 198], c1 = [232, 162, 60];
      pg.fillStyle = `rgb(${c0.map((v, i) => Math.round(v + (c1[i] - v) * mp.hot)).join(",")})`;
      pg.beginPath(); pg.arc(cx, cy, r, 0, TAU); pg.fill();
      pg.shadowColor = "transparent";
      pg.strokeStyle = "rgba(15,13,11,.4)"; pg.lineWidth = .8; pg.beginPath(); pg.arc(cx, cy, Math.max(0, r - .4), 0, TAU); pg.stroke();
    }
    pg.restore();
    return Math.abs(mp.v) > .002 || Math.abs(target - mp.x) > .002 || Math.abs((open ? 1 : 0) - mp.bead) > .01;
  };
  // Every card tied to the pill, as ask.js sends it: where the pill is,
  // before every show.
  const send = (m) => {
    if (m.type === "show") bridge.send(pillMode === "off" ? { type: "dock", pill: null, seed: false } : { type: "dock", pill: pillMode === "seed" ? null : pillAt() });
    bridge.send(m);
  };
  const box = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
  // A voice: syllables, bursts with gaps (deterministic, so a captured
  // frame is the same every time).
  const voice = (ms) => {
    const v = Math.sin(Math.floor(ms / 90) * 12.9898) * 43758.5453, rnd = v - Math.floor(v);
    return .25 + .55 * Math.abs(Math.sin(ms / 260)) * rnd;
  };
  every(() => {
    send({ type: "level", v: S.state === "listening" ? voice(now()) : 0 });
    if (DICT.on) send({ type: "peekLevel", v: voice(now()) });
  }, 90);
  /**
   * A dictation into a text box, as main.js runs one: the peek at its
   * start, the words pasted a chunk at a time as they are said (typed out
   * here), the caret asked again after each chunk and every 700 ms, then
   * writing when it stops, done when the last words land, and the peek
   * away 900 ms after. Over and over.
   */
  function dictate(box0) {
    const typed = document.getElementById("m-typed"), caretEl = document.getElementById("m-caret");
    const caret = () => { const r = caretEl.getBoundingClientRect(); return [r.left, r.top, Math.max(2, r.width), r.height]; };
    const peekNow = (state) => send({ type: "peek", caret: caret(), field: box(box0.field), state });
    const typeOut = (text, then) => {
      const ws = text.split(" ");
      ws.forEach((w, i) => later(() => {
        typed.textContent += (typed.textContent ? " " : "") + w;
        box0.changed();
        if (i === ws.length - 1 && then) then();
      }, i * 55));
    };
    every(() => { if (DICT.state === "listening" || DICT.state === "writing") peekNow(DICT.state); }, 700);
    const cycle = () => {
      typed.textContent = ""; box0.changed();
      DICT.on = true; DICT.state = "listening"; DICT.words = "";
      peekNow("listening");
      box0.chunks.forEach((c, i) => {
        later(() => { DICT.words = (DICT.words + " " + c.toLowerCase().replace(/[.,:]/g, "")).trim(); }, 500 + i * 1200);
        later(() => typeOut(c, () => peekNow("listening")), 900 + i * 1200);
      });
      const stop = 900 + box0.chunks.length * 1200;
      later(() => { DICT.on = false; DICT.state = "writing"; peekNow("writing"); }, stop);
      later(() => typeOut(box0.last, () => {
        DICT.state = "done"; peekNow("done");
        later(() => { DICT.state = "idle"; send({ type: "unpeek" }); }, 900);
      }), stop + 800);
      later(cycle, stop + 800 + 2900);
    };
    cycle();
  }
  const scenes = {
    listening: () => { send({ type: "show", state: "listening", app: "Keynote", anchor: { x: 520, y: 200 } }); },
    thinking: () => { scenes.listening(); send({ type: "heard", text: "where's the export button?" }); send({ type: "state", state: "thinking" }); },
    point: () => { scenes.thinking(); send({ type: "say", text: "Up here, top right: Export. Pick PDF in the menu it opens." }); send({ type: "point", frame: box("m-export"), caption: "Export" }); },
    // A plan, with the places it goes numbered on the screen, as the card numbers its steps.
    steps: () => {
      send({ type: "show", state: "doing", app: "Slack" });
      send({ type: "heard", text: "tell design the mockups are ready" });
      send({ type: "say", text: "Writing it in #design." });
      send({ type: "steps", items: [{ text: "Open #design", state: "done" }, { text: "Write the message", state: "doing" }, { text: "Send it", state: "todo" }] });
      send({ type: "point", frame: box("m-composer"), caption: "Message #design" });
      send({ type: "draw", id: "d1", kind: "number", frame: box("m-design"), n: 1 });
      send({ type: "draw", id: "d2", kind: "number", frame: box("m-composer"), n: 2 });
      send({ type: "draw", id: "d3", kind: "number", frame: box("m-send"), n: 3 });
    },
    // The server's own card, for something in a connected app.
    approval: () => {
      send({ type: "show", state: "thinking", app: "Slack" });
      send({ type: "heard", text: "post the standup summary to design" });
      send({
        type: "confirm", text: "", risk: "confirm",
        card: {
          title: "Ready to send?", app: "Slack", label: "The exact message",
          preview: "Post message in Slack \u2014 channel: #design; text: \u201cStandup summary: shipped the new onboarding, two bugs left on Android, Rahul reviews the pricing copy tomorrow.\u201d",
          note: "I\u2019ll do this in Slack, as you. I won\u2019t do anything else.",
          buttons: [{ id: "approve", label: "Approve" }, { id: "edit", label: "Edit" }, { id: "deny", label: "Not now" }],
        },
      });
    },
    confirm: () => {
      scenes.steps();
      send({ type: "steps", items: [{ text: "Open #design", state: "done" }, { text: "Write the message", state: "done" }, { text: "Send it", state: "doing" }] });
      send({ type: "point", frame: box("m-send"), caption: "Send" });
      send({ type: "confirm", text: "Send to #design: “The mockups are ready! Round two is in the deck.”", risk: "confirm" });
    },
    always: () => {
      send({ type: "show", state: "doing", app: "Keynote" });
      send({ type: "heard", text: "delete the old roadmap slide" });
      send({ type: "point", frame: box("m-export"), caption: "Delete slide" });
      send({ type: "confirm", text: "Delete slide 4: “Roadmap (old)”", risk: "always" });
    },
    done: () => { scenes.steps(); send({ type: "steps", items: [{ text: "Open #design", state: "done" }, { text: "Write the message", state: "done" }, { text: "Send it", state: "done" }] }); send({ type: "unpoint" }); send({ type: "say", text: "Sent. Priya's already typing." }); send({ type: "state", state: "done" }); },
    // A Mac that has not let Tailzu see the screen: the words, and the way there.
    screen: () => {
      send({ type: "show", state: "thinking", app: "Preview" });
      send({ type: "heard", text: "what does this graph show?" });
      send({ type: "say", text: "I'd have to see the picture to answer that, and this Mac hasn't let X0 Bot see the screen. Turn on X0 Bot in System Settings, Privacy & Security, Screen Recording." });
      send({ type: "offer", kind: "screenSettings", text: "Open Screen Recording settings" });
      send({ type: "state", state: "done" });
    },
    // A browser's picture card: no Always, there is no app to remember it by.
    permitOnce: () => {
      send({ type: "show", state: "thinking", app: "Chrome: Gmail" });
      send({ type: "heard", text: "what's in this photo?" });
      send({ type: "permission", app: "Chrome: Gmail", always: false, text: "To answer that I need to see it." });
    },
    error: () => { send({ type: "show", state: "thinking", app: "Keynote" }); send({ type: "heard", text: "where's the export button?" }); send({ type: "state", state: "error" }); send({ type: "say", text: "I can't read this window yet. Turn on X0 Bot under Accessibility in System Settings." }); },
    // Everything at the longest agent.js lets it be: the card must still
    // fit, its buttons on screen.
    tall: () => {
      send({ type: "show", state: "doing", app: "Slack" });
      send({ type: "heard", text: "tell design the mockups are ready and that round two is in the deck, and ask Priya to look at the launch timeline before Friday's review" });
      send({ type: "say", text: "Writing it in #design now. I've put the whole update in one message so it reads as one thought: the mockups, the deck with round two, and a nudge to Priya about the launch timeline before Friday's review. Check it before it goes." });
      send({ type: "steps", items: [
        { text: "Open #design from the sidebar", state: "done" }, { text: "Click into the message box", state: "done" },
        { text: "Write the update about the mockups", state: "done" }, { text: "Mention Priya about the launch timeline", state: "done" },
        { text: "Read it over once more", state: "done" }, { text: "Send it to the channel", state: "doing" },
      ] });
      send({ type: "point", frame: box("m-send"), caption: "Send" });
      send({ type: "confirm", text: "Send to #design: “The mockups are ready! Round two is in the deck, page 4 onwards. @Priya could you look at the launch timeline before Friday's review? There's a question on the date for the press embargo and another on who signs off the final copy for the store listing.”", risk: "confirm" });
    },
    top: () => {
      send({ type: "show", state: "thinking", app: "Chrome" });
      send({ type: "heard", text: "which tab has the roadmap?" });
      send({ type: "say", text: "That one, the second tab." });
      send({ type: "point", frame: [300, 10, 70, 30], caption: "Q3 roadmap" });
    },
    menubar: () => {
      const bar = document.createElement("div");
      bar.className = "menubar";
      bar.innerHTML = "<b>&#63743;</b><b>Keynote</b><span id=\"m-file\">File</span><span>Edit</span><span>Insert</span><span>Slide</span><span>Format</span><span>View</span>";
      document.body.insertBefore(bar, fx);
      send({ type: "area", inset: { top: 25, right: 0, bottom: 70, left: 0 } });
      send({ type: "show", state: "thinking", app: "Keynote" });
      send({ type: "heard", text: "where's save as?" });
      send({ type: "say", text: "Under File: hold Option and it turns into Save As." });
      send({ type: "point", frame: box("m-file"), caption: "File" });
    },
    // The instant layer: "where's ex…", and a guess ringed while they are
    // still saying it. The card listens on where it was.
    tentative: () => {
      scenes.listening();
      send({ type: "point", frame: box("m-export"), caption: "Export", tentative: true });
    },
    // The picture layer: may it look at this, for an app not yet allowed.
    // One line and the buttons; what is sent, and to whom, is the privacy
    // policy's to say, not the card's.
    permission: () => {
      const f = box("m-fig");
      send({ type: "show", state: "thinking", app: "Keynote", anchor: { x: f[0] + f[2] - 60, y: f[1] + f[3] - 24 } });
      send({ type: "heard", text: "explain this equation" });
      send({ type: "permission", app: "Keynote", always: true, text: "To answer that I need to see it." });
    },
    // …and the answer to it, a sentence at a time as the model writes,
    // beside the picture it is about.
    growing: () => {
      send({ type: "show", state: "thinking", app: "Keynote" });
      send({ type: "heard", text: "explain this equation" });
      send({ type: "point", frame: box("m-fig"), caption: "Looking", tentative: true });
      send({ type: "badge", text: "1 picture sent" });
      const said = [
        "It's the area under the curve y = x² from x = 0 to x = 1.",
        "The integral of x² is x³/3.",
        "At 1 that's 1/3, and at 0 it's 0, so the area is 1/3.",
        "So the curve leaves a third of the unit square under it.",
      ];
      said.forEach((text, i) => later(() => send(i ? { type: "say", text, append: true } : { type: "say", text }), 400 + i * 900));
    },
    long: () => {
      send({ type: "show", state: "doing", app: "Finder" });
      send({ type: "heard", text: "open https://docs.google.com/document/d/1x9Qe2ZlongDocumentIdThatNeverBreaks_abcdefghijklmnop/edit" });
      send({ type: "say", text: "Your file is at /Users/priya/Library/Application_Support/Keynote/Autosave/Q3_launch_roadmap_final_v2_really_final.key" });
      send({ type: "point", frame: box("m-composer"), caption: "Address" });
      send({ type: "confirm", text: "Type “https://docs.google.com/document/d/1x9Qe2ZlongDocumentIdThatNeverBreaks/edit”?", risk: "confirm" });
    },
    // THE BIRTH, and a whole question: the thread out of the pill, the card
    // at its end, listening (the voice plucks the thread), thinking (a
    // light runs up it), then the answer.
    dock: () => {
      send({ type: "show", state: "listening", app: "Keynote" });
      later(() => send({ type: "heard", text: "where's the export button?" }), 1500);
      later(() => send({ type: "state", state: "thinking" }), 2300);
      later(() => { send({ type: "say", text: "Up here, top right: Export. Pick PDF in the menu it opens." }); send({ type: "point", frame: box("m-export"), caption: "Export" }); }, 3500);
    },
    // A ring by the pill: the card moves aside along the bottom, the
    // tether bends after it, and the thread leaves the card's side.
    slide: () => {
      const bar = document.createElement("div");
      bar.className = "dockbar";
      bar.innerHTML = "<span>&lsaquo;</span><span class=\"n\">4 / 12</span><span id=\"m-present\" class=\"primary\">&#9654;&ensp;Present</span><span>&rsaquo;</span>";
      document.body.insertBefore(bar, fx);
      send({ type: "show", state: "thinking", app: "Keynote" });
      send({ type: "heard", text: "how do I start the slideshow?" });
      later(() => { send({ type: "say", text: "Press Present, just here by the pill. Esc ends it." }); send({ type: "point", frame: box("m-present"), caption: "Present" }); }, 700);
    },
    // An answer, then away: the fold, over and over.
    fold: () => {
      const cycle = () => {
        send({ type: "show", state: "thinking", app: "Keynote" });
        send({ type: "heard", text: "where's the export button?" });
        later(() => send({ type: "say", text: "Up here, top right: Export." }), 500);
        later(() => send({ type: "hide" }), 2200);
        later(cycle, 3400);
      };
      cycle();
    },
    // THE PEEK: dictating into a chat's message box. Blip on the box's top
    // edge at the cursor, gliding along it as the words land, nodding at
    // each chunk; down and up again at the next line's start when the box
    // grows a line; thinking while the last words come, a hop, and away.
    peek: () => {
      mock.classList.add("chat");
      mock.querySelector(".bar b").textContent = "#design — Chat";
      mock.querySelector(".tools").style.display = "none";
      mock.querySelector(".page").innerHTML = `<h2># design</h2>
          <div class="msg"><i style="background:#C2527A">P</i><div><b>Priya</b><time>11:02 AM</time><p>Round two of the mockups is in the deck. Ready for a look?</p></div></div>
          <div class="msg"><i style="background:#3F7F6B">A</i><div><b>Anthony</b><time>11:05 AM</time><p>Will check after the call.</p></div></div>`;
      const comp = document.getElementById("m-composer");
      comp.innerHTML = `<div class="text"><span id="m-typed"></span><span class="caret" id="m-caret"></span><span class="ph" id="m-ph">Message #design</span></div><em id="m-send">Send</em>`;
      const ph = document.getElementById("m-ph");
      dictate({
        field: "m-composer",
        chunks: ["So the plan is:", "we ship the mockups on Friday,", "then walk the whole design team", "through round two, page four onwards."],
        last: "Sound good?",
        changed: () => { ph.hidden = !!document.getElementById("m-typed").textContent; },
      });
    },
    // …and into a document: a field far taller than a line, so Blip peeks
    // over the line the cursor is on, a little to its right, off the words
    // just written.
    peekdoc: () => {
      mock.classList.add("doc");
      mock.querySelector(".bar b").textContent = "Launch notes — Docs";
      mock.querySelector(".tools").style.display = "none";
      mock.querySelector(".side").innerHTML = "<p class=\"on\">Launch notes</p><p>Mockups</p><p>Open questions</p><p>Review</p>";
      mock.querySelector(".page").innerHTML = `<div class="sheet" id="m-doc"><h2>Launch notes</h2>
          <p>Round two of the mockups is in the deck, pages four to nine. The new onboarding flow replaces the three welcome screens with one, and the empty states now say what to do next.</p>
          <p>Open questions for Friday: who signs off the store listing copy, and whether the press embargo moves with the launch date.</p>
          <p><span id="m-typed"></span><span class="caret" id="m-caret"></span></p></div>`;
      document.getElementById("m-composer").style.display = "none";
      dictate({
        field: "m-doc",
        chunks: ["For the review, start", "with the onboarding flow,", "then the empty states,", "and keep ten minutes at the end", "for the store listing."],
        last: "Priya leads it.",
        changed: () => {},
      });
    },
    // THE PEN: a picture of a right triangle, a question about it, and the
    // answer marked up on it as it is said.
    draw: () => {
      const fig = document.getElementById("m-fig");
      fig.className = "tri"; fig.id = "m-tri";
      fig.innerHTML = `<svg viewBox="0 0 480 250" width="480" height="250" aria-hidden="true">
          <polygon points="60,206 60,46 273,206" fill="currentColor" fill-opacity=".05" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/>
          <path d="M60 190 H76 V206" fill="none" stroke="currentColor" stroke-width="1.6"/>
          <text id="t-3" x="28" y="136">3</text><text id="t-4" x="158" y="238">4</text><text id="t-q" x="172" y="114">?</text></svg>`;
      mock.querySelectorAll(".page .ln").forEach((el) => { el.style.display = "none"; });
      mock.querySelector(".page h2").textContent = "Homework: triangles";
      const svg = fig.querySelector("svg").getBoundingClientRect();
      const pt = (x, y) => [svg.left + x * svg.width / 480, svg.top + y * svg.height / 250];
      const at = (x, y, w, h) => { const [a, b] = pt(x, y); return [a, b, w * svg.width / 480, h * svg.height / 250]; };
      send({ type: "show", state: "thinking", app: "Preview" });
      send({ type: "heard", text: "how long is the long side?" });
      send({ type: "point", frame: box("m-tri"), caption: "Looking", tentative: true });
      send({ type: "badge", text: "1 picture sent" });
      const says = [
        ["The long side is the hypotenuse, c: the side across from the right angle.", [
          { kind: "circle", frame: at(58, 186, 22, 22), text: "90°" },
          { kind: "arrow", from: pt(336, 66), to: pt(190, 139), text: "c, what we want" }]],
        ["For any right triangle, a² + b² = c².", [
          { kind: "number", at: pt(60, 120), n: 1 },
          { kind: "number", at: pt(166, 206), n: 2 }]],
        ["Here that's 3² + 4² = 9 + 16 = 25.", [
          { kind: "underline", frame: box("t-3") },
          { kind: "underline", frame: box("t-4") }]],
        ["So c = √25 = 5.", []],
      ];
      let id = 0;
      says.forEach(([text, draws], i) => later(() => {
        send(i ? { type: "say", text, append: true } : { type: "say", text });
        for (const d of draws) send(Object.assign({ type: "draw", id: "d" + (++id) }, d));
      }, 600 + i * 1300));
      later(() => send({ type: "unpoint" }), 600 + 4 * 1300);
    },
  };
  const start = () => {
    if (scene && scenes[scene]) { scenes[scene](); return; }
    // The whole run, on a loop.
    const order = ["listening", "thinking", "point", "steps", "confirm", "done"];
    let i = 0;
    const next = () => { scenes[order[i % order.length]](); i++; later(next, i % order.length === 0 ? 3600 : 2600); };
    next();
  };
  // For the review's checks: what the page is doing, and a way to tell it more.
  window.__guide = { S, PK, marks, LIFE, now, send: (m) => bridge.send(m), peekBlip, mouse: () => mouseCalls };
  if (CAPTURE) {
    // Every animation the page runs in CSS (the words rising, the ring's
    // label) is held and set to the page's clock too.
    const began = new WeakMap();
    const seek = () => {
      for (const a of document.getAnimations()) {
        if (!began.has(a)) { began.set(a, virtual); a.pause(); }
        a.currentTime = virtual - began.get(a);
      }
    };
    window.__step = (ms) => {
      let left = Math.max(0, Number(ms) || 0);
      do { const d = Math.min(1000 / 60, left); virtual += d; left -= d; runTimers(); frame(); seek(); } while (left > 0);
    };
    start();
    frame(); seek();
    window.__ready = true;
  } else start();
}
