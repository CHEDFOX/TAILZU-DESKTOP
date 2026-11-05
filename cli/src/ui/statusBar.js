// The one line at the bottom while Xode works: a spinner, what it is doing, how long it has been, and how to stop it.
//
//   ⠹ Build · 1m 12s · esc to stop
//
// Redrawn in place about ten times a second (on a terminal only: elsewhere nothing is drawn).

"use strict";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** "12s", "1m 12s", "1h 3m". */
function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The line for `st` ({ word, since, tail }) at spinner frame `frame`. */
function barLine(st, frame, paint, now = Date.now()) {
  const parts = [paint.bold(st.word)];
  if (st.since) parts.push(paint.dim(elapsed(now - st.since)));
  if (st.tail) parts.push(paint.dim(st.tail));
  return `${paint.cyan(FRAMES[frame % FRAMES.length])} ${parts.join(paint.dim(" · "))}`;
}

/** input: the input layer (setStatus, screen); paint. show(st), update(patch), hide(); pause() and resume() around a question. */
function createStatusBar({ input, paint, everyMs = 100, now = Date.now }) {
  let st = null;
  let paused = null;
  let frame = 0;
  let timer = null;
  const line = () => (st ? barLine(st, frame, paint, now()) : null);
  const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };
  return {
    get shown() { return !!st; },
    get word() { return st ? st.word : ""; },
    show(next) {
      st = { ...next };
      if (!input.screen) return;
      input.setStatus(line);
      if (!timer) {
        timer = setInterval(() => { frame += 1; input.render(); }, everyMs);
        if (timer.unref) timer.unref();
      }
    },
    update(patch) {
      if (!st) return;
      st = { ...st, ...patch };
      if (input.screen) input.render();
    },
    hide() {
      st = null;
      stopTimer();
      if (input.screen) input.setStatus(null);
    },
    /** Off while a question or a yes is asked (a line frozen above it would read as stuck); resume() puts it back as it was. */
    pause() {
      if (!st) return;
      paused = st;
      this.hide();
    },
    resume() {
      if (!paused) return;
      const back = paused;
      paused = null;
      this.show(back);
    },
  };
}

module.exports = { createStatusBar, elapsed, barLine, FRAMES };
