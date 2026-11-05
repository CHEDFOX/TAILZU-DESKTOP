// xode logout: switch the sign-in off on the server (best effort), then forget it here.

"use strict";

const { createClient } = require("../api/client");
const { hostOf } = require("../config");

async function logout({ server, store, out }) {
  const host = hostOf(server);
  const token = await store.get(host);
  if (!token) { out.line("You're not signed in."); return 0; }
  let revoked = true;
  try { await createClient({ server, token }).post("/v1/auth/device/revoke", {}, { timeoutMs: 8000 }); } catch (err) {
    // Already signed out on the server is fine; anything else is said, and the sign-in is still forgotten here.
    if (err.code !== "signed_out") revoked = false;
  }
  await store.remove(host);
  out.line("Signed out.");
  if (!revoked) out.note("The server couldn't be told; you can remove this computer in X0 Bot.");
  return 0;
}

module.exports = { logout };
