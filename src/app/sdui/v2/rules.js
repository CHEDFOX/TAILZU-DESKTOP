// Rules and timers as data (SPEC 2.4, B3): `when → do`, `every`, `after`.
//
// The kernel's RuleMachine decides everything — which rule is due, when to come back, what is throttled — and holds
// no clock of its own. This file is the clock: one timer, the screen's own, stopped the moment the screen goes.
// A node's rules are live only while that node is drawn, which falls out of collecting them during the paint.

let V2_RULES = null;       // the machine for the screen that is up
let V2_RULES_SIG = "";     // what it was built from, so a repaint does not restart its timers
let V2_RULES_AT = null;    // the timer waiting for the next rule
let V2_RULES_NODE = [];    // rules found on nodes during this paint

/** Nodes hand their own rules in while they are drawn. */
function v2RulesOnNode(list) {
  if (!Array.isArray(list)) return;
  for (const r of list) if (r && typeof r === "object") V2_RULES_NODE.push(r);
}

/** A new paint starts collecting again. */
function v2RulesPaintStart() { V2_RULES_NODE = []; }

/** Stop everything: the screen is going. */
function v2RulesLeave() {
  if (V2_RULES_AT) { clearTimeout(V2_RULES_AT); V2_RULES_AT = null; }
  V2_RULES = null;
  V2_RULES_SIG = "";
  V2_RULES_NODE = [];
}

/** One pass: what is due runs, and the next wake is booked. */
function v2RulesTick() {
  V2_RULES_AT = null;
  if (!V2_RULES || !V2.on) return;
  const k = v2Kernel();
  const now = v2Now();
  let t;
  try { t = V2_RULES.tick(v2Scope(), now); } catch { v2Bad("rules:tick"); v2RulesLeave(); return; }
  if (t.nextWakeAt != null && Number.isFinite(t.nextWakeAt)) {
    // Never a tighter loop than the kernel's own fire ceiling allows.
    const floor = k ? Math.ceil(1000 / k.LIMITS.firesPerSecond) : 100;
    const wait = Math.max(floor, t.nextWakeAt - now);
    V2_RULES_AT = setTimeout(v2RulesTick, wait);
  }
  for (const f of t.fired) {
    try { Promise.resolve(run(f.do)).catch(() => undefined); } catch { v2Bad("rules:do"); }
  }
}

/**
 * Build or keep the machine for this paint. The signature is what the rules SAY: a repaint with the same rules
 * keeps the machine, so an `after` or an `every` goes on counting instead of starting again on every keystroke.
 */
function v2RulesSync() {
  const k = v2Kernel();
  if (!k || !V2.on || !v2Has("rules")) { v2RulesLeave(); return; }
  const screen = typeof CURRENT_SCREEN !== "undefined" ? CURRENT_SCREEN : null;
  const own = screen && Array.isArray(screen.rules) ? screen.rules : [];
  const list = own.concat(V2_RULES_NODE);
  if (!list.length) { v2RulesLeave(); return; }
  let sig;
  try { sig = V2.screenId + "|" + JSON.stringify(list); } catch { sig = V2.screenId + "|?"; }
  if (V2_RULES && sig === V2_RULES_SIG) { if (!V2_RULES_AT) v2RulesTick(); return; }
  if (V2_RULES_AT) { clearTimeout(V2_RULES_AT); V2_RULES_AT = null; }
  const made = k.compileRules(list, { foreground: true });
  for (const e of made.errors) v2Bad("rules:" + e.slice(0, 40));
  V2_RULES_SIG = sig;
  V2_RULES = made.rules.length ? new k.RuleMachine(made.rules, { now: v2Now() }) : null;
  if (V2_RULES) v2RulesTick();
}
