// `local.*`: small values kept on this computer between launches (SPEC 2.9, B9) — a hint dismissed, a last choice.
//
// localStorage here, MMKV on the phone, with the same rules: one namespace per account, 256 KB in all, nothing that
// reads like a secret, and the whole thing emptied when the account signs out. Values are JSON data, never code.

const V2_LOCAL_PREFIX = "tailzu.local.";
const V2_LOCAL_LIMITS = { totalBytes: 256 * 1024, valueBytes: 8 * 1024, keys: 256 };
let V2_LOCAL_NS = null;
let V2_LOCAL_CACHE = null;

/** localStorage, or nothing in a page that has none (a test page, a window with site data blocked). */
function v2Store() {
  try { return window.localStorage || null; } catch { return null; }
}

/** Who these values belong to: the account in the session, or "anon" before anyone signs in. */
function v2Account() {
  const s = typeof SESSION !== "undefined" && SESSION ? SESSION.access_token : null;
  if (typeof s !== "string" || s.indexOf(".") === -1) return "anon";
  try {
    const body = s.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    if (typeof atob !== "function") return "signed-in";
    const who = JSON.parse(atob(body));
    return typeof who.sub === "string" && who.sub ? who.sub : "signed-in";
  } catch { return "signed-in"; }
}

/** Every key this window wrote, whoever it belonged to. */
function v2LocalKeys(store) {
  const out = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (typeof k === "string" && k.indexOf(V2_LOCAL_PREFIX) === 0) out.push(k);
  }
  return out;
}

/**
 * The namespace to write in, after making sure it is this account's.
 *
 * SIGNING OUT EMPTIES IT. Sign-out reloads the window, so the first read afterwards sees a different account and
 * wipes everything — which also covers a second person signing in on the same computer.
 */
function v2LocalNs() {
  if (V2_LOCAL_NS) return V2_LOCAL_NS;
  const store = v2Store();
  const who = v2Account();
  V2_LOCAL_NS = V2_LOCAL_PREFIX + who + ".";
  if (!store) return V2_LOCAL_NS;
  try {
    const was = store.getItem(V2_LOCAL_PREFIX + "who");
    if (was !== who) {
      for (const k of v2LocalKeys(store)) store.removeItem(k);
      store.setItem(V2_LOCAL_PREFIX + "who", who);
    }
  } catch { /* nothing kept: the values are a convenience, never the truth */ }
  return V2_LOCAL_NS;
}

/** Everything `local.*` holds for this account, as one object for the expression scope. */
function v2LocalAll() {
  if (V2_LOCAL_CACHE) return V2_LOCAL_CACHE;
  const out = {};
  const store = v2Store();
  const ns = v2LocalNs();
  if (store) {
    try {
      for (const k of v2LocalKeys(store)) {
        if (k.indexOf(ns) !== 0) continue;
        const path = k.slice(ns.length);
        const raw = store.getItem(k);
        let v;
        try { v = JSON.parse(raw); } catch { continue; }
        let at = out;
        const parts = path.split(".");
        for (let i = 0; i < parts.length - 1; i++) {
          if (!at[parts[i]] || typeof at[parts[i]] !== "object") at[parts[i]] = {};
          at = at[parts[i]];
        }
        at[parts[parts.length - 1]] = v;
      }
    } catch { /* an empty local is a working local */ }
  }
  V2_LOCAL_CACHE = out;
  return out;
}

/** How many bytes this account is using. */
function v2LocalBytes(store, ns) {
  let n = 0;
  for (const k of v2LocalKeys(store)) if (k.indexOf(ns) === 0) n += k.length + String(store.getItem(k) || "").length;
  return n;
}

/** The `local.set` action. Gives back why it was refused, or "" when it landed. */
function v2LocalSet(path, value) {
  const k = v2Kernel();
  const why = k ? k.localKeyError(String(path || "")) : "no kernel";
  if (why) return why;
  const store = v2Store();
  if (!store) return "nothing to write to";
  let raw;
  try { raw = JSON.stringify(value); } catch { return "not a value"; }
  if (raw === undefined) return "not a value";
  if (raw.length > V2_LOCAL_LIMITS.valueBytes) return "value too large";
  const ns = v2LocalNs();
  const key = ns + path;
  try {
    const had = store.getItem(key);
    if (had === null && v2LocalKeys(store).filter((x) => x.indexOf(ns) === 0).length >= V2_LOCAL_LIMITS.keys) return "too many keys";
    const delta = key.length + raw.length - (had === null ? 0 : key.length + had.length);
    if (v2LocalBytes(store, ns) + delta > V2_LOCAL_LIMITS.totalBytes) return "store full";
    store.setItem(key, raw);
  } catch { return "write failed"; }
  V2_LOCAL_CACHE = null;
  return "";
}

/** The `local.remove` action. */
function v2LocalRemove(path) {
  const store = v2Store();
  if (!store) return "nothing to write to";
  try { store.removeItem(v2LocalNs() + String(path || "")); } catch { return "write failed"; }
  V2_LOCAL_CACHE = null;
  return "";
}
