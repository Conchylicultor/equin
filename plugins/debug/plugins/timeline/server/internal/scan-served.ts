import { serveValue } from "@plugins/network/plugins/live/server";
import {
  runInBackgroundLane,
  runWithoutProfiling,
} from "@plugins/infra/plugins/runtime-profiler/core";
import type { TimelineFrame } from "../../shared/frames";
import {
  TIMELINE_CELL_EVENT_CAP,
  timelineScan,
  type TimelineScan,
  type TimelineScanQuery,
} from "../../shared/scan";
import { produceTimeline } from "./produce";

/**
 * At most about this many pushes per scan: one per `ceil(total / N)` frames,
 * plus the `{ total }` frame and completion — a small fan-out pushes every
 * cell (live progress), a many-worktree host batches.
 */
const MAX_PUSHES = 40;

interface Scan {
  readonly state: TimelineScan;
  failed: unknown;
  /** Push the scan's tuple again — a no-op once nobody reads it. */
  push: () => void;
  sincePush: number;
  pushEvery: number;
}

/** The scans a subscriber holds, by question. */
const held = new Map<string, Scan>();

function keyOf(q: TimelineScanQuery): string {
  return `${q.lookbackMs}@${q.at}`;
}

/** The window `q` names, or `null` when it names none. */
function windowOf(
  q: TimelineScanQuery,
): { fromMs: number; toMs: number } | null {
  if (q.lookbackMs <= 0 || q.at - q.lookbackMs <= 0) return null;
  return { fromMs: q.at - q.lookbackMs, toMs: q.at };
}

/** Fold one producer frame into the scan's state. */
function fold(state: TimelineScan, frame: TimelineFrame): void {
  if ("total" in frame) {
    state.total = frame.total;
    return;
  }
  if ("end" in frame) return;
  if ("health" in frame) {
    state.health.push(frame.health);
    return;
  }
  const chunk = frame.chunk;
  state.done += 1;
  if (!chunk.ok) {
    state.cells.push(chunk);
    return;
  }
  // An empty cell adds no lane: counted, not kept.
  if (chunk.events.length === 0) return;
  const newest = [...chunk.events]
    .sort((a, b) => b.startMs - a.startMs)
    .slice(0, TIMELINE_CELL_EVENT_CAP);
  state.cells.push({
    ...chunk,
    events: newest,
    omitted: chunk.events.length - newest.length,
  });
}

/**
 * Start the fan-out for `q`'s window, pushing through `push` as frames land
 * (batched to about {@link MAX_PUSHES}) and once more when it completes or
 * fails. Runs under the background lane with profiling suppressed —
 * observability never feeds the profiler or rides the interactive lane.
 */
function startScan(
  window: { fromMs: number; toMs: number },
  push: () => void,
): Scan {
  const scan: Scan = {
    state: {
      ...window,
      total: null,
      done: 0,
      complete: false,
      cells: [],
      health: [],
    },
    failed: undefined,
    push,
    sincePush: 0,
    pushEvery: 1,
  };
  const emit = (frame: TimelineFrame): void => {
    fold(scan.state, frame);
    if ("total" in frame) {
      scan.pushEvery = Math.max(1, Math.ceil(frame.total / MAX_PUSHES));
      scan.push();
      return;
    }
    if (++scan.sincePush >= scan.pushEvery) {
      scan.sincePush = 0;
      scan.push();
    }
  };
  void runInBackgroundLane(() =>
    runWithoutProfiling(async () => {
      try {
        await produceTimeline(emit, window.fromMs, window.toMs);
        scan.state.complete = true;
      } catch (err) {
        // A whole-scan failure (the fork list unreadable): the read rethrows it.
        scan.failed = err;
      }
      scan.push();
    }),
  );
  return scan;
}

/** The scan's answer as it stands — or its failure. */
function answerOf(scan: Scan): TimelineScan {
  if (scan.failed !== undefined) throw scan.failed;
  const { state } = scan;
  return { ...state, cells: [...state.cells], health: [...state.health] };
}

/**
 * The timeline scan, external `"notified"`: the truth is a fan-out over every
 * live fork DB and every worktree's log files, run ONCE per question (a
 * window frozen at `at`) while a reader holds it — the scan starts on the
 * question's first subscriber and its frames push the value forward (as
 * patches: every list is append-only) until it completes; then nothing moves
 * it. A later look is a new question. Dropped at the last unsubscribe (a
 * fan-out still running finishes into nothing). The loader only reads the
 * held scan — the fan-out (fork list included) is the subscription's, never
 * a load's — so a read with no subscription behind it fails loud.
 */
export const timelineScanServed = serveValue(timelineScan, {
  source: "external",
  changes: "notified",
  loader: (q) => {
    const window = windowOf(q);
    if (window === null)
      throw timelineScan.refuse(
        "invalid-window",
        `no window ends at ${q.at} reaching back ${q.lookbackMs} ms`,
      );
    const scan = held.get(keyOf(q));
    if (scan === undefined)
      throw new Error(
        `no timeline scan is open for ${keyOf(q)} — a scan is read through a subscription, whose first subscriber starts it`,
      );
    return answerOf(scan);
  },
  whileSubscribed: (q, notify) => {
    const window = windowOf(q);
    // The loader refuses the question; there is nothing to scan.
    if (window === null) return () => {};
    const key = keyOf(q);
    let reading = true;
    const scan = startScan(window, () => {
      if (reading) notify();
    });
    held.set(key, scan);
    return () => {
      reading = false;
      if (held.get(key) === scan) held.delete(key);
    };
  },
});
