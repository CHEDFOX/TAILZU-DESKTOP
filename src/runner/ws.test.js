// node --test
//
// The WebSocket client (ws.js) against a real server speaking the other half: text frames both ways, frames split across packets and across
// fragments, ping and pong, the closing handshake, a refusal that comes as an HTTP answer to the upgrade (the doc lists them), a frame over the
// limit, and the rule that a socket is wss: except to this computer itself.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { connectWs, acceptWs, encodeFrame, createFrameReader } = require("./ws.js");

function server(onConn, refuse) {
  const s = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  s.on("upgrade", (req, socket, head) => {
    if (refuse) { const r = refuse(req); if (r) { socket.write("HTTP/1.1 " + r.status + " X\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n" + JSON.stringify(r.body)); socket.destroy(); return; } }
    onConn(acceptWs(req, socket, head), req, socket);
  });
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve({ s, url: "ws://127.0.0.1:" + s.address().port + "/x", close: () => { s.closeAllConnections?.(); s.close(); } })));
}
const once = (em, ev) => new Promise((r) => em.once(ev, r));

test("text goes both ways, and a header and a query reach the server", async () => {
  let seen = null;
  const srv = await server((c, req) => { seen = req; c.on("message", (t) => c.send("echo:" + t)); });
  const c = await connectWs(srv.url + "?ticket=abc", { headers: { Authorization: "Bearer t1.x" } });
  c.send("hello");
  assert.strictEqual(await once(c, "message"), "echo:hello");
  const big = "é".repeat(100000);
  c.send(big);
  assert.strictEqual(await once(c, "message"), "echo:" + big, "a frame past 64 KB, multi-byte");
  assert.strictEqual(seen.headers.authorization, "Bearer t1.x");
  assert.strictEqual(new URL(seen.url, "http://x").searchParams.get("ticket"), "abc");
  c.close();
  await once(c, "close");
  srv.close();
});

test("the closing handshake carries the code and the reason, from either side", async () => {
  let peer;
  const srv = await server((c) => { peer = c; });
  const c = await connectWs(srv.url);
  const closedByServer = once(c, "close");
  peer.close(4000, "replaced");
  assert.deepStrictEqual(await closedByServer, { code: 4000, reason: "replaced" });
  const srv2 = await server((c2) => { c2.on("close", () => {}); });
  const c2 = await connectWs(srv2.url);
  const closing = once(c2, "close");
  c2.close(1000, "bye");
  assert.strictEqual((await closing).code, 1000);
  srv.close(); srv2.close();
});

test("a dropped connection is a close with 1006", async () => {
  let socket;
  const srv = await server((c, req, s) => { socket = s; });
  const c = await connectWs(srv.url);
  const closed = once(c, "close");
  socket.destroy();
  assert.strictEqual((await closed).code, 1006);
  assert.strictEqual(c.readyState, "closed");
  assert.strictEqual(c.send("x"), false, "nothing is sent on a closed socket, and nothing throws");
  srv.close();
});

test("a ping from the server is answered with a pong carrying the same bytes", async () => {
  let got = null;
  const srv = await server((c) => {
    c.socket.on("data", () => {});
    c.reader = null;
    c.socket.write(encodeFrame(0x9, Buffer.from("are you there"), false));
    c.socket.removeAllListeners("data");
    const reader = createFrameReader({ expectMasked: true, onFrame: (f) => { if (f.opcode === 0xA) got = f.payload.toString(); }, onError() {} });
    c.socket.on("data", (d) => reader.push(d));
  });
  const c = await connectWs(srv.url);
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(got, "are you there");
  c.terminate();
  srv.close();
});

test("a message sent in fragments, and frames split across packets, arrive whole", async () => {
  const srv = await server((c) => {
    const sock = c.socket;
    const f1 = Buffer.from([0x01, 3, ...Buffer.from("one")]);
    const f2 = Buffer.from([0x00, 3, ...Buffer.from("two")]);
    const f3 = Buffer.from([0x80, 5, ...Buffer.from("three")]);
    sock.write(f1); sock.write(f2); sock.write(f3);
    const whole = encodeFrame(0x1, "split into bytes", false);
    for (const b of whole) sock.write(Buffer.from([b]));
  });
  const c = await connectWs(srv.url);
  const got = [];
  c.on("message", (t) => got.push(t));
  await new Promise((r) => setTimeout(r, 300));
  assert.deepStrictEqual(got, ["onetwothree", "split into bytes"]);
  c.terminate();
  srv.close();
});

test("a refusal comes as the HTTP answer to the upgrade, with its code", async () => {
  const srv = await server(() => {}, () => ({ status: 401, body: { ok: false, code: "expired", message: "That ticket has run out." } }));
  await assert.rejects(connectWs(srv.url), (err) => err.status === 401 && err.code === "expired" && /run out/.test(err.message));
  srv.close();
  const srv2 = await server(() => {}, () => ({ status: 429, body: { ok: false, code: "too_many", message: "x" } }));
  await assert.rejects(connectWs(srv2.url), (err) => err.status === 429 && err.code === "too_many");
  srv2.close();
});

test("a server that is not there, or does not answer, is an error and not a hang", async () => {
  await assert.rejects(connectWs("ws://127.0.0.1:1/x"), (err) => /ECONNREFUSED|connect/.test(String(err.code || err.message)));
  const silent = http.createServer(() => {});
  silent.on("upgrade", () => {});
  await new Promise((r) => silent.listen(0, "127.0.0.1", r));
  await assert.rejects(connectWs("ws://127.0.0.1:" + silent.address().port, { timeoutMs: 200 }), (err) => err.code === "timeout");
  silent.closeAllConnections?.(); silent.close();
});

test("a frame over the limit closes the socket with 1009", async () => {
  const srv = await server((c) => { c.socket.write(encodeFrame(0x1, "x".repeat(5000), false)); });
  const c = await connectWs(srv.url, { maxPayload: 1000 });
  c.on("error", () => {});
  const closed = await once(c, "close");
  assert.ok([1009, 1006].includes(closed.code));
  srv.close();
});

test("a WebSocket must be wss: except to this computer itself", async () => {
  await assert.rejects(connectWs("ws://example.com/x"), (err) => err.code === "insecure");
  await assert.rejects(connectWs("http://example.com/x"), (err) => err.code === "insecure");
  await assert.rejects(connectWs("not an address"), (err) => err.code === "bad_url");
});

test("masking: a client frame is masked, a server frame is not, and each side refuses the other's mistake", () => {
  const c = encodeFrame(0x1, "hi", true);
  assert.ok(c[1] & 0x80);
  const s = encodeFrame(0x1, "hi", false);
  assert.ok(!(s[1] & 0x80));
  let err = null;
  createFrameReader({ expectMasked: true, onFrame() {}, onError: (code) => { err = code; } }).push(s);
  assert.strictEqual(err, 1002);
  err = null;
  createFrameReader({ expectMasked: false, onFrame() {}, onError: (code) => { err = code; } }).push(c);
  assert.strictEqual(err, 1002);
  let payload = null;
  createFrameReader({ expectMasked: true, onFrame: (f) => { payload = f.payload.toString(); }, onError() {} }).push(c);
  assert.strictEqual(payload, "hi");
});
