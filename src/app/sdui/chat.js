/**
 * The Train tab's conversation (ChatThread).
 *
 * Every visual value is a prop with a default, so the server moves all of it
 * without a build — the same rule the phone component follows, and the reason
 * `colors` can arrive half-filled and still land.
 *
 * Rows, whatever the server appended:
 *   { role: "ask",      text }            what the app asked
 *   { role: "mine",     text }            what the user answered
 *   { role: "note",     text }            a centred aside ("Learned: dry")
 *   { role: "variants", options: [...] }  three readings to choose between
 */
/** The thread's defaults — under the node's own `colors`, over nothing. A
 *  knob as a whole, so the server can move any of them for every screen at
 *  once; the sizes ride along with the colours. */
function chatDefaults() {
  return K.obj("desktop.chat.style", {
    askBg: "rgba(255,255,255,0.06)", askBorder: "rgba(255,255,255,0.09)",
    askText: "rgba(255,255,255,0.9)", mineBg: "#FFFFFF", mineText: "#000000",
    noteText: "#F3E2C6", noteBg: "rgba(243,226,198,0.1)", noteBorder: "rgba(243,226,198,0.26)",
    variantBg: "rgba(255,255,255,0.05)", variantBorder: "rgba(255,255,255,0.1)",
    variantText: "rgba(255,255,255,0.92)", angleText: "rgba(255,255,255,0.4)",
    pickedBg: "rgba(243,226,198,0.13)", pickedBorder: "#F3E2C6",
    labelText: "rgba(255,255,255,0.38)", radius: 16, gap: 11,
    tail: 5, fontSize: 14.5, mineLineHeight: 21, askLineHeight: 22, noteSize: 11,
    optionRadius: 14, optionSize: 14, optionLineHeight: 21, labelSize: 10.5,
  });
}

/** Which option was taken in which row, for the screen currently painted.
 *  Keyed by row index: a thread only ever grows, so an index is stable. */
let CHAT_PICKED = {};

function chatThread(n, p, s) {
  const c = { ...chatDefaults(), ...(p.colors || {}) };
  const rows = (() => { const r = stateAt((n.bind && n.bind.thread) || ""); return Array.isArray(r) ? r : []; })();
  const pickLabel = label(p.pickLabel) || K.txt("desktop.chat.pickLabel", "Tap the one that sounds like you");

  const bubble = (r, i) => {
    if (r.role === "mine") {
      return '<div style="align-self:flex-end;max-width:82%;background:' + esc(tok(c.mineBg)) +
        ";padding:10px 14px;border-radius:" + c.radius + "px;border-bottom-right-radius:" + c.tail + "px" +
        ";font-size:" + c.fontSize + "px;line-height:" + c.mineLineHeight + "px;color:" + esc(tok(c.mineText)) + '">' +
        esc(r.text || "") + "</div>";
    }
    if (r.role === "note") {
      return '<div style="align-self:center;background:' + esc(tok(c.noteBg)) + ";border:1px solid " +
        esc(tok(c.noteBorder)) + ";border-radius:999px;padding:5px 11px;font-size:" + c.noteSize + "px;letter-spacing:.5px;color:" +
        esc(tok(c.noteText)) + '">' + esc(r.text || "") + "</div>";
    }
    if (r.role === "variants") {
      const options = Array.isArray(r.options) ? r.options.filter((o) => o && o.text) : [];
      if (!options.length) return "";
      const chose = CHAT_PICKED[i];
      const opts = options.map((o, j) => {
        const isPicked = chose === j;
        const dimmed = chose != null && !isPicked;
        return '<button class="tz-press" data-pick="' + i + ":" + j + '"' +
          (chose != null ? " disabled" : "") +
          ' style="display:block;width:100%;text-align:left;cursor:' + (chose != null ? "default" : "pointer") +
          ";background:" + esc(tok(isPicked ? c.pickedBg : c.variantBg)) +
          ";border:1px solid " + esc(tok(isPicked ? c.pickedBorder : c.variantBorder)) +
          ";border-radius:" + c.optionRadius + "px;padding:11px 13px;opacity:" + (dimmed ? ".3" : "1") + '">' +
          (o.angle
            ? '<div style="font-size:10px;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;color:' +
              esc(tok(isPicked ? c.pickedBorder : c.angleText)) + '">' + esc(o.angle) + "</div>"
            : "") +
          '<div style="font-size:' + c.optionSize + "px;line-height:" + c.optionLineHeight + "px;color:" + esc(tok(c.variantText)) + '">' +
          esc(o.text) + "</div></button>";
      }).join("");
      return '<div style="display:flex;flex-direction:column;gap:7px">' +
        '<div style="font-size:' + c.labelSize + "px;letter-spacing:1.4px;text-transform:uppercase;color:" +
        esc(tok(c.labelText)) + '">' + esc(r.label || pickLabel) + "</div>" + opts + "</div>";
    }
    // Anything else is something the app said.
    return '<div style="align-self:flex-start;max-width:88%;background:' + esc(tok(c.askBg)) +
      ";border:1px solid " + esc(tok(c.askBorder)) + ";padding:12px 14px;border-radius:" + c.radius +
      "px;border-bottom-left-radius:" + c.tail + "px;font-size:" + c.fontSize + "px;line-height:" + c.askLineHeight + "px;color:" +
      esc(tok(c.askText)) + '">' + esc(r.text || "") + "</div>";
  };

  return '<div data-chat="1" style="' + s + ";flex:1;min-height:0;overflow-y:auto;display:flex" +
    ";flex-direction:column;gap:" + c.gap + 'px;padding-bottom:10px">' +
    rows.map(bubble).join("") + "</div>";
}
