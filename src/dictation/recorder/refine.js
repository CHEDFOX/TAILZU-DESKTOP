// Refine (the live path's fallback, when there is no recording).
//
// /v1/refine with no tone, as the phone's keyboard sends it: the server
// writes in the account's own voice, its tone and its preset. It used to
// pick /v1/refine/<tone> from the tone this window was handed, and that was
// "none" (repair only, restyle nothing) whenever the main process had not
// read the account, which made live dictation read like its transcript.
async function refineText(text, alternative, context, sid) {
  const rid = sid === undefined ? session : sid;
  const body = { text, targetApp: targetFor(rid), language: cfg.language || "auto", tzOffsetMinutes: -new Date().getTimezoneOffset() };
  withField(rid, (k, v) => { body[k] = v; });
  withScreen(rid, (k, v) => { body[k] = v === "true" ? true : v; });
  // Said with text selected: the server rewrites it (see selections).
  const selection = selectionFor(rid);
  if (selection) body.selection = selection;
  // What the session already wrote, as on /v1/transcribe-clean.
  if (context) body.context = context.slice(-K.num("desktop.recorder.contextChars", 600));
  // The second engine's reading goes with it: the server reconciles the
  // two and decides which leads. Dropped here, the work was wasted.
  if (alternative) body.alternative = alternative;
  // ONE RETRY for a blip. A refusal is not retried (no words left: the
  // same answer again), except a spent token, which authorized() renews
  // and resends first.
  let last = null;
  for (let i = 0; i < 2; i++) {
    try {
      const res = await authorized((h) => fetch(base() + "/v1/refine", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, h),
        body: JSON.stringify(body),
      }));
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err = Object.assign(new Error("refine HTTP " + res.status + (text ? " " + text.slice(0, K.num("desktop.recorder.errorBodyChars", 120)) : "")),
          { words: httpMessage(res.status, text), code: text.indexOf("quota_exceeded") !== -1 ? "quota_exceeded" : undefined });
        if (res.status < 500) { last = err; break; }
        throw err;
      }
      const j = await res.json();
      const refined = (j.refinedText || "").trim();
      if (refined) selections.delete(rid);
      // The join the server read, as /v1/transcribe-clean gives it: none
      // for a rewrite, which takes the selection's place, edges and all.
      return {
        text: refined,
        join: typeof j.joinWithSpace === "boolean" ? j.joinWithSpace : undefined,
        edges: j.replacedSelection && selection ? edgesOf(selection) : undefined,
      };
    } catch (err) {
      last = err;
    }
  }
  throw last || new Error("refine failed");
}
