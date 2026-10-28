/**
 * DROPPED ON THE WINDOW: SHARING INTO TAILZU ON A COMPUTER.
 *
 * Drag files, a link or some text from anywhere (Finder, Explorer, a browser,
 * a mail) over the app window and it shows "Drop to send"; let go and the
 * files go to the backend's file door (POST /v1/files, one `file` part, as
 * the signed-in person), then the share-in screen opens (bots.share-in) with
 * what was dropped, where the person picks a bot or Ask. Esc, or dragging
 * back out, cancels: that is the system's own drag, nothing to do here.
 *
 * The phones do the same from their Share menus (the iOS share extension, the
 * Android share intent): one screen, three ways in.
 *
 * Only for a signed-in window with the Bots app on (bootstrap flag bots.app).
 * Text dragged onto a text field is left to the field; a drag that started in
 * this window is never a share.
 *
 * The parts that decide (planDrop, shareParams, sendDrop) are pure and tested
 * in shareIn.test.js; install() wires them to the page, reading the window's
 * own session and navigation from sdui.js, loaded before this file.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.TailzuShareIn = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /** The share-in screen's limits (bots.share-in in the backend) and the file door's (50 MB). */
  const MAX_FILES = 5;
  const MAX_BYTES = 50 * 1024 * 1024;
  const MAX_TEXT = 2000;
  const WEB = /^https?:\/\/\S+$/i;

  /** A drag worth showing "Drop to send" for: files, a link or text. */
  function acceptable(types) {
    const t = Array.from(types || []);
    return t.indexOf("Files") !== -1 || t.indexOf("text/uri-list") !== -1 || t.indexOf("text/plain") !== -1;
  }

  /** What a drop carries, as the share-in screen takes it: up to five files, one link, the words. */
  function planDrop(dt) {
    const all = Array.from((dt && dt.files) || []);
    const files = all.slice(0, MAX_FILES);
    let skipped = all.length - files.length;
    const get = (type) => { try { return String((dt && dt.getData && dt.getData(type)) || ""); } catch { return ""; } };
    // A file dragged from a file manager can also carry its own path as a file:// address or plain text: not a link, not words.
    const links = get("text/uri-list").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l[0] !== "#" && WEB.test(l));
    let text = get("text/plain").trim();
    if (files.length && (/^file:/i.test(text) || text[0] === "/" || /^[a-z]:\\/i.test(text) || files.some((f) => f.name === text))) text = "";
    let url = links[0] || "";
    if (!url && WEB.test(text)) { url = text; text = ""; }
    if (text === url) text = "";
    const big = files.filter((f) => Number(f.size) > MAX_BYTES);
    skipped += big.length;
    return { files: files.filter((f) => big.indexOf(f) === -1), text: text.slice(0, MAX_TEXT), url: url.slice(0, MAX_TEXT), skipped, tooBig: big.length > 0 };
  }

  /** The share-in screen's params: `file` (the first id), `files` (all, when more than one), `text`, `url`. */
  function shareParams(plan, ids) {
    const p = {};
    if (ids.length) p.file = ids[0];
    if (ids.length > 1) p.files = ids.join(",");
    if (plan.text) p.text = plan.text;
    if (plan.url) p.url = plan.url;
    return p;
  }

  /** POST /v1/files with one file: its id, or the server's words for why not ("" when it gave none). */
  async function uploadFile(file, io) {
    const fd = new io.FormData();
    fd.append("file", file, file.name);
    const tok = await io.token();
    const res = await io.fetch(io.baseUrl() + "/v1/files", { method: "POST", headers: tok ? { Authorization: "Bearer " + tok } : {}, body: fd });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (res.ok && body && body.file && typeof body.file.id === "string") return { id: body.file.id };
    return { error: body && typeof body.message === "string" && body.message.length <= 200 ? body.message : "" };
  }

  /**
   * Send what was dropped and open the share-in screen. Nothing usable: say so and open nothing.
   * io: { fetch, FormData, token(), baseUrl(), open(params), toast(msg), words: { failed, partly, tooBig } }
   */
  async function sendDrop(plan, io) {
    const ids = [];
    const errors = [];
    // One at a time: a slow connection sends one file well rather than five badly.
    for (const f of plan.files) {
      try {
        const r = await uploadFile(f, io);
        if (r.id) ids.push(r.id); else errors.push(r.error || "");
      } catch {
        errors.push("");
      }
    }
    if (!ids.length && !plan.text && !plan.url) {
      io.toast(errors.find(Boolean) || (plan.tooBig ? io.words.tooBig : io.words.failed));
      return "failed";
    }
    if (errors.length || plan.skipped) io.toast(errors.find(Boolean) || (plan.tooBig ? io.words.tooBig : io.words.partly));
    io.open(shareParams(plan, ids));
    return "opened";
  }

  // ------------------------------------------------------------------ the page

  const CSS = [
    "#tzDrop{position:fixed;inset:0;z-index:9000;display:none;align-items:center;justify-content:center;padding:28px;",
    "background:rgba(255,255,255,.94);font-family:'Tailzu Geist',system-ui,-apple-system,'Segoe UI',sans-serif;color:#0a0a0a}",
    "#tzDrop.on{display:flex}",
    "#tzDrop .tzd-card{width:min(640px,100%);display:flex;flex-direction:column;gap:18px}",
    "#tzDrop .tzd-head{display:flex;align-items:center;gap:10px}",
    "#tzDrop .tzd-head b{font-family:'Tailzu Geist SemiBold','Tailzu Geist',system-ui,sans-serif;font-weight:600;font-size:17px}",
    "#tzDrop .tzd-esc{margin-left:auto;font-size:13px;color:#5c5c5c;display:flex;align-items:center;gap:8px}",
    "#tzDrop kbd{font:500 12px/1 'Tailzu Geist Medium','Tailzu Geist',system-ui,sans-serif;border:1px solid #d4d4d4;border-radius:7px;padding:6px 8px;color:#0a0a0a;background:#fff}",
    "#tzDrop .tzd-zone{border:2px dashed #0a0a0a;border-radius:22px;padding:44px 24px;display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center;background:#fff}",
    "#tzDrop .tzd-what{font-family:'Tailzu Geist Bold','Tailzu Geist',system-ui,sans-serif;font-weight:700;font-size:24px;line-height:30px;letter-spacing:-.4px}",
    "#tzDrop .tzd-line{font-size:14px;line-height:20px;color:#3d3d3d}",
    "#tzDrop .tzd-dot{width:8px;height:8px;border-radius:4px;background:#0a0a0a;animation:tzBreathe 1.8s ease-in-out infinite}",
    "#tzDrop:not(.busy) .tzd-dot{display:none}",
    "@media (prefers-reduced-motion:reduce){#tzDrop .tzd-dot{animation:none}}",
  ].join("");

  /** The Tailzu mark as eight dots in a ring (the board's drop header). */
  function mark(doc) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "22");
    svg.setAttribute("height", "22");
    svg.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const c = doc.createElementNS(ns, "circle");
      c.setAttribute("cx", String(12 + 8.5 * Math.cos(a)));
      c.setAttribute("cy", String(12 + 8.5 * Math.sin(a)));
      c.setAttribute("r", "1.7");
      c.setAttribute("fill", "#0a0a0a");
      svg.appendChild(c);
    }
    return svg;
  }

  /** What the drag holds, said before the drop (a page may not read the files' names until then). */
  function dragSays(dt, words) {
    const items = Array.from((dt && dt.items) || []);
    const files = items.filter((i) => i.kind === "file").length;
    if (files > 1) return words.files.replace("{n}", String(files));
    if (files === 1) return words.file;
    const types = Array.from((dt && dt.types) || []);
    return types.indexOf("text/uri-list") !== -1 ? words.link : words.text;
  }

  /**
   * Wire the window. host: { window, document, ready(), enabled(), token(), baseUrl(), open(params), toast(msg), txt(key, fallback) }
   */
  function install(host) {
    const win = host.window, doc = host.document;
    const w = (k, d) => host.txt("desktop.share." + k, d);
    const words = () => ({
      drop: w("drop", "Drop to send"), esc: w("esc", "to cancel"), after: w("after", "Let go, then pick the bot to send it to."),
      file: w("file", "A file"), files: w("files", "{n} files"), link: w("link", "A link"), text: w("text", "Some text"),
      adding: w("adding", "Adding it…"), failed: w("failed", "Couldn't add that. Try again."),
      partly: w("partly", "Some of it couldn't be added."), tooBig: w("tooBig", "That file is over 50 MB, which is the most Tailzu takes."),
    });

    const style = doc.createElement("style");
    style.textContent = CSS;
    doc.head.appendChild(style);
    const box = doc.createElement("div");
    box.id = "tzDrop";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-live", "polite");
    const card = doc.createElement("div"); card.className = "tzd-card";
    const head = doc.createElement("div"); head.className = "tzd-head";
    const title = doc.createElement("b");
    const esc = doc.createElement("span"); esc.className = "tzd-esc";
    const kbd = doc.createElement("kbd"); kbd.textContent = "Esc";
    const escWords = doc.createElement("span");
    esc.appendChild(kbd); esc.appendChild(escWords);
    head.appendChild(mark(doc)); head.appendChild(title); head.appendChild(esc);
    const zone = doc.createElement("div"); zone.className = "tzd-zone";
    const dot = doc.createElement("span"); dot.className = "tzd-dot";
    const what = doc.createElement("div"); what.className = "tzd-what";
    const line = doc.createElement("div"); line.className = "tzd-line";
    zone.appendChild(dot); zone.appendChild(what); zone.appendChild(line);
    card.appendChild(head); card.appendChild(zone);
    box.appendChild(card);
    doc.body.appendChild(box);

    let inner = false;   // a drag that started in this window
    let depth = 0;       // dragenter/dragleave pairs, so moving over children does not flicker
    let busy = false;

    const show = (says) => {
      const ws = words();
      title.textContent = ws.drop;
      escWords.textContent = ws.esc;
      what.textContent = says;
      line.textContent = ws.after;
      esc.style.visibility = "visible";
      box.classList.remove("busy");
      box.classList.add("on");
    };
    const hide = () => { if (!busy) box.classList.remove("on"); depth = 0; };
    const editable = (el) => !!(el && el.closest && el.closest("input, textarea, [contenteditable=''], [contenteditable='true']"));
    const ours = (e) => {
      if (inner || busy || !host.ready() || !host.enabled()) return false;
      const dt = e.dataTransfer;
      if (!dt || !acceptable(dt.types)) return false;
      // Text onto a text field is the field's.
      const hasFiles = Array.from(dt.types || []).indexOf("Files") !== -1;
      return hasFiles || !editable(e.target);
    };

    doc.addEventListener("dragstart", () => { inner = true; }, true);
    doc.addEventListener("dragend", () => { inner = false; }, true);
    win.addEventListener("dragenter", (e) => {
      if (!ours(e)) return;
      e.preventDefault();
      depth++;
      if (depth === 1) show(dragSays(e.dataTransfer, words()));
    });
    win.addEventListener("dragover", (e) => {
      if (!ours(e)) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = "copy"; } catch { /* read-only on some drags */ }
      if (!box.classList.contains("on")) show(dragSays(e.dataTransfer, words()));
    });
    win.addEventListener("dragleave", (e) => {
      if (!box.classList.contains("on")) return;
      depth = Math.max(0, depth - 1);
      // Out of the window (or Esc): the pointer left for nowhere in this page.
      if (depth === 0 || !e.relatedTarget) hide();
    });
    win.addEventListener("drop", (e) => {
      const was = box.classList.contains("on");
      if (!ours(e) && !was) return;
      e.preventDefault();
      inner = false;
      const plan = planDrop(e.dataTransfer);
      if (!plan.files.length && !plan.text && !plan.url) {
        hide();
        if (plan.tooBig) host.toast(words().tooBig);
        return;
      }
      const ws = words();
      busy = true;
      box.classList.add("busy");
      what.textContent = plan.files.length ? ws.adding : what.textContent;
      line.textContent = "";
      esc.style.visibility = "hidden";
      void sendDrop(plan, {
        fetch: (u, o) => win.fetch(u, o), FormData: win.FormData, token: host.token, baseUrl: host.baseUrl,
        open: host.open, toast: host.toast, words: ws,
      }).catch(() => host.toast(ws.failed)).finally(() => { busy = false; hide(); });
    });
    // A drop outside the zone, or a drag the page refused, must never open the file in the window.
    win.addEventListener("dragend", hide);
    return { show, hide };
  }

  return { MAX_FILES, MAX_BYTES, acceptable, planDrop, shareParams, uploadFile, sendDrop, install };
});

// In the window: wire it to the app (sdui.js, loaded first, holds the session and the navigation).
/* global SESSION, STACK, ENV, K, go, bearer, toast */
if (typeof module === "undefined" && typeof window !== "undefined" && typeof go === "function" && window.TailzuShareIn) {
  window.TailzuShareIn.install({
    window,
    document,
    ready: () => !!SESSION && STACK.length > 0,
    enabled: () => K.bool("bots.app", false),
    token: () => bearer(),
    baseUrl: () => (ENV && ENV.baseUrl) || "",
    open: (params) => {
      const id = K.str("desktop.share.screenId", "bots.share-in");
      // A second drop replaces the first one's screen rather than stacking on it.
      const top = STACK[STACK.length - 1];
      if (top && top.screenId === id) STACK.pop();
      go(id, params);
    },
    toast: (m) => toast(m),
    txt: (k, d) => K.txt(k, d),
  });
}
