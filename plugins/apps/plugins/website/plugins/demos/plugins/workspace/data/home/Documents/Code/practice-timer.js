// A tiny practice timer: start, pause, and how long I really played today.
// The real one lives in Sonata now — this is the sketch I gave the agent.

export class PracticeTimer {
  sessions = [];

  start(now = Date.now()) {
    if (this.running) return;
    this.sessions.push({ start: now, end: null });
  }

  pause(now = Date.now()) {
    const last = this.sessions.at(-1);
    if (last && last.end === null) last.end = now;
  }

  get running() {
    return this.sessions.at(-1)?.end === null;
  }

  /** Minutes played, rounded down. */
  minutes(now = Date.now()) {
    const ms = this.sessions.reduce(
      (sum, s) => sum + ((s.end ?? now) - s.start),
      0,
    );
    return Math.floor(ms / 60_000);
  }
}
