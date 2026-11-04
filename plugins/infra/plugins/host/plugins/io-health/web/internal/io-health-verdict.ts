import type {
  ResourceResult,
  ResourceUnavailable,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import { MONITOR_INTERVAL_MS, type IoHealth } from "../../core";

/**
 * How old the monitor's newest tick may be before the row says it stopped:
 * six missed 30 s ticks. A tick can take a few seconds on a slow disk and
 * launchd skips a tick while the previous still runs, so one or two missing
 * ticks are not news; three minutes of silence is.
 */
export const MONITOR_STALE_MS = 6 * MONITOR_INTERVAL_MS;

export interface IoHealthVerdict {
  status: HealthStatus;
  /** The next instant the verdict changes on its own (the newest tick going stale), or null. */
  nextChangeAt: number | null;
}

/** The read the row folds: `useLive(hostIoHealth)`'s result. */
export type IoHealthRead = ResourceResult<IoHealth> | ResourceUnavailable;

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The Disk I/O row:
 *
 * - loading → `unknown` ("Checking…"), never green before the read lands;
 * - unavailable (no computer behind this host) → `not-applicable`;
 * - the monitor's log missing → `attention`: disk health is not watched at
 *   all, which must not read as "all good";
 * - its newest tick older than {@link MONITOR_STALE_MS} → `attention`: the
 *   monitor stopped, and what the log says is history;
 * - a finding holding → its severity (a metadata stall is `critical`), the
 *   first finding's sentence (+N more);
 * - otherwise `ok`, with the device's time per read op as of the newest tick.
 */
export function ioHealthVerdict(
  read: IoHealthRead,
  now: number,
): IoHealthVerdict {
  switch (read.status) {
    case "loading":
      return { status: { state: "unknown" }, nextChangeAt: null };
    case "error":
      return {
        status: {
          state: "unknown",
          summary: "Couldn't load the disk health monitor's state",
        },
        nextChangeAt: null,
      };
    case "unavailable":
      return {
        status: { state: "not-applicable", summary: read.message },
        nextChangeAt: null,
      };
    case "ready":
      break;
  }
  const v = read.data;
  if (v.monitor === "missing") {
    return {
      status: {
        state: "attention",
        summary:
          "Disk health is not watched: the fs-latency monitor is not installed (sidequests/monitors/fs-latency)",
      },
      nextChangeAt: null,
    };
  }
  const staleAt = v.latest.at + MONITOR_STALE_MS;
  if (now >= staleAt) {
    return {
      status: {
        state: "attention",
        summary: `Disk health is not watched: the fs-latency monitor has written nothing since ${clock(v.latest.at)}`,
      },
      nextChangeAt: null,
    };
  }
  const [first, ...rest] = v.findings;
  if (first !== undefined) {
    const worst = v.findings.some((f) => f.severity === "critical")
      ? "critical"
      : "attention";
    const more = rest.length > 0 ? ` (+${rest.length} more)` : "";
    return {
      status: { state: worst, summary: `${first.summary}${more}` },
      nextChangeAt: staleAt,
    };
  }
  const ms = v.latest.msPerOp;
  return {
    status: {
      state: "ok",
      summary:
        ms === null
          ? `Disk healthy (as of ${clock(v.latest.at)})`
          : `Disk healthy: ${ms.toFixed(2)} ms per read op (as of ${clock(v.latest.at)})`,
    },
    nextChangeAt: staleAt,
  };
}
