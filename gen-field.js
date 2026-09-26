/**
 * Regenerate neuralField.html from the app's page source.
 *
 * ONE DRAWING, TWO SURFACES. The field is ~400 lines of canvas that the phones
 * build at runtime from `neuralFieldHtml(cfg)` and hand to a WebView. This
 * window has no bundler and no WebView — it loads a file in an iframe — so it
 * needs the same page written to disk.
 *
 * It was written to disk ONCE, by hand, which is a copy: the two drift the
 * moment anybody touches the phone's version, and nothing anywhere says they
 * have. This makes the copy reproducible instead. `npm run field` after a
 * change to app/src/sdui/neuralFieldPage.ts, and the window gets the same
 * drawing the phones do.
 *
 * The cfg baked in here is only the GEOMETRY — regions, colours, bloom, focal
 * length — and it is only the FALLBACK: the window passes whatever the node's
 * props say as a `cfg` query parameter, which the page lays over it (see
 * RUNTIME_CFG below). `alpha` and `growth` are read from their own parameters,
 * because they are per screen and per person and retune the field in place.
 */
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "app", "src", "sdui", "neuralFieldPage.ts");
const OUT = path.join(__dirname, "neuralField.html");

// Geometry only. Kept in step with NEURAL_FIELD in the backend's catalog, which
// is what the phones are sent; a retune there is a copy to here and one run of
// this script. alpha and growth are deliberately absent — see the header.
const CFG = {
  bloom: 0.44,
  focal: 0.35,
  maxPulses: 700,
  signal: [232, 162, 60],
  head: [255, 241, 214],
  regions: [
    { x: 0.55, y: 0.42, hue: 335, n: 6, z: 0.40, sc: 1.00 },
    { x: 0.02, y: 0.14, hue: 196, n: 5, z: -0.35, sc: 0.78 },
    { x: 1.04, y: 0.22, hue: 40, n: 5, z: 0.65, sc: 0.74 },
    { x: 0.10, y: 0.86, hue: 262, n: 6, z: 0.10, sc: 0.80 },
    { x: 0.98, y: 0.80, hue: 152, n: 5, z: -0.55, sc: 0.76 },
    { x: 0.55, y: 1.16, hue: 58, n: 4, z: 0.30, sc: 0.62 },
    { x: 0.60, y: -0.16, hue: 300, n: 4, z: -0.75, sc: 0.62 },
  ],
};

// The source is one exported function whose body is a single template literal.
// Taking the literal out beats importing it: this is a .ts file in an app with
// its own toolchain, and adding a TypeScript step to a folder that has none —
// to read one string — is a build system nobody asked for.
const ts = fs.readFileSync(SRC, "utf8");
const open = ts.indexOf("return `");
const close = ts.lastIndexOf("`;");
if (open === -1 || close <= open) {
  console.error("gen-field: could not find the page template in " + SRC);
  console.error("If neuralFieldPage.ts no longer returns one template literal, update this script.");
  process.exit(1);
}
const template = ts.slice(open + "return `".length, close);

// The only interpolation in the template is the cfg. Anything else means the
// page grew a second one and this script would silently write "${...}" into an
// HTML file, so it stops instead.
const holes = template.match(/\$\{[^}]*\}/g) || [];
const unexpected = holes.filter((h) => !/cfg/.test(h));
if (unexpected.length) {
  console.error("gen-field: unexpected interpolation in the page template: " + unexpected.join(", "));
  process.exit(1);
}

// THE REST OF THE CONFIG, AT RUNTIME TOO. The phones bake every prop the
// server sends into the page; this file is baked once, so the window passes
// the node's other props (regions, colours, bloom, focal, maxPulses…) as one
// JSON `cfg` query parameter, and this snippet lays them over the baked CFG
// before anything reads it. Absent — the phones, or a node that sends none —
// and the baked geometry stands exactly as generated. Injected here rather
// than in neuralFieldPage.ts because only this surface loads the page from a
// file.
const RUNTIME_CFG =
  "\n/* DESKTOP: the node's props at runtime (sdui.js passes them as ?cfg=JSON);\n" +
  "   the baked values above are the fallback. Injected by desktop/gen-field.js. */\n" +
  "try{var QC=new URLSearchParams(location.search).get(\"cfg\");\n" +
  "  if(QC){var RC=JSON.parse(QC),kc,vc;\n" +
  "    for(kc in RC){if(!Object.prototype.hasOwnProperty.call(RC,kc))continue;vc=RC[kc];\n" +
  "      if(vc==null)continue;\n" +
  "      if(kc===\"regions\"&&!(Array.isArray(vc)&&vc.length))continue;\n" +
  "      if(typeof vc===\"string\"&&vc.trim()!==\"\"&&!isNaN(vc))vc=Number(vc);\n" +
  "      CFG[kc]=vc}}\n" +
  "}catch(e){}";

let html = template.replace(/\$\{JSON\.stringify\(cfg\)\}/g, JSON.stringify(CFG))
  // Escapes that only exist because the source is a template literal.
  .replace(/\\`/g, "`")
  .replace(/\\\$/g, "$");

const cfgLine = /^var CFG = .*;$/m;
if (!cfgLine.test(html)) {
  console.error("gen-field: could not find the `var CFG = …;` line to follow with the runtime config.");
  process.exit(1);
}
html = html.replace(cfgLine, (line) => line + RUNTIME_CFG);

fs.writeFileSync(OUT, html);
console.log("gen-field: wrote " + path.relative(process.cwd(), OUT) + " (" + html.length + " bytes)");
