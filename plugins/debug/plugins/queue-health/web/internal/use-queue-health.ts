import { useLive } from "@plugins/network/plugins/live/web";
import {
  foldResource,
  useNotificationsChannelStatuses,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import { queuePulse, type QueuePulse } from "../../core";

/**
 * What the Job queue row can say about the queue right now. A union rather
 * than a nullable pulse, so "not known" can never be drawn as an empty queue:
 * a bar has to be told which of these it is showing.
 */
export type QueuePulseRead =
  /** This worktree's server socket is down: whatever we hold is stale. */
  | { kind: "disconnected" }
  /** Not loaded yet (or the socket is making its first connection). */
  | { kind: "loading" }
  /** The server answered with an error. */
  | { kind: "error" }
  | { kind: "ready"; pulse: QueuePulse };

/**
 * The queue pulse, as a read. One live subscription, pushed by the server on
 * queue activity and at threshold crossings — never fetched here.
 *
 * The socket is checked first because a push resource goes silent, not empty,
 * when the socket drops: the last pulse stays in the cache and would go on
 * claiming "3 running" about a server nobody can hear. A socket still making
 * its FIRST connection is not "disconnected" — that is boot, and it reads as
 * loading ("Checking…"), like any row whose probe has not reported.
 */
export function useQueuePulse(): QueuePulseRead {
  const socket = useNotificationsChannelStatuses().worktree;
  const result = useLive(queuePulse);
  if (socket === "closed" || socket === "reconnecting") {
    return { kind: "disconnected" };
  }
  if (socket === "connecting") return { kind: "loading" };
  return foldResource<typeof result, QueuePulseRead>(result, {
    loading: () => ({ kind: "loading" }),
    error: () => ({ kind: "error" }),
    ready: (pulse) => ({ kind: "ready", pulse }),
  });
}

/** The status a read gives the row. Pure, so the mapping is testable alone. */
export function queueHealthStatus(read: QueuePulseRead): HealthStatus {
  switch (read.kind) {
    case "disconnected":
      return { state: "unknown", summary: "Unknown while disconnected" };
    case "loading":
      return { state: "unknown" };
    case "error":
      return { state: "unknown", summary: "Could not read the queue" };
    case "ready":
      return {
        state: read.pulse.verdict.state,
        summary: read.pulse.verdict.summary,
      };
  }
}

/**
 * The Job queue row's `useStatus`. Called on every render of the report's host,
 * open or not — it is what colours the dot — so it only reads the resident
 * subscription and the socket state the live-state client already holds.
 */
export function useQueueHealth(): HealthStatus {
  return queueHealthStatus(useQueuePulse());
}
