// Apple and Google sign-in, the parts that need no window: the Supabase
// project, the provider's authorize URL (PKCE), the loopback page the real
// browser hands the code to, and the code's exchange for a session. main.js
// runs the flow (oauthSignIn) and owns the fallback window (oauthEmbedded).

const { shell } = require("electron");
const { txt, num, str, color } = require("../../knobs.js");

// The public client credential, same pair the window and the phones use. It is
// the anon key: safe in a distributable, useless without a user's own tokens.
const SUPABASE_URL = "https://merzyohecmyfvlyahxaz.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1lcnp5b2hlY215ZnZseWFoeGF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyMjU1MzAsImV4cCI6MjA5NzgwMTUzMH0.scDhHeRU20wRIgKBFL8GouIEp8bJG8w8aIsySUkePHY";

// The phone signs in with Apple and Google natively: the OS hands the app an
// identity token and Supabase trades it for a session. A desktop has no such
// OS service, so this is the web flow — the provider's own consent page, in a
// window we own, with PKCE so the authorization code is useless to anyone who
// intercepts it.
//
// Nothing is caught by loading the redirect. The moment the browser tries to
// GO to it we read the code off the URL and cancel the request, so the page at
// the redirect URL is never fetched and does not have to exist. It only has to
// be on the provider's allow-list, which is why it is a real https URL on a
// domain that is ours rather than a localhost port or a custom scheme.
function redirectUrl() { return str("desktop.oauth.redirectUrl", "https://x0bot.com/auth/callback"); }

// GOOGLE WILL NOT SIGN YOU IN INSIDE A WINDOW WE OWN.
//
// Their policy is disallowed_useragent: an OAuth consent screen loaded in an
// embedded browser is refused, by design, because the app hosting it can read
// everything typed into it. Apple is less strict but heading the same way. So
// the window above works for one provider and fails for the other, and the
// failure arrives as Google's own "this browser may not be secure" page, which
// reads as our bug.
//
// The way a desktop app is supposed to do this: send the person to their REAL
// browser, where they are probably already signed in, and catch the redirect on
// a loopback address only this machine can reach.
//
// Google never sees this address. The provider redirects to Supabase, and
// Supabase redirects to `redirect_to` — so the only allow-list this has to be
// on is Supabase's own, under URL Configuration.
function loopbackPort() { return num("desktop.oauth.loopbackPort", 8788); }
function loopbackUrl() { return "http://127.0.0.1:" + loopbackPort() + "/cb"; }

const escHtml = (s) =>
  String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** The page the browser shows once it has handed the code over. */
function closePage() {
  return "<!doctype html><meta charset=utf-8><title>" + escHtml(txt("desktop.oauth.pageTitle", "X0 Bot")) + "</title>" +
    "<body style=\"margin:0;height:100vh;display:flex;align-items:center;justify-content:center;" +
    "background:" + escHtml(color("desktop.oauth.pageBg", "#0b0b0f")) +
    ";color:" + escHtml(color("desktop.oauth.pageText", "rgba(255,255,255,.85)")) +
    ";font:15px -apple-system,Segoe UI,system-ui,sans-serif\">" +
    "<p>" + escHtml(txt("desktop.oauth.pageBody", "Signed in. You can close this tab and go back to X0 Bot.")) + "</p>";
}

/**
 * The system-browser half of the flow. Resolves with the authorization code.
 *
 * One request, then the server is gone. It binds to 127.0.0.1 rather than
 * 0.0.0.0 so nothing off this machine can reach it even for the seconds it is
 * up, and it times out rather than listening forever for a person who wandered
 * off mid sign-in.
 */
function awaitLoopbackCode(openUrl) {
  const http = require("http");
  const port = loopbackPort();
  const base = loopbackUrl();
  return new Promise((resolve, reject) => {
    let settled = false;
    const server = http.createServer((req, res) => {
      let u;
      try { u = new URL(req.url, base); } catch { u = null; }
      if (!u || u.pathname !== "/cb") { res.writeHead(404).end(); return; }
      // Connection: close, or the browser's keep-alive socket holds the
      // server open after close() for as long as the browser likes.
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
      res.end(closePage());
      const err = u.searchParams.get("error_description") || u.searchParams.get("error");
      const code = u.searchParams.get("code");
      done(err ? new Error(err) : code ? null : new Error(txt("desktop.oauth.noCode", "no authorization code")), code);
    });
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { server.close(); } catch { /* already closing */ }
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(
      () => done(new Error(txt("desktop.oauth.timedOut", "timed out waiting for the browser"))),
      num("desktop.oauth.timeoutMs", 300000));
    server.on("error", (e) => done(e));
    server.listen(port, "127.0.0.1", () => {
      shell.openExternal(openUrl).catch((e) => done(e));
    });
  });
}

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The provider's consent page, by way of Supabase, with the PKCE challenge. */
function authorizeUrl(provider, challenge, redirect) {
  return SUPABASE_URL + "/auth/v1/authorize" +
    "?provider=" + encodeURIComponent(provider) +
    "&redirect_to=" + encodeURIComponent(redirect) +
    "&code_challenge=" + challenge +
    "&code_challenge_method=s256";
}

/** Trade the authorization code for a session. PKCE: the verifier proves the
 *  code came back to the same process that asked for it. */
async function exchangeCode(code, verifier) {
  const res = await fetch(SUPABASE_URL + "/auth/v1/token?grant_type=pkce", {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(json.error_description || json.msg || json.error || txt("desktop.oauth.failed", "sign-in failed"));
  }
  return json;
}

module.exports = { SUPABASE_URL, SUPABASE_ANON_KEY, redirectUrl, loopbackUrl, awaitLoopbackCode, b64url, authorizeUrl, exchangeCode };
