// Takes secrets out of text before it is shown: a device token, a link's secret, a live ticket, a password in a git address.

"use strict";

const known = new Set();

/** Remembers a secret, so any text shown later has it taken out. */
function addSecret(s) {
  if (typeof s === "string" && s.length >= 8) known.add(s);
}

/** The text with every known secret, and anything shaped like a device token or a bearer header, replaced. */
function redact(text) {
  let s = String(text == null ? "" : text);
  for (const k of known) s = s.split(k).join("[hidden]");
  s = s.replace(/xdt_[A-Za-z0-9._~+/=-]+/g, "xdt_[hidden]");
  s = s.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[hidden]");
  s = s.replace(/([?&](?:ticket|token|secret)=)[^&\s]+/gi, "$1[hidden]");
  // A remote's address can carry a name and a password or token (https://user:token@github.com/...).
  s = s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi, (m, scheme, who) => (who === "git" ? m : `${scheme}[hidden]@`));
  return s;
}

module.exports = { redact, addSecret };
