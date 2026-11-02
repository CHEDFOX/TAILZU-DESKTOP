// Charts drawn as markup: the word meter, the pie and the bars.

function wordMeter(p) {
  const base = +p.base || 0, earned = +p.earned || 0;
  const total = Math.max(1, base + earned);
  const used = Math.max(0, Math.min(total, +p.used || 0));
  const left = total - used;
  const tick = earned > 0 ? (base / total) * 100 : -1;
  const fill = esc(p.fillColor || "var(--accent)");
  const big = K.num("desktop.meter.bigSize", 28), small = K.num("desktop.meter.smallSize", 13);
  const tiny = K.num("desktop.meter.tinySize", 12), bar = K.num("desktop.meter.barHeight", 10);
  return '<div><div style="display:flex;justify-content:space-between;align-items:baseline">' +
    '<span style="color:var(--text);font-size:' + big + 'px;font-weight:700;letter-spacing:-.5px">' + left.toLocaleString() + "</span>" +
    '<span style="color:var(--label);font-size:' + small + 'px">' +
    esc(K.txt("desktop.meter.used", "{used} of {total} used", { used: used.toLocaleString(), total: total.toLocaleString() })) +
    "</span></div>" +
    '<div style="color:var(--label);font-size:' + small + 'px;margin-top:2px">' + esc(K.txt("desktop.meter.left", "words left")) + "</div>" +
    '<div style="height:' + bar + "px;border-radius:" + (bar / 2) +
    'px;background:var(--border);margin-top:12px;position:relative;overflow:hidden">' +
    '<div style="width:' + (used / total) * 100 + "%;height:100%;background:" + fill + '"></div>' +
    (tick >= 0 ? '<div style="position:absolute;top:0;bottom:0;left:' + tick + '%;width:2px;background:var(--bg)"></div>' : "") +
    '</div><div style="display:flex;gap:14px;margin-top:10px">' +
    '<span style="color:var(--label);font-size:' + tiny + 'px">' +
    esc(K.txt("desktop.meter.free", "{n} free", { n: base.toLocaleString() })) + "</span>" +
    (earned > 0 ? '<span style="color:' + esc(p.earnedColor || "var(--accent)") + ";font-size:" + tiny + 'px;font-weight:600">' +
      esc(K.txt("desktop.meter.earned", "+{n} earned", { n: earned.toLocaleString() })) + "</span>" : "") + "</div>" +
    (p.caption ? '<div style="color:var(--label);font-size:' + small + 'px;margin-top:12px">' + esc(p.caption) + "</div>" : "") + "</div>";
}

function pie(p) {
  const data = (p.data || []).filter((d) => (+d.value || 0) > 0);
  const total = data.reduce((n, d) => n + (+d.value || 0), 0);
  const size = p.size || K.num("desktop.pie.size", 150), r = size / 2;
  const inner = p.donut === false ? 0 : r - r * K.num("desktop.pie.ring", 0.26);
  const fallback = K.color("desktop.chart.color", "#E8A23C");
  const legendSize = K.num("desktop.pie.legendSize", 12.5);
  if (!total) return "";
  let a = -Math.PI / 2, paths = "";
  data.forEach((d) => {
    const frac = (+d.value) / total, a1 = a + frac * Math.PI * 2;
    const big = a1 - a > Math.PI ? 1 : 0;
    const x0 = r + r * Math.cos(a), y0 = r + r * Math.sin(a);
    const x1 = r + r * Math.cos(a1), y1 = r + r * Math.sin(a1);
    const ix1 = r + inner * Math.cos(a1), iy1 = r + inner * Math.sin(a1);
    const ix0 = r + inner * Math.cos(a), iy0 = r + inner * Math.sin(a);
    // One slice covering the whole circle cannot be drawn as a single arc:
    // start and end coincide and the path collapses. Draw a ring instead.
    paths += data.length === 1
      ? '<circle cx="' + r + '" cy="' + r + '" r="' + (r + inner) / 2 + '" fill="none" stroke="' +
        esc(d.color || fallback) + '" stroke-width="' + (r - inner) + '"/>'
      : '<path d="M ' + x0 + " " + y0 + " A " + r + " " + r + " 0 " + big + " 1 " + x1 + " " + y1 +
        " L " + ix1 + " " + iy1 + " A " + inner + " " + inner + " 0 " + big + " 0 " + ix0 + " " + iy0 +
        ' Z" fill="' + esc(d.color || fallback) + '"/>';
    a = a1;
  });
  const legend = p.legend === false ? "" :
    '<div style="display:flex;flex-direction:column;gap:6px;flex:1;min-width:0">' + data.map((d) =>
      '<div style="display:flex;align-items:center;gap:8px;min-width:0">' +
      '<span style="width:8px;height:8px;border-radius:50%;flex:none;background:' + esc(d.color || fallback) + '"></span>' +
      '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:' + legendSize + 'px">' +
      esc(d.label || "") + "</span>" +
      '<span style="color:var(--label);font-size:' + legendSize + 'px">' + Math.round(((+d.value) / total) * 100) +
      "%</span></div>").join("") + "</div>";
  const centre = p.centerValue != null
    ? '<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">' +
      '<div style="color:var(--text);font-size:' + K.num("desktop.pie.centerSize", 19) + 'px;font-weight:700">' +
      esc(p.centerValue) + "</div>" +
      '<div style="color:var(--label);font-size:' + K.num("desktop.pie.centerLabelSize", 11) + 'px">' +
      esc(p.centerLabel || "") + "</div></div>"
    : "";
  return '<div style="display:flex;align-items:center;gap:18px"><div style="position:relative;flex:none;width:' +
    size + "px;height:" + size + 'px"><svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + " " + size + '">' +
    paths + "</svg>" + centre + "</div>" + legend + "</div>";
}

function bars(p) {
  const vals = (p.series || []).map((x) => (typeof x === "number" ? x : +x.value || 0));
  if (!vals.length) return "";
  const max = Math.max.apply(null, vals.concat([1]));
  const minPct = K.num("desktop.bars.minPct", 2);
  return '<div style="display:flex;align-items:flex-end;gap:' + K.num("desktop.bars.gap", 4) +
    "px;height:" + K.num("desktop.bars.height", 110) + 'px">' + vals.map((v) =>
    '<div style="flex:1;border-radius:' + K.num("desktop.bars.radius", 3) + "px;background:" +
    esc(p.color || K.color("desktop.chart.color", "#E8A23C")) +
    ';height:' + Math.max(minPct, (v / max) * 100) + '%"></div>').join("") + "</div>";
}
