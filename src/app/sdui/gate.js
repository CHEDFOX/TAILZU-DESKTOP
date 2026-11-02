// The sign-in gate: its layout beside the server's art, the bootstrap it needs
// before anyone is signed in, and the sign-in screen's state machine.

/**
 * STAND BESIDE THE ART, NOT ON IT.
 *
 * The sign-in art places a mark and a headline, and the form was centred in
 * the window — which is exactly where both of those are. On a wide window the
 * form takes a column of its own instead, at a position the server names,
 * because the art is an upload and the next one may be composed the other way
 * round.
 *
 * Below `wideAt` there is no second column to take, so it re-centres. Nothing
 * here runs at all for a server that sends no block: the window keeps the
 * centred layout it had.
 */
let GATE_LAYOUT = null;

function applyGateLayout(l) {
  if (l && typeof l === "object") GATE_LAYOUT = l;
  const g = $("gate");
  if (!g || !GATE_LAYOUT) return;
  const L = GATE_LAYOUT;
  const wide = window.innerWidth >= (Number(L.wideAt) || K.num("desktop.gate.wideAt", 860));
  const twoCol = wide && (L.align === "right" || L.align === "left");
  g.dataset.cols = twoCol ? "1" : "0";
  if (twoCol) {
    const col = Math.min(0.95, Math.max(0.05, Number(L.column) || K.num("desktop.gate.column", 0.5)));
    // Mirrored for "left", so one number describes either side.
    g.style.setProperty("--gate-col", ((L.align === "left" ? 1 - col : col) * 100) + "%");
    g.style.setProperty("--gate-w", (Number(L.columnWidth) || K.num("desktop.gate.columnWidth", 300)) + "px");
  } else {
    g.style.removeProperty("--gate-col");
    g.style.removeProperty("--gate-w");
  }
  // The scrim belongs to the layout: it darkens where the FORM is, and the
  // form only sits there when there is room for two columns.
  const bg = $("gatebg");
  if (bg) {
    bg.dataset.scrim = twoCol && typeof L.scrim === "string" && L.scrim.trim() ? "1" : "0";
    if (bg.dataset.scrim === "1") bg.style.setProperty("--gate-scrim", L.scrim);
    else bg.style.removeProperty("--gate-scrim");
  }
  // The art in these uploads already says "Code sent." and "Say it right.", so
  // the window's own heading and subtitle would be the same words twice. An
  // explicit switch, not an empty string: blank means "keep what you have"
  // everywhere else in this block, and it has to keep meaning that.
  const hide = (id, show) => { const el = $(id); if (el) el.hidden = show === false; };
  hide("gateTitle", L.showTitle);
  hide("gateSub", L.showSubtitle);
}

// A window that is resized across `wideAt` changes which layout applies.
window.addEventListener("resize", () => applyGateLayout());

/**
 * The bootstrap the GATE needs, fetched once.
 *
 * Two things on the sign-in screen come from the server — whether phone
 * sign-in is on, and the art behind the form — and both are needed before
 * there is a session. That is exactly why they ride in the boot flags rather
 * than in a screen: bootstrap is the only channel that reaches an app with
 * nobody signed into it. It runs on the fallback token here, which is all
 * either of them needs.
 *
 * Cached because it used to be called per question, and two callers meant two
 * round trips to answer one screen.
 */
let preBoot = null;
function gateBoot() {
  // ASKED AS A STRANGER. This runs before there is an account, and it used to
  // go out under the static fallback token — which resolves to a synthetic
  // user, so every launch that never signed in was charged a bootstrap against
  // somebody. Auth is optional on the route, so it simply asks without one.
  if (!preBoot) preBoot = bootstrapAnon().catch(() => null);
  return preBoot;
}

/**
 * Dress the sign-in screen with the uploaded art.
 *
 * `auth.background` is what the phones draw, and this window showed nothing at
 * all — so the first screen of the product looked like a different product on
 * the desktop. Same key, same upload, no second asset to keep in step.
 *
 * The code step gets its own art when one has been uploaded and falls back to
 * the entry's when it has not, which is the rule the phones follow.
 */
async function dressGate(step) {
  const b = await gateBoot();
  const flags = (b && b.flags) || {};
  const spec = (step === "code" && flags["auth.background.code"]) || flags["auth.background"];
  const host = $("gatebg");
  if (!host) return;
  if (!spec || !spec.url) { host.innerHTML = ""; return; }
  const gate = $("gate");
  if (gate && spec.background) gate.style.background = spec.background;
  const fit = spec.fit === "contain" ? "contain" : "cover";
  const isVideo = /^video\//.test(String(spec.contentType || "")) ||
                  /\.(mp4|mov|m4v|webm)(\?|$)/i.test(spec.url);
  // Rebuilding the element on every step would restart the clip mid sign-in,
  // so a source that has not changed is left alone.
  if (host.dataset.src === spec.url) return;
  host.dataset.src = spec.url;
  host.innerHTML = isVideo
    ? '<video src="' + esc(spec.url) + '" autoplay muted loop playsinline style="object-fit:' + fit + '"></video>'
    : '<img src="' + esc(spec.url) + '" alt="" style="object-fit:' + fit + '">';
}

/**
 * Paint the sign-in screen from the server's tree, and wire what it drew.
 *
 * Called on every change to AUTH, which is the whole state machine: a phase, a
 * typed value, a code. Repainting the lot each time is cheap — it is six rows —
 * and it means there is exactly one description of what the screen looks like
 * at any moment, rather than a set of imperative edits that have to agree.
 *
 * The rise animation is the one thing a full repaint would ruin: rows would fly
 * in again on every keystroke. So it runs once per PHASE, and repaints within a
 * phase are marked so the CSS sits them still.
 */
let AUTH_TREE = null;
let AUTH_RISEN = "";

/** The gate's error line, written from outside the sign-in state machine.
 *  A launch that never reached the backend has no tree to paint, so this
 *  writes the line directly: paintGate() draws nothing without one, and
 *  "couldn't reach the backend" is the one sentence that screen has to be
 *  able to say. */
function fail(msg) {
  AUTH.error = String(msg || "");
  const el = $("gateErr");
  if (el) el.textContent = AUTH.error;
}

function paintGate() {
  const host = $("gateForm");
  if (!host || !AUTH_TREE) return;
  const fresh = AUTH_RISEN !== AUTH.phase;
  AUTH_RISEN = AUTH.phase;
  host.dataset.still = fresh ? "0" : "1";
  // `handlers` is a module-level list that node() appends to as it renders an
  // `on.onPress`. repaint() clears it before drawing a screen; this draws
  // outside repaint(), so it has to clear it too — or the gate accumulates a
  // screen's worth of stale entries and binds by an id that has moved.
  handlers = [];
  // If the tree is the onboarding's stage, the page takes on its paper and
  // Blip goes to the step's spot; a step change glides.
  const before = stageBefore(host);
  host.innerHTML = node(AUTH_TREE);
  $("gateErr").textContent = AUTH.error;
  bindHandlers(host);
  stageAfter(host, before);
  wireGate();
}

/**
 * Attach what node() registered while rendering.
 *
 * This only ever ran inside repaint(), so a press written into the SERVER'S
 * auth tree drew its attribute and got no listener — the consent line's Terms
 * and Privacy Policy would have been underlined, looked tappable, and done
 * nothing. Exactly the failure `navigateBack` used to be.
 */
function bindHandlers(root) {
  handlers.forEach((h) => {
    const el = root.querySelector('[data-h="' + h.id + '"]');
    if (!el) return;
    el.addEventListener("click", () => { void run(h.action); });
    // A pressable box in the onboarding is a button to the keyboard as well.
    if (el.getAttribute("role") === "button") {
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void run(h.action); } });
    }
  });
}

function wireGate() {
  const host = $("gateForm");

  // Typing. The pill is the field, so its input writes straight into AUTH —
  // WITHOUT a repaint, which would take the caret with it. The disc's position
  // is the only thing that depends on the value, so it is moved by hand.
  host.querySelectorAll("[data-pill]").forEach((el) => {
    const m = el.getAttribute("data-pill");
    el.addEventListener("focus", () => {
      if (AUTH.open === m) return;
      // The onboarding's field is already open: nothing to redraw, which would
      // only cost it the caret.
      if (el.hasAttribute("data-field")) { AUTH.open = m; AUTH.error = ""; $("gateErr").textContent = ""; return; }
      AUTH.open = m; AUTH.error = "";
      paintGate();
      const again = host.querySelector('[data-pill="' + m + '"]');
      if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
    });
    el.addEventListener("input", () => {
      if (m === "phone") AUTH.phone = el.value; else AUTH.email = el.value;
      refreshDisc(m);
    });
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") void commit(m); });
  });
  const dial = host.querySelector("[data-dial]");
  if (dial) {
    dial.addEventListener("input", () => { AUTH.dial = dial.value; refreshDisc("phone"); });
    dial.addEventListener("keydown", (e) => { if (e.key === "Enter") void commit("phone"); });
  }

  host.querySelectorAll("[data-commit]").forEach((el) => {
    const m = el.getAttribute("data-commit");
    el.addEventListener("click", () => { void commit(m); });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void commit(m); }
    });
  });

  const box = host.querySelector("[data-codebox]");
  const codeIn = host.querySelector("[data-code]");
  if (box && codeIn) {
    box.addEventListener("click", () => codeIn.focus());
    codeIn.addEventListener("input", () => {
      AUTH.code = codeIn.value.replace(/\D/g, "").slice(0, AUTH.codeLength);
      codeIn.value = AUTH.code;
      AUTH.codeError = false;
      AUTH.error = "";
      // DRAWN BY HAND, NOT REPAINTED. A repaint replaced the input under the
      // caret with a fresh one, focused with its caret at the front — so the
      // next digit landed before the last, and the code read backwards; and
      // the focus did not always survive the swap, so every digit could cost
      // a click on the pill. The digits, the border and the error line are
      // the only things that change, and each is written in place.
      box.classList.remove("tz-shake");
      if (box.getAttribute("data-variant") === "boxes") {
        liveCode(box);
      } else {
        const shown = box.querySelector("span");
        if (shown) shown.textContent = AUTH.code.padEnd(AUTH.codeLength, "\u00b7").split("").join(" ");
        const D = pillDefaults();
        box.style.borderColor = AUTH.code.length === AUTH.codeLength ? tok(D.target) : D.border;
      }
      $("gateErr").textContent = "";
      codeIn.setSelectionRange(AUTH.code.length, AUTH.code.length);
      // Six digits is the whole answer — there is nothing else to press.
      if (AUTH.code.length === AUTH.codeLength) void submitCode();
    });
    codeIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && AUTH.code.length === AUTH.codeLength) void submitCode();
    });
    // The caret belongs here the moment the step opens — this IS the step.
    setTimeout(() => { const c = $("gateForm").querySelector("[data-code]"); if (c) c.focus(); },
      K.num("desktop.gate.codeFocusMs", 320));
  }

  host.querySelectorAll("[data-oauth]").forEach((el) => {
    el.addEventListener("click", () => { void oauth(el.getAttribute("data-oauth")); });
  });

  // The code boxes' two ways out: ask again, or correct the address.
  host.querySelectorAll("[data-resend]").forEach((el) => { el.addEventListener("click", () => { void resendCode(); }); });
  host.querySelectorAll("[data-back]").forEach((el) => { el.addEventListener("click", gateBack); });
}

/**
 * THE WAY BACK FROM THE CODE STEP.
 *
 * The phones have a corner arrow and a swipe from the left edge. This tree
 * carries neither, and a window has the gesture everybody already uses to back
 * out of anything: Escape. Without it a typo in the address was a dead end —
 * the code never arrives and there is nothing on the screen to press.
 *
 * The typed address is kept. Coming back to correct one character should not
 * clear the field.
 */
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") gateBack();
});

/** Back from the code to the address. Escape does it, and so does the code step's own "Change it". */
function gateBack() {
  const gate = $("gate");
  if ((gate && gate.hidden) || AUTH.phase !== "verify") return;
  AUTH.phase = "entry";
  AUTH.code = "";
  AUTH.codeError = false;
  AUTH.sendFailed = false;
  AUTH.error = "";
  paintGate();
  void dressGate("entry");
}

/**
 * SEND THE CODE AGAIN, to the address it first went to. The phase stays
 * "verify": it is the same step asked a second time, so Blip does not move and
 * nothing glides. A press while one is in flight is the same press. The old
 * code is spent the moment a new one is sent, so what was typed is cleared; and
 * a send that fails says so on the step (sendFailed), where the person is
 * looking, and not only in the line at the foot of the window.
 */
async function resendCode() {
  if (AUTH.phase !== "verify" || AUTH.resending || !AUTH.sentTo) return;
  AUTH.resending = true;
  AUTH.sendFailed = false;
  AUTH.error = "";
  paintGate();
  try {
    if (AUTH.method === "phone") await signInPhone(AUTH.sentTo); else await signIn(AUTH.sentTo);
    AUTH.code = "";
    AUTH.codeError = false;
  } catch (e) {
    userText(e, "");            // for the log; the step says it in its own words
    AUTH.sendFailed = true;
  } finally {
    AUTH.resending = false;
    paintGate();
  }
}

/**
 * Send the code. The phones swipe a badge to get here; a mouse has no thumb to
 * rest, so the disc is clicked and Enter does the same — the rule SwipeAction
 * already follows on the training tab.
 */
async function commit(method) {
  if (AUTH.phase !== "entry") return;   // already sending
  AUTH.error = "";
  AUTH.sendFailed = false;
  try {
    let to;
    if (method === "phone") {
      to = (AUTH.dial + AUTH.phone).replace(/[^\d+]/g, "");
      if (!/^\+\d{7,15}$/.test(to)) {
        throw worded(K.txt("desktop.gate.badPhone", "Enter a number with its country code, like +1 555 000 1234."));
      }
    } else {
      to = AUTH.email.trim();
      if (!/.+@.+\..+/.test(to)) throw worded(K.txt("desktop.gate.badEmail", "Enter your email address."));
    }
    AUTH.phase = "sending";
    paintGate();
    if (method === "phone") await signInPhone(to); else await signIn(to);
    AUTH.method = method;
    AUTH.sentTo = to;
    AUTH.code = "";
    AUTH.codeError = false;
    AUTH.phase = "verify";
    paintGate();
    void dressGate("code");
  } catch (e) {
    AUTH.phase = "entry";
    AUTH.error = userText(e, K.txt("desktop.gate.authFailed", "Couldn't sign you in. Try again."));
    paintGate();
  }
}

/** Answer with whichever address the code actually went to. */
async function submitCode() {
  if (AUTH.phase !== "verify") return;
  AUTH.phase = "verifying";
  AUTH.error = "";
  paintGate();
  try {
    if (AUTH.method === "phone") await verifyPhone(AUTH.sentTo, AUTH.code);
    else await verify(AUTH.sentTo, AUTH.code);
    await render();
  } catch (e) {
    // The code was wrong, not the screen. Stay on the step, say so, shake it,
    // and clear it — retyping six digits over six wrong ones is worse than
    // starting them again.
    AUTH.phase = "verify";
    AUTH.codeError = true;
    AUTH.code = "";
    AUTH.error = userText(e, K.txt("desktop.gate.codeWrong", "That code didn't work. Check it and try again."));
    paintGate();
  }
}

/** Apple / Google. The main process owns the window, the PKCE secret and the
 *  code exchange; this only asks and reacts. */
async function oauth(provider) {
  AUTH.error = "";
  const host = $("gateForm");
  host.querySelectorAll("[data-oauth]").forEach((b) => { b.disabled = true; });
  try {
    const r = await window.tailzuApp.oauth(provider);
    if (!r || !r.ok) {
      // Closing the window is a decision, not a failure worth shouting about.
      if (r && r.error === "cancelled") return;
      // The main process's reason ("no authorization code", Supabase's
      // own) is for the log; the person gets the phones' sentence.
      throw worded(provider === "apple"
        ? K.txt("auth.apple.errorBody", "Apple sign-in didn't go through. Try again, or use your email.")
        : K.txt("auth.google.errorBody", "Google sign-in didn't go through. Try again, or use your email."),
      (r && r.error) || "no session");
    }
    SESSION = r.session;
    location.reload();
  } catch (e) {
    AUTH.error = userText(e, K.txt("desktop.gate.signInFailed", "Sign-in failed."));
    paintGate();
  } finally {
    const again = $("gateForm");
    if (again) again.querySelectorAll("[data-oauth]").forEach((b) => { b.disabled = false; });
  }
}

/** The disc alone, so typing does not repaint the caret out of the field. */
function refreshDisc(method) {
  const host = $("gateForm");
  const el = host && host.querySelector('[data-commit="' + method + '"]');
  if (!el) return;
  const ready = method === "phone"
    ? /^\+?\d{7,15}$/.test((AUTH.dial + AUTH.phone).replace(/[^\d+]/g, ""))
    : /.+@.+\..+/.test(AUTH.email.trim());
  if (el.dataset.ready === String(ready)) return;
  el.dataset.ready = String(ready);
  // The onboarding's button only lights or dims; nothing is redrawn, so the
  // caret stays where it is.
  if (el.hasAttribute("data-field")) { el.disabled = !ready || AUTH.phase !== "entry"; return; }
  // Re-rendered rather than restyled: at the right end it is an arrow, at the
  // left it is the method's own glyph, and those are different drawings.
  paintGate();
  const again = $("gateForm").querySelector('[data-pill="' + method + '"]');
  if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
}
