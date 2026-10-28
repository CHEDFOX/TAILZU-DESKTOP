/**
 * SIGN IN WITH THE PHONE: the QR panel beside the window's sign-in form
 * (DSignIn's right column; the server sends `DeskLinkSignIn` with its words,
 * screens/firstRun.ts, and sdui.js's node() hands it here).
 *
 * A page script loaded after sdui.js, so it uses that file's own pieces: ENV
 * (the backend, this computer's name and system), sbFetch (Supabase with the
 * anon key), setSession and render (the same two steps a typed code ends
 * with), esc and label.
 *
 *   1. Drawn, it asks POST /v1/auth/link, signed out, for a request: a token
 *      (in the QR's link, which opens bots.link on the phone), a secret (kept
 *      here, in memory only), a code to type instead, and the QR itself, drawn
 *      by the server from its own encoder (no service is asked).
 *   2. It waits on POST /v1/auth/link/poll (held up to 25 s each time) while
 *      the panel is on screen. The code lasts five minutes; a new one is shown
 *      when it runs out, a few times, then a button does it (and only while the
 *      window is in front).
 *   3. Approved on the phone, the answer carries a one-time sign-in (a hashed
 *      token), which Supabase's /auth/v1/verify turns into this window's own
 *      session. The request is spent by then: nothing can take it twice.
 *
 * Refused ("Not me"), run out, or no sign-in made: it says so, with a button
 * for a new code. A server without it (404) leaves the panel out. Nothing here
 * logs the token, the secret or the sign-in.
 */

/** The panel's one request, and where it is. */
const LINK = {
  gen: 0,          // bumped by every new request: an older loop sees it and stops
  req: null,       // { token, secret, code, qr: { size, path }, endsAt, pollMs }
  state: "idle",   // idle | loading | waiting | approved | denied | expired | failed | offline | off
  renewals: 0,     // new codes shown on their own since the last press
  props: {},       // the server's words, from the last draw
  style: "",       // the node's own style
  tick: 0,         // the countdown's interval
};
/** New codes shown on their own before a press is needed: half an hour. */
const LINK_MAX_RENEWALS = 6;
const LINK_PATH_RE = /^(M\d{1,3} \d{1,3}h\d{1,3}v1h-\d{1,3}z)+$/;
const LINK_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** A word from the server's props, or its first-frame default. */
const linkWord = (k, fallback) => {
  const v = label(LINK.props && LINK.props[k]);
  return typeof v === "string" && v ? v : fallback;
};

/** The node: an "or" between the form and the panel, then the panel. Starts a request the first time it is drawn. */
function linkSignInNode(p, s) {
  LINK.props = p || {};
  LINK.style = s || "";
  linkStyles();
  if (LINK.state === "off") return "";
  if (LINK.state === "idle") void linkStart();
  return '<div class="d-qr-or" aria-hidden="true"><span></span>' + esc(linkWord("or", "or")) + "<span></span></div>" + linkSection();
}

function linkSection() {
  const st = LINK.state, r = LINK.req;
  const steps = Array.isArray(LINK.props.steps) ? LINK.props.steps : ["Open the camera on your phone", "Point it at this code", "Tap Approve in Tailzu"];
  let qr;
  if (r && r.qr) {
    const n = r.qr.size;
    qr = '<svg viewBox="0 0 ' + n + " " + n + '" width="132" height="132" role="img" shape-rendering="crispEdges" aria-label="' +
      esc(linkWord("qrLabel", "Sign-in code for your phone")) + '"><rect width="' + n + '" height="' + n + '" fill="#ffffff"/><path fill="#0a0a0a" d="' +
      r.qr.path + '"/></svg>';
  } else {
    qr = '<span class="d-qr-blank" aria-hidden="true"></span>';
  }
  const typed = r ? esc(linkWord("typed", "No camera? In Tailzu, go to You, then Link a computer, and type {code}")).split("{code}")
    .join('<b class="d-qr-code">' + esc(r.code) + "</b>") : "";
  let status;
  if (st === "waiting") {
    status = '<svg class="d-qr-mark" viewBox="0 0 8 8" width="8" height="8" aria-hidden="true"><circle cx="4" cy="4" r="3.25" stroke-dasharray="1.7 1.7"/></svg>' +
      "<span data-link-left>" + esc(linkLeftText()) + "</span>";
  } else if (st === "approved") {
    status = '<svg class="d-qr-mark d-qr-ok" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3.5 8.4 6.6 11.4 12.6 4.8"/></svg><span>' +
      esc(linkWord("approved", "Approved on your phone. Signing you in…")) + "</span>";
  } else if (st === "loading" || st === "idle") {
    status = "<span>" + esc(linkWord("loading", "Making a code…")) + "</span>";
  } else {
    const say = { denied: linkWord("denied", "Not approved on your phone."), expired: linkWord("expired", "This code ran out."),
      failed: linkWord("failed", "Couldn't sign you in this way. Use your number or email."), offline: linkWord("offline", "Couldn't make a code. Check your connection.") }[st] || "";
    status = "<span>" + esc(say) + '</span><button type="button" class="d-qr-renew" data-link-renew>' + esc(linkWord("renew", "Show a new code")) + "</button>";
  }
  return '<section class="d-qr" data-link-panel data-state="' + esc(st) + '" aria-label="' + esc(linkWord("title", "Scan with your phone")) + '" style="' + LINK.style + '">' +
    '<div class="d-qr-head"><span class="d-qr-t">' + esc(linkWord("title", "Scan with your phone")) + '</span><span class="d-qr-s">' +
    esc(linkWord("sub", "Already use Tailzu there? No code to type.")) + "</span></div>" +
    '<div class="d-qr-box">' + qr + "</div>" +
    '<ol class="d-qr-steps">' + steps.slice(0, 4).map((w) => "<li>" + esc(label(w) || "") + "</li>").join("") + "</ol>" +
    (typed ? '<p class="d-qr-typed">' + typed + "</p>" : "") +
    '<div class="d-qr-status" role="status" aria-live="polite">' + status + "</div></section>";
}

/** "Code changes in 4:48". */
function linkLeftText() {
  const left = LINK.req ? Math.max(0, Math.ceil((LINK.req.endsAt - Date.now()) / 1000)) : 0;
  const t = Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0");
  return linkWord("changesIn", "Code changes in {t}").split("{t}").join(t);
}

/** The panel again, in place: the form beside it keeps its caret. */
function linkRedraw() {
  const el = document.querySelector("[data-link-panel]");
  if (el) el.outerHTML = linkSection();
  linkCountdown();
}

/** The countdown, once a second while a code is up. */
function linkCountdown() {
  clearInterval(LINK.tick);
  LINK.tick = 0;
  if (LINK.state !== "waiting") return;
  LINK.tick = setInterval(() => {
    const el = document.querySelector("[data-link-left]");
    if (!el || LINK.state !== "waiting") { clearInterval(LINK.tick); LINK.tick = 0; return; }
    el.textContent = linkLeftText();
  }, 1000);
}

/** Is the panel on screen, in a window nobody has signed into? */
function linkShown() {
  const gate = document.getElementById("gate");
  return !SESSION && !!(gate && !gate.hidden) && !!document.querySelector("[data-link-panel]");
}

const linkHeaders = () => ({ "Content-Type": "application/json" });
const linkSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A new request: the QR, the code and the secret. */
async function linkStart() {
  const gen = ++LINK.gen;
  LINK.state = "loading";
  LINK.req = null;
  try {
    const res = await fetch(ENV.baseUrl + "/v1/auth/link", {
      method: "POST", headers: linkHeaders(),
      body: JSON.stringify({ deviceName: String((ENV && ENV.deviceName) || ""), platform: String((ENV && ENV.os) || "") }),
    });
    if (gen !== LINK.gen) return;
    // A server without it: the panel goes, and the form is the whole card.
    if (res.status === 404) { LINK.state = "off"; linkGone(); return; }
    if (!res.ok) throw new Error("link → " + res.status);
    const r = await res.json();
    if (gen !== LINK.gen) return;
    const size = Number(r && r.qr && r.qr.size);
    if (!r || !LINK_TOKEN_RE.test(r.token) || !LINK_TOKEN_RE.test(r.secret) || typeof r.code !== "string" || !/^[0-9A-Z-]{4,12}$/.test(r.code)) throw new Error("link: not a request");
    // Drawn only as what it says it is: a size, and runs of modules.
    const qr = Number.isInteger(size) && size >= 21 && size <= 200 && typeof r.qr.path === "string" && LINK_PATH_RE.test(r.qr.path) ? { size, path: r.qr.path } : null;
    LINK.req = {
      token: r.token, secret: r.secret, code: r.code, qr,
      // Counted on this computer's clock: the server's may differ.
      endsAt: Date.now() + Math.min(Math.max(Number(r.ttlMs) || 300000, 30000), 900000),
      pollMs: Math.min(Math.max(Number(r.pollMs) || 1500, 500), 10000),
    };
    LINK.state = "waiting";
    linkRedraw();
    void linkPoll(gen);
  } catch (e) {
    if (gen !== LINK.gen) return;
    userText(e, "");
    LINK.state = "offline";
    linkRedraw();
  }
}

/** The "or" and the panel out of the card, for a server that does not have this. */
function linkGone() {
  const el = document.querySelector("[data-link-panel]");
  if (!el) return;
  const or = el.previousElementSibling;
  if (or && or.classList && or.classList.contains("d-qr-or")) or.remove();
  el.remove();
}

/** Back to nothing, for the next time the panel is drawn. */
function linkReset() {
  LINK.gen++;
  LINK.req = null;
  LINK.state = "idle";
  clearInterval(LINK.tick);
  LINK.tick = 0;
}

/** Wait for the phone. One held request at a time; a failed one backs off. */
async function linkPoll(gen) {
  let pause = 0;
  while (gen === LINK.gen && LINK.state === "waiting") {
    if (pause) await linkSleep(pause);
    if (gen !== LINK.gen) return;
    // Signed in some other way, or the sign-in step is gone: stop, and start afresh if it comes back.
    if (!linkShown()) { linkReset(); return; }
    const r = LINK.req;
    const asked = Date.now();
    let answer;
    try {
      const res = await fetch(ENV.baseUrl + "/v1/auth/link/poll", {
        method: "POST", headers: linkHeaders(), body: JSON.stringify({ token: r.token, secret: r.secret, wait: 25 }),
      });
      if (gen !== LINK.gen) return;
      if (res.status === 404) answer = { status: "expired" };
      else if (!res.ok) { pause = Math.min(Math.max(pause * 2, 2000), 20000); continue; }
      else answer = await res.json();
    } catch {
      pause = Math.min(Math.max(pause * 2, 2000), 20000);
      continue;
    }
    if (gen !== LINK.gen) return;
    pause = 0;
    const status = answer && answer.status;
    if (status === "pending") {
      if (Date.now() >= r.endsAt) { linkRanOut(); return; }
      // A server that answered at once (not held): ask again after a moment, not at once.
      if (Date.now() - asked < 2000) pause = r.pollMs;
      continue;
    }
    if (status === "approved" && typeof answer.tokenHash === "string" && answer.tokenHash) { await linkSignIn(gen, answer); return; }
    if (status === "denied") { LINK.state = "denied"; linkRedraw(); return; }
    if (status === "expired") { linkRanOut(); return; }
    // "used" (taken already) or "failed" (no sign-in could be made).
    LINK.state = "failed";
    linkRedraw();
    return;
  }
}

/** The code ran out: a new one while someone is looking, a few times; else the button. */
function linkRanOut() {
  if (LINK.renewals < LINK_MAX_RENEWALS && !document.hidden && linkShown()) {
    LINK.renewals++;
    void linkStart();
    return;
  }
  LINK.state = "expired";
  LINK.req = null;
  linkRedraw();
}

/** Approved: the one-time sign-in becomes this window's session, as a typed code's does. */
async function linkSignIn(gen, answer) {
  LINK.state = "approved";
  linkRedraw();
  try {
    const type = answer.type === "email" ? "email" : "magiclink";
    const session = await sbFetch("/auth/v1/verify", { token_hash: answer.tokenHash, type });
    if (gen !== LINK.gen) return;
    await setSession(session);
    if (!SESSION) throw new Error("link: no session");
    linkReset();
    await render();
  } catch (e) {
    if (gen !== LINK.gen) return;
    userText(e, "");
    LINK.state = "failed";
    LINK.req = null;
    linkRedraw();
  }
}

// "Show a new code": a press starts the count of new codes again.
document.addEventListener("click", (e) => {
  const b = e.target && e.target.closest ? e.target.closest("[data-link-renew]") : null;
  if (!b) return;
  LINK.renewals = 0;
  void linkStart();
});

/** The panel's look (DSignIn), once. */
function linkStyles() {
  if (document.getElementById("d-qr-css")) return;
  const el = document.createElement("style");
  el.id = "d-qr-css";
  el.textContent = [
    ".d-qr-or{display:flex;flex-direction:column;align-items:center;gap:8px;padding:20px 0;font-size:12px;line-height:16px;color:#5c5c5c;flex:0 0 auto}",
    ".d-qr-or span{flex-grow:1;width:1px;background:#ededed}",
    ".d-qr{flex:1 1 200px;min-width:0;padding:20px;display:flex;flex-direction:column;gap:12px;box-sizing:border-box;font-family:'Tailzu Geist',var(--f-ui),system-ui,sans-serif;color:#0a0a0a}",
    ".d-qr-head{display:flex;flex-direction:column;gap:3px}",
    ".d-qr-t{font-family:'Tailzu Geist SemiBold','Tailzu Geist',system-ui,sans-serif;font-size:16px;line-height:21px}",
    ".d-qr-s{font-size:13px;line-height:18px;color:#3d3d3d}",
    ".d-qr-box{align-self:flex-start;padding:8px;border:1px solid #e6e6e6;border-radius:14px;display:flex;background:#ffffff}",
    ".d-qr-box svg,.d-qr-blank{display:block;width:132px;height:132px}",
    ".d-qr-blank{border-radius:6px;background:#f5f5f5}",
    ".d-qr[data-state=approved] .d-qr-box svg,.d-qr[data-state=denied] .d-qr-box svg,.d-qr[data-state=failed] .d-qr-box svg{opacity:.2}",
    ".d-qr-steps{margin:0;padding-left:18px;font-size:13px;line-height:20px;color:#3d3d3d}",
    ".d-qr-typed{margin:0;font-size:12px;line-height:17px;color:#5c5c5c}",
    ".d-qr-code{font-family:'Tailzu Geist Mono',ui-monospace,monospace;font-weight:500;color:#0a0a0a;letter-spacing:.5px;white-space:nowrap;user-select:all}",
    ".d-qr-status{display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-size:12px;line-height:16px;color:#5c5c5c}",
    ".d-qr-mark{flex-shrink:0;fill:none;stroke:#0a0a0a;stroke-width:1.5}",
    ".d-qr-ok{stroke-width:2;stroke-linecap:round;stroke-linejoin:round}",
    ".d-qr-renew{font:inherit;font-family:'Tailzu Geist Medium','Tailzu Geist',system-ui,sans-serif;font-size:13px;color:#0a0a0a;background:#ffffff;border:1px solid #d4d4d4;border-radius:18px;height:32px;padding:0 14px;cursor:pointer}",
    ".d-qr-renew:focus-visible{outline:2px solid #0a0a0a;outline-offset:2px}",
    // A narrow window: the panel under the form, the "or" across.
    "@media (max-width:640px){.d-qr-or{flex:1 1 100%;flex-direction:row;padding:0 20px}.d-qr-or span{height:1px;width:auto}.d-qr{flex-basis:100%}}",
  ].join("\n");
  document.head.appendChild(el);
}
