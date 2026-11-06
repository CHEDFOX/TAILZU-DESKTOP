// MentionField (shared/types/sdui.ts 3i): a message field where "@" picks a person (a chip) and "/" picks one of the person's
// bots, then one of its things (a chip), or one of the screen's tools. Inside a space it is his thought's box. Each person in the
// "@" list is shown by their own tiny bot (the row's `bot`, personBot.js; 3j), never a letter.
//
// IT OWNS ITS OWN DOM AND IS NEVER REPAINTED. A paint replaces #view's markup, and a feed repaints whenever someone else writes
// (a live reload), so a field drawn from state each time would lose its words, its chips, an open list and the caret. Instead its
// element (input, chips, send) lives in MF_LIVES by `life`; the node draws an empty slot and mountMentions() moves the kept
// element into it, then gives back the focus and the selection it had. Typing writes a MentionDraft to draftPath (the text without
// the chips) with no repaint. The list over the field is its own element on <body>, placed by the field's rect.
//
// Before on.onSubmit runs: a text that starts with "@word" and no person chip becomes that person's chip when exactly one person's
// first name is that word (the "@word" taken out); when more than one is, the People list opens on it and nothing is sent; nobody,
// and it goes as written. The server clears draftPath after sending; the field then empties itself, chips and all.

const MF_LIVES = new Map();
/** The lives mounted by the last paint (a field appearing anew takes autoFocus). */
let MF_SHOWN = new Set();

const EMPTY_MENTION = { text: "", toId: "", toName: "", bot: "", botName: "", thingId: "", thingTitle: "" };

// ---- the rules (pure) --------------------------------------------------------------------------------------------------

/**
 * What the text before the caret asks for: "@" or "/" typed at the start or after a space, with no space after it yet.
 * { kind: "people" | "bots", start (the mark's index), query (what follows it) }, or null. "@" only while no person is picked.
 */
function mentionTrigger(text, caret, hasPerson) {
  const before = String(text || "").slice(0, Math.max(0, caret == null ? String(text || "").length : caret));
  const m = /(^|\s)([@/])([^\s@/]*)$/.exec(before);
  if (!m) return null;
  const kind = m[2] === "@" ? "people" : "bots";
  if (kind === "people" && hasPerson) return null;
  return { kind, start: before.length - m[3].length - 1, query: m[3] };
}

/** The people whose name has a word starting with `query` (all of them for none). */
function mentionPeople(people, query) {
  const q = String(query || "").toLowerCase();
  return (Array.isArray(people) ? people : []).filter((p) => p && p.id && (!q || String(p.name || "").toLowerCase().split(/\s+/).some((w) => w.startsWith(q))));
}

/** The bots whose name holds `query`, or whose slug starts with it (all of them for none): the phone's mentionCore filterBots. */
function mentionBots(bots, query) {
  const q = String(query || "").trim().toLowerCase();
  return (Array.isArray(bots) ? bots : []).filter((b) => b && (!q || String(b.name || "").toLowerCase().includes(q) || String(b.slug || "").toLowerCase().startsWith(q)));
}

/** The text with [start, end) taken out, and the caret where it was. */
function mentionCut(text, start, end) {
  const s = String(text || "");
  let rest = s.slice(0, start) + s.slice(end);
  // Two spaces where the mark was are one.
  if (rest[start - 1] === " " && rest[start] === " ") rest = rest.slice(0, start) + rest.slice(start + 1);
  return { text: rest, caret: start };
}

/**
 * At send: { send: true } to send as it is, { send: true, draft } with the person turned into a chip, or { send: false, query } to
 * open the People list on the word (more than one person by that first name).
 */
function mentionAtSend(draft, people) {
  const d = Object.assign({}, EMPTY_MENTION, draft || {});
  if (d.toId) return { send: true };
  const m = /^\s*@([^\s@/]+)\s*/.exec(d.text);
  if (!m) return { send: true };
  const word = m[1].toLowerCase().replace(/[.,!?;:]+$/, "");
  const hits = (Array.isArray(people) ? people : []).filter((p) => p && p.id && String(p.name || "").trim().split(/\s+/)[0].toLowerCase() === word);
  if (hits.length === 1) return { send: true, draft: Object.assign({}, d, { text: d.text.slice(m[0].length).trim(), toId: hits[0].id, toName: hits[0].name }) };
  if (hits.length > 1) return { send: false, query: m[1] };
  return { send: true };
}

// ---- the node and the mount ------------------------------------------------------------------------------------------------

function mentionFieldNode(n, p) {
  const id = BT_PENDING.push({ kind: "mention", n, p }) - 1;
  return '<div class="tz-mf-slot" data-mf="' + id + '"></div>';
}

/** One field's life: built once, kept across paints. */
function mfLife(life) {
  let L = MF_LIVES.get(life);
  if (L) return L;
  // A field of a space no longer on screen goes, a few at most kept (each is a whole small DOM).
  if (MF_LIVES.size >= K.num("desktop.mention.lives", 12)) {
    for (const [k, v] of MF_LIVES) { if (!v.el.isConnected) { mfClose(v); MF_LIVES.delete(k); break; } }
  }
  const mk = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  const el = mk("div", "tz-mf");
  const line = mk("div", "tz-mf-line");
  const chips = mk("span", "tz-mf-chips");
  const input = mk("input", "tz-mf-in");
  input.setAttribute("type", "text");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "true");
  const send = mk("button", "tz-mf-send");
  send.setAttribute("type", "button");
  send.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
  line.appendChild(chips); line.appendChild(input); line.appendChild(send);
  el.appendChild(line);
  const list = mk("div", "tz-mf-pop");
  list.setAttribute("role", "listbox");
  L = { life, el, input, chips, send, list, d: Object.assign({}, EMPTY_MENTION), cfg: null, on: null, menu: null, hi: 0, things: new Map(), focus: null };
  MF_LIVES.set(life, L);
  input.addEventListener("input", () => mfTyped(L));
  input.addEventListener("keydown", (e) => mfKey(L, e));
  input.addEventListener("click", () => mfTyped(L));
  input.addEventListener("blur", () => { setTimeout(() => { if (document.activeElement !== L.input && !L.list.contains(document.activeElement)) mfCloseSoon(L); }, 0); });
  send.addEventListener("click", () => { void mfSubmit(L); });
  // A press in the list keeps the field's focus (the pick then puts the caret back).
  list.addEventListener("mousedown", (e) => e.preventDefault());
  return L;
}

/** Before #view's markup is replaced: which field has the focus, and where its caret is (put back after the paint). */
function mentionBefore() {
  for (const L of MF_LIVES.values()) {
    L.focus = L.el.isConnected && document.activeElement === L.input ? { start: L.input.selectionStart, end: L.input.selectionEnd } : null;
  }
}

/** A fetch of the same screen (paint(true)) brings the server's empty draft: a field holding words keeps them in state too. */
function mentionCarry() {
  for (const L of MF_LIVES.values()) {
    if (L.el.isConnected && L.cfg && mfHas(L)) setStatePath(L.cfg.draftPath, Object.assign({}, L.d));
  }
}

const mfHas = (L) => !!(L.d.text || L.d.toId || L.d.thingId);

/** After a paint: each slot gets its field (made once), with the newest props; focus and caret back where they were. */
function mountMentions(root) {
  const now = new Set();
  root.querySelectorAll("[data-mf]").forEach((slot) => {
    const cfg = BT_PENDING[Number(slot.getAttribute("data-mf"))];
    if (!cfg || !cfg.p) return;
    const p = cfg.p;
    const L = mfLife(String(p.life || "mention"));
    L.cfg = p;
    L.on = (cfg.n && cfg.n.on) || {};
    L.input.setAttribute("placeholder", label(p.placeholder || ""));
    L.input.setAttribute("aria-label", label(p.placeholder || ""));
    if (Number(p.maxLength) > 0) L.input.setAttribute("maxlength", String(Math.floor(Number(p.maxLength))));
    L.send.setAttribute("aria-label", K.txt("desktop.mention.send", "Send"));
    // draftPath cleared (sent, or put away): the field empties, chips too. Never filled from state otherwise.
    const st = stateAt(p.draftPath);
    if ((!st || (!st.text && !st.toId && !st.thingId)) && mfHas(L)) { L.d = Object.assign({}, EMPTY_MENTION); L.input.value = ""; mfClose(L); }
    slot.replaceWith ? slot.replaceWith(L.el) : slot.parentElement.replaceChild(L.el, slot);
    mfChips(L);
    const appeared = !MF_SHOWN.has(L.life);
    now.add(L.life);
    if (L.focus) {
      try { L.input.focus({ preventScroll: true }); L.input.setSelectionRange(L.focus.start, L.focus.end); } catch { /* not focusable now */ }
      L.focus = null;
    } else if (appeared && p.autoFocus === true) {
      try { L.input.focus({ preventScroll: true }); } catch { /* not focusable now */ }
    }
    if (L.menu) mfPlace(L);
  });
  // A field this paint did not draw (another screen): its list goes.
  for (const L of MF_LIVES.values()) if (!now.has(L.life)) mfClose(L);
  MF_SHOWN = now;
}

// ---- typing --------------------------------------------------------------------------------------------------------------

/** The draft to state, no repaint. */
function mfWrite(L) {
  if (L.cfg && L.cfg.draftPath) setStatePath(L.cfg.draftPath, Object.assign({}, L.d));
  L.el.classList.toggle("has", mfHas(L));
}

function mfTyped(L) {
  L.d.text = L.input.value;
  mfWrite(L);
  const t = mentionTrigger(L.input.value, L.input.selectionStart, !!L.d.toId);
  if (!t) { if (L.menu && L.menu.kind !== "things") mfClose(L); return; }
  if (t.kind === "people") mfOpen(L, { kind: "people", start: t.start, query: t.query });
  else if (!L.menu || L.menu.kind !== "things") mfOpen(L, { kind: "bots", start: t.start, query: t.query });
}

function mfKey(L, e) {
  const rows = L.menu ? Array.from(L.list.querySelectorAll("[data-row]")) : [];
  if (e.key === "Escape") {
    // The list first; then the field lets go; the thought closes on the next (listen.js, stage.js).
    e.preventDefault();
    e.stopPropagation();
    if (L.menu) mfClose(L); else L.input.blur();
    return;
  }
  if (L.menu && (e.key === "ArrowDown" || e.key === "ArrowUp") && rows.length) {
    e.preventDefault();
    L.hi = (L.hi + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
    rows.forEach((r, i) => r.classList.toggle("hl", i === L.hi));
    return;
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (L.menu && rows.length) { rows[Math.min(L.hi, rows.length - 1)].__pick(); return; }
    void mfSubmit(L);
    return;
  }
  // Backspace in an empty field takes the last chip (the thing, then the person).
  if (e.key === "Backspace" && !L.input.value && L.input.selectionStart === 0) {
    if (L.d.thingId) { Object.assign(L.d, { bot: "", botName: "", thingId: "", thingTitle: "" }); }
    else if (L.d.toId) { Object.assign(L.d, { toId: "", toName: "" }); }
    else return;
    e.preventDefault();
    mfChips(L);
    mfWrite(L);
  }
}

/** The chips before the words: the person, the thing; each with its ×. */
function mfChips(L) {
  L.chips.textContent = "";
  const chip = (text, drop) => {
    const c = document.createElement("span");
    c.className = "tz-mf-chip";
    const t = document.createElement("span");
    t.textContent = text;
    const x = document.createElement("button");
    x.setAttribute("type", "button");
    x.className = "tz-mf-x";
    x.setAttribute("aria-label", K.txt("desktop.mention.remove", "Remove {what}").replace("{what}", text));
    x.textContent = "×";
    x.addEventListener("mousedown", (e) => e.preventDefault());
    x.addEventListener("click", () => { drop(); mfChips(L); mfWrite(L); L.input.focus(); });
    c.appendChild(t); c.appendChild(x);
    L.chips.appendChild(c);
  };
  if (L.d.toId) chip("@" + L.d.toName, () => Object.assign(L.d, { toId: "", toName: "" }));
  if (L.d.thingId) chip(L.d.thingTitle + " · " + L.d.botName, () => Object.assign(L.d, { bot: "", botName: "", thingId: "", thingTitle: "" }));
  L.el.classList.toggle("has", mfHas(L));
}

// ---- the list ------------------------------------------------------------------------------------------------------------

function mfOpen(L, menu) {
  L.menu = menu;
  L.hi = 0;
  mfDrawList(L);
  if (!L.list.isConnected) document.body.appendChild(L.list);
  mfPlace(L);
  L.list.classList.add("on");
}

function mfClose(L) {
  L.menu = null;
  L.list.classList.remove("on");
  if (L.list.parentElement) L.list.remove();
}
function mfCloseSoon(L) { if (L.menu) mfClose(L); }

/** Over the field, its left edge with the field's: placed by the field's rect each time it opens or the page is drawn. */
function mfPlace(L) {
  const r = L.el.getBoundingClientRect();
  const w = Math.min(K.num("desktop.mention.listWidth", 320), Math.max(220, r.width));
  L.list.style.left = Math.max(8, r.left) + "px";
  L.list.style.width = w + "px";
  L.list.style.bottom = Math.max(8, window.innerHeight - r.top + 8) + "px";
}

/** The look a row carries (MentionFieldProps.people[].bot), when it names a person and a colour; else null. */
function mentionLook(b) {
  if (!b || typeof b !== "object" || typeof b.seed !== "string" || typeof b.color !== "string") return null;
  return { seed: b.seed, avatar: typeof b.avatar === "string" ? b.avatar : "", color: b.color };
}

/** A row without a look (a server from before people were bots): a plain circle in a colour of the person's own (the phone's). */
const MF_DOTS = ["#6E4A6B", "#4F7A3A", "#A9573A", "#3E6E8E", "#8F6A1F", "#2F5D50", "#7A6440", "#5F6B6E"];
function mentionDot(name) {
  let h = 0;
  const s = String(name || "");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return MF_DOTS[h % MF_DOTS.length];
}

/**
 * A person in the "@" list: their own tiny bot (personBot.js, the row's `bot`), decoration beside their name, never a letter. The
 * list's bots live apart from the screen's ("mention" scope), each person counted so the same one twice is two.
 */
function mfFace(person, size, salts) {
  const look = mentionLook(person.bot);
  if (look && typeof personBotEl === "function") {
    const salt = salts.get(look.seed) || 0;
    salts.set(look.seed, salt + 1);
    return personBotEl(look, size, "mention", salt);
  }
  const dot = document.createElement("span");
  dot.className = "tz-mf-av";
  dot.setAttribute("aria-hidden", "true");
  dot.style.width = size + "px";
  dot.style.height = size + "px";
  dot.style.background = look ? look.color : mentionDot(person.name);
  return dot;
}

/** The rows of the list now: people, bots and tools, or one bot's things. */
function mfDrawList(L) {
  const p = L.cfg || {}, words = p.words || {};
  const list = L.list;
  list.textContent = "";
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const row = (cls, pick) => {
    const r = mk("div", "tz-mf-row " + cls);
    r.setAttribute("data-row", "1");
    r.setAttribute("role", "option");
    r.__pick = pick;
    r.addEventListener("click", pick);
    return r;
  };
  const head = (text) => list.appendChild(mk("div", "tz-mf-head", text));
  const m = L.menu;
  if (m.kind === "people") {
    head(label(words.people || ""));
    const people = mentionPeople(p.people, m.query);
    if (!people.length) list.appendChild(mk("div", "tz-mf-empty", label(words.empty || "")));
    const size = K.num("desktop.mention.botSize", 28);
    const salts = new Map();
    people.forEach((person) => {
      const r = row("tz-mf-person", () => mfPickPerson(L, person));
      r.appendChild(mfFace(person, size, salts));
      r.appendChild(mk("span", "tz-mf-name", person.name));
      list.appendChild(r);
    });
  } else if (m.kind === "bots") {
    head(label(words.bots || ""));
    // Filtered by what follows the "/", as the people are by what follows the "@".
    mentionBots(p.bots, m.query).forEach((b) => {
      const r = row("tz-mf-bot", () => void mfPickBot(L, b));
      const dot = mk("span", "tz-mf-dot");
      dot.style.background = String(b.color || "#0a0a0a");
      r.appendChild(dot);
      r.appendChild(mk("span", "tz-mf-name", b.name));
      list.appendChild(r);
    });
    const tools = Array.isArray(p.tools) ? p.tools : [];
    if (tools.length) list.appendChild(mk("div", "tz-mf-div"));
    tools.forEach((t) => {
      const r = row("tz-mf-tool", () => mfPickTool(L, t));
      r.appendChild(mk("span", "tz-mf-name", label(t.label)));
      list.appendChild(r);
    });
  } else if (m.kind === "things") {
    const top = mk("div", "tz-mf-thead");
    const back = mk("button", "tz-mf-back", "‹");
    back.setAttribute("type", "button");
    back.setAttribute("aria-label", K.txt("desktop.mention.back", "Back"));
    back.addEventListener("click", () => { mfOpen(L, { kind: "bots", start: m.start, query: "" }); L.input.focus(); });
    top.appendChild(back);
    top.appendChild(mk("span", "tz-mf-name", m.bot.name));
    list.appendChild(top);
    if (!m.items) list.appendChild(mk("div", "tz-mf-empty", "…"));
    else if (!m.items.length) list.appendChild(mk("div", "tz-mf-empty", label(words.empty || "")));
    else m.items.forEach((it) => {
      const r = row("tz-mf-thing", () => mfPickThing(L, m.bot, it));
      const bar = mk("span", "tz-mf-bar");
      bar.style.background = String(m.bot.color || "#0a0a0a");
      const tx = mk("span", "tz-mf-tx");
      tx.appendChild(mk("span", "tz-mf-name", it.title));
      if (it.line) tx.appendChild(mk("span", "tz-mf-sub", it.line));
      r.appendChild(bar); r.appendChild(tx);
      list.appendChild(r);
    });
  }
  Array.from(list.querySelectorAll("[data-row]")).forEach((r, i) => r.classList.toggle("hl", i === L.hi));
}

/** The "@word" or "/word" typed, out of the words (from the mark to the caret). */
function mfDropMark(L) {
  const m = L.menu;
  if (!m) return;
  const end = Math.max(m.start + 1, L.input.selectionStart == null ? L.input.value.length : L.input.selectionStart);
  const cut = mentionCut(L.input.value, m.start, end);
  L.input.value = cut.text;
  L.d.text = cut.text;
  try { L.input.setSelectionRange(cut.caret, cut.caret); } catch { /* not a text field now */ }
}

function mfPickPerson(L, person) {
  mfDropMark(L);
  L.d.toId = String(person.id);
  L.d.toName = String(person.name || "");
  mfClose(L);
  mfChips(L);
  mfWrite(L);
  L.input.focus();
}

/** A bot picked: its things, from the person's own (thingsPath, through the window's signed-in fetch). */
async function mfPickBot(L, bot) {
  const m = L.menu;
  if (!m) return;
  const kept = L.things.get(bot.slug);
  mfOpen(L, { kind: "things", start: m.start, bot, items: kept || null });
  L.input.focus();
  try {
    const path = String((L.cfg && L.cfg.thingsPath) || "").replace(":bot", encodeURIComponent(String(bot.slug || "")));
    const res = await api(path, undefined, "GET");
    const items = (res && Array.isArray(res.items) ? res.items : []).filter((i) => i && i.id).map((i) => ({ id: String(i.id), title: String(i.title || ""), line: String(i.line || "") }));
    L.things.set(bot.slug, items);
    if (L.menu && L.menu.kind === "things" && L.menu.bot === bot) { L.menu.items = items; mfDrawList(L); mfPlace(L); }
  } catch {
    if (L.menu && L.menu.kind === "things" && L.menu.bot === bot) { L.menu.items = kept || []; mfDrawList(L); }
  }
}

function mfPickThing(L, bot, item) {
  mfDropMark(L);
  Object.assign(L.d, { bot: String(bot.slug || ""), botName: String(bot.name || ""), thingId: item.id, thingTitle: item.title });
  mfClose(L);
  mfChips(L);
  mfWrite(L);
  L.input.focus();
}

function mfPickTool(L, tool) {
  mfDropMark(L);
  mfClose(L);
  mfWrite(L);
  void run(tool.action);
}

/** Enter or the send button: "@word" made a chip first when it is one person; several, the list instead; then on.onSubmit. */
async function mfSubmit(L) {
  if (L.menu) mfClose(L);
  L.d.text = L.input.value;
  const p = L.cfg || {};
  const at = mentionAtSend(L.d, p.people);
  if (!at.send) {
    const t = /@/.exec(L.d.text);
    const start = t ? t.index : 0;
    try { L.input.setSelectionRange(start + 1 + at.query.length, start + 1 + at.query.length); } catch { /* fine */ }
    mfOpen(L, { kind: "people", start, query: at.query });
    L.input.focus();
    return;
  }
  if (at.draft) {
    L.d = at.draft;
    L.input.value = L.d.text;
    mfChips(L);
  }
  mfWrite(L);
  if (L.on && L.on.onSubmit) await run(L.on.onSubmit);
}

/** Escape anywhere: an open list closes (true), else nothing here. */
function mentionEscape() {
  for (const L of MF_LIVES.values()) if (L.menu) { mfClose(L); return true; }
  return false;
}
