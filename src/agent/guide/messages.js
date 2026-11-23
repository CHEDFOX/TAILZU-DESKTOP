// Messages from the main process (channel "guide"), the card's buttons, and
// what the pointer may click.
"use strict";

function show(m) {
  // A question ends any peek first (Ask and dictation never overlap: this
  // is only a guard). Blip is gone at once; the card's own Blip comes up
  // with the card.
  if (PK.on) endPeek();
  const first = !S.shown;
  // A new card asks to take clicks afresh (the window may have been let go by main meanwhile, hidden or peeked): the next
  // frame's hit test says whether the pointer is on it.
  PTR.inside = false;
  // Put away completely (not just folding): it starts from nothing, where
  // it is to be. A fold still under way is turned round where it is.
  const fresh = first && lifeAt(now()).over;
  S.shown = true; S.hideAt = 0;
  S.ring = null; S.anchor = m.anchor ? [m.anchor.x, m.anchor.y] : null;
  // Every show is a new question (agent.js begin), and a new card starts
  // over the pill, from wherever the last one is: one asked while the last
  // answer's card was still up, or folding, opened where that answer's
  // ring had sent it. A conversation's next question (`thread`, ask.js) is
  // asked in the card already up: it stays where it is, and keeps the turns
  // before it (turn).
  const more = m.thread === true && !first;
  if (!more) {
    S.slid = false; clearTurns();
    // A conversation says so itself, right after (mute): until then this is
    // a question's card, with no microphone button and no chat.
    delete card.dataset.convo; $("mute").hidden = true; S.muteKey = "";
  }
  chatFresh();
  $("app").textContent = m.app || "";
  $("heard").textContent = ""; S.heard = "";
  $("say").textContent = "";
  $("badge").textContent = "";
  setSteps([]);
  setOffer(null);
  chip.classList.remove("on"); S.chipBox = null;
  S.risk = "confirm";
  // A new card's marks are its own: the last one's fade.
  fadeMarks();
  setState(m.state || "listening", m.label);
  // The one key is tapped once; Ask's own pair, twice.
  $("askHint").textContent = m.once ? K.txt("desktop.guide.askHintOnce", "or tap {key}", { key: m.key || "Fn" })
    : K.txt("desktop.guide.askHint", "or tap {key} twice", { key: m.key || "Alt" });
  card.classList.add("on");
  capCard();
  place(fresh);
  if (first) {
    S.lineMix = S.state === "listening" ? 1 : 0;
    startLife(true);
  }
  wake();
}
/** The finished card's one button (ask.js offer): { kind, text }, or none. */
function setOffer(m) {
  const b = $("offerBtn");
  const text = m && m.kind ? String(m.text || "").trim().slice(0, 60) : "";
  b.textContent = text;
  b.title = text;
  b.dataset.kind = text ? String(m.kind) : "";
  $("offer").hidden = !text;
}
function hide() {
  if (!S.shown) return;
  stopSpeaking();
  S.shown = false;
  blip.pose("hidden");
  S.hideAt = now() / 1000;
  // Blip ducks and the marks fade first; then the card folds back into the
  // thread's end and the thread is pulled down into the pill (lifeAt).
  chip.classList.remove("on");
  fadeMarks();
  startLife(false);
  // Let clicks through, and forget the pointer was on the card: the next card that comes up under a pointer that has not
  // moved must ask to take clicks again. Kept "inside", it never asked, and its buttons let every click through to the
  // app below until the pointer left the card and came back (every system: the buttons that "worked a few times only").
  PTR.inside = false;
  bridge.mouse(false);
  wake();
}
const handlers = {
  show,
  hide,
  // Where the pill is, in this window's coordinates, for the card to grow
  // out of and stay tied to; null when no question has it here (a seed of
  // the guide's own instead, or with `seed: false` nothing: the card is
  // placed as it was before it had a pill). ask.js sends it before every
  // show, and again whenever the window moves to another display.
  dock: (m) => {
    const p = m && m.pill;
    // Numbers, and only numbers: Number(null) is 0, and a pill with a
    // missing y read as one at the top of the screen.
    const ok = p && [p.x, p.y, p.w, p.h].every(isNum) && p.w > 0 && p.h > 0;
    const next = { pill: ok ? { x: Number(p.x), y: Number(p.y), w: Number(p.w), h: Number(p.h) } : null, seed: !(m && m.seed === false) };
    const was = S.dock;
    const same = was && was.seed === next.seed && (was.pill === next.pill || (was.pill && next.pill && ["x", "y", "w", "h"].every((k) => was.pill[k] === next.pill[k])));
    S.dock = next;
    if (same) return;
    capCard();
    place(true);
  },
  // The label, when there is one, is what it is doing ("Pressing Export"),
  // in the eyebrow.
  state: (m) => { if (m.risk) S.risk = m.risk; setState(m.state, m.label ? String(m.label).slice(0, 34) : ""); fit(); },
  level: (m) => { S.levelTo = Math.max(0, Math.min(1, Number(m.v) || 0)); },
  // In a conversation their words are a chat bubble, not a quotation.
  heard: (m) => { S.heard = m.text ? String(m.text) : ""; $("heard").textContent = S.heard && !inConvo() ? "“" + S.heard + "”" : S.heard; fit(); },
  // A CONVERSATION'S MICROPHONE (ask.js MUTE): this card is a conversation's
  // (a chat, with the button), muted or listening, and the key that does
  // the same when there is one. Sent after every show of one, and on every
  // change.
  // THE VOICE (ask.js toggleVoice): answers said aloud, or only shown for reading. Sent with every show, and on every change.
  voiceOff: (m) => {
    const b = $("speak"), off = m.off === true;
    b.setAttribute("aria-pressed", off ? "true" : "false");
    const what = off ? K.txt("desktop.guide.voiceOn", "Read answers aloud") : K.txt("desktop.guide.voiceOff", "Read only, no voice");
    b.title = what; b.setAttribute("aria-label", what);
  },
  mute: (m) => {
    card.dataset.convo = "";
    const b = $("mute"), muted = m.muted === true;
    S.muteKey = m.key ? String(m.key).slice(0, 24) : "";
    b.hidden = false;
    b.setAttribute("aria-pressed", muted ? "true" : "false");
    const what = muted ? K.txt("desktop.guide.unmute", "Listen again") : K.txt("desktop.guide.mute", "Mute");
    b.title = S.muteKey ? what + " (" + S.muteKey + ")" : what;
    b.setAttribute("aria-label", what);
    // Their words so far, unquoted now that they are a bubble.
    if (S.heard) $("heard").textContent = S.heard;
    if (S.state === "muted") setState("muted");
    capCard();
    fit();
  },
  // A CONVERSATION'S NEXT TURN (ask.js nextTurn, desktop.agent.thread): what
  // was just asked and answered goes up into the turns above, small, and the
  // card listens for the next question. The card stays where it is, tied to
  // the pill as it was; only its contents change.
  turn: () => {
    if (!S.shown) return;
    keepTurn();
    $("heard").textContent = ""; S.heard = "";
    $("say").textContent = "";
    $("badge").textContent = "";
    setSteps([]);
    setOffer(null);
    S.ring = null; chip.classList.remove("on"); S.chipBox = null;
    S.risk = "confirm";
    setState("listening");
    // The newest is what they are waiting for: back to it, wherever they had scrolled.
    chatFresh();
    place(false);
    fit();
    wake();
  },
  // The words at once; the voice when it is ready (`voice`): the server's
  // audio, or the built-in voice with a locale.
  // `append`: the next sentence of an answer that is still coming.
  // An answer while the picture card is still up means it was settled
  // without a click (no answer in time): the card answers, its buttons go.
  say: (m) => {
    words($("say"), m.text, m.append === true);
    if (S.state === "listening" || S.state === "thinking" || S.state === "permission") setState("showing");
    fit();
  },
  // Only for the card that is up. The main process drops a voice whose
  // card has gone; this is the second lock. Either way the main process
  // hears it is over, so the next sentence is not held up.
  voice: (m) => { if (S.shown && (m.audio || m.speak)) speak(m); else bridge.spoken(); },
  hush: () => stopSpeaking(),
  area: (m) => {
    const i = (m && m.inset) || {};
    const n = (v) => Math.max(0, Number(v) || 0);
    S.inset = { top: n(i.top), right: n(i.right), bottom: n(i.bottom), left: n(i.left) };
    capCard();
    place(true);
  },
  // `tentative`: a guess while they are still talking (it leaves the card
  // listening), or the part of the window a picture is of. The same guess
  // again leaves the ring as it is; an answer's own ring replaces it.
  point: (m) => {
    if (!Array.isArray(m.frame) || m.frame.length !== 4) return;
    const frame = m.frame.map(Number);
    if (!frame.every(Number.isFinite)) return;
    const tentative = m.tentative === true;
    if (tentative && S.ring && S.ring.tentative && S.ring.frame.every((v, i) => Math.abs(v - frame[i]) < 1)) return;
    S.ring = { frame, caption: tentative ? "" : m.caption || "", at: now() / 1000, tentative };
    chip.textContent = S.ring.caption;
    if (!tentative && (S.state === "listening" || S.state === "thinking")) setState("showing");
    else blip.pose(poseFor());
    place(false);
    wake();
  },
  badge: (m) => { $("badge").textContent = m.text ? String(m.text).slice(0, 32) : ""; },
  // A button on the finished card, for what stopped the answer: the Mac's
  // Screen Recording settings, after the card says why it could not look.
  offer: (m) => { setOffer(m); fit(); },
  // May a picture go: once, always for this app, or not now. No Always
  // (`always: false`) for an app with no name of its own to remember it by
  // (a browser, whose label is the page's; a Store app seen only as its
  // frame): ask.js would take a click on it as once.
  permission: (m) => {
    const app = String(m.app || "").trim();
    $("permitText").textContent = String(m.text || "");
    $("once").textContent = K.txt("desktop.guide.permitOnce", "Allow once");
    $("always").textContent = app ? K.txt("desktop.guide.permitAlways", "Always for {app}", { app }) : K.txt("desktop.guide.permitAlwaysHere", "Always here");
    $("always").title = $("always").textContent;
    $("always").hidden = m.always === false;
    $("notnow").textContent = K.txt("desktop.guide.permitNo", "Not now");
    setState("permission");
    fit();
  },
  unpoint: () => { S.ring = null; chip.classList.remove("on"); S.chipBox = null; blip.pose(poseFor()); place(false); },
  steps: (m) => { setSteps(m.items); fit(); },
  confirm: (m) => {
    S.risk = m.risk === "always" ? "always" : "confirm";
    // THE SERVER'S CARD (a connected app): its words, drawn as they came.
    // The title is the card's heading, the app and what the words are come
    // above them, what it will and won't do below, and the buttons are the
    // ones the server named, in its order (yes, change it, no).
    const c = m.card && typeof m.card === "object" ? m.card : null;
    S.server = !!c;
    $("ask").toggleAttribute("data-server", S.server);
    if (c) {
      const by = (id) => (Array.isArray(c.buttons) ? c.buttons : []).find((b) => b && b.id === id);
      $("what").textContent = [c.app, c.label].filter(Boolean).join(" · ");
      $("quote").textContent = String(c.preview || "");
      $("note").textContent = String(c.note || "");
      $("note").hidden = !c.note;
      $("yes").textContent = String((by("approve") || {}).label || "");
      $("edit").textContent = String((by("edit") || {}).label || "");
      $("edit").hidden = !by("edit");
      $("no").textContent = String((by("deny") || {}).label || "");
      setWays(Array.isArray(c.buttons) ? c.buttons : []);
      setFields(Array.isArray(c.fields) ? c.fields : []);
      setState("confirm", String(c.title || ""));
      fit();
      return;
    }
    $("note").hidden = true;
    $("edit").hidden = true;
    setWays([]);
    setFields([]);
    const [what, quote] = splitConfirm(m.text);
    $("what").textContent = what;
    $("quote").textContent = quote;
    $("yes").textContent = K.txt("desktop.guide.yes", "Do it");
    $("no").textContent = K.txt("desktop.guide.no", "Not now");
    setState("confirm");
    fit();
  },
  // A mark on the screen (ask.js draw: geometry already in this window's
  // coordinates, a fresh id each), and all of them away.
  draw: (m) => addMark(m),
  clear: () => fadeMarks(),
  // While a dictation records: Blip over the text box at the cursor
  // (`caret`, `field`: [x, y, w, h] or null, in this window's
  // coordinates; `state`: listening, writing, done), the voice for its
  // antenna, and away.
  peek: (m) => peek(m),
  peekLevel: (m) => { const v = Number(m && m.v); PK.levelTo = Number.isFinite(v) ? clamp(v) : 0; PK.heard = now(); },
  unpeek: () => unpeek(),
};
bridge.onGuide((m) => { if (m && handlers[m.type]) { try { handlers[m.type](m); } catch (e) { console.error(e); } } });

// A button answers on its press, not its release: the card glides and
// changes height under the pointer, and a release that lands after the
// window has gone back to letting clicks through never reached it, so the
// click was lost. One answer per question: a second press does nothing.
/**
 * THE PAGE'S OWN WAYS IN, as buttons of their own (agent.js's ALSO lines on a sign-in handover).
 *
 * The card's three answers are fixed in the markup, looked up by the ids `approve`, `edit` and `deny`. Anything else the
 * card carries is a way the PAGE offers — "Continue with Google", "Use email instead" — and there may be up to four, so
 * they are built here per card rather than being mapped onto buttons that do not exist. Without this they were simply
 * never drawn.
 *
 * Each sends its own id back, which the main process matches against the buttons it sent (ask.js `cardButtons`), so a
 * press answers as itself and not as the main button.
 */
/**
 * THE BOXES OF A SIGN-IN CARD (docs/sign-in.md's FIELD lines): the page's real fields, named in the person's own
 * language, filled here and set into the page by the main process.
 *
 * A secret and a one-time code are `type="password"` — hidden as typed, as rule S5 says — and nothing is remembered: the
 * values live in the inputs until Continue is pressed, go across once, and the inputs are dropped with the card. No
 * autofill or password manager is asked for (`autocomplete="off"`), because this is not the site's own page and should
 * never look to the browser like it is.
 */
function setFields(fields) {
  const box = $("fields");
  box.textContent = "";
  const own = fields.filter((f) => f && typeof f.id === "string" && f.id && f.label).slice(0, 6);
  box.hidden = !own.length;
  for (const f of own) {
    const row = document.createElement("label");
    row.className = "f";
    const name = document.createElement("span");
    name.textContent = String(f.label);
    const input = document.createElement("input");
    input.type = f.kind === "secret" || f.kind === "code" ? "password" : f.kind === "email" ? "email" : f.kind === "phone" ? "tel" : "text";
    if (f.kind === "code") { input.inputMode = "numeric"; }
    input.autocomplete = "off";
    input.spellcheck = false;
    input.dataset.id = String(f.id);
    input.maxLength = 200;
    row.append(name, input);
    box.appendChild(row);
  }
  if (own.length) requestAnimationFrame(() => { const first = box.querySelector("input"); if (first) first.focus(); });
}

/** What was typed, by the page's element id. Read once, on Continue; nothing is held between cards. */
function fieldValues() {
  const out = {};
  for (const el of $("fields").querySelectorAll("input")) {
    const id = el.dataset.id;
    if (id && el.value) out[id] = el.value;
  }
  return out;
}

function setWays(buttons) {
  const row = $("ways");
  row.textContent = "";
  const own = buttons.filter((b) => b && typeof b.id === "string" && b.id && b.id !== "approve" && b.id !== "edit" && b.id !== "deny" && b.label).slice(0, 4);
  row.hidden = !own.length;
  for (const b of own) {
    const el = document.createElement("button");
    el.type = "button";
    el.textContent = String(b.label);
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || S.state !== "confirm") return;
      e.preventDefault();
      bridge.confirm(String(b.id));
      // The card stays up: starting a way in is the beginning of their part, not the end, and the main process sends the
      // card again. `doing` would hide the answers they still have to give.
    });
    row.appendChild(el);
  }
}

const press = (id, fn) => $(id).addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  fn();
});
press("yes", () => {
  if (S.state !== "confirm") return;
  // A card with boxes answers with what was typed into them; any other answers as it always did.
  const box = $("fields");
  bridge.confirm(box.hidden ? true : { id: "approve", values: fieldValues() });
  setState("doing");
  fit();
});
// On the server's card Not now and Edit are answers of their own (the agent
// calls the route each names); on any other it is a plain no.
press("no", () => { if (S.state !== "confirm") return; bridge.confirm(S.server ? "deny" : false); setState("doing"); fit(); });
press("edit", () => { if (S.state !== "confirm") return; bridge.confirm("edit"); setState("doing"); fit(); });
// Whichever it is, the answer is on its way next: with the picture, or
// from the words alone.
for (const [id, choice] of [["once", "once"], ["always", "always"], ["notnow", "no"]]) {
  press(id, () => { if (S.state !== "permission") return; bridge.permit(choice); setState("thinking"); fit(); });
}
press("close", () => bridge.dismiss());
// Muted or listening: main decides, and says which (mute).
press("mute", () => { if (bridge.mute) bridge.mute(); });
// Said aloud or only shown: main decides, and says which (voice).
press("speak", () => { if (bridge.toggleVoice) bridge.toggleVoice(); });
press("offerBtn", () => {
  const kind = $("offerBtn").dataset.kind;
  if (kind && bridge.offer) bridge.offer(kind);
});

// TAKING CLICKS. The window lets clicks through to the app below except over
// the card. mouseenter and mouseleave fire only when the pointer moves, so a
// card that glided or bloomed under a still pointer never took its click,
// and one that shrank mid-press lost it. Instead the pointer is checked
// against the card on every frame, from where it was last seen: the
// window's own (forwarded) moves, and main's report of the pointer while
// the window is up (the "cursor" message), which needs no move at all.
const PTR = { x: -1, y: -1, inside: false };
// A card waiting on an answer (its buttons up) takes clicks a little before the pointer reaches it, so the switch from
// letting clicks through is done by the time the pointer is on a button; any other card only when the pointer is on it.
const ANSWERING = new Set(["confirm", "permission"]);
function hitTest() {
  const r = card.getBoundingClientRect();
  const slack = ANSWERING.has(S.state) ? 28 : 4;
  const inside = S.shown && card.classList.contains("on") && r.width > 0 &&
    PTR.x >= r.left - slack && PTR.x <= r.right + slack && PTR.y >= r.top - slack && PTR.y <= r.bottom + slack;
  if (inside !== PTR.inside) { PTR.inside = inside; bridge.mouse(inside); }
}
document.addEventListener("mousemove", (e) => { PTR.x = e.clientX; PTR.y = e.clientY; hitTest(); }, { passive: true });
handlers.cursor = (m) => {
  const x = Number(m && m.x), y = Number(m && m.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  PTR.x = x; PTR.y = y; hitTest();
};

if (bridge.knobs) bridge.knobs().then((k) => { K.setKnobs(k); look(); }).catch(() => {});
if (bridge.onKnobs) bridge.onKnobs((k) => { K.setKnobs(k); look(); });
look();
// The faces the canvas writes in, asked for now: a label drawn before its
// face has loaded would be measured in another.
const faces = document.fonts ? Promise.all([labelFont(19), '600 12px "Instrument Sans"'].map((f) => document.fonts.load(f).catch(() => null))) : Promise.resolve();
resize();
