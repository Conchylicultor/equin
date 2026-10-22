import { samplingProfilerStackTraces, startSamplingProfiler } from "bun:jsc";
import {
  createActivityLog,
  processActivityLog,
  type ActivityLog,
  type ThreadActivity,
} from "./activity";

// The ONE owner of bun:jsc's sampling profiler. Everything a caller would
// otherwise re-learn about the API lives here, once:
//
// - It runs on its OWN thread, so it keeps sampling the armed thread's JS stack
//   DURING a synchronous block — the exact window where an on-demand "start
//   profiling" request could never be processed. That is the whole point.
// - It samples ONLY the thread/VM that armed it. A Worker busy for 600 ms added
//   zero samples to the main thread's buffer, so off-thread work is invisible
//   here by construction, not free.
// - `startSamplingProfiler(optionalDirectory?)`'s only argument is an output
//   DIRECTORY. It is not a sample interval; passing a number is meaningless, so
//   it is called with none.
// - There is NO stop. Arming is a one-way latch for the process's lifetime; a
//   consumer that is done simply stops reading, and the sampler thread idles.
// - Reading `samplingProfilerStackTraces()` DRAINS the buffer: it returns only
//   the samples taken since the previous read. A reader that drains once per
//   tick therefore gets exactly the samples of that tick's window, and after a
//   block the late tick gets the whole block. It is also why this plugin
//   refuses a second owner (see `claimStackSampler`).
// - The observed rate varies — ~40 Hz in a CLI probe, ~230 Hz on the main
//   backend — and the returned `interval` (0.001) does not describe it. A
//   consumer derives the rate from samples / window; never assume one.
// - An idle thread yields NO traces at all (not empty ones): one second parked
//   in the event loop drained zero samples.
//
// `samplingProfilerStackTraces` exists at runtime but is absent from bun-types
// (1.3.x), so it is declared in `./bun-jsc.d.ts`.

// JSC marks "no line / no column" with this sentinel (0xFFFFFFFF). Normalized
// to `null` here so no caller compares against a magic number.
const NO_LINE = 4_294_967_295;

export interface StackFrame {
  /** The raw JSC function name; may be `""` for an anonymous function. */
  name: string;
  /**
   * The frame's source file, or `null` when JSC gave none (native and runtime
   * frames). Paths come back fully realpath-resolved — `/private/tmp/…` for a
   * `/tmp/…` checkout — so a caller stripping a root must try its realpath too.
   */
  sourceURL: string | null;
  /** The sample's EXECUTING line (not the function's declaration line), or `null`. */
  line: number | null;
  column: number | null;
  /** JSC's tier / executable kind, e.g. `LLInt`, `FTL`, `Unknown Executable`; `native` if absent. */
  category: string;
}

/**
 * One sample of the armed thread's stack. `frames` run innermost → outermost,
 * and they are the PHYSICAL stack only: an async function resumed after an
 * `await` has only itself on it (its caller is absent), and module evaluation
 * from `await import()` reads `(module)@file ← evaluate ← moduleEvaluation ←
 * requestImportModule` with no importer. `timestamp` is JSC's own clock
 * (seconds, monotonic) — not `Date.now()`.
 */
export interface JscSample {
  timestamp: number;
  frames: StackFrame[];
}

/** A drained sample: JSC's own, plus the activity running when it was taken. */
export interface StackSample extends JscSample {
  /**
   * The `withThreadActivity` interval this sample fell in (innermost when they
   * nest), or null — none was running, or the sample's time could not be placed
   * on `performance.now()` (see `createSampleClock`).
   */
  activity: ThreadActivity | null;
}

export interface StackSampler {
  /** Every sample since the previous drain (the read empties JSC's buffer). */
  drain(): StackSample[];
}

// The two bun:jsc calls, as a seam: `createStackSamplerClaim` is the claim
// logic, and the process-wide `claimStackSampler` below is that logic bound to
// the real profiler. Tests exercise the logic against a fake — `bun test` runs
// every test file in ONE process, so a test claiming the real sampler under its
// own owner would make every other file's claim throw.
interface SamplerBackend {
  start(): void;
  read(): unknown;
}

/**
 * Places a sample's JSC `timestamp` on `performance.now()`.
 *
 * The two are different clocks (measured, Bun 1.4 on macOS): JSC stamps samples
 * in seconds of the system's monotonic time, `performance.now()` counts ms from
 * process start, and no JS API reads the former. Both advance together, so they
 * differ by one constant offset — which each drain BRACKETS without a probe: a
 * sample in a batch was taken after the previous drain and before this one, so
 * `T − drain ≤ offset ≤ T − previousDrain` for every sample `T`. The bounds from
 * every batch are intersected; while the thread is busy across a drain (which is
 * exactly when naming samples matters) they close to about one sample period.
 *
 * If the bounds ever cross — the clocks did not advance together after all — the
 * estimate restarts from the current batch alone rather than trusting a stale
 * one, and a batch whose own bounds cross places nothing (`toMs` → null).
 */
export function createSampleClock(): {
  observe(
    previousDrainMs: number,
    drainMs: number,
    samples: readonly JscSample[],
  ): void;
  toMs(timestampSeconds: number): number | null;
} {
  let lower = -Infinity;
  let upper = Infinity;
  let valid = false;
  return {
    observe(previousDrainMs, drainMs, samples) {
      if (samples.length === 0) return;
      let batchLower = -Infinity;
      let batchUpper = Infinity;
      for (const sample of samples) {
        const ms = sample.timestamp * 1000;
        batchLower = Math.max(batchLower, ms - drainMs);
        batchUpper = Math.min(batchUpper, ms - previousDrainMs);
      }
      if (batchLower > batchUpper) {
        valid = false;
        return;
      }
      const nextLower = Math.max(lower, batchLower);
      const nextUpper = Math.min(upper, batchUpper);
      if (nextLower > nextUpper) {
        lower = batchLower;
        upper = batchUpper;
      } else {
        lower = nextLower;
        upper = nextUpper;
      }
      valid = true;
    },
    toMs(timestampSeconds) {
      if (!valid) return null;
      return timestampSeconds * 1000 - (lower + upper) / 2;
    },
  };
}

export function createStackSamplerClaim(
  backend: SamplerBackend,
  options: { now?: () => number; activities?: ActivityLog } = {},
): (owner: string) => StackSampler {
  const now = options.now ?? (() => performance.now());
  const activities = options.activities ?? createActivityLog();
  let claimed: { owner: string; sampler: StackSampler } | null = null;
  return (owner) => {
    if (claimed) {
      if (claimed.owner === owner) return claimed.sampler;
      throw new Error(
        `stack-sampler: "${owner}" cannot claim the JSC sampling profiler — "${claimed.owner}" ` +
          `already owns it in this process. Every samplingProfilerStackTraces() read EMPTIES ` +
          `the shared buffer, so two readers would each silently get a share of the samples. ` +
          `Route both consumers through the one owner instead.`,
      );
    }
    backend.start();
    activities.arm();
    const clock = createSampleClock();
    let previousDrainMs = now();
    const sampler: StackSampler = {
      drain: () => {
        const raw = normalizeTraces(backend.read());
        const drainMs = now();
        clock.observe(previousDrainMs, drainMs, raw);
        const samples = raw.map((sample): StackSample => {
          const ms = clock.toMs(sample.timestamp);
          return {
            ...sample,
            activity:
              ms === null
                ? null
                : activities.at(
                    Math.min(drainMs, Math.max(previousDrainMs, ms)),
                  ),
          };
        });
        // Every later sample is taken after this drain, so an activity that
        // ended before it can never match again.
        activities.prune(drainMs);
        previousDrainMs = drainMs;
        return samples;
      },
    };
    claimed = { owner, sampler };
    return sampler;
  };
}

const claimProcessSampler = createStackSamplerClaim(
  {
    start: () => startSamplingProfiler(),
    read: () => samplingProfilerStackTraces(),
  },
  { activities: processActivityLog },
);

/**
 * Arm this thread's JSC sampling profiler (first call only — it cannot be
 * disarmed) and return its single reader. The same `owner` again gets the same
 * handle; a DIFFERENT owner in the same process throws, because each drain
 * empties the buffer both would be reading.
 */
export function claimStackSampler(owner: string): StackSampler {
  return claimProcessSampler(owner);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function lineOrNull(value: unknown): number | null {
  return typeof value === "number" && value !== NO_LINE ? value : null;
}

function normalizeFrame(raw: unknown): StackFrame {
  if (!isRecord(raw))
    throw new TypeError(
      `stack-sampler: a JSC frame is not an object: ${String(raw)}`,
    );
  return {
    name: typeof raw.name === "string" ? raw.name : "",
    sourceURL:
      typeof raw.sourceURL === "string" && raw.sourceURL.length > 0
        ? raw.sourceURL
        : null,
    line: lineOrNull(raw.line),
    column: lineOrNull(raw.column),
    category:
      typeof raw.category === "string" && raw.category.length > 0
        ? raw.category
        : "native",
  };
}

/**
 * The raw `samplingProfilerStackTraces()` result → typed samples. Pure (exported
 * for tests). A trace with no frames is dropped; a result that is not the shape
 * above throws, so a Bun API change is loud rather than an empty profile.
 */
export function normalizeTraces(raw: unknown): JscSample[] {
  if (!isRecord(raw) || !Array.isArray(raw.traces)) {
    throw new TypeError(
      "stack-sampler: samplingProfilerStackTraces() returned no `traces` array",
    );
  }
  const samples: JscSample[] = [];
  for (const trace of raw.traces) {
    if (!isRecord(trace))
      throw new TypeError(
        `stack-sampler: a JSC trace is not an object: ${String(trace)}`,
      );
    if (!Array.isArray(trace.frames) || trace.frames.length === 0) continue;
    if (typeof trace.timestamp !== "number") {
      throw new TypeError(
        "stack-sampler: a JSC trace has no numeric `timestamp`",
      );
    }
    samples.push({
      timestamp: trace.timestamp,
      frames: trace.frames.map(normalizeFrame),
    });
  }
  return samples;
}

/**
 * A frame's identity key. A JS frame with a source and a line →
 * `name @ path:line`; anything else (native, runtime, no line) →
 * `name [category]`. An empty name reads `(anonymous)`. `shorten` rewrites the
 * path (e.g. relative to a root); identity by default.
 */
export function frameKey(
  frame: StackFrame,
  shorten: (sourceURL: string) => string = (s) => s,
): string {
  const name = frame.name.length > 0 ? frame.name : "(anonymous)";
  if (frame.sourceURL !== null && frame.line !== null) {
    return `${name} @ ${shorten(frame.sourceURL)}:${frame.line}`;
  }
  return `${name} [${frame.category.length > 0 ? frame.category : "native"}]`;
}
