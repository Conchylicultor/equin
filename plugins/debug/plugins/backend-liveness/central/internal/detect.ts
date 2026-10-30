import {
  FROZEN_AFTER_MS,
  HEARTBEAT_MS,
  PROBE_EVERY_MS,
  type BackendFrozenPayload,
} from "../../core";

// The pure half of the liveness probe: given what one tick saw, which
// `backend-frozen` reports to file. No clock, no I/O — the probe hands it the
// tick's wall time.

/** One backend, as one tick probed it. */
export interface Observation {
  worktree: string;
  pid: number;
  /**
   * - `answered` — any HTTP answer: its JS thread ran;
   * - `unanswered` — its socket is bound but nothing answered in time, and its
   *   process is running;
   * - `unserved` — its socket is not bound yet (a boot before it listens):
   *   nothing to judge;
   * - `paused` — no answer, and its process is stopped (SIGSTOP, a debugger);
   * - `exited` — no answer, and its process is gone;
   * - `unknown` — it could not be judged this tick (its pid sidecar mid-swap,
   *   `ps` too slow): its streak neither grows nor ends.
   */
  result:
    | "answered"
    | "unanswered"
    | "unserved"
    | "paused"
    | "exited"
    | "unknown";
}

/** What one tick saw. */
export type Tick =
  | {
      atMs: number;
      /**
       * True when the tick's own probes overran their timeout by far — the
       * observer was suspended mid-tick (machine sleep), so the interval since
       * the previous tick was not observed awake.
       */
      suspended: boolean;
      /** Every backend the gateway runs or is starting (central excluded). */
      observations: Observation[];
    }
  | {
      atMs: number;
      /** The gateway fleet could not be read: nothing was observed. */
      observations: null;
    };

interface Streak {
  worktree: string;
  pid: number;
  sinceMs: number;
  unansweredMs: number;
  /** Wall ms it was last reported frozen; null while not yet frozen. */
  reportedMs: number | null;
}

/** An interval longer than this was not observed (the observer slept or stalled). */
export const MAX_OBSERVED_INTERVAL_MS = 3 * PROBE_EVERY_MS;

export interface LivenessDetector {
  step(tick: Tick): BackendFrozenPayload[];
}

export function createLivenessDetector(): LivenessDetector {
  const streaks = new Map<string, Streak>();
  let prevAtMs: number | null = null;

  function report(
    s: Streak,
    state: BackendFrozenPayload["state"],
    atMs: number,
  ): BackendFrozenPayload {
    return {
      worktree: s.worktree,
      pid: s.pid,
      sinceMs: s.sinceMs,
      unansweredMs: s.unansweredMs,
      state,
      observedMs: atMs,
    };
  }

  /** End a streak; an episode that was reported gets its closing report. */
  function end(
    key: string,
    state: Exclude<BackendFrozenPayload["state"], "frozen">,
    atMs: number,
  ): BackendFrozenPayload[] {
    const s = streaks.get(key);
    if (s === undefined) return [];
    streaks.delete(key);
    return s.reportedMs === null ? [] : [report(s, state, atMs)];
  }

  return {
    step(tick) {
      if (tick.observations === null) {
        // Nothing observed: the next interval is not counted either.
        prevAtMs = null;
        return [];
      }
      const interval = prevAtMs === null ? 0 : tick.atMs - prevAtMs;
      // Only an interval the observer was awake through counts toward a
      // freeze — a machine sleep (or central itself stalling) adds nothing.
      const observedMs =
        tick.suspended || interval > MAX_OBSERVED_INTERVAL_MS ? 0 : interval;
      prevAtMs = tick.atMs;

      const out: BackendFrozenPayload[] = [];
      const seen = new Set<string>();
      const unjudged = new Set<string>();
      for (const o of tick.observations) {
        const key = `${o.worktree}:${o.pid}`;
        seen.add(key);
        if (o.result === "unknown") {
          // Not judged: whatever this worktree's streak is, it is kept.
          unjudged.add(o.worktree);
          continue;
        }
        if (o.result !== "unanswered") {
          // `unserved` cannot follow a bound socket of the same process; it
          // only ends a streak that never reached a report.
          const state = o.result === "unserved" ? "exited" : o.result;
          out.push(...end(key, state, tick.atMs));
          continue;
        }
        const streak = streaks.get(key);
        if (streak === undefined) {
          // First miss: the freeze began between the last answer and now.
          streaks.set(key, {
            worktree: o.worktree,
            pid: o.pid,
            sinceMs: tick.atMs,
            unansweredMs: 0,
            reportedMs: null,
          });
          continue;
        }
        streak.unansweredMs += observedMs;
        const due =
          streak.reportedMs === null
            ? streak.unansweredMs >= FROZEN_AFTER_MS
            : tick.atMs - streak.reportedMs >= HEARTBEAT_MS;
        if (!due) continue;
        streak.reportedMs = tick.atMs;
        out.push(report(streak, "frozen", tick.atMs));
      }
      // No longer run by the gateway (stopped, or replaced by a new process):
      // its episode ended with that process.
      for (const [key, s] of [...streaks])
        if (!seen.has(key) && !unjudged.has(s.worktree))
          out.push(...end(key, "exited", tick.atMs));
      return out;
    },
  };
}
