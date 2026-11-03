import type { ResourceResult } from "@plugins/network/plugins/live/plugins/live-state/web";
import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
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
 * The Database row's verdict from the resource read and the current instant.
 *
 * - still loading → `unknown` with no summary (the dot pulses: "Checking…"),
 *   never `ok` — a row that has not read its data must not claim green;
 * - failed to load → `unknown` with a summary (grey, still);
 * - a hit (on any pool) in the last 10 min → `attention`, counting them and
 *   naming the latest;
 * - otherwise → `ok`.
 */
export function databaseVerdict(
  result: ResourceResult<QueryDeadlines>,
  now: number,
): DatabaseVerdict {
  if (result.status === "loading") {
    return { status: { state: "unknown" }, nextChangeAt: null };
  }
  if (result.status === "error") {
    return {
      status: {
        state: "unknown",
        summary: "Couldn't load recent database call failures",
      },
      nextChangeAt: null,
    };
  }

  const recent = result.data.hits.filter((h) => h.at > now - RECENT_WINDOW_MS);
  if (recent.length === 0) {
    return {
      status: {
        state: "ok",
        summary: "No unanswered database calls in the last 10 min",
      },
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
    status: { state: "attention", summary: lostSummary(recent, latest) },
    nextChangeAt: oldestAt + RECENT_WINDOW_MS,
  };
}
