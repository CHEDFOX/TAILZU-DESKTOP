// One `Input` node with a `kind` (SPEC 2.8, B8). The value is sanitized, capped and written to the path the node
// names — never evaluated, whatever it holds.
//
// The kinds, the caps and the stored shapes are the phone's (components/input/inputCore.ts), so a field filled in
// the window and the same field filled on a phone put the same value in the same place.

const V2_INPUT_KINDS = [
  "text", "multiline", "number", "code", "search", "switch", "toggle", "slider", "segmented", "slideToConfirm",
  "stepper", "picker", "date", "time", "rating", "chips",
];
const V2_INPUT_LIMITS = { textMax: 8192, lineMax: 512, searchMax: 128, codeMax: 12, chipsMax: 32, chipMax: 64, optionsMax: 64, ratingMax: 10 };
/** Control characters and the bidirectional overrides, which can make a value read as the reverse of what is stored. */
// eslint-disable-next-line no-control-regex
const V2_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩﻿]/g;

let V2_INPUTS = new Map();

function v2Line(raw, max) {
  const cap = Math.max(0, Math.min(V2_INPUT_LIMITS.textMax, Math.floor(max) || 0));
  return String(raw == null ? "" : raw).replace(/[\r\n\t]+/g, " ").replace(V2_CONTROL, "").slice(0, cap);
}
function v2Text(raw, max) {
  const cap = Math.max(0, Math.min(V2_INPUT_LIMITS.textMax, Math.floor(max) || 0));
  return String(raw == null ? "" : raw).replace(/\r\n?/g, "\n").replace(V2_CONTROL, "").slice(0, cap);
}
function v2Code(raw, length, digitsOnly) {
  const cap = Math.max(1, Math.min(V2_INPUT_LIMITS.codeMax, Math.floor(length) || 1));
  return String(raw == null ? "" : raw).replace(digitsOnly ? /[^0-9]/g : /[^0-9a-z]/gi, "").toUpperCase().slice(0, cap);
}
function v2Range(n, min, max) {
  let v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) v = 0;
  if (Number.isFinite(min) && v < min) v = min;
  if (Number.isFinite(max) && v > max) v = max;
  return v;
}
function v2Step(value, min, max, step) {
  const lo = Number.isFinite(min) ? min : 0;
  const hi = Number.isFinite(max) && max > lo ? max : lo + 1;
  const v = v2Range(value, lo, hi);
  const s = Number.isFinite(step) && step > 0 ? step : 0;
  const out = s ? lo + Math.round((v - lo) / s) * s : v;
  return Math.round(v2Range(out, lo, hi) * 1e6) / 1e6;
}
/** A number as it is typed: digits, one point, one leading minus. The text stays, the value is null until it is one. */
function v2Number(raw, shape) {
  const o = shape || {};
  const decimals = Number.isFinite(o.decimals) ? Math.max(0, Math.min(6, Math.floor(o.decimals))) : 2;
  const negative = o.negative === true || (Number.isFinite(o.min) && o.min < 0);
  let s = String(raw == null ? "" : raw).replace(/[^0-9.\-]/g, "");
  const neg = negative && s.indexOf("-") === 0;
  s = s.replace(/-/g, "");
  if (decimals === 0) s = s.replace(/\./g, "");
  const dot = s.indexOf(".");
  if (dot >= 0) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, "").slice(0, decimals);
  s = (neg ? "-" : "") + s;
  if (s === "" || s === "-" || s === "." || s === "-.") return { text: s, value: null };
  const n = Number(s);
  return Number.isFinite(n) ? { text: s, value: v2Range(n, o.min, o.max) } : { text: s, value: null };
}
/** The choices a picker or a segmented control offers, as { value, label } pairs, each label one line. */
function v2Options(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [], seen = new Set();
  for (const o of raw.slice(0, V2_INPUT_LIMITS.optionsMax)) {
    let value = "", text = "";
    if (typeof o === "string" || typeof o === "number") { value = v2Line(o, V2_INPUT_LIMITS.chipMax); text = value; }
    else if (o && typeof o === "object") {
      value = v2Line(o.value != null ? o.value : o.id, V2_INPUT_LIMITS.chipMax);
      text = v2Line(o.label != null ? o.label : o.title != null ? o.title : value, V2_INPUT_LIMITS.chipMax);
    }
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push({ value, label: text || value });
  }
  return out;
}

/** Where this field writes: its `bind.value` path, else `into`. */
function v2InputPath(n, p) {
  if (n.bind && typeof n.bind.value === "string" && n.bind.value) return n.bind.value;
  return typeof p.into === "string" && p.into ? p.into : "";
}

/** The `Input` node's markup. The wiring below gives it its behaviour. */
function v2InputNode(n, p, s) {
  const kind = typeof p.kind === "string" && V2_INPUT_KINDS.indexOf(p.kind) !== -1 ? p.kind : null;
  if (!kind) return n.fallback ? node(n.fallback) : "";
  const id = "v2i" + V2_INPUTS.size;
  const path = v2InputPath(n, p);
  const value = path ? stateAt(path) : p.value;
  V2_INPUTS.set(id, { id, node: n, props: p, kind, path });
  const lab = p.label != null ? '<span style="display:block;color:var(--label);font-size:12px;margin-bottom:6px">' + esc(label(p.label)) + "</span>" : "";
  const off = p.disabled === true ? " disabled" : "";
  const box = "background:var(--input);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:10px 12px;width:100%;box-sizing:border-box";
  const head = '<label data-v2-in="' + id + '" data-kind="' + kind + '" style="' + s + ';display:block">' + lab;
  const place = p.placeholder != null ? ' placeholder="' + esc(label(p.placeholder)) + '"' : "";
  switch (kind) {
    case "multiline":
      return head + '<textarea data-v2-f rows="' + Math.max(2, Math.min(20, Number(p.rows) || 4)) + '"' + place + off +
        ' style="' + box + ';resize:vertical">' + esc(v2Text(value, Number(p.maxLength) || V2_INPUT_LIMITS.textMax)) + "</textarea></label>";
    case "switch": case "toggle":
      return head + '<button data-v2-f type="button" role="switch" aria-checked="' + (truthy(value) ? "true" : "false") + '"' + off +
        ' style="width:46px;height:26px;border-radius:999px;border:1px solid var(--border);cursor:pointer;background:' +
        (truthy(value) ? "var(--accent)" : "var(--input)") + '"><span style="display:block;width:20px;height:20px;border-radius:50%;background:var(--bg);margin-left:' +
        (truthy(value) ? "22px" : "2px") + '"></span></button></label>';
    case "slider": {
      const min = Number.isFinite(Number(p.min)) ? Number(p.min) : 0;
      const max = Number.isFinite(Number(p.max)) ? Number(p.max) : 1;
      const step = Number(p.step) > 0 ? Number(p.step) : (max - min) / 100;
      return head + '<input data-v2-f type="range" min="' + min + '" max="' + max + '" step="' + step +
        '" value="' + v2Step(value, min, max, Number(p.step) || 0) + '"' + off + ' style="width:100%">' + "</label>";
    }
    case "segmented": {
      const opts = v2Options(p.options);
      const now = v2Line(value, V2_INPUT_LIMITS.chipMax);
      return head + '<span style="display:inline-flex;gap:4px;border:1px solid var(--border);border-radius:10px;padding:3px">' +
        opts.map((o) => '<button data-v2-f type="button" data-value="' + esc(o.value) + '"' + off +
          ' aria-pressed="' + (o.value === now ? "true" : "false") + '" style="border:0;border-radius:8px;padding:6px 12px;cursor:pointer;background:' +
          (o.value === now ? "var(--accent)" : "transparent") + ";color:" + (o.value === now ? "var(--bg)" : "var(--body)") + '">' +
          esc(o.label) + "</button>").join("") + "</span></label>";
    }
    case "picker": {
      const opts = v2Options(p.options);
      const now = v2Line(value, V2_INPUT_LIMITS.chipMax);
      return head + '<select data-v2-f' + off + ' style="' + box + '">' +
        opts.map((o) => '<option value="' + esc(o.value) + '"' + (o.value === now ? " selected" : "") + ">" + esc(o.label) + "</option>").join("") +
        "</select></label>";
    }
    case "chips": {
      const list = Array.isArray(value) ? value.slice(0, V2_INPUT_LIMITS.chipsMax) : [];
      return head + '<span style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">' +
        list.map((c, i) => '<button data-v2-chip="' + i + '" type="button" style="border:1px solid var(--border);border-radius:999px;padding:4px 10px;background:var(--input);color:var(--body);cursor:pointer">' +
          esc(v2Line(c, V2_INPUT_LIMITS.chipMax)) + " ×</button>").join("") +
        '<input data-v2-f type="text"' + place + off + ' style="' + box + ';width:auto;flex:1;min-width:90px"></span></label>';
    }
    case "date": case "time":
      return head + '<input data-v2-f type="' + kind + '" value="' + esc(v2Line(value, 16)) + '"' + off +
        (kind === "time" && Number(p.minuteStep) > 0 ? ' step="' + Math.max(60, Math.min(1800, Math.floor(Number(p.minuteStep)) * 60)) + '"' : "") +
        ' style="' + box + '"></label>';
    case "rating": {
      const stars = Math.max(1, Math.min(V2_INPUT_LIMITS.ratingMax, Math.floor(Number(p.stars) || 5)));
      const now = Math.round(v2Range(value, 0, stars));
      let out = "";
      for (let i = 1; i <= stars; i++) {
        out += '<button data-v2-f type="button" data-value="' + i + '"' + off + ' aria-pressed="' + (i <= now ? "true" : "false") +
          '" style="border:0;background:none;cursor:pointer;font-size:18px;color:' + (i <= now ? "var(--accent)" : "var(--border)") + '">★</button>';
      }
      return head + '<span style="display:inline-flex;gap:2px">' + out + "</span></label>";
    }
    case "stepper": {
      const min = Number.isFinite(Number(p.min)) ? Number(p.min) : 0;
      const max = Number.isFinite(Number(p.max)) ? Number(p.max) : 100;
      const now = v2Step(value, min, max, Number(p.step) || 1);
      const b = "border:1px solid var(--border);background:var(--input);color:var(--text);border-radius:8px;width:30px;height:30px;cursor:pointer";
      return head + '<span style="display:inline-flex;gap:8px;align-items:center"><button data-v2-f type="button" data-step="-1" style="' + b + '">−</button>' +
        '<span style="min-width:2em;text-align:center">' + esc(String(now)) + "</span>" +
        '<button data-v2-f type="button" data-step="1" style="' + b + '">+</button></span></label>';
    }
    case "slideToConfirm":
      return head + '<span data-v2-slide style="display:block;position:relative;height:46px;border-radius:999px;background:var(--input);border:1px solid var(--border);overflow:hidden">' +
        '<span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--label);pointer-events:none">' +
        esc(label(p.placeholder) || K.txt("desktop.input.slide", "Slide to confirm")) + "</span>" +
        '<span data-v2-f style="position:absolute;top:3px;left:3px;width:40px;height:38px;border-radius:999px;background:var(--accent);cursor:grab"></span></span></label>';
    case "code":
      return head + '<input data-v2-f type="text" inputmode="' + (p.digitsOnly === true ? "numeric" : "text") +
        '" maxlength="' + Math.max(1, Math.min(V2_INPUT_LIMITS.codeMax, Math.floor(Number(p.length) || 6))) + '"' + place + off +
        ' value="' + esc(v2Code(value, Number(p.length) || 6, p.digitsOnly === true)) + '" style="' + box + ';letter-spacing:.4em;text-transform:uppercase"></label>';
    case "number":
      return head + '<input data-v2-f type="text" inputmode="decimal"' + place + off +
        ' value="' + esc(v2Number(value, p).text) + '" style="' + box + '"></label>';
    default:
      return head + '<input data-v2-f type="' + (kind === "search" ? "search" : "text") + '"' + place + off +
        (Number(p.maxLength) > 0 ? ' maxlength="' + Math.floor(Number(p.maxLength)) + '"' : "") +
        ' value="' + esc(v2Line(value, Number(p.maxLength) || (kind === "search" ? V2_INPUT_LIMITS.searchMax : V2_INPUT_LIMITS.lineMax))) +
        '" style="' + box + '"></label>';
  }
}

/** Write a value and tell the screen. `redraw` is for the kinds whose own markup shows the value. */
function v2InputWrite(st, value, redraw) {
  if (st.path) setStatePath(st.path, value);
  const on = st.node.on || {};
  if (on.onChange) void run(on.onChange, value);
  if (redraw && typeof repaint === "function") repaint();
}

/** Every field the paint drew. */
function v2InputsWire(root) {
  root.querySelectorAll("[data-v2-in]").forEach((host) => {
    const st = V2_INPUTS.get(host.getAttribute("data-v2-in"));
    if (!st || host.getAttribute("data-v2-wired") === "1") return;
    host.setAttribute("data-v2-wired", "1");
    const p = st.props;
    const on = st.node.on || {};
    const fields = host.querySelectorAll("[data-v2-f]");
    const field = fields[0];
    if (!field) return;
    const submit = (v) => { if (on.onSubmit) void run(on.onSubmit, v); };
    switch (st.kind) {
      case "text": case "search": case "multiline": {
        const cap = Number(p.maxLength) > 0 ? Number(p.maxLength)
          : st.kind === "search" ? V2_INPUT_LIMITS.searchMax : st.kind === "multiline" ? V2_INPUT_LIMITS.textMax : V2_INPUT_LIMITS.lineMax;
        field.addEventListener("input", () => {
          const v = st.kind === "multiline" ? v2Text(field.value, cap) : v2Line(field.value, cap);
          if (v !== field.value) field.value = v;
          v2InputWrite(st, v, false);
        });
        field.addEventListener("keydown", (e) => { if (e.key === "Enter" && st.kind !== "multiline") { e.preventDefault(); submit(v2Line(field.value, cap)); } });
        break;
      }
      case "code": {
        const len = Math.floor(Number(p.length) || 6);
        field.addEventListener("input", () => {
          const v = v2Code(field.value, len, p.digitsOnly === true);
          if (v !== field.value) field.value = v;
          v2InputWrite(st, v, false);
          if (v.length >= Math.min(V2_INPUT_LIMITS.codeMax, len)) submit(v);
        });
        break;
      }
      case "number": {
        field.addEventListener("input", () => {
          const got = v2Number(field.value, p);
          if (got.text !== field.value) field.value = got.text;
          v2InputWrite(st, got.value, false);
        });
        field.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(v2Number(field.value, p).value); } });
        break;
      }
      case "switch": case "toggle":
        field.addEventListener("click", () => { v2InputWrite(st, !truthy(st.path ? stateAt(st.path) : p.value), true); });
        break;
      case "slider": {
        const min = Number.isFinite(Number(p.min)) ? Number(p.min) : 0;
        const max = Number.isFinite(Number(p.max)) ? Number(p.max) : 1;
        const step = Number(p.step) > 0 ? Number(p.step) : 0;
        let last = 0;
        field.addEventListener("input", () => {
          const v = v2Step(field.value, min, max, step);
          // Live: at most ten writes a second while the finger moves. Off: the value lands when it is let go.
          if (p.live !== true) return;
          const now = Date.now();
          if (now - last < 100) return;
          last = now;
          v2InputWrite(st, v, false);
        });
        field.addEventListener("change", () => { const v = v2Step(field.value, min, max, step); v2InputWrite(st, v, false); submit(v); });
        break;
      }
      case "segmented": case "rating":
        fields.forEach((b) => b.addEventListener("click", () => {
          const raw = b.getAttribute("data-value");
          v2InputWrite(st, st.kind === "rating" ? Number(raw) : raw, true);
        }));
        break;
      case "picker":
        field.addEventListener("change", () => { v2InputWrite(st, v2Line(field.value, V2_INPUT_LIMITS.chipMax), false); });
        break;
      case "stepper":
        fields.forEach((b) => b.addEventListener("click", () => {
          const dir = Number(b.getAttribute("data-step")) < 0 ? -1 : 1;
          const min = Number.isFinite(Number(p.min)) ? Number(p.min) : 0;
          const max = Number.isFinite(Number(p.max)) ? Number(p.max) : 100;
          const step = Number(p.step) > 0 ? Number(p.step) : 1;
          v2InputWrite(st, v2Step(v2Range(st.path ? stateAt(st.path) : 0, min, max) + dir * step, min, max, step), true);
        }));
        break;
      case "date": case "time":
        field.addEventListener("change", () => { const v = v2Line(field.value, 16); v2InputWrite(st, v, false); submit(v); });
        break;
      case "chips": {
        const held = () => (Array.isArray(st.path ? stateAt(st.path) : null) ? stateAt(st.path).slice() : []);
        field.addEventListener("keydown", (e) => {
          if (e.key !== "Enter" || !field.value) return;
          e.preventDefault();
          const list = held();
          if (list.length >= Math.min(V2_INPUT_LIMITS.chipsMax, Number(p.max) > 0 ? Number(p.max) : V2_INPUT_LIMITS.chipsMax)) return;
          list.push(v2Line(field.value, V2_INPUT_LIMITS.chipMax));
          field.value = "";
          v2InputWrite(st, list, true);
        });
        host.querySelectorAll("[data-v2-chip]").forEach((b) => b.addEventListener("click", () => {
          const list = held();
          list.splice(Number(b.getAttribute("data-v2-chip")), 1);
          v2InputWrite(st, list, true);
        }));
        break;
      }
      case "slideToConfirm": {
        const track = host.querySelector("[data-v2-slide]");
        const want = Number(p.threshold) >= 0.5 && Number(p.threshold) <= 1 ? Number(p.threshold) : 0.9;
        let from = null;
        const width = () => Math.max(1, (track && track.clientWidth ? track.clientWidth : 240) - 46);
        field.addEventListener("pointerdown", (e) => { from = (e.clientX || 0) - parseFloat(field.style.left || "3"); });
        const move = (e) => {
          if (from === null) return;
          const x = Math.max(3, Math.min(width(), (e.clientX || 0) - from));
          field.style.left = x + "px";
        };
        const up = () => {
          if (from === null) return;
          from = null;
          const at = (parseFloat(field.style.left || "3") - 3) / width();
          if (at >= want) { v2InputWrite(st, true, false); if (on.onCommit) void run(on.onCommit, true); else submit(true); }
          else { field.style.left = "3px"; if (on.onDismiss) void run(on.onDismiss, false); }
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        break;
      }
      default:
        break;
    }
    if (p.autoFocus === true && typeof field.focus === "function") { try { field.focus(); } catch { /* not focusable */ } }
  });
}

/** A new paint starts from no fields. */
function v2InputsPaintStart() { V2_INPUTS = new Map(); }
