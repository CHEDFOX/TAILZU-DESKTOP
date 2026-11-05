// xode login: a code to type in X0 Bot (x0bot.com/device), then the device token kept in the keychain (or the 600 file).

"use strict";

const { createClient } = require("../api/client");
const { startLink, waitForApproval } = require("../auth/link");
const { hostOf } = require("../config");

const WHY = {
  denied: "The sign-in was turned down in X0 Bot.",
  expired: "The code ran out before it was approved: run xode login for a new one.",
  used: "That code was already used: run xode login for a new one.",
  failed: "The sign-in didn't go through: run xode login to try again.",
};

async function login({ server, store, out, input }) {
  const host = hostOf(server);
  const client = createClient({ server });
  const ctl = new AbortController();
  let cancelled = false;
  input.onInterrupt(() => { cancelled = true; ctl.abort(); });
  try {
    const link = await startLink(client, { signal: ctl.signal });
    const where = String(link.deviceUrl || "https://x0bot.com/device").replace(/^https?:\/\//, "").replace(/\/+$/, "");
    out.line(`To sign in, open ${where} and enter the code`);
    out.line(`  ${out.paint.bold(out.paint.cyan(link.code))}`);
    if (link.deviceUrlWithCode) out.line(`(or open ${link.deviceUrlWithCode})`);
    out.line("Waiting for you to approve it in X0 Bot…");
    const r = await waitForApproval(client, link, { signal: ctl.signal });
    if (r.status !== "approved") { out.error(WHY[r.status] || WHY.failed); return 1; }

    const old = await store.get(host).catch(() => null);
    const kept = await store.set(host, r.deviceToken);
    // The sign-in this one replaces is switched off on the server too (best effort).
    if (old && old !== r.deviceToken) await createClient({ server, token: old }).post("/v1/auth/device/revoke", {}, { timeoutMs: 5000 }).catch(() => null);
    let account = "", device = "";
    try {
      const d = await createClient({ server, token: r.deviceToken }).get("/v1/auth/device", { timeoutMs: 10_000 });
      const u = d.user || {};
      account = u.email || u.name || "";
      device = d.name || "";
    } catch { /* signed in all the same */ }
    out.good(["Signed in", account ? `as ${account}` : "", device ? `on ${device}` : ""].filter(Boolean).join(" ") + ".");
    if (kept === "file") out.note(`Kept in ${shortPath(store.file.file)}, which only you can read.`);
    return 0;
  } catch (err) {
    if (cancelled || err.code === "cancelled") { out.line(""); out.line("Sign-in cancelled."); return 130; }
    out.error(err.message);
    return 1;
  }
}

/** A path with the home folder as ~, so it fits a narrow terminal. */
function shortPath(p) {
  const home = require("os").homedir();
  return home && p.startsWith(home + require("path").sep) ? "~" + p.slice(home.length) : p;
}

module.exports = { login };
