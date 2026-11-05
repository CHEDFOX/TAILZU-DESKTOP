// What the job did, as short lines: from the work log (GET /v1/code/jobs/:id/log, polling) or the live room's tool calls.
// The log's words follow the app's (tulmi/src/botsCodeWork/read.ts workLine).

"use strict";

const short = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t; };
const fileOf = (p) => String(p).split("/").filter(Boolean).slice(-3).join("/") || String(p);

/** One work-log entry ({ seq, kind, text, files?, data? }) as a line, or null for the ones left out (notes, decisions, questions). */
function logLine(e) {
  if (!e || typeof e !== "object") return null;
  const files = (Array.isArray(e.files) ? e.files : []).map(fileOf);
  const more = files.length > 1 ? ` and ${files.length - 1} more` : "";
  const data = e.data && typeof e.data === "object" ? e.data : {};
  switch (e.kind) {
    case "read": return `Read ${files[0] || short(e.text, 60)}${more}`;
    case "edit": {
      const verb = data.action === "create" ? "Made" : data.action === "delete" ? "Removed" : "Edited";
      return `${verb} ${files[0] || "a file"}${more}`;
    }
    case "command": {
      const kind = typeof data.kind === "string" ? data.kind : "";
      const what = kind === "test" ? "the tests" : kind === "build" ? "the build" : kind === "lint" ? "the linter" : kind === "typecheck" ? "the type check" : short(e.text, 50);
      const summary = typeof data.summary === "string" ? short(data.summary, 50) : typeof data.exitCode === "number" ? (data.exitCode === 0 ? "passed" : "failed") : "";
      return `Ran ${what}${summary ? ` · ${summary}` : ""}`;
    }
    case "step": return short(e.text, 90);
    case "finding": return `Found: ${short(e.text, 80)}`;
    default: return null;
  }
}

const TOOL_VERB = {
  read_file: "Read", edit_file: "Edited", write_file: "Wrote", delete_file: "Removed", list_dir: "Looked in",
  run: "Ran", grep: "Searched for", glob: "Looked for files", search_code: "Searched the code for", web_search: "Searched the web for",
  read_page: "Read", research: "Looked into", find_resources: "Looked for", flag_finding: "Flagged",
};

/** A live tool call ({ name, brief }) as a line, or null for the ones shown some other way (a question, the end, a note). */
function toolLine(ev) {
  if (!ev || ["ask_user", "done", "note"].includes(ev.name)) return null;
  const verb = TOOL_VERB[ev.name];
  const brief = short(ev.brief, 90);
  if (!verb) return brief || null;
  return brief ? `${verb} ${brief}` : verb;
}

module.exports = { logLine, toolLine };
