// A WebSocket client, in this folder's own words (RFC 6455), with nothing to install.
//
// Why not the platform's: the app's main process runs Node 20 (Electron 31), which has no WebSocket of its own; the browser
// windows have one but must not hold a device ticket. The protocol needs very little of it: text frames up to 2 MB, ping and
// pong, close with a code, and the HTTP answer when the upgrade is refused (the doc lists the refusals: 401 expired, 409
// superseded, 429 too_many, ...). Server frames are never masked, client frames always are.
//
// The frame reader and writer are exported too: the tests' fake Worker speaks the other half with them.

"use strict";

const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { EventEmitter } = require("events");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** One frame, as bytes. `mask` for a client's. */
function encodeFrame(opcode, payload, mask) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const len = data.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeUInt32BE(Math.floor(len / 4294967296), 2); head.writeUInt32BE(len >>> 0, 6); }
  head[0] = 0x80 | (opcode & 0x0f);
  if (!mask) return Buffer.concat([head, data]);
  head[1] |= 0x80;
  const key = crypto.randomBytes(4);
  const out = Buffer.alloc(head.length + 4 + len);
  head.copy(out, 0);
  key.copy(out, head.length);
  for (let i = 0; i < len; i += 1) out[head.length + 4 + i] = data[i] ^ key[i & 3];
  return out;
}

/**
 * Reads frames out of a byte stream: push(chunk) calls onFrame({ fin, opcode, payload }) for each complete one, or onError(code,
 * message) once for a frame that breaks the rules (a reserved bit, a control frame that is too long or split, one over
 * maxPayload) after which it reads no more.
 */
function createFrameReader({ maxPayload = 8 * 1024 * 1024, expectMasked = false, onFrame, onError }) {
  let buf = Buffer.alloc(0);
  let dead = false;
  const fail = (code, message) => { dead = true; buf = Buffer.alloc(0); onError(code, message); };
  return {
    push(chunk) {
      if (dead) return;
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (buf.length < 2) return;
        const b0 = buf[0];
        const b1 = buf[1];
        if (b0 & 0x70) return fail(1002, "reserved bits are set");
        const opcode = b0 & 0x0f;
        const masked = !!(b1 & 0x80);
        if (masked !== expectMasked) return fail(1002, masked ? "a masked frame from the server" : "an unmasked frame from the client");
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) {
          if (buf.length < 10) return;
          const hi = buf.readUInt32BE(2);
          if (hi > 0) return fail(1009, "a frame that big");
          len = buf.readUInt32BE(6);
          off = 10;
        }
        if (opcode >= 8 && (len > 125 || !(b0 & 0x80))) return fail(1002, "a control frame that is too long or split");
        if (len > maxPayload) return fail(1009, "a frame over the limit");
        let key = null;
        if (masked) { if (buf.length < off + 4) return; key = buf.subarray(off, off + 4); off += 4; }
        if (buf.length < off + len) return;
        const payload = Buffer.from(buf.subarray(off, off + len));
        if (key) for (let i = 0; i < len; i += 1) payload[i] ^= key[i & 3];
        buf = buf.subarray(off + len);
        onFrame({ fin: !!(b0 & 0x80), opcode, payload });
        if (dead) return;
      }
    },
  };
}

/** The socket the upgrade gave us, as a connection: events "message" (text), "close" ({ code, reason }), "error". */
class WsConn extends EventEmitter {
  constructor(socket, { maxPayload = 8 * 1024 * 1024, mask = true } = {}) {
    super();
    this.socket = socket;
    this.readyState = "open";
    this.mask = mask;
    this.closeInfo = null;
    this._parts = [];
    this._size = 0;
    this._closeTimer = null;
    this._maxPayload = maxPayload;
    this.reader = createFrameReader({
      maxPayload, expectMasked: !mask,
      onFrame: (f) => this._frame(f),
      onError: (code, message) => { this.emit("error", new Error("WebSocket protocol error: " + message)); this._closeWith(code, message); },
    });
    socket.setNoDelay(true);
    socket.on("data", (d) => this.reader.push(d));
    socket.on("error", (err) => { this.emit("error", err); this._done(1006, "the connection failed"); });
    socket.on("close", () => this._done(1006, "the connection closed"));
    socket.on("end", () => { try { socket.end(); } catch { /* closed */ } });
  }

  _frame({ fin, opcode, payload }) {
    if (opcode === 0x9) { this._write(encodeFrame(0xA, payload, this.mask)); return; }
    if (opcode === 0xA) return;
    if (opcode === 0x8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
      if (this.readyState === "open") { this.readyState = "closing"; this._write(encodeFrame(0x8, payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0), this.mask)); }
      this._done(code, reason);
      try { this.socket.end(); } catch { /* closed */ }
      return;
    }
    if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
      if (opcode !== 0x0) { this._parts = []; this._size = 0; this._binary = opcode === 0x2; }
      this._size += payload.length;
      if (this._size > this._maxPayload) { this._closeWith(1009, "a message over the limit"); return; }
      this._parts.push(payload);
      if (fin) {
        const all = this._parts.length === 1 ? this._parts[0] : Buffer.concat(this._parts);
        this._parts = [];
        this._size = 0;
        if (!this._binary) this.emit("message", all.toString("utf8"));
      }
    }
  }

  _write(buf) {
    try { if (!this.socket.destroyed) this.socket.write(buf); return true; } catch { return false; }
  }

  /** Sends a text frame. False when the socket is not open. */
  send(text) {
    if (this.readyState !== "open") return false;
    return this._write(encodeFrame(0x1, String(text), this.mask));
  }

  /** Starts the closing handshake (a code and a short reason); the socket is dropped if the other end does not answer in 2 s. */
  close(code = 1000, reason = "") {
    if (this.readyState !== "open") return;
    this._closeWith(code, reason);
  }

  _closeWith(code, reason) {
    if (this.readyState === "closed") return;
    if (this.readyState === "open") {
      this.readyState = "closing";
      const r = Buffer.from(String(reason || "").slice(0, 100), "utf8");
      const body = Buffer.alloc(2 + r.length);
      body.writeUInt16BE(code, 0);
      r.copy(body, 2);
      this._write(encodeFrame(0x8, body, this.mask));
    }
    clearTimeout(this._closeTimer);
    this._closeTimer = setTimeout(() => { this._done(code, reason); try { this.socket.destroy(); } catch { /* closed */ } }, 2000);
    if (this._closeTimer.unref) this._closeTimer.unref();
  }

  /** Drops the socket at once. */
  terminate() {
    this._done(1006, "dropped");
    try { this.socket.destroy(); } catch { /* closed */ }
  }

  _done(code, reason) {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    clearTimeout(this._closeTimer);
    this.closeInfo = { code, reason };
    this.emit("close", { code, reason });
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Opens a WebSocket. Resolves a WsConn, or rejects with an Error that has `status` (the HTTP answer to a refused upgrade) and
 * `code` (the `code` of the JSON body: expired, replayed, too_many, superseded, ...) when the server said no.
 * `wss:` only, except for this computer itself (a backend run locally).
 */
function connectWs(url, { headers = {}, timeoutMs = 15000, maxPayload = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { reject(Object.assign(new Error("That is not an address."), { code: "bad_url" })); return; }
    const secure = u.protocol === "wss:" || u.protocol === "https:";
    if (!secure && !((u.protocol === "ws:" || u.protocol === "http:") && LOOPBACK.has(u.hostname))) {
      reject(Object.assign(new Error("A WebSocket must be wss: (or ws: to this computer itself)."), { code: "insecure" }));
      return;
    }
    const key = crypto.randomBytes(16).toString("base64");
    const req = (secure ? https : http).request({
      host: u.hostname.replace(/^\[|\]$/g, ""), port: u.port || (secure ? 443 : 80), path: u.pathname + u.search, method: "GET", agent: false, timeout: timeoutMs,
      headers: Object.assign({ Host: u.host, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13" }, headers),
    });
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };
    req.on("timeout", () => req.destroy(Object.assign(new Error("The server did not answer in time."), { code: "timeout" })));
    req.on("error", (err) => fail(err));
    req.on("response", (res) => {
      // Not an upgrade: the server's refusal, as JSON { code, message } when it is.
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { if (body.length < 4096) body += d; });
      res.on("end", () => {
        let j = null;
        try { j = JSON.parse(body); } catch { /* not JSON */ }
        fail(Object.assign(new Error((j && j.message) || "The server refused the connection (" + res.statusCode + ")."), { status: res.statusCode, code: (j && typeof j.code === "string" && j.code) || "refused" }));
      });
    });
    req.on("upgrade", (res, socket, head) => {
      const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
      if (String(res.headers["sec-websocket-accept"]) !== accept) { socket.destroy(); fail(Object.assign(new Error("The server's handshake was wrong."), { code: "bad_handshake" })); return; }
      if (settled) { socket.destroy(); return; }
      settled = true;
      req.setTimeout(0);
      socket.setTimeout(0);
      const conn = new WsConn(socket, { maxPayload, mask: true });
      resolve(conn);
      // Whatever came along with the upgrade is read once the caller has had its chance to listen.
      if (head && head.length) setImmediate(() => conn.reader.push(head));
    });
    req.end();
  });
}

/** The server's half of the handshake, for tests: answers an upgrade request and returns a WsConn on the accepted socket. */
function acceptWs(req, socket, head, { maxPayload = 8 * 1024 * 1024 } = {}) {
  const accept = crypto.createHash("sha1").update(String(req.headers["sec-websocket-key"]) + GUID).digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
  const conn = new WsConn(socket, { maxPayload, mask: false });
  if (head && head.length) conn.reader.push(head);
  return conn;
}

module.exports = { connectWs, acceptWs, WsConn, encodeFrame, createFrameReader };
