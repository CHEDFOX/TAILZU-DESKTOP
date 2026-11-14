// The permission card, over the app (sdui/permCard.js).

/**
 * ONE PERMISSION, ASKED FOR WHERE IT IS MISSED.
 *
 * The window's onboarding asks for all four at once ("Let me in, once"), and a
 * person may say no to any of them, or turn one off months later. What they
 * met after that was a failure with nothing to do about it: a dictation that
 * only copied, a look that answered "I can't see your screen", a call whose
 * camera button did nothing. The phone has the answer to this already — a card
 * over the app, the page behind it blurred — so this is that card, for the
 * things only a computer keeps:
 *
 *   ax    Accessibility: the words could not be typed where the cursor is
 *   see   Screen Recording: Ask could not look at the screen
 *   mic   the microphone: nothing could be heard
 *   cam   the camera: a call could not turn one on
 *
 * WHO PUTS IT UP. The window, at the moment the thing is missed, not the
 * server: only this side knows a paste came back refused. The main process
 * says so with "perm-needed" (tailzuApp.onPermNeeded) for what happens outside
 * the window, and the renderer calls permNeed() for what happens inside it. It
 * is never put up while the window is not on screen — a card nobody is looking
 * at is not an ask, it is a surprise for later — so the main process keeps its
 * notification for that case.
 *
 * HOW FAR IT CAN GO, which is as far as the system allows and no further:
 *
 *   microphone, camera   macOS asks, over this window, the first time: Allow
 *                        there is the whole of it. Told no once, it never asks
 *                        again, and the button becomes its settings page.
 *                        Windows never asks at all, so it is the page there.
 *   Accessibility        No system lets an app grant it. macOS shows its own
 *   Screen Recording     dialog (which the main process asks for) and the
 *                        switch is flipped in System Settings; the button
 *                        opens that exact page.
 *
 * So the card is honest about the trip when there is one, and does not make
 * one when there is not. It closes itself the moment the answer turns yes —
 * which, for the two that are granted in System Settings, is when the person
 * comes back to this window.
 */

/** What each card says and does. The words are the server's (knobs), with these as the fallback. */
const PERM_CARDS = {
  ax: {
    icon: "keys",
    h: ["desktop.perm.ax.h", "Let me type for you"],
    p: ["desktop.perm.ax.p", "Your words were copied, but I couldn’t put them where your cursor is. Allow X0 Bot under Accessibility and I’ll type them straight in."],
    cta: ["desktop.perm.open", "Open Settings"],
    reading: () => (typeof axReading === "function" ? axReading() : Promise.resolve(null)),
    on: () => typeof axAskOn === "function" && axAskOn(),
    press: () => askAction("openAccessibility"),
  },
  see: {
    icon: "eye",
    h: ["desktop.perm.see.h", "Let me see your screen"],
    p: ["desktop.perm.see.p", "Ask answers about the window you’re looking at, and it can’t see it yet. Allow X0 Bot under Screen Recording."],
    cta: ["desktop.perm.open", "Open Settings"],
    reading: () => (typeof seeReading === "function" ? seeReading() : Promise.resolve(null)),
    on: () => typeof seeAskOn === "function" && seeAskOn(),
    press: () => askAction("openScreenRecording"),
  },
  mic: {
    icon: "mic",
    h: ["desktop.perm.mic.h", "Let me hear you"],
    p: ["desktop.perm.mic.p", "I couldn’t open the microphone, so there was nothing to write down."],
    cta: ["desktop.perm.allow", "Allow"],
    reading: () => (typeof micReading === "function" ? micReading() : Promise.resolve(null)),
    on: () => typeof micAskOn === "function" && micAskOn(),
    press: () => permAskMedia("microphone", "openMicrophone"),
  },
  cam: {
    icon: "cam",
    h: ["desktop.perm.cam.h", "Let me use the camera"],
    p: ["desktop.perm.cam.p", "A call can’t turn your camera on until your computer lets X0 Bot use it. Nothing is sent until you turn it on in the call."],
    cta: ["desktop.perm.allow", "Allow"],
    reading: () => (typeof camReading === "function" ? camReading() : Promise.resolve(null)),
    on: () => typeof camAskOn === "function" && camAskOn(),
    press: () => permAskMedia("camera", "openCamera"),
  },
};

/** The glyphs, one path each, as the onboarding's step draws them. */
const PERM_ICON = {
  mic: "M9 6a3 3 0 0 1 6 0v5a3 3 0 0 1-6 0zM5 11a7 7 0 0 0 14 0M12 18v3",
  cam: "M5.5 7.8h2.4l1.2-1.9h5.8l1.2 1.9h2.4a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM12 10.2a3.1 3.1 0 1 0 0 6.2 3.1 3.1 0 0 0 0-6.2z",
  keys: "M3.6 7.6h16.8a1.6 1.6 0 0 1 1.6 1.6v5.6a1.6 1.6 0 0 1-1.6 1.6H3.6A1.6 1.6 0 0 1 2 14.8V9.2a1.6 1.6 0 0 1 1.6-1.6zM7 11h.01M11 11h.01M15 11h.01M8.6 13.9h6.8",
  eye: "M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12zM12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z",
  check: "M5 12.5l4.5 4.5L19 7.5",
};

let PERM_UP = "";        // the kind on screen, or ""
let PERM_WATCH = 0;      // the timer watching for the answer to turn yes

const permWord = (pair) => K.txt(pair[0], pair[1]);

/**
 * ASK THE SYSTEM FOR THE MICROPHONE OR THE CAMERA, and if it will not ask —
 * Windows never does, and a Mac that has been told no does not ask twice —
 * open the page where the switch is instead. The second press is the one that
 * opens it: the first still tries, because a system that has not been asked
 * yet shows its own prompt and that is the whole of it.
 */
async function permAskMedia(permission, openKind) {
  const card = document.querySelector(".tz-pc");
  if (card && card.getAttribute("data-tried") === "1") { askAction(openKind); return; }
  if (card) card.setAttribute("data-tried", "1");
  let ok = false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia(permission === "camera" ? { video: true } : { audio: true });
    stream.getTracks().forEach((t) => t.stop());
    ok = true;
  } catch { ok = false; }
  if (ok) { permSettled(); return; }
  // It would not ask, or it was refused: say where the switch is, and let the
  // next press open it.
  const btn = card && card.querySelector(".tz-pc-go");
  if (btn) btn.textContent = permWord(["desktop.perm.open", "Open Settings"]);
  const line = card && card.querySelector(".tz-pc-foot");
  if (line) line.textContent = K.txt("desktop.perm.blocked", "Your computer is holding this one. Open its settings, turn X0 Bot on, and come back.");
}

/** The answer turned yes (or the person closed it): the card goes. */
function permSettled() {
  const card = document.querySelector(".tz-pc");
  if (card) {
    const tick = card.querySelector(".tz-pc-icon");
    if (tick) tick.innerHTML = permGlyph("check");
    const go = card.querySelector(".tz-pc-go");
    if (go) go.remove();
    const p = card.querySelector(".tz-pc-p");
    if (p) p.textContent = K.txt("desktop.perm.done", "That’s it. Carry on.");
  }
  setTimeout(permClose, K.num("desktop.perm.doneMs", 900));
}

const permGlyph = (name) => '<svg viewBox="0 0 24 24" aria-hidden="true" style="width:22px;height:22px;fill:none;stroke:currentColor;' +
  'stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round"><path d="' + PERM_ICON[name] + '"></path></svg>';

/** Put the card up for one permission. Nothing happens if one is already up, if the window cannot ask for that
 *  one, if the answer is already yes, or if nobody is looking at the window. */
async function permNeed(kind) {
  const card = PERM_CARDS[kind];
  if (!card || PERM_UP || !card.on()) return false;
  if (document.hidden || !document.body) return false;
  const now = await card.reading();
  if (now !== false) return false;        // already allowed, or this computer keeps no such answer
  if (PERM_UP) return false;              // one went up while this one was reading
  PERM_UP = kind;
  const veil = document.createElement("div");
  veil.className = "tz-pc-veil";
  veil.setAttribute("role", "dialog");
  veil.setAttribute("aria-modal", "true");
  veil.setAttribute("aria-label", permWord(card.h));
  veil.innerHTML = '<div class="tz-pc" data-perm="' + esc(kind) + '">' +
    '<div class="tz-pc-icon">' + permGlyph(card.icon) + "</div>" +
    '<h2 class="tz-pc-h">' + esc(permWord(card.h)) + "</h2>" +
    '<p class="tz-pc-p">' + esc(permWord(card.p)) + "</p>" +
    '<button type="button" class="tz-pc-go">' + esc(permWord(card.cta)) + "</button>" +
    '<button type="button" class="tz-pc-no">' + esc(K.txt("desktop.perm.later", "Not now")) + "</button>" +
    '<p class="tz-pc-foot"></p></div>';
  document.body.appendChild(veil);
  veil.querySelector(".tz-pc-go").addEventListener("click", () => { try { card.press(); } catch { /* the card stays up */ } });
  veil.querySelector(".tz-pc-no").addEventListener("click", permClose);
  veil.addEventListener("click", (e) => { if (e.target === veil) permClose(); });
  const go = veil.querySelector(".tz-pc-go");
  if (go.focus) go.focus();
  requestAnimationFrame(() => veil.classList.add("on"));
  permWatch(kind);
  return true;
}

/** The two that are granted in System Settings turn yes while the person is away in them, so while the card is
 *  up the answer is read again every second — and once it is yes, the card says so and goes. */
function permWatch(kind) {
  PERM_WATCH = setTimeout(() => {
    PERM_WATCH = 0;
    if (PERM_UP !== kind) return;
    PERM_CARDS[kind].reading().then((on) => {
      if (PERM_UP !== kind) return;
      if (on === true) permSettled();
      else permWatch(kind);
    });
  }, K.num("desktop.perm.watchMs", 1000));
}

function permClose() {
  clearTimeout(PERM_WATCH);
  PERM_WATCH = 0;
  PERM_UP = "";
  document.querySelectorAll(".tz-pc-veil").forEach((v) => {
    v.classList.remove("on");
    setTimeout(() => v.remove(), K.num("desktop.perm.outMs", 220));
  });
}

document.addEventListener("keydown", (e) => { if (e.key === "Escape" && PERM_UP) permClose(); });

/** The main process: something it tried could not be done for want of one of these. */
try {
  if (window.tailzuApp && typeof window.tailzuApp.onPermNeeded === "function") {
    window.tailzuApp.onPermNeeded((kind) => { permNeed(kind); });
  }
} catch { /* an older main process says nothing, and nothing asks */ }
