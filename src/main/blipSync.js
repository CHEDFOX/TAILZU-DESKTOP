/**
 * BLIP'S CATALOG, KEPT UP TO DATE: the server says which catalog of his moves and poses is current (the bootstrap's
 * "desktop.blip": { v, url }); when it is not the one kept here, this fetches it, checks that it compiles (the same
 * compiler every window uses, shared/blipCatalog.js), keeps it in the app's data (blip.json) for the next launch, and says
 * so (onChange), so main.js hands it to every window with the knobs. Nothing is fetched when the versions match.
 *
 * A catalog that does not compile, or answers with another v, is not kept: the one before it stays. The server may also
 * go DOWN a version (a pushed catalog taken back): any v that is not this one is fetched and used.
 */
const fs = require("fs");
const path = require("path");
const { compile } = require("../shared/blipCatalog.js");

const MAX_BYTES = 512 * 1024;

function createBlipSync(o) {
  const file = path.join(o.userData, "blip.json");
  let current = read();
  let fetching = null;

  function read() {
    try {
      const spec = JSON.parse(fs.readFileSync(file, "utf8"));
      compile(spec);
      return spec;
    } catch { return null; }
  }

  /** The catalog to hand the windows: the one fetched and kept, or null (they keep the copy they carry). */
  function catalog() { return current; }

  /** The bootstrap's flag: fetch the catalog it names when its v is not the one kept. Resolves true when it changed. */
  async function check(flag) {
    if (!flag || typeof flag !== "object" || !Number.isInteger(flag.v) || typeof flag.url !== "string") return false;
    if (current && current.v === flag.v) return false;
    if (!/^\/v1\/blip(\?[A-Za-z0-9=&.]*)?$/.test(flag.url)) return false;
    if (fetching) return fetching;
    fetching = (async () => {
      try {
        const res = await o.fetch(o.baseUrl().replace(/\/+$/, "") + flag.url);
        if (!res || !res.ok) return false;
        const text = await res.text();
        if (text.length > MAX_BYTES) return false;
        const spec = JSON.parse(text);
        if (!spec || spec.v !== flag.v) return false;
        compile(spec);
        try { fs.writeFileSync(file + ".tmp", JSON.stringify(spec)); fs.renameSync(file + ".tmp", file); } catch { /* kept for this run only */ }
        current = spec;
        try { o.onChange(spec); } catch { /* a window that is gone */ }
        return true;
      } catch (e) {
        if (o.log) o.log("blip: the catalog could not be used: " + ((e && e.message) || e));
        return false;
      } finally {
        fetching = null;
      }
    })();
    return fetching;
  }

  return { catalog, check };
}

module.exports = { createBlipSync };
