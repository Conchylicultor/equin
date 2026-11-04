import {
  ACTIVE_FINDINGS_MAX,
  MONITOR_INTERVAL_MS,
  createIoHealthDetector,
  findingKey,
  type Finding,
  type IoHealth,
  type MonitorTick,
} from "../../core";
import type { LogCursor, TailRead } from "./log-tail";

/** A finding still holding is recorded again after this long, so its report row's last-seen time says it is still going. */
export const RERECORD_MS = 60 * 60_000;

/**
 * Findings are filed only while the log is live: its newest tick at most this
 * old. A backend booting onto a log the monitor stopped writing hours ago
 * shows those findings (the row says the monitor stopped) but files nothing
 * about a past it cannot see the end of.
 */
export const FRESH_TICK_MS = 5 * MONITOR_INTERVAL_MS;

export interface IoHealthStateDeps {
  read(cursor: LogCursor | null): Promise<TailRead>;
  /** File one finding as a report. Only called where `files` is true. */
  record(finding: Finding): Promise<void>;
  /** Whether this backend files reports (main only: the log is host-global). */
  files: boolean;
  now(): number;
}

export interface IoHealthState {
  /** Read what the monitor appended since the last refresh, re-evaluate, file, notify. Serialize calls. */
  refresh(): Promise<void>;
  /** The value as of the last refresh; null before the first one completed. */
  current(): IoHealth | null;
  /** Run `fn` after every refresh that changed the value. Returns the unsubscribe. */
  subscribe(fn: () => void): () => void;
}

function toValue(last: MonitorTick, findings: Finding[]): IoHealth {
  return {
    monitor: "present",
    latest: {
      at: Math.round(last.t * 1000),
      maxOpMs: last.max_op_ms,
      readOpsS: last.disk_read_ops_s ?? null,
      msPerOp: last.disk_read_ms_per_op ?? null,
      load1: last.load1,
    },
    root: last.disk_readers_mb_s !== undefined,
    findings: findings.slice(0, ACTIVE_FINDINGS_MAX),
  };
}

/**
 * The io-health state of one backend: a cursor into the monitor's log, the
 * detector over what it read, and the reports filed for its findings. Every
 * input comes through `deps`, so a test drives it with no disk and no engine.
 *
 * A read that restarts at the log's tail (a replaced or truncated file, a
 * gap) hands the detector ticks it has already seen; the detector drops those
 * as not newer than its last, so overlap costs nothing.
 */
export function createIoHealthState(deps: IoHealthStateDeps): IoHealthState {
  let cursor: LogCursor | null = null;
  let detector = createIoHealthDetector();
  let value: IoHealth | null = null;
  const recordedAt = new Map<string, number>();
  const listeners = new Set<() => void>();

  async function file(findings: Finding[], last: MonitorTick): Promise<void> {
    const keys = new Set(findings.map(findingKey));
    for (const k of recordedAt.keys()) if (!keys.has(k)) recordedAt.delete(k);
    const lastAt = last.t * 1000;
    if (!deps.files || deps.now() - lastAt > FRESH_TICK_MS) return;
    for (const f of findings) {
      const k = findingKey(f);
      const prev = recordedAt.get(k);
      if (prev !== undefined && lastAt - prev < RERECORD_MS) continue;
      recordedAt.set(k, lastAt);
      await deps.record(f);
    }
  }

  return {
    async refresh() {
      const r = await deps.read(cursor);
      let next: IoHealth;
      if (r.kind === "missing") {
        cursor = null;
        detector = createIoHealthDetector();
        recordedAt.clear();
        next = { monitor: "missing" };
      } else {
        cursor = r.cursor;
        for (const tick of r.ticks) detector.push(tick);
        const last = detector.last();
        if (last === null) {
          // An empty log: installed, and not one tick written yet.
          next = { monitor: "missing" };
        } else {
          const findings = detector.active();
          await file(findings, last);
          next = toValue(last, findings);
        }
      }
      const changed = JSON.stringify(next) !== JSON.stringify(value);
      value = next;
      if (changed) for (const fn of listeners) fn();
    },
    current: () => value,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
