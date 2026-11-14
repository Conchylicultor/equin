import { clientLog } from "@plugins/primitives/plugins/log-channels/web";
import type { MainThreadStallDraft, StallStacks } from "../../core";
import { LOG_CHANNEL } from "./log-channel";
import {
  reduceStallStacks,
  type KeptTrace,
  type ProfilerTrace,
} from "./stack-profile";

// The tab's rolling JS Self-Profiling trace (Chrome's `Profiler`; the gateway
// serves every app document with `Document-Policy: js-profiling`). LoAF names
// a frozen frame's entry point only; a sampling profiler's samples are taken
// by V8 off the main thread, so the profiler running when the thread froze
// keeps sampling THROUGH the freeze — and once the tab is back, the stacks
// that ran underneath are in its trace.
//
// One profiler runs at a time while the tab is visible; it is rotated (the
// next started, then this one stopped, in one task — no gap, and V8 keeps its
// code-event logging on across the swap) once it is ROTATE_MS old, so the one
// a freeze lands in has most of its buffer left. Rotation rides the
// watchdog's 1 Hz ping (or the fallback's heartbeat) — no timer of its own; a
// frozen thread rotates nothing, so the covering trace is never cut. Stopped
// traces are kept RETAIN_MS: a recovered stall is filed ~2 s after it ends.

export const PROFILE = {
  // 20 ms: 50 samples a second — a minutes-long loop yields thousands of
  // samples, far more than enough to name it, at a cost V8 pays on its
  // sampler thread (a signal + stack walk per sample, microseconds).
  SAMPLE_INTERVAL_MS: 20,
  // 15 000 samples = 300 s of sampling: a profiler at most ROTATE_MS old when
  // a freeze begins covers its first 270 s (longer ones are marked truncated).
  MAX_BUFFER_SAMPLES: 15_000,
  ROTATE_MS: 30_000,
  RETAIN_MS: 90_000,
  RETAIN_TRACES: 4,
} as const;

interface ProfilerInstance extends EventTarget {
  stop(): Promise<ProfilerTrace>;
}
type ProfilerCtor = new (opts: {
  sampleInterval: number;
  maxBufferSize: number;
}) => ProfilerInstance;

interface Running {
  profiler: ProfilerInstance;
  startedAt: number;
  full: boolean;
}

export interface StallProfiler {
  /** The clock moved (a watchdog ping, a heartbeat): start, or rotate an old profile. */
  pulse(): void;
  /** The stacks of a stall this tab is filing (its own, recovered — else why not). */
  stacksFor(
    draft: MainThreadStallDraft,
    ownTabId: string,
  ): Promise<StallStacks>;
  dispose(): void;
}

function profilerCtor(): ProfilerCtor | null {
  const g = globalThis as unknown as { Profiler?: ProfilerCtor };
  return g.Profiler ?? null;
}

export function installStallProfiler(): StallProfiler {
  const Ctor = profilerCtor();
  // Why this tab cannot sample, once known: the report says so.
  let unavailable: string | null = Ctor
    ? null
    : "this browser has no JS Self-Profiling API (no `Profiler` global: Chromium only, secure contexts only)";
  let running: Running | null = null;
  let kept: KeptTrace[] = [];
  // Stops in flight: each settles to null, or to the error its stop threw.
  const pending = new Set<Promise<Error | null>>();
  let disposed = false;

  const log = (line: Record<string, unknown>): void =>
    clientLog(LOG_CHANNEL, JSON.stringify({ kind: "profiler", ...line }));
  if (unavailable) log({ unavailable });

  const prune = (): void => {
    const now = Date.now();
    kept = kept
      .filter((k) => now - k.stoppedAt <= PROFILE.RETAIN_MS)
      .slice(-PROFILE.RETAIN_TRACES);
  };

  const stop = (run: Running): void => {
    const stoppedAt = Date.now();
    const timeOrigin = performance.timeOrigin;
    const settled = run.profiler.stop().then(
      (trace) => {
        if (disposed) return null;
        kept.push({
          trace,
          timeOrigin,
          startedAt: run.startedAt,
          stoppedAt,
          full: run.full,
        });
        prune();
        return null;
      },
      (err: unknown) => {
        const e = err instanceof Error ? err : new Error(String(err));
        log({ stopFailed: e.message });
        return e;
      },
    );
    pending.add(settled);
    void settled.then(() => pending.delete(settled));
  };

  const start = (): void => {
    if (!Ctor || unavailable || running || disposed) return;
    if (document.visibilityState !== "visible") return;
    let profiler: ProfilerInstance;
    try {
      profiler = new Ctor({
        sampleInterval: PROFILE.SAMPLE_INTERVAL_MS,
        maxBufferSize: PROFILE.MAX_BUFFER_SAMPLES,
      });
    } catch (err) {
      // The document was served without `Document-Policy: js-profiling` (a
      // gateway older than it, a host that serves the shell itself): Chrome
      // refuses with a DOMException. Anything else is a bug — thrown.
      if (!(err instanceof DOMException)) throw err;
      unavailable = `the browser refused to start a Profiler (${err.name}: ${err.message}) — is the document served with \`Document-Policy: js-profiling\`?`;
      log({ unavailable });
      return;
    }
    const run: Running = { profiler, startedAt: Date.now(), full: false };
    // Fires once the thread is back: the buffer is spent, start a fresh one.
    profiler.addEventListener("samplebufferfull", () => {
      run.full = true;
      if (running === run) rotate();
    });
    running = run;
  };

  const rotate = (): void => {
    const prev = running;
    running = null;
    start();
    if (prev) stop(prev);
  };

  const onVisibility = (): void => {
    if (document.visibilityState === "visible") start();
    else if (running) {
      // A hidden tab's stalls are never reported: sample nothing there.
      stop(running);
      running = null;
    }
  };
  document.addEventListener("visibilitychange", onVisibility);

  return {
    pulse() {
      if (!running) start();
      else if (Date.now() - running.startedAt >= PROFILE.ROTATE_MS) rotate();
    },
    async stacksFor(draft, ownTabId) {
      if (draft.ended !== "recovered")
        return {
          kind: "unavailable",
          reason: `the tab did not survive the stall (${draft.ended}): its profile went with it`,
        };
      if (draft.tabId !== ownTabId)
        return {
          kind: "unavailable",
          reason:
            "filed by another tab: only the stalled tab holds the profile of its own thread",
        };
      if (unavailable) return { kind: "unavailable", reason: unavailable };
      // The running profile may hold the stall: finalize it (a fresh one
      // takes over).
      if (running) rotate();
      const errors = (await Promise.all([...pending])).filter(
        (e): e is Error => e !== null,
      );
      const failed = errors[0];
      if (failed)
        return {
          kind: "unavailable",
          reason: `the profiler's trace could not be read: ${failed.message}`,
        };
      return reduceStallStacks({
        traces: kept,
        startedAt: draft.startedAt,
        endedAt: draft.endedAt,
        sampleIntervalMs: PROFILE.SAMPLE_INTERVAL_MS,
      });
    },
    dispose() {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (running) stop(running);
      running = null;
      kept = [];
    },
  };
}
