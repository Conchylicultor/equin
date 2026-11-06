import { useLive } from "@plugins/network/plugins/live/web";
import {
  foldResource,
  type ResourceResult,
  useNotificationsChannelStatuses,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import {
  queuePulse,
  queueVerdictValue,
  type QueuePulse,
  type QueueVerdict,
} from "../../core";

/**
 * What the Job queue row can say about the queue right now. A union rather
 * than a nullable value, so "not known" can never be drawn as an empty queue:
 * a bar has to be told which of these it is showing.
 */
export type QueueRead<T> =
  /** This worktree's server socket is down: whatever we hold is stale. */
  | { kind: "disconnected" }
  /** Not loaded yet (or the socket is making its first connection). */
  | { kind: "loading" }
  /** The server answered with an error. */
  | { kind: "error" }
  | { kind: "ready"; value: T };

export type QueuePulseRead = QueueRead<QueuePulse>;

/**
 * A queue value, as a read. One live subscription, pushed by the server on
 * queue activity and at threshold crossings — never fetched here.
 *
 * The socket is checked first because a push resource goes silent, not empty,
 * when the socket drops: the last value stays in the cache and would go on
 * claiming "3 running" about a server nobody can hear. A socket still making
 * its FIRST connection is not "disconnected" — that is boot, and it reads as
 * loading ("Checking…"), like any row whose probe has not reported.
 */
function useQueueRead<T>(result: ResourceResult<T>): QueueRead<T> {
  const socket = useNotificationsChannelStatuses().worktree;
  if (socket === "closed" || socket === "reconnecting") {
    return { kind: "disconnected" };
  }
  if (socket === "connecting") return { kind: "loading" };
  return foldResource<typeof result, QueueRead<T>>(result, {
    loading: () => ({ kind: "loading" }),
    error: () => ({ kind: "error" }),
    ready: (value) => ({ kind: "ready", value }),
  });
}

/** The full pulse — for the glance and detail, which render only while the
 * report is open, so only an open report holds this subscription. */
export function useQueuePulse(): QueuePulseRead {
  return useQueueRead(useLive(queuePulse));
}

/** The status a read gives the row. Pure, so the mapping is testable alone. */
export function queueHealthStatus(read: QueueRead<QueueVerdict>): HealthStatus {
  switch (read.kind) {
    case "disconnected":
      return { state: "unknown", summary: "Unknown while disconnected" };
    case "loading":
      return { state: "unknown" };
    case "error":
      return { state: "unknown", summary: "Could not read the queue" };
    case "ready":
      return { state: read.value.state, summary: read.value.summary };
  }
}

/**
 * The Job queue row's `useStatus`. Called on every render of the report's host,
 * open or not — it is what colours the dot — so it subscribes to the verdict
 * alone (`queueVerdictValue`), never the full pulse.
 */
export function useQueueHealth(): HealthStatus {
  return queueHealthStatus(useQueueRead(useLive(queueVerdictValue)));
}
