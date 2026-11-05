// Actions: run() does what a node's action says (navigate, call an endpoint,
// set state and the rest), and the toast that reports it.

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("on"), K.num("desktop.toast.ms", 2600));
}

/** What the control that fired the current action handed over.
 *
 *  The catalog writes "$event" where a handler needs it — the transcript a mic
 *  produced, the error a session raised — and this window resolved it to the
 *  literal string "$event". So a failed dictation toasted the word "$event" at
 *  the user instead of saying what went wrong. */
let EVENT = undefined;

function resolveValue(v) {
  if (typeof v === "string" && v.indexOf("$state.") === 0) return stateAt(v.slice(7));
  if (v === "$event") return EVENT;
  return v;
}

async function run(action, eventValue) {
  if (!action) return;
  if (arguments.length > 1) EVENT = eventValue;
  if (typeof action === "string") return run((CURRENT_ACTIONS || {})[action], ...(arguments.length > 1 ? [eventValue] : []));
  switch (action.kind) {
    // Params can name state ("$state.asked.id"): the screen to open is sometimes one an answer named.
    // `replace` swaps the top of the stack (Done on Spaces opens the made space's moment with nothing behind it to go back to).
    case "navigate": {
      const params = action.params ? deepResolve(action.params) : action.params;
      if (action.replace === true && STACK.length && action.screenId) { STACK[STACK.length - 1] = { screenId: action.screenId, params }; paint(); return; }
      go(action.screenId, params);
      return;
    }
    // TWO NAMES FOR ONE THING, and only one was answered. The catalog says
    // "navigateBack" — fifteen times, on every back control in the four inside
    // screens — and this understood only "back". So every one of those arrows
    // was drawn, was clickable, and did nothing; an action this switch does not
    // know falls through in silence, which is how it stayed invisible.
    case "back": case "navigateBack": case "dismiss": back(); return;
    case "switchTab": switchTab(action.tabId); return;
    case "reloadScreen": case "refresh": await paint(true); return;
    case "setState": setStatePath(action.path, resolveValue(action.value)); repaint(); return;
    case "clearState": setStatePath(action.path, undefined); repaint(); return;
    case "appendState": {
      const cur = stateAt(action.path);
      const arr = Array.isArray(cur) ? cur.slice() : [];
      arr.push(resolveValue(action.value));
      setStatePath(action.path, arr);
      repaint();
      return;
    }
    // The same evaluator the tree's visibleIf uses, so a condition means the
    // same thing whether it gates a node or an action.
    case "condition": {
      const branch = visible(action.if) ? action.then : action.else;
      if (branch) await run(branch);
      return;
    }
    case "toggleState": setStatePath(action.path, !truthy(stateAt(action.path))); repaint(); return;
    case "toggleInArray": {
      const cur = stateAt(action.path);
      const list = Array.isArray(cur) ? cur.slice() : [];
      const v = resolveValue(action.value);
      const i = list.indexOf(v);
      if (i === -1) list.push(v); else list.splice(i, 1);
      setStatePath(action.path, list); repaint(); return;
    }
    // resolveValue, so "$event" is the error it carries and not the word.
    case "toast": { const m = resolveValue(action.message); toast(label(m == null ? "" : String(m)) || ""); return; }
    // A note back on the clipboard, as it was written.
    case "copyText": {
      const t = String(resolveValue(action.text) ?? "");
      try { await navigator.clipboard.writeText(t); toast(label(action.message) || K.txt("desktop.toast.copied", "Copied")); }
      catch { toast(K.txt("desktop.toast.copyFailed", "Couldn't copy that")); }
      return;
    }
    // What is on the clipboard, into a field (Ask's Paste), as the phone does.
    case "readClipboard": {
      try {
        const t = String((await window.tailzuApp.readClipboard()) ?? "");
        if (t) { setStatePath(action.assignTo, t); repaint(); }
      } catch { toast(K.txt("desktop.toast.pasteFailed", "Couldn't paste that")); }
      return;
    }
    // A setting that lives on this computer. The main process checks the key
    // and the value, writes its own file, and answers with every setting again.
    case "desktop.config": {
      try {
        const v = action.value === "$toggle" ? !truthy(stateAt("desktop." + action.key)) : resolveValue(action.value);
        const next = await window.tailzuApp.setConfig(String(action.key || ""), v);
        if (next && typeof next === "object") LOCAL = next;
      } catch { toast(K.txt("desktop.toast.settingFailed", "Couldn't change that setting")); }
      STATE.desktop = Object.assign({}, LOCAL);
      repaint();
      return;
    }
    // Keep an ask to send once online, take one out, try one again, clear the sent (outbox.js, loaded after this file).
    case "outbox": return typeof outboxRun === "function" ? outboxRun(action) : undefined;
    case "dictate":
      try { window.tailzuApp.dictate(); } catch { /* tray only */ }
      return;
    // The bot on the screen listens, turn by turn, and stops (listen.js, loaded after this file).
    case "voiceLive": return typeof voiceLiveRun === "function" ? voiceLiveRun(action) : run(action.onError);
    case "voiceStop": if (typeof voiceStopRun === "function") voiceStopRun(); return;
    // Send a picked file, play a sound (media.js, loaded after this file).
    case "uploadFile": case "playAudio": case "stopAudio":
      return typeof mediaRun === "function" ? mediaRun(action) : undefined;
    case "signOut":
      await signOutHere();
      return;
    case "haptic": return;                      // no equivalent, and none faked
    case "delay": await new Promise((r) => setTimeout(r, action.ms || 0)); return;
    case "openUrl": window.tailzuApp.openExternal(String(resolveValue(action.url) ?? "")); return;
    case "notes.toggle": try { window.tailzuApp.toggleNotes(); } catch { /* an older main process */ } return;
    case "notes.stop": try { window.tailzuApp.stopNotes(String(action.id || "")); } catch { /* an older main process */ } return;
    case "notes.allowSystemAudio": try { window.tailzuApp.allowSystemAudio(); } catch { /* an older main process */ } return;
    case "installUpdate": return installUpdate(action);
    // The Ask setup card. The window names which setting, never an address;
    // the main process opens its own fixed pages and ignores any other kind.
    case "ask.openAccessibility": askAction("openAccessibility"); return;
    case "ask.openScreenRecording": askAction("openScreenRecording"); return;
    case "ask.picturesAll": askAction("picturesAll", action.on === true || action.on === "true"); return;
    case "ask.relaunch": askAction("relaunch"); return;
    case "connector.connect": return connectApp(action);
    case "requestPermission":
      if (action.permission === "microphone") return askMic(action);
      return run(action.onDenied);

    // ── buying ────────────────────────────────────────────────────────────
    // Every row on the paywall fires one of these, and this window answered
    // none of them: the screen drew, the rows clicked, and nothing happened —
    // the same silence `navigateBack` used to fall into.
    //
    // RevenueCat has no desktop SDK, so there is no store to call. Web Billing
    // is its own checkout, opened in the user's browser, and the identity
    // already lines up — the app user id is the Supabase user id on both
    // sides, so paying here writes the same entitlements row a phone purchase
    // writes, and someone who paid on their phone is already entitled here.
    case "iap.subscribe":
    case "iap.showPaywall":
      return buyOnWeb();

    // NOTHING TO RESTORE FROM, and nothing that needs restoring. On a phone
    // this asks the store to re-attach a purchase made on another device. Here
    // the server already knows: entitlement is a row against this account, not
    // a receipt on this machine. So the honest action is to go and ask it.
    case "iap.restore":
      await refreshEntitlement(true);
      return;
    case "sequence":
      for (const a of action.actions || []) await run(a);
      return;
    case "callEndpoint": {
      // `stream`: the answer's words, written into state as they come over the live socket (askStreamTake).
      let unlisten = null;
      try {
        const path = String(action.path || "").replace(/\$state\.[A-Za-z0-9_.]+/g, (m) => {
          const v = stateAt(m.slice(7));
          return v == null ? "" : encodeURIComponent(String(v));
        });
        let body = action.body != null ? deepResolve(action.body) : undefined;
        if (typeof action.stream === "string" && action.stream && body && typeof body === "object" && !Array.isArray(body)) {
          const id = askStreamId();
          setStatePath(action.stream, { id, text: "", step: "" });
          unlisten = askStreamListen(id, action.stream);
          body = Object.assign({}, body, { streamId: id });
        }
        const res = await api(path, body, action.method || "POST");
        if (action.assignTo) { setStatePath(action.assignTo, res); repaint(); }
        await run(action.onSuccess);
        if (action.method && action.method.toUpperCase() !== "GET") {
          // Any write could have been the tone. Telling the tray to re-read is
          // cheaper, and more honest, than guessing which writes matter.
          try { window.tailzuApp.changed(); } catch { /* tray only */ }
          // The onboarding saves as it goes (a language, then the profile at
          // the end) and nothing it shows depends on the answer; a fetch here
          // would rebuild the step under the person's hand. Nor while another
          // call's answer is being written in (a Stop): it would wipe the words.
          // `stay` (KitExtras): the screen asked to be kept as it is (a question the answer opened, "Send this to Mom only?",
          // which a fetch would wipe before it showed; its own onSuccess refreshes when it means to).
          if (!stageUp() && ASK_TAPS.size <= (unlisten ? 1 : 0) && action.stay !== true) await paint(true);
        }
      } catch (err) {
        if (err && err.quota) { go(K.str("quota.screenId", "paywall")); return; }
        // What the server said about it, for the failure's own toast ("$state.lastError.message", said.ts); null when it said nothing.
        setStatePath("lastError", err && err.server ? { code: err.server.code, message: err.server.message } : null);
        await run(action.onError);
      } finally {
        // A moment more: the last words can come over the socket just after the answer.
        if (unlisten) setTimeout(unlisten, 600);
      }
      return;
    }
    default: return;
  }
}

function deepResolve(v) {
  if (typeof v === "string") return resolveValue(v);
  if (Array.isArray(v)) return v.map(deepResolve);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = deepResolve(v[k]);
    return o;
  }
  return v;
}

function setStatePath(path, value) {
  const parts = String(path).replace(/^state\./, "").split(".");
  // A path is data from the tree; one that walks into a prototype would
  // write into every object in this window.
  if (parts.some((k) => k === "__proto__" || k === "constructor" || k === "prototype")) return;
  let o = STATE;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof o[parts[i]] !== "object" || o[parts[i]] === null) o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
}
