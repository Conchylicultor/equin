import { defineFileSink } from "@plugins/infra/plugins/file-sink/core";
import { buildProgressLogDir } from "@plugins/framework/plugins/cli/data-dirs";

// Host-global, exactly like the check-progress log next door
// (checks/core/progress-log.ts) and for the same reason: an incident is
// investigated from whichever shell is free, not from the wedged worktree.
// `runId` + `pid` + `worktree` on every line keep concurrent builds separable —
// and this box routinely runs several builds at once, one of which can wedge and
// pin the whole cpu-slot pool (see research/2026-07-21-global-cli-op-wedge-gc-sink.md).
export const PROGRESS_FILE = buildProgressLogDir.file("build-progress.jsonl");

// Same explicit 2 MB × keep 2 bound the check log chose (defineFileSink's 128 MB
// default is a firehose budget for the live-state channel, absurd here): a full
// build is well under a few hundred span lines, so this retains dozens of builds
// of real history. The bound is true by construction — `append()` IS the rotation.
const progressSink = defineFileSink({
  id: "build-progress",
  description:
    "Per-build progress log (`./singularity build`): one JSONL line per build " +
    "open, top-level span enter/leave (with RSS), 30s heartbeat, and completion — " +
    "so a wedged build names the phase it is stuck in AND whether its heap was " +
    "climbing. Host-global across worktrees.",
  path: PROGRESS_FILE,
  maxBytes: 2 * 1024 * 1024,
  keep: 2,
});

/** Heartbeat cadence: frequent enough to time a hang, rare enough to be free. */
const HEARTBEAT_MS = 30_000;

interface RecordBase {
  t: string;
  runId: string;
  pid: number;
  worktree: string;
}

/**
 * `enter`/`leave` carry `rssMb` (this process's resident set) because the wedge
 * this log exists to catch is a **GC/heap blowup**, not a stalled child — so the
 * culprit phase is named not only by `enter` without `leave` but by the RSS jump
 * across it. That heap dimension is the one deliberate addition over copying the
 * check-progress grammar verbatim.
 */
export type BuildProgressRecord =
  | (RecordBase & { phase: "run"; buildId: string | null; rssMb: number })
  | (RecordBase & {
      phase: "enter";
      token: number;
      id: string;
      step: string;
      label: string;
      rssMb: number;
    })
  | (RecordBase & {
      phase: "leave";
      token: number;
      id: string;
      durationMs: number;
      rssMb: number;
    })
  | (RecordBase & {
      phase: "pending";
      elapsedMs: number;
      inFlight: string[];
      rssMb: number;
      peakRssMb: number;
    })
  | (RecordBase & {
      phase: "done";
      success: boolean;
      elapsedMs: number;
      peakRssMb: number;
    });

function rssMb(): number {
  return Math.round(process.memoryUsage().rss / (1024 * 1024));
}

interface OpenRun {
  runId: string;
  pid: number;
  worktree: string;
  startedAt: number;
  /** Spans currently open, keyed by the profiler's per-span token. */
  inFlight: Map<number, { label: string; startedAt: number }>;
  heartbeat: ReturnType<typeof setInterval>;
  peakRssMb: number;
}

// Module-global single open build. buildProfilerStart is a module-level function
// in profiler.ts, so the progress it feeds is module-level too. Before
// openBuildProgress runs (early preflight spans) every marker is a no-op — the run
// gate below — which is why the fast pre-name preflight steps are simply not
// logged, and why importing this module has no effect until a build opts in.
let current: OpenRun | null = null;

/**
 * Append one record through the sink. `FileSink.append` is a single SYNCHRONOUS,
 * unbuffered `appendFileSync` (file-sink/core), so the line is on disk BEFORE the
 * next statement — surviving the SIGKILL that ends every real wedge, and surviving
 * a fully blocked event loop. That is the whole reason this is not the in-memory
 * `spans` array the profiler already keeps.
 */
function writeRecord(record: BuildProgressRecord): void {
  progressSink.append(JSON.stringify(record));
}

function stamp(): RecordBase {
  // `current` is guaranteed non-null at every writeRecord call site except the
  // `run` record, which passes its own identity in explicitly.
  const run = current!;
  return {
    t: new Date().toISOString(),
    runId: run.runId,
    pid: run.pid,
    worktree: run.worktree,
  };
}

/**
 * Open the build's progress run: mint the `run` record and arm the heartbeat.
 * Call ONCE, as early as the worktree `name` is known (build.ts computes
 * `basename(root)` — the SAME key the op marker and `writeBuildProfile` use, so
 * this log correlates with `ops/build.json` by worktree + pid). Idempotent: a
 * second call is ignored.
 */
export function openBuildProgress(
  worktree: string,
  buildId: string | null,
): void {
  if (current) return;
  const run: OpenRun = {
    runId: crypto.randomUUID(),
    pid: process.pid,
    worktree,
    startedAt: performance.now(),
    inFlight: new Map(),
    // Armed just below; real handle assigned before we return.
    heartbeat: undefined as unknown as ReturnType<typeof setInterval>,
    peakRssMb: rssMb(),
  };
  current = run;

  writeRecord({ ...stamp(), phase: "run", buildId, rssMb: run.peakRssMb });

  // `.unref()` so this timer can NEVER be the reason the process stays alive — the
  // heartbeat observes a hang, it must not cause one. (The wedge under study keeps
  // the loop alive via GC, not via this timer, but the discipline is non-negotiable.)
  run.heartbeat = setInterval(() => {
    const now = rssMb();
    if (now > run.peakRssMb) run.peakRssMb = now;
    if (run.inFlight.size === 0) return;
    writeRecord({
      ...stamp(),
      phase: "pending",
      elapsedMs: Math.round(performance.now() - run.startedAt),
      inFlight: [...run.inFlight.values()].map((s) => s.label),
      rssMb: now,
      peakRssMb: run.peakRssMb,
    });
  }, HEARTBEAT_MS);
  run.heartbeat.unref();
}

/**
 * Record a build span entering its body. Written synchronously BEFORE the body
 * runs. `token` is the profiler's per-span unique id (a monotonic counter), NOT
 * the human `id`, so concurrent spans that share an `id` never collide — the build
 * runs several spans in parallel (web artifacts, checks).
 */
export function buildProgressSpanStart(
  token: number,
  id: string,
  step: string,
  label: string,
): void {
  const run = current;
  if (!run) return;
  const now = rssMb();
  if (now > run.peakRssMb) run.peakRssMb = now;
  run.inFlight.set(token, { label, startedAt: performance.now() });
  writeRecord({
    ...stamp(),
    phase: "enter",
    token,
    id,
    step,
    label,
    rssMb: now,
  });
}

/**
 * Record a build span settling. Written from the profiler's `end` closure (which
 * itself is called in a `finally`), so a throwing span still lands its `leave`.
 * The set difference `enter − leave` (by token) is the wedge suspect.
 */
export function buildProgressSpanEnd(
  token: number,
  id: string,
  durationMs: number,
): void {
  const run = current;
  if (!run) return;
  if (!run.inFlight.delete(token)) return;
  writeRecord({
    ...stamp(),
    phase: "leave",
    token,
    id,
    durationMs,
    rssMb: rssMb(),
  });
}

/**
 * Write the terminal `done` record and stop the heartbeat. Call from the build's
 * single graceful-exit hook (`finalizeBuild`) with its success flag — a wedge is
 * precisely the run for which this NEVER fires, so the absence of a `done` (with
 * the pid still live) is the wedge signal, and `outstanding` names the stuck
 * phase. `success:false` here is a caught, graceful failure — categorically not a
 * wedge. Idempotent, mirroring `finalizeBuild`'s own guard.
 */
export function finishBuildProgress(success: boolean): void {
  const run = current;
  if (!run) return;
  clearInterval(run.heartbeat);
  writeRecord({
    ...stamp(),
    phase: "done",
    success,
    elapsedMs: Math.round(performance.now() - run.startedAt),
    peakRssMb: run.peakRssMb,
  });
  current = null;
}

/** One outstanding span: entered, never left. The hang suspect. */
export interface OutstandingSpan {
  label: string;
  startedAt: string;
  elapsedMs: number;
  /** RSS (MB) at the moment this span was entered. */
  rssMb: number;
}

/** A reconstructed build run, newest activity last. */
export interface BuildRunProgress {
  runId: string;
  pid: number;
  worktree: string;
  buildId: string | null;
  startedAt: string;
  lastActivityAt: string;
  /**
   * The last time the run demonstrably MOVED: its `run` record or a span
   * `enter`/`leave`. Unlike `lastActivityAt`, a `pending` heartbeat does not
   * advance it — the heartbeat is a timer, so it proves only that the process
   * exists, never that the build is getting anywhere (a build wedged on a hung
   * child keeps heartbeating).
   */
  lastAdvanceAt: string;
  /** Peak RSS seen across this run's markers/heartbeats. */
  peakRssMb: number;
  /** `enter − leave`: empty for a healthy run, the culprit set for a hung one. */
  outstanding: OutstandingSpan[];
  /** Present iff the run reached its `done` record (any graceful exit, not a wedge). */
  done: {
    at: string;
    success: boolean;
    elapsedMs: number;
    peakRssMb: number;
  } | null;
}

/**
 * Read the progress file and reconstruct each build run — mirror of
 * `readCheckProgress`. Tolerant by construction: lines from concurrent worktrees
 * interleave (grouped by `runId`), and a trailing partial line (the normal state
 * while a build is mid-write, i.e. exactly when a wedge is read) is skipped by
 * `readJsonlTail`. `includeRotated` because a build straddling a rotation would
 * otherwise lose its `run` line. Newest run first, by last activity.
 */
export function readBuildProgress(): BuildRunProgress[] {
  const result = progressSink.readJsonlTail<BuildProgressRecord>({
    includeRotated: true,
    maxBytes: 8 * 1024 * 1024,
  });
  if (result.kind === "missing") return [];
  return foldBuildProgress(result.records);
}

/**
 * The pure half of `readBuildProgress`: fold raw progress records (in file
 * order) into runs, newest activity first.
 */
export function foldBuildProgress(
  records: readonly BuildProgressRecord[],
): BuildRunProgress[] {
  const runs = new Map<string, BuildRunProgress>();
  const openByRun = new Map<
    string,
    Map<number, { label: string; at: string; rssMb: number }>
  >();

  for (const record of records) {
    if (record.phase === "run") {
      runs.set(record.runId, {
        runId: record.runId,
        pid: record.pid,
        worktree: record.worktree,
        buildId: record.buildId,
        startedAt: record.t,
        lastActivityAt: record.t,
        lastAdvanceAt: record.t,
        peakRssMb: record.rssMb,
        outstanding: [],
        done: null,
      });
      openByRun.set(record.runId, new Map());
      continue;
    }
    const run = runs.get(record.runId);
    if (!run) continue; // orphan line whose `run` rotated past the read budget
    run.lastActivityAt = record.t;
    const open = openByRun.get(record.runId);
    if (!open) continue;
    if (record.phase === "enter" || record.phase === "leave") {
      run.lastAdvanceAt = record.t;
    }
    if (record.phase === "enter") {
      if (record.rssMb > run.peakRssMb) run.peakRssMb = record.rssMb;
      open.set(record.token, {
        label: record.label,
        at: record.t,
        rssMb: record.rssMb,
      });
    } else if (record.phase === "leave") {
      open.delete(record.token);
    } else if (record.phase === "pending") {
      if (record.peakRssMb > run.peakRssMb) run.peakRssMb = record.peakRssMb;
    } else if (record.phase === "done") {
      if (record.peakRssMb > run.peakRssMb) run.peakRssMb = record.peakRssMb;
      run.done = {
        at: record.t,
        success: record.success,
        elapsedMs: record.elapsedMs,
        peakRssMb: record.peakRssMb,
      };
    }
  }

  for (const run of runs.values()) {
    const last = Date.parse(run.lastActivityAt);
    const open = openByRun.get(run.runId);
    run.outstanding = [...(open ?? new Map()).values()].map((s) => ({
      label: s.label,
      startedAt: s.at,
      elapsedMs: last - Date.parse(s.at),
      rssMb: s.rssMb,
    }));
  }

  return [...runs.values()].sort(
    (a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt),
  );
}
