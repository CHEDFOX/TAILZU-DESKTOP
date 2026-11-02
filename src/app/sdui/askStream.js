// An answer as it is written (shared/types/sdui.ts 3f; the phone's askStream.ts)
//
// A call with `stream: "reply"` writes `{ id, text, step }` at `reply` and sends the id as `streamId`; while it is out, the live
// socket (live.js) hands each `ask:<id>` event here. The words are appended to `reply.text` and the line bound to it is changed
// in place (its data-tb), with no repaint: only when something appears or goes (the first words, the first step, a reset) is the
// page painted again, holding the field being typed in where it was. Pieces are numbered; one missing stops the appending (the
// answer, whole, comes with the call).

const ASK_TAPS = new Map();

function askStreamId() {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 22; i++) id += a[Math.floor(Math.random() * a.length) % a.length];
  return id;
}

function askStreamListen(id, path) {
  let next = 0, broken = false, done = false;
  const take = (raw) => {
    if (broken || done || !raw || typeof raw !== "object") return;
    const n = typeof raw.n === "number" ? raw.n : -1;
    if (n < next) return;
    if (n > next) { broken = true; return; }
    next++;
    const was = stateAt(path) || {};
    const before = { text: String(was.text || ""), step: String(was.step || "") };
    let text = before.text, step = before.step;
    if (raw.reset === true) text = "";
    if (typeof raw.text === "string" && raw.text) text += raw.text;
    if (typeof raw.step === "string" && raw.step) step = raw.step.slice(0, 80);
    if (raw.end === true) done = true;
    setStatePath(path + ".text", text);
    setStatePath(path + ".step", step);
    if (!!text !== !!before.text || !!step !== !!before.step) {
      const live = window.TailzuLive, held = live && live.holdView ? live.holdView(document) : null;
      repaint();
      if (held) live.restoreView(document, held);
      return;
    }
    const view = document.getElementById("view");
    if (!view) return;
    if (text !== before.text) view.querySelectorAll('[data-tb="' + path + '.text"]').forEach((el) => { el.textContent = text; });
    if (step !== before.step) view.querySelectorAll('[data-tb="' + path + '.step"]').forEach((el) => { el.textContent = step; });
  };
  ASK_TAPS.set(id, take);
  return () => { if (ASK_TAPS.get(id) === take) ASK_TAPS.delete(id); };
}

/** A live event of a stream (live.js): to the call listening for it, if one is. */
function askStreamTake(id, data) {
  const fn = ASK_TAPS.get(String(id));
  if (fn) { try { fn(data); } catch (e) { console.warn("[Tailzu][stream] a piece failed:", e); } }
}
