// node --test
//
// The sign-in on disk (sessionFile.js): sealed with safeStorage where it can be, read back, an older build's plain file read and then
// sealed, the plain 0600 file kept where there is no key store (Linux without a keyring, or its basic_text store), and nothing opened
// before `ready`.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSessionFile } = require("./sessionFile.js");

const SESSION = { access_token: "at-1", refresh_token: "rt-secret-1", expires_at: 123 };

/** A stand-in for Electron's safeStorage: reversible, and never the plain text. */
function fakeSafe(o = {}) {
  return {
    isEncryptionAvailable: () => o.available !== false,
    getSelectedStorageBackend: () => o.backend || "gnome_libsecret",
    encryptString: (t) => Buffer.concat([Buffer.from("v10"), Buffer.from(t, "utf8").map((b) => b ^ 0x5a)]),
    decryptString: (b) => { if (b.subarray(0, 3).toString() !== "v10") throw new Error("not ours"); return Buffer.from(b.subarray(3).map((x) => x ^ 0x5a)).toString("utf8"); },
  };
}

function rig(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tzsession-"));
  const file = path.join(dir, "session.json");
  const ready = { v: o.ready !== false };
  const store = createSessionFile({ fs, file, safeStorage: o.safe === undefined ? fakeSafe() : o.safe, isReady: () => ready.v, platform: o.platform || "darwin" });
  return { dir, file, ready, store, raw: () => fs.readFileSync(file), remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("sealed where safeStorage can: the file holds no token in the clear, and reads back", () => {
  const r = rig();
  r.store.save(SESSION);
  assert.ok(!r.raw().toString("latin1").includes("rt-secret-1"), "the refresh token is not in the file");
  assert.notStrictEqual(r.raw()[0], 0x7b);
  assert.deepStrictEqual(r.store.load(), SESSION);
  assert.strictEqual(r.store.plain(), false);
  if (process.platform !== "win32") assert.strictEqual(fs.statSync(r.file).mode & 0o777, 0o600);
  r.remove();
});

test("an older build's plain file is read as it is, and sealed when it is written again", () => {
  const r = rig();
  fs.writeFileSync(r.file, JSON.stringify(SESSION, null, 2), { mode: 0o644 });
  assert.deepStrictEqual(r.store.load(), SESSION);
  assert.strictEqual(r.store.plain(), true);
  r.store.save(r.store.load());
  assert.ok(!r.raw().toString("latin1").includes("rt-secret-1"));
  assert.deepStrictEqual(r.store.load(), SESSION);
  if (process.platform !== "win32") assert.strictEqual(fs.statSync(r.file).mode & 0o777, 0o600, "narrowed");
  r.remove();
});

test("no key store (Linux without a keyring, or its basic_text store, or no safeStorage): the plain 0600 file, as before", () => {
  for (const o of [{ safe: fakeSafe({ available: false }), platform: "linux" }, { safe: fakeSafe({ backend: "basic_text" }), platform: "linux" }, { safe: null }]) {
    const r = rig(o);
    r.store.save(SESSION);
    assert.deepStrictEqual(JSON.parse(r.raw().toString("utf8")), SESSION);
    assert.deepStrictEqual(r.store.load(), SESSION);
    assert.strictEqual(r.store.plain(), true);
    r.remove();
  }
});

test("before ready a sealed file is locked, not lost: it opens once the app is ready", () => {
  const r = rig();
  r.store.save(SESSION);
  r.ready.v = false;
  assert.strictEqual(r.store.load(), null);
  assert.strictEqual(r.store.locked(), true);
  r.ready.v = true;
  assert.deepStrictEqual(r.store.load(), SESSION);
  assert.strictEqual(r.store.locked(), false);
  r.remove();
});

test("signed out removes the file; a file nobody can open is no session", () => {
  const r = rig();
  r.store.save(SESSION);
  r.store.save(null);
  assert.ok(!fs.existsSync(r.file));
  assert.strictEqual(r.store.load(), null);
  fs.writeFileSync(r.file, Buffer.from([1, 2, 3, 4]));
  assert.strictEqual(r.store.load(), null);
  r.remove();
});
