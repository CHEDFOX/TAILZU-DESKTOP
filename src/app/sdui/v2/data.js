// The data block (SPEC 2.10, B10): what `callEndpoint` gains — retry, cache, multipart with progress, optimistic —
// and `subscribe`, which listens on the live socket this window already keeps open.
//
// HOW IT JOINS THE WINDOW. Actions run through actions.js's run(), which this build does not own, so the block
// wraps it instead of editing it: an action that is not ours is handed straight on, unchanged. The lines it would
// rather see inside actions.js are in the package's questions.

const V2_ENDPOINT_LIMITS = { retryMax: 5, backoffMaxMs: 8000, cacheTtlMaxMs: 10 * 60 * 1000, cacheEntries: 50, files: 8, progressMs: 100 };
const V2_SUBSCRIBE_LIMITS = { topics: 4, messageBytes: 64 * 1024, listItems: 2000, topicChars: 64 };
const V2_TOPIC = /^[A-Za-z0-9:_\-.*]{1,64}$/;

let V2_CACHE_HTTP = new Map();
let V2_SUBS = new Map();
let V2_RUN_WRAPPED = false;
let V2_LIVE_HOOKED = false;

/** A topic a screen may listen to: never `ask:` (that belongs to a call in flight), and a wildcard only at the end. */
function v2TopicOk(topic) {
  if (typeof topic !== "string" || !V2_TOPIC.test(topic)) return false;
  if (topic.indexOf("ask:") === 0) return false;
  const star = topic.indexOf("*");
  return star === -1 || topic === "*" || star === topic.length - 1;
}

/** Hand the live socket's events to whoever subscribed. The socket itself is live.js's, kept as it is. */
function v2LiveHook() {
  if (V2_LIVE_HOOKED) return;
  const live = typeof window !== "undefined" && window.TailzuLiveWindow;
  if (!live || !live.client || !live.client.o) return;
  V2_LIVE_HOOKED = true;
  const o = live.client.o;
  const was = o.onEvent;
  o.onEvent = (topic, m) => {
    try { v2LiveEvent(topic, m); } catch { /* a screen's own problem, never the socket's */ }
    if (typeof was === "function") was(topic, m);
  };
}

/** True when a subscription's topic covers the one that arrived ("job:*" hears every job). */
function v2TopicHears(want, got) {
  if (want === got || want === "*") return true;
  return want.charAt(want.length - 1) === "*" && String(got).indexOf(want.slice(0, -1)) === 0;
}

/** One event: into the store the way the subscription asked, and the screen is painted again. */
function v2LiveEvent(topic, m) {
  if (!V2.on || !v2Has("data") || !V2_SUBS.size) return;
  let changed = false;
  for (const sub of V2_SUBS.values()) {
    if (!v2TopicHears(sub.topic, topic)) continue;
    let data = m && m.data;
    try { if (JSON.stringify(data || "").length > V2_SUBSCRIBE_LIMITS.messageBytes) continue; } catch { continue; }
    const held = stateAt(sub.into);
    if (sub.mode === "append") {
      const list = (Array.isArray(held) ? held : []).concat([data]);
      const max = Math.min(V2_SUBSCRIBE_LIMITS.listItems, Number(sub.max) > 0 ? Number(sub.max) : V2_SUBSCRIBE_LIMITS.listItems);
      setStatePath(sub.into, list.slice(Math.max(0, list.length - max)));
    } else if (sub.mode === "merge" && data && typeof data === "object" && !Array.isArray(data)) {
      setStatePath(sub.into, Object.assign({}, held && typeof held === "object" ? held : {}, data));
    } else {
      setStatePath(sub.into, data);
    }
    changed = true;
  }
  if (changed && typeof repaint === "function") repaint();
}

/** The `subscribe` action. */
function v2Subscribe(action) {
  const k = v2Kernel();
  const topic = String(action.topic || "");
  const into = String(action.into || "");
  if (!v2TopicOk(topic) || !into || (k && !k.statePathOk(into))) { v2Bad("subscribe:bad"); return; }
  if (V2_SUBS.size >= V2_SUBSCRIBE_LIMITS.topics && !V2_SUBS.has(topic + "→" + into)) { v2Bad("subscribe:too many"); return; }
  V2_SUBS.set(topic + "→" + into, {
    topic, into,
    mode: action.mode === "append" || action.mode === "merge" ? action.mode : "replace",
    max: Number(action.max) > 0 ? Number(action.max) : 0,
  });
  v2LiveHook();
}

/** The screen is going: nothing it asked to hear is heard any more. */
function v2DataLeave() { V2_SUBS = new Map(); }

/** How long to wait before trying again. */
function v2Backoff(spec, attempt) {
  const b = spec && spec.backoff;
  if (typeof b === "number" && Number.isFinite(b)) return Math.min(V2_ENDPOINT_LIMITS.backoffMaxMs, Math.max(0, b));
  if (b === "fixed") return 500;
  return Math.min(V2_ENDPOINT_LIMITS.backoffMaxMs, 300 * Math.pow(2, attempt));
}

/** A cached GET, while it is still fresh. */
function v2CacheGet(spec) {
  if (!spec || typeof spec.key !== "string" || !spec.key) return undefined;
  const got = V2_CACHE_HTTP.get(spec.key);
  if (!got) return undefined;
  const ttl = Math.min(V2_ENDPOINT_LIMITS.cacheTtlMaxMs, Math.max(0, Number(spec.ttlMs) || 0));
  if (Date.now() - got.at > ttl) { V2_CACHE_HTTP.delete(spec.key); return undefined; }
  return got.value;
}
function v2CachePut(spec, value) {
  if (!spec || typeof spec.key !== "string" || !spec.key) return;
  if (V2_CACHE_HTTP.size >= V2_ENDPOINT_LIMITS.cacheEntries) V2_CACHE_HTTP.delete(V2_CACHE_HTTP.keys().next().value);
  V2_CACHE_HTTP.set(spec.key, { at: Date.now(), value });
}
/** Any successful write, and signing out, empty the cache: a cached answer must never outlive what it describes. */
function v2CacheClear() { V2_CACHE_HTTP = new Map(); }

/** A multipart send, with how far it has got written where the screen asked. */
function v2Multipart(path, spec, progressInto) {
  return new Promise((resolve, reject) => {
    if (typeof XMLHttpRequest !== "function" || typeof FormData !== "function") { reject(new Error("no multipart here")); return; }
    const form = new FormData();
    const files = Array.isArray(spec.files) ? spec.files.slice(0, V2_ENDPOINT_LIMITS.files) : [];
    for (const f of files) {
      if (!f || typeof f !== "object" || !f.file) continue;
      form.append(String(f.field || "file"), f.file, String(f.name || "file"));
    }
    if (spec.fields && typeof spec.fields === "object") {
      for (const key of Object.keys(spec.fields)) form.append(key, String(spec.fields[key]));
    }
    const xhr = new XMLHttpRequest();
    xhr.open("POST", ENV.baseUrl + path);
    let last = 0;
    xhr.upload.onprogress = (e) => {
      if (!progressInto) return;
      const now = Date.now();
      if (now - last < V2_ENDPOINT_LIMITS.progressMs) return;
      last = now;
      const total = e.total || 0;
      setStatePath(progressInto, { loaded: e.loaded || 0, total, pct: total ? Math.round(((e.loaded || 0) / total) * 100) : 0 });
    };
    xhr.onload = () => {
      if (progressInto) setStatePath(progressInto, { loaded: 1, total: 1, pct: 100 });
      if (xhr.status >= 200 && xhr.status < 300) { try { resolve(JSON.parse(xhr.responseText)); } catch { resolve(xhr.responseText); } }
      else reject(new Error("upload → " + xhr.status));
    };
    xhr.onerror = () => reject(new Error("upload failed"));
    Promise.resolve(bearer()).then((tok) => {
      if (tok) xhr.setRequestHeader("Authorization", "Bearer " + tok);
      xhr.send(form);
    }).catch(reject);
  });
}

/** True when this callEndpoint is asking for something only this block can give. */
function v2CallIsOurs(a) {
  return !!(a && (a.retry || a.cache || a.multipart || a.progressInto || a.optimistic || a.queue));
}

/** `callEndpoint` with the new options. Everything else about it stays as actions.js has it. */
async function v2Call(action) {
  const path = String(action.path || "");
  const k = v2Kernel();
  if (k && !k.networkPathOk(path)) { v2Bad("call:path"); await run(action.onError); return; }
  // Kept to send once online: the outbox's own `add`, which is the only shape outboxRun understands.
  if (action.queue === "outbox" && typeof outboxRun === "function") {
    return outboxRun({ kind: "outbox", op: "add", path, body: action.body, label: action.label, sub: action.sub });
  }
  const method = (action.method || "POST").toUpperCase();
  const undo = [];
  if (action.optimistic && typeof action.optimistic.path === "string") {
    undo.push([action.optimistic.path, stateAt(action.optimistic.path)]);
    setStatePath(action.optimistic.path, action.optimistic.value);
    if (typeof repaint === "function") repaint();
  }
  if (method === "GET") {
    const hit = v2CacheGet(action.cache);
    if (hit !== undefined) {
      if (action.assignTo) { setStatePath(action.assignTo, hit); if (typeof repaint === "function") repaint(); }
      await run(action.onSuccess);
      return;
    }
  }
  const times = Math.max(0, Math.min(V2_ENDPOINT_LIMITS.retryMax, Number(action.retry && action.retry.times) || 0));
  // Read once, now, while the strings this action's expressions made are still marked as data (v2Literal).
  const body = action.body != null ? deepResolve(action.body) : undefined;
  let error = null;
  for (let attempt = 0; attempt <= times; attempt++) {
    try {
      const res = action.multipart
        ? await v2Multipart(path, action.multipart, typeof action.progressInto === "string" ? action.progressInto : "")
        : await api(path, body, method);
      if (method === "GET") v2CachePut(action.cache, res);
      else v2CacheClear();
      if (action.assignTo) setStatePath(action.assignTo, res);
      if (typeof repaint === "function") repaint();
      await run(action.onSuccess);
      return;
    } catch (e) {
      error = e;
      // Only a call that can be sent twice safely is sent twice, unless the screen says it is idempotent.
      const safe = method === "GET" || (action.retry && action.retry.idempotent === true);
      if (attempt >= times || !safe) break;
      await new Promise((r) => setTimeout(r, v2Backoff(action.retry, attempt)));
    }
  }
  for (const [p, was] of undo) setStatePath(p, was);
  setStatePath("lastError", error && error.server ? { code: error.server.code, message: error.server.message } : null);
  if (typeof repaint === "function") repaint();
  await run(action.onError);
}

/**
 * The keys that hold ANOTHER action. They are resolved when that action runs (run() comes back through the hook),
 * not now: an `onSuccess` reads the answer its call wrote, and a sequence's second step sees what the first did.
 */
const V2_LATER_KEYS = new Set([
  "onSuccess", "onError", "onCommit", "onCancel", "onDismiss", "onResult", "onChange", "onSubmit", "onComplete",
  "onLeft", "onRight", "onUp", "onDown", "then", "else", "actions", "do",
]);
/**
 * Strings an expression made for the action being handed to actions.js right now. actions.js reads a bare
 * "$state.x" or "$event" as a token; a person's own words that happen to start that way must reach it as data.
 */
let V2_LIT = null;
function v2Literal(v) { return V2_LIT !== null && typeof v === "string" && V2_LIT.has(v); }

/** An action's own `$` and `$t` values, resolved. A path's holes are URL-encoded; display values are not. */
function v2ResolveAction(a, depth, made) {
  const k = v2Kernel();
  if (!k || depth > 6) return a;
  const value = (v, encode) => {
    const r = v2Value(v, v2Scope(), encode);
    if (made && typeof r === "string") made.add(r);
    return r;
  };
  if (k.isEvaluable(a)) return value(a, false);
  if (Array.isArray(a)) return a.map((x) => v2ResolveAction(x, depth + 1, made));
  if (a && typeof a === "object") {
    const out = {};
    for (const key of Object.keys(a)) {
      const v = a[key];
      if (V2_LATER_KEYS.has(key) && typeof a.kind === "string") { out[key] = v; continue; }
      // A path field's holes are URL-encoded (a `$t`); a whole `{ $: … }` value is the path or the URL as stored,
      // which is what `encode` leaves alone in the kernel.
      const isPath = key === "path" || key === "endpoint" || key === "url" || key === "topic";
      out[key] = k.isEvaluable(v) ? value(v, isPath) : v2ResolveAction(v, depth + 1, made);
    }
    return out;
  }
  return a;
}

/**
 * The block's one seam into the window: actions it owns are answered here, and every other action is handed on
 * exactly as it arrived.
 */
function v2RunHook() {
  if (V2_RUN_WRAPPED || typeof run !== "function") return;
  V2_RUN_WRAPPED = true;
  const inner = run;
  // eslint-disable-next-line no-global-assign
  run = function (action, eventValue) {
    if (!V2.on || !action || typeof action !== "object") return inner.apply(this, arguments);
    const made = new Set();
    const a = v2Has("expr") ? v2ResolveAction(action, 0, made) : action;
    // actions.js and outbox.js read their tokens synchronously, before their first await, so the set only has to
    // live that long.
    const was = V2_LIT;
    V2_LIT = made.size ? made : was;
    try {
      if (a && typeof a === "object") {
        // A path an expression made is checked like every other network path before actions.js sends it.
        const k = v2Kernel();
        if (a.kind === "callEndpoint" && k && k.isEvaluable(action.path) && !k.networkPathOk(String(a.path || ""))) {
          v2Bad("call:path");
          return inner.call(this, a.onError);
        }
        if (a.kind === "subscribe" && v2Has("data")) return v2Subscribe(a);
        if (a.kind === "local.set" && v2Has("local")) {
          const why = v2LocalSet(a.path, a.value);
          if (why) { v2Bad("local:" + why); return inner.call(this, a.onError); }
          return typeof repaint === "function" ? repaint() : undefined;
        }
        if (a.kind === "local.remove" && v2Has("local")) {
          v2LocalRemove(a.path);
          return typeof repaint === "function" ? repaint() : undefined;
        }
        if (a.kind === "callEndpoint" && v2Has("data") && v2CallIsOurs(a)) return v2Call(a);
      }
      return arguments.length > 1 ? inner.call(this, a, eventValue) : inner.call(this, a);
    } finally {
      V2_LIT = was;
    }
  };
}
