// "ADD THIS": WHAT IS ON THE SCREEN GOES TO PLAN EASE WITH THE WORDS (the backend's docs/plan-ease.md "The one box"; design B11).
//
// Said with an email, a page or a selection in front ("add this", "remind me about this on Friday", "isko plan mein daal do"), the
// words alone told Plan Ease nothing: "this" was on the screen, not in the sentence. Now, when the words point at the screen
// (router.js pointsAtScreen) and Plan Ease is the bot they go to, what they point at goes with them to Plan Ease's one box:
//
//   POST /v1/botsapp/bots/plan/box { words, tz, seen: { from, text, app?, title?, where? } }   → the box's answer (BoxReply)
//
// The server does the reading: one item ("Added: Dentist, Fri 13 Nov, 5 pm", with Undo), or a card of the things in it, through its
// capture, with the person's yes to AI and Plan Ease's budget, as for a shared circular. The person only says "add this".
//
// What "this" is, in order: the selection (what they picked out), else the page in front (its readable text, the part around where
// they are first: src/context/pageRead.js, never scrolled for this), else the visible window's text (src/context/screenRead.js), else
// nothing, and then the words go as they always did (/v1/shell/ask). Never from a sensitive app (money, health, passwords) or a
// private window, where the words go alone; routing.js and pageRead.js both hold to that.
//
// Off until the server says its box reads `seen` (desktop.plan.addThis, sent only by one that does), so an older server never gets
// "add this" as a to-do called "this". A box answer of "chat" (it understood no item), or any failure, sends the words the old way.

"use strict";

const { pointsAtScreen } = require("./router.js");

/** Plan Ease's slug: the only bot "add this" carries the screen to. */
const PLAN = "plan";
/** The box's own cap on words (the backend's planEase.ts box). */
const WORDS_MAX = 2000;
const SEEN_FROM = new Set(["selection", "page", "screen"]);
const SCREEN_ID = /^[A-Za-z0-9_.-]{1,80}$/;
const PARAM_KEY = /^[A-Za-z0-9_]{1,40}$/;
const ITEM = /^[a-z][a-z0-9_]{0,15}(?::[A-Za-z0-9_.-]{1,80}){1,4}$/;
const ACTION = /^[a-z0-9_]{1,24}$/;

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const line = (s, max) => String(s || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * What goes as `seen`, or null when there is nothing worth sending. Its lines are kept (a circular's lines are its items), control
 * characters and runs of blank lines are not, and it is cut to `max`.
 */
function seenOf(o, max) {
  if (!isObj(o) || !SEEN_FROM.has(o.from)) return null;
  const text = String(o.text || "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ")
    .replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, Math.max(200, max | 0));
  if (!text) return null;
  const out = { from: o.from, text };
  const app = line(o.app, 80), title = line(o.title, 200), where = line(o.where, 200);
  if (app) out.app = app;
  if (title) out.title = title;
  if (where) out.where = where;
  return out;
}

/** The box's request. */
function boxBody(words, seen, tz) {
  const n = Math.round(Number(tz));
  return { words: String(words || "").trim().slice(0, WORDS_MAX), tz: Number.isFinite(n) ? Math.max(-720, Math.min(840, n)) : 0, seen };
}

/**
 * The box's answer as the pill and the notification say it: { name, text, kind, open, undo? }, or null when the chat should answer
 * (kind "chat", or no line), and the words then go as before. A click opens what the answer names (the card), else the Plan page.
 */
function replyOf(j, name) {
  if (!isObj(j) || j.kind === "chat") return null;
  const text = line(j.line, 300);
  if (!text) return null;
  const out = { name: String(name || "Plan Ease"), text, kind: typeof j.kind === "string" ? j.kind : "said", open: { screenId: "bots.plan", params: {} } };
  if (isObj(j.open) && typeof j.open.screen === "string" && SCREEN_ID.test(j.open.screen)) {
    const params = {};
    if (isObj(j.open.params)) {
      for (const [k, v] of Object.entries(j.open.params).slice(0, 8)) if (PARAM_KEY.test(k) && typeof v === "string") params[k] = v.slice(0, 200);
    }
    out.open = { screenId: j.open.screen, params };
  }
  if (isObj(j.undo) && typeof j.undo.item === "string" && ITEM.test(j.undo.item) && typeof j.undo.action === "string" && ACTION.test(j.undo.action)) {
    out.undo = { item: j.undo.item, action: j.undo.action };
  }
  return out;
}

/**
 * d: {
 *   on()                 the server's box reads `seen` (desktop.plan.addThis), and someone is signed in
 *   page(words)          the page in front: pageRead.readPage's { text, where } (never scrolled for this)
 *   screen()             the visible window's text, or "" (screenRead.readScreen, for a page the tree cannot read)
 *   post(path, body)     → the JSON answer; throws on a refusal
 *   act(item, action)    the act door (POST /v1/widgets/act with a key) → true when it took it
 *   tz()                 minutes east of UTC
 *   knobs: { num, str }
 * }
 */
function createAddThis(d) {
  const { num, str } = d.knobs;
  const max = () => Math.max(200, num("desktop.plan.addThis.chars", 12000));

  /** What "this" is: the selection, else the page, else the visible window, else null. o: { words, selection, app, title } */
  async function read(o) {
    const sel = o && typeof o.selection === "string" ? o.selection.trim() : "";
    const app = o && o.app, title = o && o.title;
    if (sel) return seenOf({ from: "selection", text: sel, app, title }, max());
    let page = null;
    try { page = await d.page(String((o && o.words) || "")); } catch { page = null; }
    const enough = Math.max(1, num("desktop.plan.addThis.minChars", 40));
    if (page && typeof page.text === "string" && page.text.trim().length >= enough) {
      return seenOf({ from: "page", text: page.text, where: page.where, app, title }, max());
    }
    let shown = "";
    try { shown = await d.screen(); } catch { shown = ""; }
    if (typeof shown === "string" && shown.trim().length >= enough) return seenOf({ from: "screen", text: shown, app, title }, max());
    return null;
  }

  /** The words and what they point at, to the box. Null on any failure, or when the chat should answer: the words go the old way. */
  async function send(words, seen, name) {
    let j = null;
    try { j = await d.post(str("desktop.plan.addThis.path", "/v1/botsapp/bots/plan/box"), boxBody(words, seen, d.tz())); } catch { return null; }
    return replyOf(j, name);
  }

  /** The box's own Undo, through the act door. */
  async function undo(u) {
    if (!isObj(u) || !ITEM.test(String(u.item)) || !ACTION.test(String(u.action))) return false;
    return !!(await d.act(u.item, u.action));
  }

  return { slug: PLAN, on: () => { try { return !!d.on(); } catch { return false; } }, points: pointsAtScreen, read, send, undo };
}

module.exports = { createAddThis, seenOf, boxBody, replyOf, PLAN };
