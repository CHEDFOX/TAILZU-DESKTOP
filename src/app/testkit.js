// For tests only (not shipped): the app window's scripts as app.html loads
// them, so a test can run them in a vm context in the page's own order.
const fs = require("fs");
const path = require("path");

/** Every script app.html loads, in order, as absolute paths. */
function appScripts() {
  const html = fs.readFileSync(path.join(__dirname, "app.html"), "utf8");
  return [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => path.resolve(__dirname, m[1]));
}

/**
 * The files behind `names`, the scripts' own file names ("knobs.js",
 * "sdui.js"), in the order given. "sdui.js" stands for the renderer, which
 * app.html loads as the files in src/app/sdui/, in its order.
 */
function pageFiles(names) {
  const all = appScripts();
  const sdui = path.join(__dirname, "sdui") + path.sep;
  return names.flatMap((name) => {
    if (name === "sdui.js") return all.filter((f) => f.startsWith(sdui));
    const f = all.find((p) => path.basename(p) === name);
    if (!f) throw new Error(`app.html loads no ${name}`);
    return [f];
  });
}

/**
 * A small DOM for the renderer's tests (Spaces' stage, the @ field, the live words): elements with attributes, styles, classes,
 * children, events that bubble to the document, focus, a caret, and an innerHTML that parses the markup sdui/ writes (double-
 * quoted attributes, void inputs and images). Layout is what a test gives: `el.rect` (viewport px), else its parent's rect moved
 * by its own style left and top and sized by its style width and height, else its parent's.
 */
function fakeDom(o = {}) {
  const VOID = new Set(["input", "img", "br", "hr", "meta", "link", "source"]);
  const camel = (k) => k.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
  const kebab = (k) => k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
  const px = (v) => (typeof v === "string" && /^-?[\d.]+px$/.test(v) ? parseFloat(v) : null);
  const unesc = (v) => v.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  class Ev {
    constructor(type, init) { Object.assign(this, { type, bubbles: true, defaultPrevented: false, stopped: false, detail: 1, clientX: 0, clientY: 0 }, init); }
    preventDefault() { this.defaultPrevented = true; }
    stopPropagation() { this.stopped = true; }
  }
  const listen = (self) => ({
    addEventListener(t, f) { (self.listeners[t] = self.listeners[t] || []).push(f); },
    removeEventListener(t, f) { self.listeners[t] = (self.listeners[t] || []).filter((x) => x !== f); },
  });
  function matches(el, sel) {
    const m = /^([a-z0-9]+)?((?:[.#][\w-]+|\[[\w-]+(?:=["'][^"']*["'])?\])*)$/i.exec(sel.trim());
    if (!m) throw new Error("selector not handled here: " + sel);
    if (m[1] && el.tagName.toLowerCase() !== m[1].toLowerCase()) return false;
    for (const part of m[2].match(/[.#][\w-]+|\[[\w-]+(?:=["'][^"']*["'])?\]/g) || []) {
      if (part[0] === ".") { if (!el.classList.contains(part.slice(1))) return false; continue; }
      if (part[0] === "#") { if (el.getAttribute("id") !== part.slice(1)) return false; continue; }
      const a = /^\[([\w-]+)(?:=["']([^"']*)["'])?\]$/.exec(part);
      if (!el.hasAttribute(a[1])) return false;
      if (a[2] !== undefined && el.getAttribute(a[1]) !== a[2]) return false;
    }
    return true;
  }
  // A selector list, each a compound selector or a few of them with descendant spaces ("#tabs .tab").
  const hit = (el, sel, root) => {
    const parts = sel.trim().split(/\s+/);
    if (!matches(el, parts[parts.length - 1])) return false;
    let at = el.parentElement;
    for (let i = parts.length - 2; i >= 0; i--) {
      while (at && at !== root.parentElement && !matches(at, parts[i])) at = at.parentElement;
      if (!at || at === root.parentElement) return false;
      at = at.parentElement;
    }
    return true;
  };
  const all = (root, sel) => {
    const out = [];
    const sels = sel.split(",").map((x) => x.trim());
    (function walk(e) { for (const c of e.children) { if (c.tagName !== "#TEXT" && sels.some((x) => hit(c, x, root))) out.push(c); walk(c); } })(root);
    return out;
  };
  let doc = null;
  class El {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.attrs = {}; this.children = []; this.parentElement = null; this.listeners = {};
      this.text = ""; this.value = ""; this.selectionStart = 0; this.selectionEnd = 0; this.rect = null;
      this.scrollTop = 0; this.scrollHeight = 0; this.scrollWidth = 0; this.offsetHeight = 0; this.offsetWidth = 0;
      Object.assign(this, listen(this));
      const self = this;
      this.style = new Proxy({}, { set(t, k, v) { t[k] = v == null ? "" : String(v); return true; }, get(t, k) { if (k === "setProperty") return (a, b) => { t[camel(a)] = String(b); }; return k in t ? t[k] : ""; } });
      this.dataset = new Proxy({}, { get: (_t, k) => self.getAttribute("data-" + kebab(String(k))) ?? undefined, set: (_t, k, v) => { self.setAttribute("data-" + kebab(String(k)), String(v)); return true; } });
      this.classList = {
        contains: (c) => (self.attrs.class || "").split(/\s+/).includes(c),
        add: (...cs) => { for (const c of cs) if (!self.classList.contains(c)) self.attrs.class = ((self.attrs.class || "") + " " + c).trim(); },
        remove: (...cs) => { self.attrs.class = (self.attrs.class || "").split(/\s+/).filter((x) => x && !cs.includes(x)).join(" "); },
        toggle: (c, on) => { const want = on === undefined ? !self.classList.contains(c) : !!on; if (want) self.classList.add(c); else self.classList.remove(c); return want; },
      };
    }
    get className() { return this.attrs.class || ""; }
    set className(v) { this.attrs.class = String(v); }
    get id() { return this.attrs.id || ""; }
    get type() { return this.attrs.type || ""; }
    get isContentEditable() { return false; }
    get firstElementChild() { return this.children[0] || null; }
    get nextElementSibling() { const p = this.parentElement; if (!p) return null; return p.children[p.children.indexOf(this) + 1] || null; }
    get isConnected() { let e = this; while (e.parentElement) e = e.parentElement; return !!doc && e === doc.documentElement; }
    get clientWidth() { return this.rect ? this.rect.width : this.getBoundingClientRect().width; }
    get clientHeight() { return px(this.style.height) ?? (this.rect ? this.rect.height : this.getBoundingClientRect().height); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    setAttribute(k, v) {
      this.attrs[k] = String(v);
      if (k === "style") for (const d of String(v).split(";")) { const i = d.indexOf(":"); if (i > 0) this.style[camel(d.slice(0, i).trim())] = d.slice(i + 1).trim(); }
      if (k === "value") this.value = String(v);
    }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    removeAttribute(k) { delete this.attrs[k]; }
    appendChild(c) { if (c.parentElement) c.parentElement.removeChild(c); c.parentElement = this; this.children.push(c); return c; }
    insertBefore(c, ref) { if (c.parentElement) c.parentElement.removeChild(c); c.parentElement = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentElement = null; return c; }
    replaceChild(n, old) { this.insertBefore(n, old); return this.removeChild(old); }
    remove() { if (this.parentElement) this.parentElement.removeChild(this); }
    replaceWith(n) { const p = this.parentElement; if (p) { p.insertBefore(n, this); p.removeChild(this); } }
    contains(e) { for (let x = e; x; x = x.parentElement) if (x === this) return true; return false; }
    closest(sel) { for (let x = this; x; x = x.parentElement) if (x.tagName && matches(x, sel)) return x; return null; }
    matches(sel) { return matches(this, sel); }
    querySelectorAll(sel) { return all(this, sel); }
    querySelector(sel) { return all(this, sel)[0] || null; }
    get textContent() { return this.text + this.children.map((c) => c.textContent).join(""); }
    set textContent(v) { this.children.forEach((c) => { c.parentElement = null; }); this.children = []; this.text = String(v); }
    get innerHTML() { return this.html || ""; }
    set innerHTML(v) { this.textContent = ""; this.html = String(v); parse(this, String(v)); }
    getBoundingClientRect() {
      if (this.rect) return Object.assign({ right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height }, this.rect);
      const p = this.parentElement ? this.parentElement.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
      const left = p.left + (px(this.style.left) ?? 0), top = p.top + (px(this.style.top) ?? 0);
      const width = px(this.style.width) ?? (this.style.position === "absolute" || this.classList.contains("tz-st-layer") ? p.width : px(this.style.width) ?? p.width);
      const height = px(this.style.height) ?? p.height;
      return { left, top, width, height, right: left + width, bottom: top + height };
    }
    dispatchEvent(ev) {
      ev.target = ev.target || this;
      for (let x = this; x && !ev.stopped; x = x.parentElement) for (const f of (x.listeners[ev.type] || []).slice()) f.call(x, ev);
      if (!ev.stopped && this.isConnected) for (const f of (doc.listeners[ev.type] || []).slice()) f.call(doc, ev);
      return !ev.defaultPrevented;
    }
    click(init) { return this.dispatchEvent(new Ev("click", init)); }
    key(key, init) { return this.dispatchEvent(new Ev("keydown", Object.assign({ key }, init))); }
    type(text) {
      // Typing at the caret: the value, the caret after it, then an input event.
      const v = this.value, at = this.selectionStart;
      this.value = v.slice(0, at) + text + v.slice(this.selectionEnd);
      this.selectionStart = this.selectionEnd = at + text.length;
      return this.dispatchEvent(new Ev("input"));
    }
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
    // A canvas draws into nothing: every call is taken, and the bot's drawing runs for real.
    getContext() {
      if (this.tagName !== "CANVAS") return null;
      if (!this.ctx2d) { const fn = () => this.ctx2d; this.ctx2d = new Proxy({}, { get: (t, k) => (k in t ? t[k] : fn), set: (t, k, v) => { t[k] = v; return true; } }); }
      return this.ctx2d;
    }
    focus() { if (doc.activeElement === this) return; const was = doc.activeElement; doc.activeElement = this; if (was && was !== doc.body) was.dispatchEvent(new Ev("blur", { bubbles: false })); this.dispatchEvent(new Ev("focusin")); }
    blur() { if (doc.activeElement !== this) return; doc.activeElement = doc.body; this.dispatchEvent(new Ev("blur", { bubbles: false })); this.dispatchEvent(new Ev("focusout")); }
  }
  function parse(into, html) {
    const stack = [into];
    const re = /<\/([a-z0-9]+)\s*>|<([a-z0-9]+)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/gi;
    let m;
    while ((m = re.exec(html))) {
      const top = stack[stack.length - 1];
      if (m[1]) { for (let i = stack.length - 1; i > 0; i--) if (stack[i].tagName === m[1].toUpperCase()) { stack.length = i; break; } continue; }
      if (m[2]) {
        const el = new El(m[2]);
        for (const a of (m[3] || "").matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) el.setAttribute(a[1], a[2] === undefined ? "" : unesc(a[2]));
        top.appendChild(el);
        if (!VOID.has(m[2].toLowerCase()) && !/\/>$/.test(m[0])) stack.push(el);
        continue;
      }
      if (m[4] && m[4].trim()) { const t = new El("#text"); t.text = unesc(m[4]); top.appendChild(t); }
    }
  }
  doc = Object.assign({ listeners: {}, activeElement: null, hidden: false, visibilityState: "visible" }, {
    createElement: (t) => new El(t),
    getElementById: (id) => all(doc.documentElement, "#" + id)[0] || null,
    querySelector: (s) => all(doc.documentElement, s)[0] || null,
    querySelectorAll: (s) => all(doc.documentElement, s),
  });
  Object.assign(doc, listen(doc));
  doc.documentElement = new El("html");
  doc.body = doc.documentElement.appendChild(new El("body"));
  doc.activeElement = doc.body;
  for (const id of o.ids || ["view", "toast", "main", "title", "back", "shell", "crumb"]) { const e = doc.body.appendChild(new El("div")); e.setAttribute("id", id); }
  return { document: doc, El, Ev };
}

/**
 * sdui/ as the window runs it, on fakeDom(), with a clock the test moves (setTimeout, requestAnimationFrame and performance.now
 * all on it: tick(ms) fires what is due, a frame every 16 ms), and a stand-in bridge that writes down what the window sends.
 * o.files: the page's scripts (default knobs.js, botTiles.js, botLooks.js and the renderer); o.bridge: more of window.tailzuApp.
 */
function fakePage(o = {}) {
  const fs = require("fs");
  const vm = require("vm");
  const dom = fakeDom();
  const noop = () => {};
  let now = 1000, seq = 0;
  let timers = [];
  const sent = [];
  const later = (f, ms, frame) => { const t = { id: ++seq, f, at: now + Math.max(0, Number(ms) || 0), frame }; timers.push(t); return t.id; };
  const cancel = (id) => { timers = timers.filter((t) => t.id !== id); };
  const bridge = Object.assign({
    env: () => new Promise(() => {}),
    voice: (cmd, opts) => sent.push(["voice", cmd, Object.assign({}, opts)]),
    talkTo: (t) => sent.push(["talkTo", t]),
    onVoice: (cb) => { g.__voice = cb; },
    onKnobs: noop, onNavigate: noop, onDictated: noop, onNotes: noop, onAskSetup: noop, changed: noop,
  }, o.bridge);
  const g = {
    console: { warn: noop, log: noop, error: noop },
    setTimeout: (f, ms) => later(f, ms), clearTimeout: cancel, setInterval: () => 0, clearInterval: noop,
    requestAnimationFrame: (f) => later(() => f(now), 16, true), cancelAnimationFrame: cancel,
    performance: { now: () => now },
    Promise, JSON, Object, Array, String, Number, Math, Date, RegExp, Error, Map, Set, Proxy, encodeURIComponent,
    navigator: { language: "en-US" }, innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1,
    addEventListener: noop, removeEventListener: noop,
    matchMedia: (q) => ({ matches: !!(o.reduced && /reduce/.test(q)), addEventListener: noop }),
    getComputedStyle: () => ({ flexGrow: "0", overflowY: "" }),
    localStorage: { getItem: () => null, setItem: noop },
    document: dom.document,
    fetch: o.fetch || (async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({}), text: async () => "{}" })),
    tailzuApp: bridge,
  };
  g.window = g;
  const ctx = vm.createContext(g);
  for (const f of pageFiles(o.files || ["knobs.js", "botTiles.js", "botLooks.js", "sdui.js"])) vm.runInContext(fs.readFileSync(f, "utf8"), ctx, { filename: f });
  const run = (code) => vm.runInContext(code, ctx);
  /** Time passes: what is due runs, in order. */
  const tick = (ms) => {
    const until = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      timers = timers.filter((t) => t !== due);
      now = Math.max(now, due.at);
      due.f();
    }
    now = until;
  };
  const settle = async (ms = 0) => { for (let i = 0; i < 8; i++) { await new Promise((r) => setImmediate(r)); tick(0); } if (ms) tick(ms); };
  return { ctx, g, run, tick, settle, sent, dom, document: dom.document, view: dom.document.getElementById("view") };
}

module.exports = { pageFiles, fakeDom, fakePage };
