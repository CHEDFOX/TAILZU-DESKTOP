// The network: one step of a run posted to the server, and its answer read as
// a stream of events.

const { TEXT } = require("./text.js");
const { str, squash, clip } = require("./helpers.js");
const { hasBytes } = require("./picture.js");

/** One line of the stream, or null for a blank or broken one. A line that is
 *  not an event is skipped rather than ending the run: a proxy's keep-alive,
 *  a stray newline, half a line the server never finished. */
function parseLine(line) {
  const s = line.trim();
  if (!s || s[0] !== "{") return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) && typeof v.t === "string" ? v : null;
  } catch {
    return null;
  }
}

/** No line of this protocol comes near this; a "line" this long with no
 *  newline is not one, and is dropped rather than held in memory. */
const MAX_LINE = 1 << 20;

/**
 * The events in an NDJSON body, as they arrive. Takes a fetch Response's body
 * (a web ReadableStream of bytes) or any async iterable of bytes or strings.
 * A chunk can end anywhere — mid-line, mid-character — so bytes are decoded
 * as a stream and lines are only cut at a newline. Errors from the stream
 * itself (a dropped connection, an abort) are thrown to the reader.
 */
async function* readEvents(body) {
  if (!body) return;
  const decoder = new TextDecoder();
  let buf = "";
  function* lines(chunk, last) {
    buf += typeof chunk === "string" ? chunk : chunk ? decoder.decode(chunk, { stream: !last }) : decoder.decode();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const ev = parseLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (ev) yield ev;
    }
    if (last) {
      const ev = parseLine(buf);
      buf = "";
      if (ev) yield ev;
    } else if (buf.length > MAX_LINE) {
      buf = "";
    }
  }
  if (typeof body.getReader === "function") {
    const reader = body.getReader();
    let finished = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { finished = true; break; }
        yield* lines(value, false);
      }
      yield* lines(null, true);
    } finally {
      // Stopped early — a terminal event, a cancelled run: let the
      // connection go rather than read a body nobody wants.
      if (!finished) { try { reader.cancel().then(null, () => {}); } catch { /* gone */ } }
    }
    return;
  }
  if (typeof body[Symbol.asyncIterator] === "function") {
    for await (const chunk of body) yield* lines(chunk, false);
    yield* lines(null, true);
  }
}

/** The recording's file name and type, by its CONTAINER, which is what the
 *  server decodes by (the extension first). Opus is a codec that rides in
 *  either: the recorder's "audio/webm;codecs=opus" is a WebM file, and named
 *  .ogg it fails the server's speech measurement and goes to speech-to-text
 *  as the wrong format. A bare "audio/opus" is an Ogg Opus file. */
function audioFile(mime) {
  const m = str(mime).toLowerCase();
  if (/webm/.test(m)) return { name: "ask.webm", type: "audio/webm" };
  if (/ogg/.test(m) || /^audio\/opus\b/.test(m)) return { name: "ask.ogg", type: "audio/ogg" };
  if (/wav|wave/.test(m)) return { name: "ask.wav", type: "audio/wav" };
  if (/mp4|m4a|aac/.test(m)) return { name: "ask.m4a", type: "audio/mp4" };
  return { name: "ask.webm", type: "audio/webm" };
}

/** The picture's file name and type: the three the server takes, by the
 *  crop's own type. A JPEG unless it says otherwise. */
function pictureFile(mime) {
  const m = str(mime).toLowerCase();
  if (/png/.test(m)) return { name: "picture.png", type: "image/png" };
  if (/webp/.test(m)) return { name: "picture.webp", type: "image/webp" };
  return { name: "picture.jpg", type: "image/jpeg" };
}

const STATUS_TEXT = Object.defineProperties({}, {
  400: { enumerable: true, get: () => TEXT.status400 },
  401: { enumerable: true, get: () => TEXT.signIn },
  413: { enumerable: true, get: () => TEXT.status413 },
  429: { enumerable: true, get: () => TEXT.status429 },
});

/**
 * The `post` dependency, over fetch: POST {baseUrl}/v1/agent, answered as a
 * stream of events.
 *
 *   audio   multipart, a `request` field (the step as JSON) and the recording
 *           as `audio` — the request first, so the server has it before the
 *           file. Without audio, plain JSON.
 *   image   the picture path's one picture, as an `image` part after them
 *           (picture.jpg, .png or .webp by its type): multipart too, with or
 *           without audio. A JSON body never carries a picture.
 *   401     the token is spent whatever its expiry said; renewed once
 *           (token(true)) and the step sent again.
 *   errors  a refusal before streaming (400/401/413/429…) arrives as JSON;
 *           it becomes one { t:"error" } event, so the run handles every
 *           failure in one place. So does a request that never got there.
 *           An aborted one ends quietly: the run that made it is gone.
 *
 * @param {{ baseUrl: string|(() => string), token: (renew: boolean) => Promise<string|null>, fetch?: Function, path?: string }} opts
 */
function makePost(opts) {
  const o = opts || {};
  const fetchFn = o.fetch || globalThis.fetch;
  const path = o.path || "/v1/agent";
  async function tokenFor(renew) {
    try { return str(typeof o.token === "function" ? await o.token(renew) : o.token) || null; } catch { return null; }
  }
  return async function* post(request, audio, signal, image) {
    const base = str(typeof o.baseUrl === "function" ? o.baseUrl() : o.baseUrl).replace(/\/+$/, "");
    const withAudio = !!(audio && audio.data);
    const withImage = !!(image && hasBytes(image.data));
    const send = async (tok) => {
      const headers = { Accept: "application/x-ndjson" };
      if (tok) headers.Authorization = "Bearer " + tok;
      let body;
      if (withAudio || withImage) {
        body = new FormData();
        body.append("request", JSON.stringify(request));
        if (withAudio) {
          const given = typeof Blob !== "undefined" && audio.data instanceof Blob ? audio.data : null;
          const file = audioFile(audio.mime || (given && given.type));
          // Wrapped again (no copy) so the part's type is the plain container's,
          // agreeing with its name.
          const blob = new Blob([audio.data], { type: file.type });
          body.append("audio", blob, file.name);
        }
        if (withImage) {
          const given = typeof Blob !== "undefined" && image.data instanceof Blob ? image.data : null;
          const file = pictureFile(image.mime || (given && given.type));
          body.append("image", new Blob([image.data], { type: file.type }), file.name);
        }
      } else {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(request);
      }
      return fetchFn(base + path, { method: "POST", headers, body, signal });
    };

    let res;
    try {
      const first = await tokenFor(false);
      res = await send(first);
      if (res.status === 401) {
        const renewed = await tokenFor(true);
        if (renewed) {
          try { if (res.body && typeof res.body.cancel === "function") res.body.cancel().then(null, () => {}); } catch { /* gone */ }
          res = await send(renewed);
        }
      }
    } catch (e) {
      if (signal && signal.aborted) return;
      yield { t: "error", code: "network", message: TEXT.network };
      return;
    }

    if (res.status !== 200) {
      let code = "http_" + res.status;
      let message = "";
      try {
        const j = await res.json();
        if (j && typeof j.code === "string" && j.code) code = j.code;
        else if (j && typeof j.error === "string" && j.error) code = j.error;
        if (j && typeof j.message === "string") message = j.message;
      } catch { /* not JSON: the status says enough */ }
      // A 401 that survived a renewal means signed out; the server's words
      // for it ("Missing or invalid token") are not for a person.
      if (res.status === 401 || !message) message = STATUS_TEXT[res.status] || TEXT.failed;
      yield { t: "error", code, message: clip(squash(message), 240) };
      return;
    }

    try {
      yield* readEvents(res.body);
    } catch (e) {
      if (signal && signal.aborted) return;
      yield { t: "error", code: "network", message: TEXT.network };
    }
  };
}

module.exports = { readEvents, makePost };
