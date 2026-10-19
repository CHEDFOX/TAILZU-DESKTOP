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
  box.borderRadius = K.num("desktop.overlay.radius", 16) + "px";
  box.background = K.color("desktop.overlay.background", "#151210");
  box.color = K.color("desktop.overlay.text", "#F3E2C6");
  box.fontSize = K.num("desktop.overlay.fontSize", 15) + "px";
  box.fontWeight = String(K.num("desktop.overlay.fontWeight", 500));
  box.boxShadow = K.str("desktop.overlay.shadow", "inset 0 0 0 1px rgba(243, 226, 198, 0.12), 0 18px 40px -12px rgba(0, 0, 0, 0.5), 0 3px 10px rgba(0, 0, 0, 0.25)");
  const d = K.num("desktop.overlay.dotSize", 7) + "px";
  dot.width = d; dot.height = d;
  dot.background = K.color("desktop.overlay.dot", "#E8A23C");
  dot.animationDuration = K.num("desktop.overlay.pulseMs", 1400) / 1000 + "s";
  document.getElementById("label").textContent = K.txt("desktop.overlay.label", "Live");
  paint(last);
}

function paint(t) {
  last = t || "";
  document.getElementById("inner").textContent =
    last.trim() ? last : K.txt("desktop.overlay.listening", "listening…");
  // Before the first word, the waiting line is set as the guide sets what
  // it heard: in the serif, softer.
  const box = document.getElementById("text");
  box.classList.toggle("idle", !last.trim());
  // Only a line that has outgrown the strip fades at its start.
  box.classList.toggle("long", box.scrollWidth > box.clientWidth + 1);
}

window.tailzu.onOverlayText(paint);
window.tailzu.onKnobs((k) => { K.setKnobs(k); style(); });
window.tailzu.knobs().then((k) => { K.setKnobs(k); style(); }).catch(() => {});
