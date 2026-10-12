import { useSyncExternalStore } from "react";
import { clientLog } from "@plugins/primitives/plugins/log-channels/web";
import {
  RENDER_PROFILER_CHANNEL,
  type CommitSample,
  type HookChange,
  type InitiatorStat,
  type ProfilerReport,
  type ProfilerStartOptions,
  type RemountStat,
} from "../../core";
import type { Fiber, FiberRoot } from "./react-types";
import {
  collectCommit,
  getComponentName,
  type PositionOccupant,
} from "./fiber-walk";
import { classifyHookChanges } from "./hook-classify";
import { isExcludedFiber } from "./global-api";

const DEFAULT_MAX_DURATION_MS = 30_000;
/** Commits kept in the per-commit log; the aggregates keep counting past it. */
const COMMIT_LOG_CAP = 2_000;
/** Cap the recompute/notify cadence to ~4×/s — NOT a polling loop. */
const FLUSH_INTERVAL_MS = 250;

// ---- Module-level session state -------------------------------------------

const stats = new Map<string, InitiatorStat>();
// Remount aggregation, keyed by positionKey (a different identity space from the
// initiator signature — a position with a from→to type, not a single component).
const remounts = new Map<string, RemountStat>();
// Previous commit's recorded position occupants; diffed against each commit's
// positions to detect remounts. Swapped EVERY commit (not on the throttled
// flush) or the diff goes stale and reports phantom remounts.
let prevPositions = new Map<string, PositionOccupant>();
// Previous commit's component fibers by identity; threaded into collectCommit so
// it can tell a genuine render from a stale PerformedWork flag on a persisted
// (bailed/skipped) fiber. Swapped EVERY commit, like prevPositions.
let prevSeen = new WeakSet<Fiber>();
// The first observed commit only seeds the baselines (prevSeen / prevPositions):
// with no prior tree we cannot tell a genuine render from a fiber that already
// carried PerformedWork before the session started, so we attribute nothing for
// it and report accurately from the second commit on.
let primed = false;
let remountTruncated = false;
let totalCommits = 0;
const commitLog: CommitSample[] = [];
let commitLogTruncated = false;
let startedAtMs: number | null = null;
let running = false;
let maxDurationMs = DEFAULT_MAX_DURATION_MS;
let bridgeMissing = false;
let autoStopHandle: ReturnType<typeof setTimeout> | null = null;
let lastFlushMs = 0;

// External-store wiring: a stable cached snapshot so useSyncExternalStore never
// loops; we only replace the cached object on flush.
const subscribers = new Set<() => void>();
// eslint-disable-next-line scoped-store/no-module-mutable-store -- intentionally page-global: a profiling session observes the single React fiber root + the single window.__REACT_DEVTOOLS_GLOBAL_HOOK__ commit stream for the whole page; per-surface scoping would fragment one global commit stream and is semantically wrong.
let cachedReport: ProfilerReport = emptyReport();

function emptyReport(): ProfilerReport {
  return {
    running: false,
    startedAtMs: null,
    durationMs: 0,
    totalCommits: 0,
    commitsPerSec: 0,
    initiators: [],
    remounts: [],
    commits: [],
  };
}

function signatureFor(
  componentName: string,
  ancestorPath: string[],
  changedHooks: HookChange[],
): string {
  return (
    ancestorPath.join(">") +
    "|" +
    componentName +
    "|" +
    changedHooks.map((h) => h.kind + "#" + h.index).join(",")
  );
}

/**
 * Elapsed session time used as the denominator for /s rates. Floored at 1s so
 * the first sub-second commit doesn't divide by ~0 and report an absurd spike
 * (e.g. "714/s"); within the first second a rate reads as the raw count, then
 * becomes exact. Not used for the displayed duration, which stays precise.
 */
function elapsedSecondsForRate(): number {
  if (startedAtMs == null) return 1;
  return Math.max(1, (performance.now() - startedAtMs) / 1000);
}

function computeReport(): ProfilerReport {
  const secs = elapsedSecondsForRate();
  const initiators = Array.from(stats.values())
    .map((s): InitiatorStat => ({
      ...s,
      // Rate over the whole session elapsed time (stable; a per-initiator
      // first→last window oscillates wildly for bursty initiators).
      ratePerSec: s.commitCount / secs,
    }))
    .sort((a, b) => b.commitCount - a.commitCount);

  const remountStats = Array.from(remounts.values()).sort(
    (a, b) => b.count - a.count,
  );

  return {
    running,
    startedAtMs,
    durationMs: startedAtMs == null ? 0 : performance.now() - startedAtMs,
    totalCommits,
    commitsPerSec: totalCommits / secs,
    initiators,
    remounts: remountStats,
    remountTruncated: remountTruncated || undefined,
    commits: commitLog.slice(),
    commitLogTruncated: commitLogTruncated || undefined,
    bridgeMissing: bridgeMissing || undefined,
  };
}

function flush(): void {
  cachedReport = computeReport();
  subscribers.forEach((cb) => cb());
}

function maybeFlush(): void {
  const now = performance.now();
  if (now - lastFlushMs >= FLUSH_INTERVAL_MS) {
    lastFlushMs = now;
    flush();
  }
}

interface CommitInitiator {
  componentName: string;
  ancestorPath: string[];
  changedHooks: HookChange[];
  /** True when this signature's fiber freshly mounted this commit. */
  isMount: boolean;
  /** Fibers rendered under this signature's instances this commit. */
  rendered: number;
}

function onCommit(root: FiberRoot): void {
  if (!running) return;

  const {
    initiators,
    currentPositions,
    remounts: detected,
    truncated,
    rendered,
    currentSeen,
  } = collectCommit(root, prevPositions, prevSeen);

  // Swap the per-commit baselines EVERY commit (not on the throttled flush), or
  // the diffs go stale and report phantom renders / remounts.
  prevSeen = currentSeen;

  // First observed commit: seed baselines only, attribute nothing (see `primed`).
  if (!primed) {
    primed = true;
    prevPositions = currentPositions;
    return;
  }

  // One commit per onCommit call — the headline "commits/s" rate.
  totalCommits += 1;
  if (truncated) remountTruncated = true;

  // Dedupe by signature WITHIN this commit: a repeated list row (e.g. 180
  // SortableItem fibers) shares one signature and must count as ONE commit for
  // that initiator (not 180), or commitCount would exceed totalCommits and the
  // per-initiator rate would be meaningless. We keep the per-commit fiber count
  // as `instanceCount` — a separate, useful signal.
  const perCommit = new Map<string, CommitInitiator & { instances: number }>();
  for (const { fiber, ancestorPath, isMount, rendered: under } of initiators) {
    if (isExcludedFiber(fiber)) continue;
    const componentName = getComponentName(fiber);
    const changedHooks = classifyHookChanges(fiber).filter((h) => h.changed);
    const signature = signatureFor(componentName, ancestorPath, changedHooks);
    const seen = perCommit.get(signature);
    if (seen) {
      seen.instances += 1;
      seen.rendered += under;
      // The signature counts as a mount for this commit if any instance mounted.
      if (isMount) seen.isMount = true;
    } else {
      perCommit.set(signature, {
        componentName,
        ancestorPath,
        changedHooks,
        isMount,
        instances: 1,
        rendered: under,
      });
    }
  }

  const now = performance.now();
  if (commitLog.length < COMMIT_LOG_CAP)
    commitLog.push({
      atMs: now,
      rendered,
      initiators: [...perCommit.values()]
        .map((i) => ({ name: i.componentName, rendered: i.rendered }))
        .sort((a, b) => b.rendered - a.rendered),
    });
  else commitLogTruncated = true;
  for (const [signature, info] of perCommit) {
    const existing = stats.get(signature);
    if (existing) {
      existing.commitCount += 1;
      if (info.isMount) existing.mountCount += 1;
      else existing.updateCount += 1;
      existing.instanceCount = info.instances;
      existing.fibersRendered += info.rendered;
      existing.lastSeenMs = now;
      existing.changedHooks = info.changedHooks;
      existing.ancestorPath = info.ancestorPath;
    } else {
      stats.set(signature, {
        signature,
        componentName: info.componentName,
        ancestorPath: info.ancestorPath,
        commitCount: 1,
        mountCount: info.isMount ? 1 : 0,
        updateCount: info.isMount ? 0 : 1,
        instanceCount: info.instances,
        fibersRendered: info.rendered,
        ratePerSec: 0,
        firstSeenMs: now,
        lastSeenMs: now,
        changedHooks: info.changedHooks,
      });
    }
  }

  // Aggregate remounts by positionKey: bump the count and refresh from/to/cause
  // to the most recent occurrence.
  for (const r of detected) {
    const existing = remounts.get(r.positionKey);
    if (existing) {
      existing.count += 1;
      existing.fromType = r.fromType;
      existing.toType = r.toType;
      existing.cause = r.cause;
      existing.ancestorPath = r.ancestorPath;
    } else {
      remounts.set(r.positionKey, {
        positionKey: r.positionKey,
        ancestorPath: r.ancestorPath,
        fromType: r.fromType,
        toType: r.toType,
        cause: r.cause,
        count: 1,
      });
    }
  }

  // Swap the position snapshot EVERY commit (not on the throttled flush), or the
  // diff goes stale and reports phantom remounts.
  prevPositions = currentPositions;

  maybeFlush();
}

function bridgeSubscribers(): Set<(root: FiberRoot) => void> | undefined {
  return window.__REACT_DEVTOOLS_GLOBAL_HOOK__?.__commitSubscribers;
}

export function startSession(opts?: ProfilerStartOptions): void {
  if (running) return;
  stats.clear();
  remounts.clear();
  prevPositions = new Map();
  prevSeen = new WeakSet();
  primed = false;
  remountTruncated = false;
  totalCommits = 0;
  commitLog.length = 0;
  commitLogTruncated = false;
  bridgeMissing = false;
  maxDurationMs = opts?.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  startedAtMs = performance.now();
  lastFlushMs = 0;
  running = true;

  const subs = bridgeSubscribers();
  if (subs) {
    subs.add(onCommit);
  } else {
    // The passive bridge in index.html was not installed (frontend not rebuilt).
    bridgeMissing = true;
  }

  // One-shot session cap. This is an upper bound, NOT an interval-based polling
  // loop (the no-polling rule forbids interval change-checking, not a timed cap).
  if (autoStopHandle) clearTimeout(autoStopHandle);
  autoStopHandle = setTimeout(stopSession, maxDurationMs);

  flush();
}

export function stopSession(): void {
  if (!running) {
    return;
  }
  const subs = bridgeSubscribers();
  subs?.delete(onCommit);
  if (autoStopHandle) {
    clearTimeout(autoStopHandle);
    autoStopHandle = null;
  }
  running = false;
  flush();

  // Dump the final ranked report to the per-worktree JSONL so headless/agent
  // runs can read root-cause without the UI. clientLog is fire-and-forget (void).
  clientLog(
    RENDER_PROFILER_CHANNEL,
    JSON.stringify({ type: "report", ...cachedReport }),
  );
}

export function getReport(): ProfilerReport {
  // Recompute on demand so an imperative getReport() reflects the latest stats
  // even between throttled flushes; keep the cache in sync.
  cachedReport = computeReport();
  return cachedReport;
}

export function isRunning(): boolean {
  return running;
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

function getSnapshot(): ProfilerReport {
  return cachedReport;
}

/** React hook the pane uses to re-render on each throttled flush. */
export function useProfilerReport(): ProfilerReport {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
