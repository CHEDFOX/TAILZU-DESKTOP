// Navigation and painting: going to a screen and back, switching tabs,
// paint() and repaint(), and wiring what a paint drew.

let CURRENT_ACTIONS = {};

function go(screenId, params) {
  if (!screenId) return;
  STACK.push({ screenId, params });
  paint();
}

/**
 * A screen the MAIN PROCESS asked for — the paywall, when the hotkey was
 * refused for being out of words. The window may still be booting, so the
 * request waits for render() to lay the landing tab down and goes on top of
 * it; and a second request for the screen already showing is not a second
 * copy of it.
 */
let PENDING_SCREEN = null;
function navigateTo(target) {
  // A screen id, or { screenId, params }: a link's (main.js screenFromLink, a space's invite).
  const params = target && typeof target === "object" && target.params && typeof target.params === "object" ? target.params : undefined;
  const screenId = target && typeof target === "object" ? target.screenId : target;
  if (typeof screenId !== "string" || !screenId) return;
  if (!SESSION || !STACK.length) { PENDING_SCREEN = params ? { screenId, params } : screenId; return; }
  const top = STACK[STACK.length - 1];
  if (top && top.screenId === screenId && !params) return;
  // Coming back from connecting an app in the middle of onboarding: stay on
  // it, and read it again so the app shows as connected.
  if (top && top.screenId === "onboard") { paint(true); return; }
  go(screenId, params);
}
function back() {
  if (STACK.length > 1) { STACK.pop(); paint(); }
}
function switchTab(tabId) {
  const tab = TABS.find((t) => t.id === tabId);
  if (!tab) return;
  TAB_ID = tabId;
  STACK = [{ screenId: tab.screenId }];
  paint();
}

async function paint(force) {
  const cur = STACK[STACK.length - 1];
  if (!cur) return;
  paint._at = Date.now();
  // A LOOP THAT OUTLIVES ITS SCREEN HOLDS A LIVE MICROPHONE BEHIND A WINDOW
  // THE USER BELIEVES THEY HAVE LEFT. Ended here, before the next screen can
  // start one of its own.
  stopSession();
  if (MIC) { try { MIC.rec.stop(); } catch {} MIC = null; }
  // The bot's own voice (listen.js) is the exception: it stops only when the screen changes (another screen, or other params).
  // A write's paint(true) or a quiet reload of the same screen keeps a voice chat going while the feed updates under it.
  if (typeof voiceLeave === "function") voiceLeave(cur);
  // A sound or an upload started on another screen stops with it (media.js).
  if (typeof mediaLeave === "function") mediaLeave(cur);
  const view = $("view");
  // THE SCREEN THAT IS UP STAYS UP UNTIL THE NEXT ONE IS READY.
  //
  // This used to blank the view to "Loading…" the instant a navigation began,
  // so every screen change was three frames the eye could count: the old
  // screen gone, grey text on black, the new screen. On slide-to-begin that
  // was the blink between the pill and the session. Now the old screen holds
  // while the next is fetched and is replaced in ONE frame when it lands.
  //
  // A GENUINELY SLOW FETCH IS NOT A BLACK SHEET. It used to swap the page
  // for "Loading…" on the legacy ground, which is black — on the desk's paper
  // that was a dark slab across the window until the screen arrived. Now the
  // page that is up stays up, quietened and out of reach, and a thin amber
  // line runs along the top until the next one lands (#main[data-wait]).
  // Its delay is desktop.screen.waitMs. The old knob, slowMs, still timed the
  // black sheet on builds before this one, so the server holds that one high
  // (a minute) and those builds simply keep the old page up instead.
  const seq = paint._seq = (paint._seq || 0) + 1;
  const fresh = force || !paint._last || paint._last !== cur.screenId;
  let slow = 0;
  const main = $("main");
  const settled = () => { delete main.dataset.wait; view.removeAttribute("aria-busy"); };
  if (!paint._last) {
    // tz-loading: held out of sight while the onboarding holds the window, so
    // Blip stands on paper and not over a grey word.
    view.innerHTML = '<div class="pad tz-loading" style="color:var(--label)">' + esc(K.txt("desktop.screen.loading", "Loading…")) + "</div>";
  } else if (fresh) {
    slow = setTimeout(() => {
      if (seq !== paint._seq) return;
      dropField();
      main.dataset.wait = "1";
      view.setAttribute("aria-busy", "true");
    }, K.num("desktop.screen.waitMs", 700));
  }
  // Another page: a setup card that finished while it was in view has been
  // seen ticked, and the home page drops it from here on.
  if (paint._last !== cur.screenId) ASK_HOLD = false;
  paint._last = cur.screenId;
  let screen;
  // Offline, Home is drawn as the Offline page kept from the last time it was fetched (outbox.js); else fetched as ever.
  const kept = typeof offlineInstead === "function" ? offlineInstead(cur) : null;
  try {
    screen = kept || await fetchScreen(cur.screenId, cur.params);
  } catch (err) {
    clearTimeout(slow);
    if (seq !== paint._seq) return;
    settled();
    // Out of words is not a broken screen: it is the one the server names
    // for it, in place of the one that was refused.
    const quotaScreen = K.str("quota.screenId", "paywall");
    if (err && err.quota && cur.screenId !== quotaScreen) {
      STACK[STACK.length - 1] = { screenId: quotaScreen };
      return paint(true);
    }
    dropField();
    // A bot standing over an error is no help: the onboarding lets go.
    leaveOnboard();
    // The second line says what to do when there is something to say (a
    // refused request, no network); the error itself goes to the console.
    const why = userText(err, "");
    view.innerHTML = '<div class="pad"><p style="color:var(--danger)">' +
      esc(K.txt("desktop.screen.loadFailed", "Couldn't load this screen.")) + "</p>" +
      (why ? '<p style="color:var(--label);font-size:13px">' + esc(why) + "</p>" : "") + "</div>";
    return;
  }
  clearTimeout(slow);
  // A newer navigation started while this one was in flight. Its screen is
  // the one that should land; this one would paint over it a moment later.
  if (seq !== paint._seq) return;
  settled();
  STATE = Object.assign({}, screen.state || {});
  STATE.desktop = Object.assign({}, LOCAL);
  // The same screen fetched again (a write's refresh): an @ field still holding words keeps them (mention.js).
  if (repaint._target === cur && typeof mentionCarry === "function") mentionCarry();
  // `online`, `outbox`, `outboxWaiting` (outbox.js), and the Offline page kept while online.
  if (typeof offlineState === "function") Object.assign(STATE, offlineState());
  if (!kept && typeof offlineKeep === "function") offlineKeep(cur, screen);
  // Picks belong to the thread that was on screen. A new screen has none.
  CHAT_PICKED = {};
  CURRENT_ACTIONS = screen.actions || {};
  $("title").textContent = label(screen.title) || "";
  $("back").hidden = STACK.length <= 1;
  applyChrome(screen);
  // The stack entry this screen is for: a repaint of it (or a fetch of it again) is the same screen; another entry is not.
  repaint._next = cur;
  repaint(screen);
  micFollow();
  axFollow();
}

/**
 * A SCREEN THAT OWNS THE WINDOW.
 *
 * `hideChrome` and `hideHeader` are how the catalog says "this screen is the
 * whole surface" — the paywall says it, and so does the history view with its
 * own back chevron. Neither word appeared anywhere in this renderer, so the
 * paywall drew inside the rail and under the crumb: full-bleed art in a strip,
 * beside a nav bar it had asked not to have.
 *
 * Two more things a full-bleed screen needs that a padded column does not. Its
 * root asks for `flex: 1`, which means nothing inside a plain block — so the
 * view becomes a flex column for it and the root can actually fill. And it
 * scrolls no more: a screen the size of the window has nothing to scroll, and
 * an overflow container would let one stray absolute child add a scrollbar to
 * a screen with no content below the fold.
 */
function applyChrome(screen) {
  const bare = screen.hideChrome === true;
  const shell = $("shell"), view = $("view");
  shell.dataset.chrome = bare ? "0" : "1";
  $("crumb").hidden = bare || screen.hideHeader === true;
  view.dataset.full = bare ? "1" : "0";
}

/** Find a node by type anywhere in a tree. The chat and the mic need their own
 *  node back — for the paths the server named on it, and for its handlers —
 *  and the renderer returns strings, so there is nothing to close over. */
function findNode(n, type) {
  if (!n || typeof n !== "object") return null;
  if (n.type === type) return n;
  for (const c of n.children || []) { const r = findNode(c, type); if (r) return r; }
  return null;
}

/**
 * Picking a variant.
 *
 * Handled here rather than by the server, for the same reason the phones
 * handle it locally: the click has to answer instantly and a round trip
 * cannot. The choice is written to paths the SERVER names, then `onSelect`
 * fires — so the server still decides what a pick MEANS, it just does not have
 * to be present for the row to respond.
 */
function wireChat(view, sc) {
  const host = view.querySelector("[data-chat]");
  if (!host) return;
  const n = findNode(sc.root, "ChatThread");
  if (!n) return;
  const p = deepResolve(n.props || {});
  const rows = (() => { const r = stateAt((n.bind && n.bind.thread) || ""); return Array.isArray(r) ? r : []; })();

  view.querySelectorAll("[data-pick]").forEach((el) => {
    el.addEventListener("click", async () => {
      const [i, j] = el.getAttribute("data-pick").split(":").map(Number);
      const options = (rows[i] && rows[i].options || []).filter((o) => o && o.text);
      const taken = options[j];
      if (!taken) return;
      // Snapshot in the order the server's pick endpoint expects: what was
      // taken, then the two that were not.
      const others = options.filter((_, k) => k !== j);
      setStatePath(String(p.chosenPath || "_chosen"), taken.text || "");
      setStatePath(String(p.anglePath || "_angle"), taken.angle || "");
      setStatePath(String(p.rejectedAPath || "_rejA"), (others[0] && others[0].text) || "");
      setStatePath(String(p.rejectedBPath || "_rejB"), (others[1] && others[1].text) || "");
      CHAT_PICKED[i] = j;
      repaint();
      if (n.on && n.on.onSelect) await run(n.on.onSelect, taken.text || "");
    });
  });

  // A new row below the fold is a row nobody sees. After the paint, so the
  // rows have measured — scrolling before that lands short.
  requestAnimationFrame(() => { host.scrollTop = host.scrollHeight; });
}

function wireMic(view, sc) {
  view.querySelectorAll("[data-mic]").forEach((el) => {
    if (el.hasAttribute("data-hold")) { wireHold(el, sc); return; }
    el.addEventListener("click", async () => {
      // Stop first: a second click on a live button is "stop", not "start
      // another one on top of the one already running".
      if (MIC) { try { MIC.rec.stop(); } catch { MIC = null; repaint(); } return; }
      const path = el.getAttribute("data-mic") || "";
      const n = findNode(sc.root, "VoiceToggle") || findNode(sc.root, "VoiceButton");
      try {
        await micStart(path, n || {});
      } catch (err) {
        MIC = null;
        repaint();
        const eh = n && n.on && n.on.onError;
        const msg = (err && err.name === "NotAllowedError")
          ? K.txt("desktop.voice.micBlocked", "microphone blocked — allow it in your system settings")
          : userText(err, K.txt("desktop.recorder.micError", "Couldn't start the microphone. Try again."));
        if (eh) await run(eh, msg); else toast(msg);
      }
    });
  });
}

/**
 * THE HELD MIC. Pressing starts, letting go stops, wherever the pointer is by
 * then: the button is redrawn on every state change (the mic going live is
 * one), so the release is listened for on the window, not on a button that
 * will already be a different element. Letting go while the permission prompt
 * or the device was still opening stops the take the moment it starts, rather
 * than leaving a microphone running behind a hand that has gone. The window
 * losing focus mid-hold is a let-go too: nothing else would ever say so.
 */
let HELD = false;
function wireHold(el, sc) {
  const path = el.getAttribute("data-mic") || "";
  const n = findNode(sc.root, "VoiceButton") || {};
  const ends = ["pointerup", "pointercancel", "keyup", "blur"];
  const release = () => {
    ends.forEach((t) => window.removeEventListener(t, release));
    HELD = false;
    if (MIC) { try { MIC.rec.stop(); } catch { MIC = null; if (n.bind && n.bind.state) setStatePath(n.bind.state, "idle"); repaint(); } }
  };
  const press = async () => {
    if (HELD || MIC) return;
    HELD = true;
    ends.forEach((t) => window.addEventListener(t, release));
    try {
      await micStart(path, n);
      if (!HELD && MIC) { try { MIC.rec.stop(); } catch { /* it ended on its own */ } }
    } catch (err) {
      ends.forEach((t) => window.removeEventListener(t, release));
      HELD = false;
      MIC = null;
      if (n.bind && n.bind.state) setStatePath(n.bind.state, "idle");
      repaint();
      // A blocked microphone is not "I couldn't hear that": it needs the
      // system's settings, and says so. Anything else is the node's own line.
      if (err && err.name === "NotAllowedError") toast(K.txt("desktop.voice.micBlocked", "microphone blocked — allow it in your system settings"));
      else if (n.on && n.on.onError) await run(n.on.onError, userText(err, K.txt("desktop.recorder.micError", "Couldn't start the microphone. Try again.")));
      else toast(userText(err, K.txt("desktop.recorder.micError", "Couldn't start the microphone. Try again.")));
    }
  };
  el.addEventListener("pointerdown", (e) => { if (e.button !== 0) return; e.preventDefault(); void press(); });
  el.addEventListener("keydown", (e) => { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); void press(); } });
}

/** First node in the tree carrying this event, and the action it names. */
function findEvent(n, name) {
  if (!n || typeof n !== "object") return null;
  if (n.on && n.on[name]) return n.on[name];
  for (const c of n.children || []) { const r = findEvent(c, name); if (r) return r; }
  return null;
}

/**
 * KitExtras' startAtEnd: a box marked data-end (a Stack or a Scroll; a space's feed) opens at its end, and stays there as things come
 * in while the person is within desktop.screen.endSlackPx of it; scrolled further up, their place is kept. `near`: for each box of the
 * last paint of this screen, whether it was at its end (null: a new screen, every box starts at its end).
 */
function nearEnds(view) {
  const slack = K.num("desktop.screen.endSlackPx", 80);
  return Array.from(view.querySelectorAll("[data-end]")).map((el) => el.scrollHeight - el.scrollTop - el.clientHeight <= slack);
}
function keepEnds(view, near) {
  const slack = K.num("desktop.screen.endSlackPx", 80);
  view.querySelectorAll("[data-end]").forEach((el, i) => {
    let pinned = !near || near[i] !== false;
    const toEnd = () => { if (pinned && el.isConnected) el.scrollTop = el.scrollHeight; };
    toEnd();
    // Once laid out (a first paint measures late), and as pictures in it load.
    requestAnimationFrame(toEnd);
    el.addEventListener("scroll", () => { pinned = el.scrollHeight - el.scrollTop - el.clientHeight <= slack; }, { passive: true });
    el.addEventListener("load", toEnd, true);
  });
}

/**
 * KitExtras' autoFocus: a field marked data-af takes the focus when its id first appears on this screen: on the screen's first
 * paint, or when a setState shows it (the email field after Create); never again while it stays (a repaint, a quiet reload).
 */
let AF_SHOWN = new Set();
function focusNew(view, same) {
  const now = new Set();
  let focus = null;
  view.querySelectorAll("[data-af]").forEach((el) => {
    const id = el.getAttribute("data-af");
    if (!id) return;
    now.add(id);
    if (!focus && !(same && AF_SHOWN.has(id))) focus = el;
  });
  AF_SHOWN = now;
  if (focus && typeof focus.focus === "function") {
    try { focus.focus({ preventScroll: true }); } catch { /* not focusable */ }
  }
}

/**
 * onAppear (nodes.js appearAt): each node's action runs once as it comes onto this screen, on the screen's first paint or when a
 * setState shows it; never again while it stays (a repaint, a quiet reload), and again if it goes and comes back. Run after the
 * paint has landed and been wired, one turn later, so an action that repaints does so on a finished page.
 */
let AP_SHOWN = new Set();
function appearNew(same) {
  const now = new Set();
  const due = [];
  for (const a of APPEARS) {
    now.add(a.key);
    if (!(same && AP_SHOWN.has(a.key))) due.push(a.action);
  }
  AP_SHOWN = now;
  for (const act of due) Promise.resolve().then(() => run(act)).catch(() => undefined);
}

let CURRENT_SCREEN = null;
function repaint(screen) {
  if (screen) CURRENT_SCREEN = screen;
  // The sign-in stage is up in the gate: a state change (its step) is for it. Nothing on it takes the one key.
  if (gateUp()) { paintGate(); if (typeof talkToFollow === "function") talkToFollow(); return; }
  const sc = CURRENT_SCREEN;
  if (!sc) return;
  // The same screen drawn again (a state change, a write's fetch, a quiet reload): what the person was doing in it is kept, the
  // field being typed in and every box's scroll (live.js holdView), and a box at its end stays there. Another screen starts fresh.
  const target = repaint._next || repaint._target || STACK[STACK.length - 1] || null;
  repaint._next = null;
  const same = !!target && repaint._target === target;
  repaint._target = target;
  handlers = [];
  SUBMITS = [];
  APPEARS = [];
  BT_PENDING = [];
  // Whatever was turning words over belongs to the DOM about to be replaced.
  stopFlips();
  IN_KIT = sc.look === "bots";
  let html;
  try { html = sc.root ? node(sc.root) : '<div class="pad">' + (sc.blocks || []).map(node).join("") + "</div>"; }
  finally { IN_KIT = false; }
  const view = $("view");
  // A page with its own ground (a Bots page is white) paints the view in it, so nothing dark shows around it
  // while it fades in. Every other page keeps the view's own.
  const ground = sc.theme && sc.theme.color && sc.theme.color.bg;
  view.style.background = typeof ground === "string" && /^#[0-9a-f]{3,8}$/i.test(ground) ? ground : "";
  // A desk page sits on the desk's own ground. A phone screen pushed from one
  // (the paywall, a live training session) keeps its own dark room.
  view.dataset.look = DESK && sc.look === "desk" ? "desk" : "legacy";
  const before = stageBefore(view);
  const live = window.TailzuLive;
  const held = same && live && live.holdView ? live.holdView(document) : null;
  const near = same ? nearEnds(view) : null;
  // His stage's box and the @ field: where they were, for after (stage.js, mention.js).
  if (typeof stagesBefore === "function") stagesBefore(view);
  view.innerHTML = html;
  // A stage glides its own steps in; a fade of the whole stage on top of that
  // would be two entrances. Anything else ends the onboarding if it was on.
  const staged = stageAfter(view, before);
  if (!staged) leaveOnboard();
  // A NEW SCREEN ARRIVES, IT DOES NOT SNAP. The first paint of a screen fades
  // its content in over the field, which stays where it was; a repaint of the
  // same screen — a state change mid-session — is instant, as it must be.
  if (repaint._id !== sc.screenId && view.firstElementChild && !staged) {
    view.firstElementChild.classList.add("tz-swap");
  }
  repaint._id = sc.screenId;
  // A ROOT THAT ASKS TO FILL GETS SOMETHING TO FILL. The phones lay every
  // screen in a flex column, so a root with `flex: 1` is the height of the
  // screen there. In a plain block that number means nothing, and a root
  // whose children are all placed absolutely — the live session: the field,
  // the caption, the end button — has no height of its own and collapsed to
  // zero: black, and a field with nowhere to be. The view becomes a column
  // for such a root, and only for such a root; a padded page is left alone.
  const root = view.firstElementChild;
  view.dataset.flex = root && parseFloat(getComputedStyle(root).flexGrow) > 0 ? "1" : "0";
  startFlips();

  bindHandlers(view);
  // A code field (keyboard "code") is written in capitals, as it is shown.
  const valueOf = (el) => (el.getAttribute("data-kb") === "code" ? String(el.value).toUpperCase() : el.value);
  view.querySelectorAll("[data-s]").forEach((el) => {
    const act = SUBMITS[Number(el.getAttribute("data-s")) - 1];
    if (act) el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); setStatePath(el.getAttribute("data-bind"), valueOf(el)); void run(act); } });
  });
  view.querySelectorAll("[data-bind]").forEach((el) => {
    const path = el.getAttribute("data-bind");
    if (!path) return;
    el.addEventListener("input", () => { setStatePath(path, valueOf(el)); });
  });
  // A committed pill. `onComplete` is the phones' name for it and the catalog
  // sends the same tree to both, so the name is honoured rather than renamed.
  view.querySelectorAll("[data-ev='onComplete']").forEach((el) => {
    const ref = (sc.root && findEvent(sc.root, "onComplete")) || null;
    if (ref) el.addEventListener("click", () => { void run(ref); });
  });
  view.querySelectorAll("[data-toggle]").forEach((el) => {
    const path = el.getAttribute("data-toggle");
    if (!path) return;
    el.addEventListener("click", () => { setStatePath(path, !truthy(stateAt(path))); repaint(); });
  });
  wireChat(view, sc);
  wireMic(view, sc);
  wireField(view);
  // Live pages: a layer over each slot this paint drew (liveView.js).
  if (typeof wireLive === "function") wireLive(view);
  // Last: the living tiles and cards (an overlay card is lifted out to the body, after everything above is wired), his stage and
  // its thought (stage.js), the @ field moved back in (mention.js).
  mountBotTiles(view);
  if (held) live.restoreView(document, held);
  keepEnds(view, near);
  focusNew(view, same);
  appearNew(same);
  // Whether this screen's bot takes the one key now (listen.js).
  if (typeof talkToFollow === "function") talkToFollow();
  document.querySelectorAll("#tabs .tab, #mtabs .mtab").forEach((b) => {
    b.setAttribute("aria-current", String(b.dataset.tab === TAB_ID && STACK.length <= 1));
  });
}
