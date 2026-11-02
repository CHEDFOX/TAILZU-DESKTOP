// THE DATA TABS STAY FRESH, as they do on the phone. A dictation happens in
// another app (the pill pastes there), so by the time the window is in front
// again its numbers are stale. Today and Insights (and Words/Voices) re-fetch
// when you return to the window or switch to them, and again a moment after a
// dictation lands — never over a live capture, and throttled by refreshMs so
// alt-tabbing is not a request storm. Train (a live canvas) and Notes (often
// mid-edit) keep their own refresh and are left alone.
const LIVE_TABS = new Set(["desk_today", "desk_insights", "desk_words", "desk_voices", "desk_tasks"]);
function onLiveTab() {
  const top = STACK[STACK.length - 1];
  return DESK && !!top && STACK.length === 1 && LIVE_TABS.has(top.screenId);
}
let lastLiveRefresh = 0;
function refreshLiveTab() {
  if (!SESSION || MIC || document.hidden || !onLiveTab()) return;
  const now = Date.now();
  if (now - lastLiveRefresh < Math.max(800, K.num("desktop.desk.refreshMs", 1500))) return;
  lastLiveRefresh = now;
  void paint(true);
}
window.addEventListener("focus", refreshLiveTab);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshLiveTab(); });
