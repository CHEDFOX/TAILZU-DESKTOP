// Signing in: Supabase's REST auth (an email or phone code), the session the
// main process keeps, and the words an error is shown in.

/**
 * A FAILURE, WORDED FOR THE PERSON AT THE WINDOW.
 *
 * Errors here used to carry "/v1/app/bootstrap → 500", the browser's own
 * "Failed to fetch" or Supabase's "invalid_grant", and the gate and the voice
 * screens showed a thrown message as it stood. Now a failure this file words
 * on purpose is marked `worded` (with the raw detail beside it for the log),
 * and anything else is logged and replaced by the caller's sentence. The
 * words for a refused request are the phones' (labels error.*), so one edit
 * on the server changes both.
 */
function worded(message, detail) {
  const e = new Error(message);
  e.worded = true;
  if (detail) e.detail = detail;
  return e;
}

function statusText(status) {
  if (status === 401 || status === 403) return K.txt("error.unauthorized", "Your session has expired. Sign in again to continue.");
  if (status === 404) return K.txt("error.notFound", "That isn't available right now.");
  if (status === 429) return K.txt("error.rateLimited", "Too many requests. Wait a moment, then try again.");
  if (status >= 500) return K.txt("error.server", "Something went wrong on our side. Try again in a moment.");
  return K.txt("error.generic", "Something went wrong. Try again.");
}

/** What to show for a caught failure; the raw detail goes to the console. */
function userText(err, fallback) {
  if (err && err.worded) {
    if (err.detail) console.warn("[tailzu]", err.detail);
    return err.message;
  }
  console.warn("[tailzu]", err);
  // fetch rejects with a TypeError when the network is not there at all.
  if (err instanceof TypeError) return K.txt("error.network", "Couldn't reach X0 Bot. Check your connection and try again.");
  return fallback;
}

async function sbFetch(path, body) {
  const res = await fetch(SUPABASE_URL + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Supabase's own words ("Token has expired or is invalid", "invalid_grant")
    // are for the log. A refused code is the one case with its own sentence.
    const detail = path + " → " + res.status + " " + (json.error_description || json.msg || json.error || "");
    if (res.status === 429 || res.status >= 500) throw worded(statusText(res.status), detail);
    if (path.indexOf("/verify") !== -1) {
      throw worded(K.txt("desktop.gate.codeWrong", "That code didn't work. Check it and try again."), detail);
    }
    throw worded(K.txt("desktop.gate.authFailed", "Couldn't sign you in. Try again."), detail);
  }
  return json;
}

/**
 * A valid access token, renewed when the stored one has expired.
 *
 * Null when nobody is signed in, and the request then goes out with no
 * Authorization header at all. There used to be a static fallback token here,
 * which the backend resolves to a synthetic user — so a signed-out window
 * asked for things as somebody nobody is.
 *
 * THE MAIN PROCESS RENEWS IT, not this window. Supabase rotates the refresh
 * token on every use, and this window used to renew with its own copy after
 * the tray's timer had already spent it — which signed the account out
 * everywhere. The main process holds the only refresh token and answers with
 * a live access token (or none, once the account is really gone).
 */
async function bearer() {
  if (!SESSION) return null;
  const now = Math.floor(Date.now() / 1000);
  if (SESSION.expires_at && SESSION.expires_at - K.num("desktop.auth.refreshSkewSec", 60) <= now) {
    SESSION = (await window.tailzuApp.session()) || null;
    if (!SESSION) { render(); return null; }
  }
  return SESSION.access_token;
}

/** Signed in (a Supabase session) or out (null). The main process keeps it
 *  and hands back the part this window holds. */
async function setSession(raw) {
  SESSION = (await window.tailzuApp.setSession(raw || null)) || null;
}

async function signIn(email) {
  await sbFetch("/auth/v1/otp", { email, create_user: true });
}
async function verify(email, token) {
  const r = await sbFetch("/auth/v1/verify", { email, token, type: "email" });
  await setSession(r);
}
// Phone is the same two calls with a different key and a different OTP type.
// It only appears when the backend says an SMS provider is actually wired up —
// a button that sends a code nobody can receive is worse than no button.
async function signInPhone(phone) {
  await sbFetch("/auth/v1/otp", { phone, create_user: true });
}
async function verifyPhone(phone, token) {
  const r = await sbFetch("/auth/v1/verify", { phone, token, type: "sms" });
  await setSession(r);
}
