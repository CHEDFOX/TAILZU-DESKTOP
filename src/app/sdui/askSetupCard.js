// Ask's one-time setup card (DeskAskSetup): "Let Ask see what you see.", drawn
// from the permission states the main process reports.

/**
 * LET ASK SEE WHAT YOU SEE: the one-time setup card.
 *
 * The server sends the words (props: eyebrow, title, titleEm, lede, rows,
 * on, allow, turnOff, restart, restartButton, foot, policyLabel, policyUrl)
 * and where the card is (place: "home" or "settings"). Whether each row is
 * done it cannot know: Accessibility and Screen Recording are this Mac's
 * answers, and "look without asking" is a flag on this computer. So the
 * main process reports them (tailzuApp.askSetup, pushed again on onAskSetup)
 * and the rows are drawn from that:
 *
 *   { platform, read: on|off|na, see: on|off|restart|na, pictures: on|off|never }
 *
 * Until it has answered the home card stays away: an Allow that turns into
 * "On" a moment later is a button that moved under the pointer.
 */
let ASK_SETUP = null;     // the main process's last answer, or null until it gives one
let ASK_LISTENING = false;
// The home card was up with something left to do on this visit. When the last
// row turns on while it is in view it stays, every row ticked, until the next
// page: a card that vanished under the click read as the click going wrong.
let ASK_HOLD = false;
// When the card last sent a press. A double-click on the picture row's Allow
// landed its second click on the Turn off drawn in Allow's place, and the yes
// was taken back in the same breath; a double-click on Restart would ask for
// two relaunches. A second press inside the moment of a double-click is the
// same press.
let ASK_PRESSED_AT = 0;

/** Which button each kind of row has while it is off, and what turns it off
 *  again. Only these keys are drawn: a row the window has no state for has
 *  no honest way to say whether it is on. */
const ASK_ROWS = {
  read: { allow: { kind: "ask.openAccessibility" } },
  see: { allow: { kind: "ask.openScreenRecording" } },
  pictures: { allow: { kind: "ask.picturesAll", on: true }, off: { kind: "ask.picturesAll", on: false } },
};

/**
 * What each row shows, from the server's rows and the main process's state.
 * `mode` is one of on, allow, restart, never and wait (no state yet); `done`
 * puts the green tick in the disc. "na" is a permission this computer does
 * not have (Windows asks for neither), so the row is simply on.
 */
function askSetupRows(p, st) {
  const rows = Array.isArray(p && p.rows) ? p.rows : [];
  return rows.filter((r) => r && typeof r === "object" && Object.hasOwn(ASK_ROWS, r.key)).map((r, i) => {
    const kind = ASK_ROWS[r.key];
    const v = st ? String(st[r.key] || "") : "";
    const out = { key: r.key, n: i + 1, title: label(r.title) || "", sub: label(r.sub) || "", mode: "wait", done: false, action: null, off: null };
    if (v === "on" || v === "na") {
      out.mode = "on";
      out.done = true;
      // Only the picture row is this app's own switch; the Mac's two are
      // turned off where they were turned on, in System Settings.
      if (v === "on" && kind.off) out.off = kind.off;
    } else if (v === "off") {
      out.mode = "allow";
      out.action = kind.allow;
    } else if (v === "restart" && r.key === "see") {
      out.mode = "restart";
      out.action = { kind: "ask.relaunch" };
    } else if (v === "never" && r.key === "pictures") {
      // The server has pictures off for everyone: nothing here can allow it.
      out.mode = "never";
    }
    return out;
  });
}

/** Nothing on the card is left for the person to do: every row is on, or
 *  (pictures "never") is not theirs to change. */
const askSettled = (rows) => rows.every((r) => r.done || r.mode === "never");

function askSetupNode(p, s) {
  const rows = askSetupRows(p, ASK_SETUP);
  if (!rows.length) return "";
  const home = p.place !== "settings";
  if (home) {
    if (!ASK_SETUP) return "";
    const settled = askSettled(rows);
    if (settled && !ASK_HOLD) return "";
    if (!settled) ASK_HOLD = true;
  }
  const t = (v) => esc(label(v) || "");
  const tick = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.4 6.6 11.4 12.6 4.8"/></svg>';
  const btn = (action, words, quiet, title) => '<button type="button" class="d-ask-btn' + (quiet ? " d-ask-quiet" : "") + '"' +
    bind(action) + ' aria-label="' + esc(String(words) + ": " + title) + '">' + esc(words) + "</button>";
  const body = rows.map((r) => {
    let act = "";
    if (r.mode === "on") {
      act = '<span class="d-ask-state">' + tick + t(p.on) + "</span>" + (r.off ? btn(r.off, label(p.turnOff) || "", true, r.title) : "");
    } else if (r.mode === "allow") {
      act = btn(r.action, label(p.allow) || "", false, r.title);
    } else if (r.mode === "restart") {
      act = btn(r.action, label(p.restartButton) || "", false, r.title);
    } else if (r.mode === "never") {
      act = '<span class="d-ask-state d-ask-never">' + esc(K.txt("desktop.askSetup.never", "Off")) + "</span>";
    }
    return '<div class="d-ask-row" data-ask="' + esc(r.key) + '" data-mode="' + r.mode + '"' + (r.done ? ' data-done="1"' : "") + ">" +
      '<span class="d-ask-n" aria-hidden="true">' + (r.done ? tick : r.n) + "</span>" +
      '<div class="d-ask-text"><div class="d-ask-t">' + esc(r.title) + '</div><div class="d-ask-s">' + esc(r.sub) + "</div>" +
      (r.mode === "restart" ? '<div class="d-ask-note"><i></i>' + t(p.restart) + "</div>" : "") + "</div>" +
      '<div class="d-ask-act">' + act + "</div></div>";
  }).join("");
  // The server places the card with its own d- classes and style (a d-page
  // on the home page, say), on the outside; the column inside keeps the
  // card's own measure whatever the page around it is.
  const more = String(p.cls || "").split(/\s+/).filter((c) => /^d-[a-z0-9-]+$/.test(c));
  const policy = typeof p.policyUrl === "string" && /^https:\/\//.test(p.policyUrl) && label(p.policyLabel)
    ? ' <button type="button" class="d-ask-link"' + bind({ kind: "openUrl", url: p.policyUrl }) + ">" + t(p.policyLabel) + "</button>"
    : "";
  return '<section class="' + ["d-ask"].concat(more).join(" ") + '" data-place="' + (home ? "home" : "settings") + '"' +
    ' aria-label="' + esc([label(p.title), label(p.titleEm)].filter(Boolean).join(" ")) + '" style="' + s + '"><div class="d-ask-in">' +
    // In Settings the section's own heading names it, so the card is its
    // rows and the line under them; the headline is the home page's.
    (home
      ? (p.eyebrow ? '<div class="d-ask-eyebrow"><i></i>' + t(p.eyebrow) + "</div>" : "") +
        '<h2 class="d-ask-title">' + t(p.title) + (p.titleEm ? " <em>" + t(p.titleEm) + "</em>" : "") + "</h2>"
      : "") +
    (p.lede ? '<p class="d-ask-lede">' + t(p.lede) + "</p>" : "") +
    '<div class="d-ask-card">' + body + "</div>" +
    (p.foot || policy ? '<p class="d-ask-foot">' + t(p.foot) + policy + "</p>" : "") +
    "</div></section>";
}

/** Start following the states. Once, as soon as env() says Ask is on, so the
 *  first page that carries the card already has them. */
function askSetupWatch() {
  if (ASK_LISTENING || !ENV || !ENV.askSetup) return;
  ASK_LISTENING = true;
  try { window.tailzuApp.onAskSetup((st) => askSetupTook(st)); } catch { /* an older main process */ }
  askSetupRead();
}

function askSetupRead() {
  try { Promise.resolve(window.tailzuApp.askSetup()).then(askSetupTook, () => {}); } catch { /* an older main process */ }
}

/** A new answer from the main process. Redrawn only when something changed
 *  and only when the page on screen carries the card; the button that had the
 *  keyboard's focus keeps it, since a repaint replaces every element. */
function askSetupTook(st) {
  if (!st || typeof st !== "object") return;
  const next = {
    platform: String(st.platform || ""), read: String(st.read || ""),
    see: String(st.see || ""), pictures: String(st.pictures || ""),
  };
  if (ASK_SETUP && JSON.stringify(next) === JSON.stringify(ASK_SETUP)) return;
  ASK_SETUP = next;
  if (!CURRENT_SCREEN || !findNode(CURRENT_SCREEN.root, "DeskAskSetup")) return;
  const had = document.activeElement && document.activeElement.closest && document.activeElement.closest("[data-ask]");
  const key = had ? had.getAttribute("data-ask") : "";
  repaint();
  if (key) {
    const again = document.querySelector('#view [data-ask="' + key + '"] button');
    if (again) again.focus();
  }
}

/** A button on the card. The main process checks the kind and pushes the
 *  new state back. The picture switch is this computer's own flag, so it is
 *  drawn at once rather than after the round trip; the push confirms it. */
function askAction(kind, on) {
  // A clock set back reads as a long gap, never as a card that stops answering.
  const now = Date.now(), gap = now - ASK_PRESSED_AT;
  if (gap >= 0 && gap < K.num("desktop.askSetup.repeatMs", 500)) return;
  ASK_PRESSED_AT = now;
  try { window.tailzuApp.askSetupAction(kind, on); } catch { return; /* an older main process */ }
  if (kind === "picturesAll" && ASK_SETUP && ASK_SETUP.pictures !== "never") {
    askSetupTook(Object.assign({}, ASK_SETUP, { pictures: on ? "on" : "off" }));
  }
}
