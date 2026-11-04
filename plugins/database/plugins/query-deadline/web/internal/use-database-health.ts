import { useEffect, useState } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import { dbLockWatch } from "@plugins/database/plugins/lock-watch/core";
import { dbQueryDeadlines } from "../../core";
import { databaseVerdict } from "./database-health";

/**
 * The health report's Database row. Cheap: two subscriptions to small pushed
 * values the server already holds in memory — the recent deadline hits and the
 * lock watch's latest look — nothing is fetched per render.
 *
 * Time moves the verdict on its own (a lost query ages out of the 10-minute
 * window; the lock watch's latest look goes stale when no newer one lands), so `now` is state, refreshed by ONE timer scheduled to the next
 * instant the verdict changes. When nothing is waiting to expire there is no
 * timer at all.
 *
 * Why a stale `now` between timers is still correct: `now` only lags real time
 * while no in-window hit is due to expire (the timer would have fired). A new
 * hit arriving meanwhile is newer than `now`, so it counts as recent — which it
 * is — and any older hit counted as recent still has its expiry timer pending.
 * A read that brings in a hit which already aged out (a first load, a
 * reconnect) puts its expiry in the past, so the timer fires at once and the
 * next render is right.
 */
export function useDatabaseHealth(): HealthStatus {
  const result = useLive(dbQueryDeadlines);
  const lockWatch = useLive(dbLockWatch);
  const [now, setNow] = useState(() => Date.now());
  const verdict = databaseVerdict(result, lockWatch, now);
  const nextChangeAt = verdict.nextChangeAt;

  useEffect(() => {
    if (nextChangeAt === null) return;
    const id = setTimeout(
      // Never step `now` to less than the instant we waited for: a timer may
      // fire a millisecond "early" by Date's reckoning, and a `now` still short
      // of the expiry would leave the verdict — and so this effect's dep —
      // unchanged, with no timer left to fire again.
      () => setNow(Math.max(Date.now(), nextChangeAt)),
      Math.max(0, nextChangeAt - Date.now()),
    );
    return () => clearTimeout(id);
  }, [nextChangeAt]);

  return verdict.status;
}
