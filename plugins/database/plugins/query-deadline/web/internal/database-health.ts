import type { ResourceResult } from "@plugins/network/plugins/live/plugins/live-state/web";
import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import {
  describeLockHolder,
  type LockWatchObservation,
  type LockWatchState,
} from "@plugins/database/plugins/lock-watch/core";
import type { QueryDeadlineHit, QueryDeadlines } from "../../core";

/** How long a database call with no reply keeps the Database row in `attention`. */
export const RECENT_WINDOW_MS = 10 * 60_000;

export interface DatabaseVerdict {
  status: HealthStatus;
  /**
   * The next instant this verdict changes on its own — the soonest moment an
   * in-window hit ages out — or null when nothing is waiting to expire. The
   * hook schedules exactly one timer to it; there is no polling.
   */
  nextChangeAt: number | null;
}

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The latest hit in words: which connection, what it was doing, who issued it,
 * when. "jobs-enqueue, issued by tasks.maybe-launch, at 10:21"; a connect reads
 * "opening a jobs-enqueue connection, …"; an unknown caller is left out rather
 * than spelled "unknown".
 */
function describeHit(h: QueryDeadlineHit): string {
  const article = /^[aeiou]/.test(h.pool) ? "an" : "a";
  const what =
    h.phase === "connect" ? `opening ${article} ${h.pool} connection` : h.pool;
  const who = h.origin !== null ? `, issued by ${h.origin}` : "";
  return `${what}${who}, at ${clockTime(h.at)}`;
}

function lostSummary(
  recent: readonly QueryDeadlineHit[],
  latest: QueryDeadlineHit,
): string {
  return recent.length === 1
    ? `1 database call got no reply in the last 10 min — ${describeHit(latest)}`
    : `${recent.length} database calls got no reply in the last 10 min — last: ${describeHit(latest)}`;
}

/**
 * How old the lock watch's latest look may be before the row stops trusting
 * it: three of its one-minute ticks. Past it the watch itself is not running
 * (its job wedged, or the backend's queue stopped), which is news on its own.
 */
export const LOCK_WATCH_STALE_MS = 3 * 60_000;

/** One read's contribution to the row. */
interface Part {
  state: "ok" | "attention" | "critical" | "unknown";
  summary: string;
  /** When this part changes on its own; null when it never does. */
  nextChangeAt: number | null;
}

function deadlinePart(
  result: ResourceResult<QueryDeadlines> & { status: "ready" | "error" },
  now: number,
): Part {
  if (result.status === "error") {
    return {
      state: "unknown",
      summary: "Couldn't load recent database call failures",
      nextChangeAt: null,
    };
  }
  const recent = result.data.hits.filter((h) => h.at > now - RECENT_WINDOW_MS);
  if (recent.length === 0) {
    return {
      state: "ok",
      summary: "No unanswered database calls in the last 10 min",
      nextChangeAt: null,
    };
  }
  let oldestAt = recent[0]!.at;
  let latest = recent[0]!;
  for (const h of recent) {
    if (h.at < oldestAt) oldestAt = h.at;
    if (h.at > latest.at) latest = h;
  }
  return {
    state: "attention",
    summary: lostSummary(recent, latest),
    nextChangeAt: oldestAt + RECENT_WINDOW_MS,
  };
}

/**
 * What the lock watch saw on its latest look, in words, and how bad it is: a
 * session holding others back is `critical` (its waiters are already failing:
 * the watch's bound is the query deadline's), one idle inside a transaction is
 * `attention`. A look not taken yet is `unknown` — never green — and one
 * older than {@link LOCK_WATCH_STALE_MS} is `attention`: the watch stopped.
 */
function lockPart(
  lockWatch: ResourceResult<LockWatchState> & { status: "ready" | "error" },
  now: number,
): Part {
  if (lockWatch.status === "error") {
    return {
      state: "unknown",
      summary: "Couldn't load the database lock watch",
      nextChangeAt: null,
    };
  }
  const o: LockWatchObservation | null = lockWatch.data.observation;
  if (o === null) {
    return {
      state: "unknown",
      summary: "the lock watch has not looked yet",
      nextChangeAt: null,
    };
  }
  const staleAt = o.observedAt + LOCK_WATCH_STALE_MS;
  if (now >= staleAt) {
    return {
      state: "attention",
      summary: `the lock watch has not looked since ${clockTime(o.observedAt)}`,
      nextChangeAt: null,
    };
  }
  const head = o.holders[0];
  const asOf = ` — as of ${clockTime(o.observedAt)}`;
  if (head === undefined) {
    return {
      state: "ok",
      summary: `no session holding others back (as of ${clockTime(o.observedAt)})`,
      nextChangeAt: staleAt,
    };
  }
  const more = o.holders.length > 1 ? ` (+${o.holders.length - 1} more)` : "";
  return head.waiting > 0
    ? {
        state: "critical",
        summary: `Blocked now: ${describeLockHolder(head)}${more}${asOf}`,
        nextChangeAt: staleAt,
      }
    : {
        state: "attention",
        summary: `Now: ${describeLockHolder(head)}${more}${asOf}`,
        nextChangeAt: staleAt,
      };
}

const SEVERITY: Record<Part["state"], number> = {
  ok: 0,
  unknown: 1,
  attention: 2,
  critical: 3,
};

/**
 * The Database row's verdict from its two reads — the lock watch's latest look
 * (the state NOW) and recent calls with no reply (a fading 10-minute window) —
 * and the current instant.
 *
 * - either still loading → `unknown` with no summary (the dot pulses:
 *   "Checking…"), never `ok` — a row that has not read its data must not claim
 *   green;
 * - otherwise each read gives a part (above) and the row is the worst of the
 *   two: `critical` while a session holds others back, `attention` for one
 *   idle in its transaction, a stopped lock watch or a recent unanswered call,
 *   `unknown` for a read that failed or a watch that has not looked yet. Its
 *   summary is every part that is not ok, the lock watch's first; both when
 *   all is well. A failed read never hides what the other one knows.
 */
export function databaseVerdict(
  result: ResourceResult<QueryDeadlines>,
  lockWatch: ResourceResult<LockWatchState>,
  now: number,
): DatabaseVerdict {
  if (result.status === "loading" || lockWatch.status === "loading") {
    return { status: { state: "unknown" }, nextChangeAt: null };
  }
  const parts = [lockPart(lockWatch, now), deadlinePart(result, now)];
  const worst = parts.reduce((a, b) =>
    SEVERITY[b.state] > SEVERITY[a.state] ? b : a,
  ).state;
  const summary = (
    worst === "ok"
      ? [...parts].reverse()
      : parts.filter((p) => p.state !== "ok")
  )
    .map((p) => p.summary)
    .join("; ");
  const sentence = summary.charAt(0).toUpperCase() + summary.slice(1);
  const changes = parts
    .map((p) => p.nextChangeAt)
    .filter((t): t is number => t !== null);
  return {
    status: healthStatus(worst, sentence),
    nextChangeAt: changes.length === 0 ? null : Math.min(...changes),
  };
}

function healthStatus(state: Part["state"], summary: string): HealthStatus {
  switch (state) {
    case "unknown":
      return { state, summary };
    case "attention":
      return { state, summary };
    case "ok":
    case "critical":
      return { state, summary };
  }
}
