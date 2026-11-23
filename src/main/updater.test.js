// node --test
//
// In-place updates (updater.js): never backwards. A build whose version is not greater than the running one is refused before
// anything is downloaded, whatever the server or the window names.

const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

// updater.js is the main process's: Electron is faked for it, as a packaged build on Linux running from an AppImage.
const fake = { app: { isPackaged: true, getVersion: () => "0.5.2", getPath: () => require("node:os").tmpdir() }, net: { request() { throw new Error("no network in tests"); } } };
const load = Module._load;
Module._load = function (req, ...rest) { return req === "electron" ? fake : load.call(this, req, ...rest); };
const { update, newerThan } = require("./updater.js");
Module._load = load;

test("newerThan compares dotted numbers, and only strictly greater is newer", () => {
  assert.strictEqual(newerThan("0.5.3", "0.5.2"), true);
  assert.strictEqual(newerThan("0.10.0", "0.9.9"), true);
  assert.strictEqual(newerThan("1.0.0", "0.99.999"), true);
  assert.strictEqual(newerThan("0.5.2", "0.5.2"), false, "the same build is not an update");
  assert.strictEqual(newerThan("0.5.1", "0.5.2"), false, "an older build is a downgrade");
  assert.strictEqual(newerThan("0.4.99", "0.5.0"), false);
  assert.strictEqual(newerThan("", "0.5.2"), false);
});

test("an update to the same or an older version is refused before anything is fetched", async () => {
  const prev = { platform: process.platform, appimage: process.env.APPIMAGE };
  Object.defineProperty(process, "platform", { value: "linux" });
  const fs = require("node:fs");
  const dir = fs.mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "tzupdate-"));
  process.env.APPIMAGE = require("node:path").join(dir, "Tailzu.AppImage");
  fs.writeFileSync(process.env.APPIMAGE, "");
  try {
    const sent = [];
    for (const version of ["0.5.2", "0.5.1", "0.1.0"]) {
      const r = await update({ url: "https://x0bot.com/downloads/Tailzu.AppImage", version, sha512: "a".repeat(128) }, (p) => sent.push(p));
      assert.deepStrictEqual(r, { ok: false, reason: "current" }, version);
    }
    assert.deepStrictEqual(sent, [], "nothing was downloaded");
    // A newer one gets past the version check (and fails later, here, for want of a network).
    const newer = await update({ url: "https://x0bot.com/downloads/Tailzu.AppImage", version: "0.5.3", sha512: "a".repeat(128) }, (p) => sent.push(p));
    assert.deepStrictEqual(newer, { ok: false, reason: "failed" });
    assert.deepStrictEqual(sent[0], { phase: "downloading", pct: 0 });
  } finally {
    Object.defineProperty(process, "platform", { value: prev.platform });
    fs.rmSync(dir, { recursive: true, force: true });
    if (prev.appimage === undefined) delete process.env.APPIMAGE; else process.env.APPIMAGE = prev.appimage;
  }
});
