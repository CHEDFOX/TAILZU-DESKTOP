// overlay.html's script: the live-caption strip (used when the pill is off).
const K = window.TailzuKnobs;
let last = "";

/** The strip as the server draws it. Re-run whenever the knobs move. */
function style() {
  const box = document.getElementById("box").style;
  const dot = document.getElementById("dot").style;
  box.margin = K.num("desktop.overlay.margin", 8) + "px";
  box.padding = K.num("desktop.overlay.paddingV", 12) + "px " + K.num("desktop.overlay.paddingH", 18) + "px";
  box.minHeight = K.num("desktop.overlay.minHeight", 44) + "px";
  box.maxHeight = K.num("desktop.overlay.maxHeight", 64) + "px";
  box.borderRadius = K.num("desktop.overlay.radius", 14) + "px";
  box.background = K.color("desktop.overlay.background", "rgba(12, 12, 16, 0.88)");
  box.color = K.color("desktop.overlay.text", "#f5f0e8");
  box.fontSize = K.num("desktop.overlay.fontSize", 15) + "px";
  box.fontWeight = String(K.num("desktop.overlay.fontWeight", 500));
  box.boxShadow = K.str("desktop.overlay.shadow", "0 6px 24px rgba(0, 0, 0, 0.35)");
  const d = K.num("desktop.overlay.dotSize", 9) + "px";
  dot.width = d; dot.height = d;
  dot.background = K.color("desktop.overlay.dot", "#e8a23c");
  dot.animationDuration = K.num("desktop.overlay.pulseMs", 1200) / 1000 + "s";
  paint(last);
}

function paint(t) {
  last = t || "";
  document.getElementById("inner").textContent =
    last.trim() ? last : K.txt("desktop.overlay.listening", "listening…");
}

window.tailzu.onOverlayText(paint);
window.tailzu.onKnobs((k) => { K.setKnobs(k); style(); });
window.tailzu.knobs().then((k) => { K.setKnobs(k); style(); }).catch(() => {});
