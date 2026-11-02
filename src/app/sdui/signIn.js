// The sign-in screen's pieces, drawn from the server's auth tree: the pills
// you commit, the code boxes and the social buttons.

/**
 * THE GATE IS A SCREEN LIKE THE OTHERS NOW.
 *
 * It was the last one in this window that was not: its own markup in app.html,
 * its own tabs and its own big amber button, while the phones drew theirs from
 * `auth.screen` — the pills you swipe, the two round social buttons, the code
 * pill, the staggered rise. The first screen of the product was the one screen
 * that looked like a different product, and the only one whose wording and
 * arrangement still needed an installer.
 *
 * The same tree renders here. What differs is what a mouse can do: there is no
 * thumb to rest on a badge, so the pill commits on a click of its disc or on
 * Enter — the same rule SwipeAction already follows on the training tab. The
 * gesture was never the point; the deliberateness was.
 *
 * The auth LOGIC stays where it was, in the handlers below. These components
 * read this object and call into it; they do not know how to sign anybody in.
 */
const AUTH = {
  phase: "entry",         // entry | sending | verify | verifying
  method: "email",        // which pill was committed
  email: "",
  dial: "+1",
  phone: "",
  sentTo: "",
  code: "",
  codeLength: 6,
  codeError: false,
  /** Sending the code again is in flight / failed (the onboarding's code step says so). */
  resending: false,
  sendFailed: false,
  /** The dial code the server last asked a number to start with, so an edit to it is not undone. */
  dialFrom: "",
  error: "",
  /** Which pill is open for typing. Only one at a time: opening the second
   *  should close the first, or the screen has two carets in it. */
  open: "",
};

/** A row that flies in. The phones spring it; a window has no spring, so this
 *  is the same delay, the same travel and the same overshoot, in CSS. */
function riseNode(n, p, s, kids) {
  const delay = Number(p.delayMs) || 0;
  const from = Number(p.fromY) || 0;
  const scale = Number(p.scaleFrom) || 1;
  return '<div class="tz-rise" style="' + s +
    ";--rise-y:" + from + "px;--rise-s:" + scale +
    ";animation-delay:" + delay + 'ms">' + kids + "</div>";
}

/** The sign-in pills' defaults, under whatever the auth tree's props say —
 *  shared by the method pills, the code pill and the code pill's live border. */
function pillDefaults() {
  return K.obj("desktop.pill", {
    height: 56, fontSize: 15, background: "rgba(255,255,255,0.06)", border: "rgba(255,255,255,0.10)",
    text: "rgba(255,255,255,0.96)", badge: "rgba(255,255,255,0.10)", badgeBorder: "rgba(255,255,255,0.18)",
    target: "#F3E2C6", targetIcon: "#000000", codeFontSize: 17, codeSpacing: 8,
  });
}

/** One sign-in method. The pill IS the field: click it and the caret lands
 *  inside, type, then the disc at the right end commits. */
function swipePill(p, s) {
  const method = p.method === "phone" ? "phone" : "email";
  if (method === "phone" && !AUTH.phoneOn) return "";
  // The onboarding's: a field and a button, nothing to swipe.
  if (p.variant === "field") return fieldPill(method, p, s);
  const D = pillDefaults();
  const h = Number(p.height) || D.height;
  const open = AUTH.open === method;
  const value = method === "phone" ? AUTH.phone : AUTH.email;
  const ready = method === "phone" ? /^\+?\d{7,15}$/.test((AUTH.dial + value).replace(/[^\d+]/g, ""))
                                   : /.+@.+\..+/.test(value.trim());
  const badge = h - 10;
  const label = String((method === "phone" ? p.phoneLabel : p.emailLabel) ||
    (method === "phone" ? K.txt("desktop.gate.phoneLabel", "Phone number") : K.txt("desktop.gate.emailLabel", "Email address")));
  // The disc: at the left as a badge while the pill is closed; at the right
  // end the moment the pill opens — dim until there is something to send,
  // then the brand's amber with an arrow. It used to stay on the left until
  // the address was complete, which put it over the first letters of what
  // was being typed, and on the phone pill over the dial.
  // In flight: the row still draws, because the tree shows the same children
  // for "entry" and "sending" — but a second click would send a second code.
  const busy = AUTH.phase !== "entry";
  const disc = '<span class="tz-disc' + (busy ? " tz-busy" : "") + '" data-commit="' + method + '"' +
    ' role="button" tabindex="0" aria-label="' + esc(K.txt("desktop.gate.continue", "Continue")) + '"' +
    (busy ? ' aria-disabled="true"' : "") +
    ' style="width:' + badge + "px;height:" + badge + "px;" +
    (ready
      ? "right:5px;background:" + esc(tok(p.targetBackground || D.target)) +
        ";border-color:transparent;cursor:pointer"
      : (open ? "right:5px;" : "left:5px;") + "background:" + esc(tok(p.badgeBackground || D.badge)) +
        ";border-color:" + esc(tok(p.badgeBorderColor || D.badgeBorder))) + '">' +
    (ready
      ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="' +
        esc(tok(p.targetIconColor || D.targetIcon)) +
        '" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M5 12h13M12 5l7 7-7 7"/></svg>'
      : methodGlyph(method)) + "</span>";
  const dial = method === "phone" && open
    ? '<input class="tz-dial" data-dial="1" value="' + esc(AUTH.dial) + '" maxlength="5"' +
      ' inputmode="tel" aria-label="' + esc(K.txt("desktop.gate.countryCode", "Country code")) + '">'
    : "";
  return '<div class="tz-pill" style="' + s + ";height:" + h + "px;border-radius:" +
    (Number(p.radius) || h / 2) + "px;background:" + esc(tok(p.background || D.background)) +
    ";border:1px solid " + esc(tok(p.borderColor || D.border)) + '">' +
    disc + dial +
    '<input class="tz-pillin" data-pill="' + method + '"' +
    // TEXT, not email. Chromium refuses setSelectionRange on an email input,
    // and the caret has to be restored by hand after every repaint — so the
    // stricter type costs the field its cursor. inputmode still summons the
    // right keyboard and autocomplete still offers the right address.
    ' type="' + (method === "phone" ? "tel" : "text") + '"' +
    ' inputmode="' + (method === "phone" ? "tel" : "email") + '"' +
    ' placeholder="' + esc(label) + '" aria-label="' + esc(label) + '"' +
    ' autocomplete="' + (method === "phone" ? "tel" : "email") + '"' +
    ' spellcheck="false" value="' + esc(value) + '"' +
    ' style="padding-left:' + (open ? (method === "phone" ? 96 : 20) : h + 6) + "px" +
    ";padding-right:" + (open ? h + 6 : 18) + "px" +
    ";font-size:" + (Number(p.fontSize) || D.fontSize) + "px" +
    ";color:" + esc(tok(p.textColor || D.text)) + '"></div>';
}

function methodGlyph(method) {
  return method === "phone"
    ? '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.7)" stroke-width="1.8" stroke-linecap="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>'
    : '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.7)" stroke-width="1.8" stroke-linecap="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 6 10-6"/></svg>';
}

/** The code step: one pill, the digits spaced out, dots for what is missing. */
function codeEntry(p, s) {
  if (p.variant === "boxes") return codeBoxes(p, s);
  const D = pillDefaults();
  const h = Number(p.height) || D.height;
  const len = AUTH.codeLength;
  const shown = AUTH.code.padEnd(len, "·").split("").join(" ");
  const done = AUTH.code.length === len;
  return '<div class="tz-pill' + (AUTH.codeError ? " tz-shake" : "") + '" data-codebox="1" style="' + s +
    ";height:" + h + "px;border-radius:" + (h / 2) + "px;cursor:text" +
    ";background:" + esc(D.background) + ";border:1px solid " +
    (AUTH.codeError ? "var(--danger)" : done ? esc(tok(D.target)) : esc(D.border)) + '">' +
    // A real input, held invisible over the pill: the browser's own autofill
    // for a one-time code only offers itself to a field it can see.
    '<input data-code="1" inputmode="numeric" autocomplete="one-time-code"' +
    ' maxlength="' + len + '" value="' + esc(AUTH.code) + '" aria-label="' +
    esc(K.txt("desktop.gate.codeLabel", "Enter the code we sent you")) + '"' +
    ' style="position:absolute;inset:0;width:100%;height:100%;opacity:0;border:0;background:none">' +
    '<span style="width:100%;text-align:center;pointer-events:none;font-variant-numeric:tabular-nums' +
    ";letter-spacing:" + (Number(p.letterSpacing) || D.codeSpacing) + "px" +
    ";font-size:" + (Number(p.fontSize) || D.codeFontSize) + "px" +
    ";color:" + esc(D.text) + '">' + esc(shown) + "</span></div>";
}

/** Apple and Google, as the round icon buttons the phones draw — not the wide
 *  labelled rows this window used to have. */
function socialButton(provider, p, s) {
  // With words of its own it is the onboarding's wide button, not the round one.
  if (p.label) return wideSocial(provider, p, s);
  const size = Number(p.size) || K.num("desktop.gate.socialSize", 52);
  const mark = socialMark(provider, Math.round(size * (provider === "apple" ? 0.42 : 0.40)), "#fff");
  return '<button class="tz-social tz-press" data-oauth="' + provider + '"' +
    ' aria-label="' + esc(K.txt("desktop.gate.continueWith", "Continue with {provider}",
      { provider: provider === "apple" ? "Apple" : "Google" })) + '"' +
    ' style="' + s + ";width:" + size + "px;height:" + size + 'px">' + mark + "</button>";
}

// What the server writes into a style attribute of the onboarding's sign-in is
// a colour, a number or a short value; anything with a quote, a brace or a
// semicolon in it is not one, and falls back to the design's own.
const cssv = (v, fb) => (typeof v === "string" && /^[#a-zA-Z0-9(),.%\s-]{1,80}$/.test(v) ? v : fb);
const CHECK_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const CLOCK_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 12a8.5 8.5 0 1 0 17 0a8.5 8.5 0 1 0-17 0zM12 7.5V12l3 2"/></svg>';

/**
 * THE ONBOARDING'S SIGN-IN FIELD: a plain input and, under it, a button that
 * says what it does and lights up when the address (or the number) is good.
 *
 * Nothing to swipe and no disc to find. The pill is a gesture for a thumb; a
 * window has a keyboard, and "type it, then press the button that says what
 * happens" is how everyone signs in on one. The flow behind it is the same:
 * the button and Enter both go through commit(), the one door a code is sent
 * from, so the review address, the retries and the errors are all unchanged.
 */
function fieldPill(method, p, s) {
  const phone = method === "phone";
  // A number starts in the country the server names, once: a repaint must not
  // undo the person's own edit to it.
  if (phone && p.dial && AUTH.dialFrom !== String(p.dial)) { AUTH.dialFrom = String(p.dial); AUTH.dial = String(p.dial); }
  const value = phone ? AUTH.phone : AUTH.email;
  const ready = phone ? /^\+?\d{7,15}$/.test((AUTH.dial + value).replace(/[^\d+]/g, "")) : /.+@.+\..+/.test(value.trim());
  const busy = AUTH.phase !== "entry";
  const ask = label(p.placeholder) || (phone ? K.txt("desktop.gate.phoneLabel", "Phone number") : K.txt("desktop.gate.emailLabel", "Email address"));
  const go = label(p.submitLabel) || K.txt("desktop.gate.continue", "Continue");
  const vars = [
    "--f-h:" + okNum(p.height, 48, 32, 72) + "px", "--f-r:" + okNum(p.radius, 16, 0, 36) + "px", "--f-fs:" + okNum(p.fontSize, 17, 11, 28) + "px",
    "--f-bg:" + cssv(tok(p.background), "#FFFFFF"), "--f-bd:" + cssv(tok(p.borderColor), "#1C1A17"),
    "--f-tx:" + cssv(tok(p.textColor), "#1C1A17"), "--f-ph:" + cssv(tok(p.placeholderColor), "rgba(28,26,23,0.56)"),
    "--f-bbg:" + cssv(tok(p.buttonBackground), "#1C1A17"), "--f-btx:" + cssv(tok(p.buttonTextColor), "#FCFBF8"),
    "--f-bh:" + okNum(p.buttonHeight, 48, 32, 72) + "px", "--f-br:" + okNum(p.buttonRadius, 16, 0, 36) + "px",
    "--f-cbg:" + cssv(tok(p.countryBackground), "#FCFBF8"), "--f-cbd:" + cssv(tok(p.countryBorderColor), "rgba(28,26,23,0.13)"),
  ].join(";");
  const input = '<input class="ob-in" data-pill="' + method + '" data-field="1"' +
    // TEXT, not email, for the reason swipePill gives: the caret.
    ' type="' + (phone ? "tel" : "text") + '" inputmode="' + (phone ? "tel" : "email") + '"' +
    ' placeholder="' + esc(ask) + '" aria-label="' + esc(ask) + '" autocomplete="' + (phone ? "tel-national" : "email") + '"' +
    ' spellcheck="false" value="' + esc(value) + '">';
  const dial = '<input class="ob-dial" data-dial="1" value="' + esc(AUTH.dial) + '" maxlength="5" inputmode="tel" aria-label="' +
    esc(K.txt("desktop.gate.countryCode", "Country code")) + '">';
  return '<div class="ob-field" style="' + s + ";" + vars + '">' +
    (phone ? '<div class="ob-inrow">' + dial + input + "</div>" : input) +
    '<button type="button" class="ob-go" data-commit="' + method + '" data-field="1" data-ready="' + ready + '"' +
    (ready && !busy ? "" : " disabled") + (busy ? ' aria-busy="true"' : "") + ">" + esc(go) + "</button></div>";
}

/**
 * THE CODE, IN BOXES: one for each digit, the one to fill next lit, and under
 * them what is happening, a way to ask again and a way out to correct the
 * address. A real input is held invisibly over the boxes, so the browser can
 * offer a one-time code to it (autocomplete) and paste lands whole.
 *
 * Typing is drawn in place (liveCode), never by repainting: a repaint swaps
 * the input under the caret. Everything else repaints with the flow.
 */
function codeBoxes(p, s) {
  const len = AUTH.codeLength, code = AUTH.code;
  const done = code.length >= len || AUTH.phase === "verifying";
  const phone = AUTH.method === "phone";
  const vars = [
    "--bx-h:" + okNum(p.boxHeight, 60, 36, 90) + "px", "--bx-r:" + okNum(p.boxRadius, 14, 0, 30) + "px", "--bx-g:" + okNum(p.boxGap, 8, 0, 20) + "px",
    "--bx-bg:" + cssv(tok(p.boxBackground), "#FCFBF8"), "--bx-bd:" + cssv(tok(p.boxBorderColor), "rgba(28,26,23,0.13)"),
    "--bx-fbg:" + cssv(tok(p.boxFilledBackground), "#FFFFFF"), "--bx-fbd:" + cssv(tok(p.boxFilledBorderColor), "#1C1A17"),
    "--bx-ring:" + cssv(tok(p.boxActiveRing), "rgba(57,255,20,0.2)"), "--bx-dc:" + cssv(tok(p.digitColor), "#1C1A17"),
    "--bx-df:" + okFont(tok(p.digitFont), "Tailzu Grotesk") + ",system-ui", "--bx-ds:" + okNum(p.digitSize, 28, 14, 44) + "px",
    "--bx-tx:" + cssv(tok(p.textColor), "rgba(28,26,23,0.7)"), "--bx-lk:" + cssv(tok(p.linkColor), "#1C1A17"),
  ].join(";");
  // {to} and {len} are the flow's to fill; the rest of the line is the server's words, escaped.
  const sent = esc(label(p.sentTo) || "").replace(/\{len\}/g, () => String(len)).replace(/\{to\}/g, () => "<b>" + esc(AUTH.sentTo) + "</b>");
  const wait = String(label(p.waitLabel) || ""), ok = String(label(p.okLabel) || "");
  const shown = AUTH.sendFailed ? String(label(p.failLabel) || "") : done ? ok : wait;
  let cells = "";
  for (let i = 0; i < len; i++) {
    cells += '<div class="ob-box' + (i < code.length ? " f" : i === code.length ? " cur" : "") + '">' + esc(code[i] || "") + "</div>";
  }
  const stopped = AUTH.resending || AUTH.phase !== "verify";
  return '<div class="ob-code" style="' + s + ";" + vars + '">' +
    '<p class="ob-sent">' + sent + "</p>" +
    '<div class="ob-boxes' + (AUTH.codeError ? " tz-shake" : "") + '" data-codebox="1" data-variant="boxes">' +
    '<input data-code="1" inputmode="numeric" autocomplete="one-time-code" maxlength="' + len + '" value="' + esc(code) + '" aria-label="' +
    esc(K.txt("desktop.gate.codeLabel", "Enter the code we sent you")) + '">' + cells + "</div>" +
    '<div class="ob-status" data-status="1" data-wait="' + esc(wait) + '" data-ok="' + esc(ok) + '" data-fail="' + (AUTH.sendFailed ? "1" : "") +
    '" aria-live="polite"><span class="ob-ck"' + (done && !AUTH.sendFailed ? "" : " hidden") + ">" + CHECK_SVG + '</span><span class="ob-st">' + esc(shown) + "</span></div>" +
    '<button type="button" class="ob-link ob-resend" data-resend="1"' + (stopped ? " disabled" : "") + ">" + CLOCK_SVG + "<span>" + esc(label(p.resendLabel) || "") + "</span></button>" +
    '<div class="ob-wrong"><span>' + esc(label(phone ? p.wrongLabel : p.wrongEmailLabel) || "") + '</span> <button type="button" class="ob-link" data-back="1">' +
    esc(label(p.changeLabel) || "") + "</button></div></div>";
}

/** A digit typed or pasted: the boxes, the lit one and the status line, written in place. */
function liveCode(box) {
  const len = AUTH.codeLength, code = AUTH.code;
  box.querySelectorAll(".ob-box").forEach((cell, i) => {
    cell.textContent = code[i] || "";
    cell.className = "ob-box" + (i < code.length ? " f" : i === code.length ? " cur" : "");
  });
  const wrap = box.closest ? box.closest(".ob-code") : null;
  const st = wrap && wrap.querySelector("[data-status]");
  if (!st) return;
  const done = code.length >= len;
  st.querySelector(".ob-ck").hidden = !done;
  st.querySelector(".ob-st").textContent = (done ? st.getAttribute("data-ok") : st.getAttribute("data-wait")) || "";
}

/** Google's and Apple's own marks, drawn at `px`; Apple's takes the colour it is on. */
function socialMark(provider, px, apple) {
  return provider === "apple"
    ? '<svg width="' + px + '" height="' + px + '" viewBox="0 0 24 24"><path fill="' + apple + '" d="M16.365 1.43c0 1.14-.493 2.27-1.177 3.08-.744.9-1.99 1.57-2.987 1.57-.12 0-.23-.02-.3-.03-.01-.06-.04-.22-.04-.39 0-1.15.572-2.27 1.206-2.98.804-.94 2.142-1.64 3.248-1.68.03.13.05.28.05.43zm4.565 15.71c-.03.07-.46 1.58-1.51 3.14-.9 1.36-1.84 2.71-3.32 2.71-1.48 0-1.86-.88-3.56-.88-1.66 0-2.25.91-3.6.91-1.36 0-2.3-1.27-3.22-2.61-1.87-2.61-3.34-7.53-1.42-10.86.95-1.66 2.65-2.7 4.5-2.73 1.4-.03 2.72.95 3.58.95.85 0 2.45-1.18 4.12-1.01.7.03 2.67.28 3.93 2.13-.1.06-2.35 1.37-2.33 4.07.03 3.22 2.83 4.29 2.86 4.31z"/></svg>'
    : '<svg width="' + px + '" height="' + px + '" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
}

/**
 * GOOGLE AND APPLE AS A WIDE BUTTON WITH ITS WORDS, the onboarding's. The
 * round icon is the pill's company; this one stands alone above the email
 * field and says what it does. The look is the node's own props (the server
 * writes them once, for both sides of sign-in); ink on paper by default.
 */
function wideSocial(provider, p, s) {
  const h = okNum(p.size, 48, 32, 72), ink = cssv(tok(p.borderColor), "#1C1A17");
  const words = label(p.label) || K.txt("desktop.gate.continueWith", "Continue with {provider}", { provider: provider === "apple" ? "Apple" : "Google" });
  return '<button class="tz-social tz-press ob-social" data-oauth="' + provider + '" aria-label="' + esc(words) + '"' +
    ' style="' + s + ";width:100%;height:" + h + "px;border-radius:" + okNum(p.radius, 16, 0, 36) + "px;background:" + cssv(tok(p.background), "#FCFBF8") +
    ";border:" + okNum(p.borderWidth, 1.5, 0, 4) + "px solid " + ink + ";color:" + ink + '">' +
    socialMark(provider, 20, ink) + "<span>" + esc(words) + "</span></button>";
}
