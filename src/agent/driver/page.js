// A "page" answer as callers see it, from either helper (tzax.swift on a Mac,
// uia-agent.ps1 on Windows): the focused window's whole readable text, the
// parts out of sight included, for understanding the page and never for
// acting on it. Built afresh, so nothing else the helper wrote gets through.
//
//   { ok: true, text, headings: [{ level, text }], approxWhere, whereOffset,
//     truncated, ms, app: { name, pid }, window: { title, frame }, scale }
//   { ok: false, error }
//
// The window's title is for the device's own check (a sensitive app, a private window), as a
// snapshot's is, and its frame (in the driver's units, `scale`) for telling
// whether a scroll under the pointer would reach it; neither is sent.

/** The most text an answer may carry, whatever the helper sent. */
const PAGE_TEXT_MAX = 100000;
const HEADINGS_MAX = 200;
const HEADING_MAX = 300;
const WHERE_MAX = 200;

const isFrame = (f) => Array.isArray(f) && f.length === 4 && f.every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1e6)
  && f[2] > 0 && f[3] > 0;

function pageShape(r, scale) {
  if (!r || typeof r !== "object" || typeof r.ok !== "boolean") return { ok: false, error: "bad_answer" };
  if (!r.ok) return { ok: false, error: typeof r.error === "string" && /^[a-z_]{1,40}$/.test(r.error) ? r.error : "failed" };
  if (typeof r.text !== "string") return { ok: false, error: "bad_answer" };
  // Windows PowerShell writes a list of one as the one; either way it is a list here.
  const list = Array.isArray(r.headings) ? r.headings : r.headings && typeof r.headings === "object" ? [r.headings] : [];
  const headings = [];
  for (const h of list) {
    if (headings.length >= HEADINGS_MAX) break;
    if (!h || typeof h !== "object" || typeof h.text !== "string" || !h.text.trim()) continue;
    const n = Number(h.level);
    headings.push({ level: Number.isInteger(n) && n >= 1 && n <= 6 ? n : 1, text: h.text.trim().slice(0, HEADING_MAX) });
  }
  const text = r.text.slice(0, PAGE_TEXT_MAX);
  const off = Number(r.whereOffset);
  const a = r.app && typeof r.app === "object" && !Array.isArray(r.app) ? r.app : {};
  const w = r.window && typeof r.window === "object" && !Array.isArray(r.window) ? r.window : {};
  return {
    ok: true,
    text,
    headings,
    approxWhere: typeof r.approxWhere === "string" ? r.approxWhere.slice(0, WHERE_MAX) : "",
    whereOffset: Number.isInteger(off) && off >= 0 && off < text.length ? off : -1,
    truncated: r.truncated === true || r.text.length > PAGE_TEXT_MAX,
    ms: typeof r.ms === "number" && Number.isFinite(r.ms) ? r.ms : 0,
    app: { name: typeof a.name === "string" ? a.name.slice(0, 200) : "", pid: Number.isInteger(a.pid) && a.pid > 0 ? a.pid : 0 },
    window: { title: typeof w.title === "string" ? w.title.slice(0, 200) : "", frame: isFrame(w.frame) ? w.frame.slice() : null },
    scale: scale === "pixels" ? "pixels" : "points",
  };
}

/** The options a page read is asked with: the helper's character budget, its
 *  walk's time budget, and the call's own timeout a little past that. */
function pageOptions(o, margin) {
  const opt = o && typeof o === "object" ? o : {};
  const int = (v, lo, hi, d) => {
    const n = Number(v);
    return v == null || v === "" || !Number.isFinite(n) ? d : Math.max(lo, Math.min(hi, Math.round(n)));
  };
  const chars = int(opt.chars, 500, PAGE_TEXT_MAX, 20000);
  const budgetMs = int(opt.budgetMs, 50, 6000, 1200);
  const timeoutMs = int(opt.timeoutMs, 200, 10000, budgetMs + margin);
  return { chars, budgetMs: Math.max(50, Math.min(budgetMs, timeoutMs - margin)), timeoutMs };
}

module.exports = { pageShape, pageOptions, PAGE_TEXT_MAX };
