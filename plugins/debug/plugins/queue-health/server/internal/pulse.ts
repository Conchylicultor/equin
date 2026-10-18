import { serveValue } from "@plugins/network/plugins/live/server";
import { getConfig } from "@plugins/config_v2/server";
import {
  _deadJobs,
  PICKUP_WINDOW_MS,
  getForfeitedSlots,
  getOccupiedSlots,
  getPickupStats,
  onQueueActivity,
  queryOldestWaiting,
  queryQueuePulse,
  queryRecentDeadJobs,
} from "@plugins/infra/plugins/jobs/server";
import {
  PULSE_DEAD_LIMIT,
  PULSE_DEAD_WINDOW_MS,
  PULSE_WAITING_LIMIT,
  queueHealthConfig,
  queuePulse,
  type QueuePulse,
} from "../../core";
import { assemblePulse } from "./assemble-pulse";

// The health report's Job queue row, as a live value.
//
// PUSH-BASED, with no poll. Graphile's tables live outside the schema the DB
// change feed covers, so the feed never invalidates this; it is served external
// (`source: "external"`), and notified — only while a tab is subscribed, since
// `whileSubscribed` is what hands out `notify` — by two things:
//
// - the jobs plugin's queue-activity signal (`onQueueActivity`): a job started
//   or finished in this backend, a row was inserted, or the jobs plugin itself
//   touched the queue (cancel, retry, GC, the stuck-lock reclaim);
// - ONE timer, armed at the verdict's `nextChangeAt` — the next instant the
//   colour could change with no event at all (a waiting job crossing its
//   threshold, a running one reaching the stuck line, a death aging out). A
//   wedged queue emits nothing, and must still turn amber on time. This is a
//   deadline, not a poll: it fires at the instant the answer changes, and each
//   load re-arms it.
//
// `throttleMs`: a burst of activity (a fan-out enqueue, a queue draining) costs
// one load per second.
//
// The loader reads the database only through the jobs plugin's introspection
// API. Its one public read, the `dead_jobs` archive, is declared in `reads`;
// graphile's own `_private_*` tables are a schema the change feed never
// captures, which the reason says. Deaths need nothing extra: graphile emits
// `job:complete` after writing a final failure, and the dead-job GC that moves
// rows into the `dead_jobs` archive announces activity itself.

// setTimeout's largest delay; anything longer fires immediately in Bun/Node.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

// The subscribed tuple's `notify`, set for exactly as long as a tab is
// subscribed (`whileSubscribed` below). The value is param-less, so there is at
// most one.
let pulseNotify: (() => void) | undefined;
let changeTimer: ReturnType<typeof setTimeout> | undefined;

function clearChangeTimer(): void {
  if (changeTimer !== undefined) clearTimeout(changeTimer);
  changeTimer = undefined;
}

// One timer, re-armed by every load. Armed only while someone is subscribed: a
// load with no subscriber (an HTTP read) must not leave a timer behind.
function armChangeTimer(at: number | null): void {
  clearChangeTimer();
  const notify = pulseNotify;
  if (notify === undefined || at === null) return;
  const delay = Math.min(Math.max(0, at - Date.now()), MAX_TIMEOUT_MS);
  changeTimer = setTimeout(() => {
    changeTimer = undefined;
    notify();
  }, delay);
}

async function loadQueuePulse(): Promise<QueuePulse> {
  const since = Date.now() - PULSE_DEAD_WINDOW_MS;
  const [classes, oldestWaiting, dead] = await Promise.all([
    queryQueuePulse(),
    queryOldestWaiting(PULSE_WAITING_LIMIT),
    queryRecentDeadJobs({ since, limit: PULSE_DEAD_LIMIT }),
  ]);
  // Memory reads AFTER the queries: a job that started while they ran is then
  // in the ledger but not in the locked count, which `orphanLocked` clamps —
  // the other order would report it as orphaned.
  const now = Date.now();
  const { pulse, nextChangeAt } = assemblePulse(
    {
      slots: getOccupiedSlots(),
      forfeits: getForfeitedSlots(),
      pickup: getPickupStats(now),
      classes,
      oldestWaiting,
      dead,
      pickupWindowMs: PICKUP_WINDOW_MS,
    },
    getConfig(queueHealthConfig),
    now,
  );
  armChangeTimer(nextChangeAt);
  return pulse;
}

// The runtime starts `whileSubscribed` before the first subscriber's load, so
// that load already sees `pulseNotify` and arms its timer.
export const queuePulseServed = serveValue(queuePulse, {
  source: "external",
  changes: "notified",
  reads: {
    tables: [_deadJobs],
    reason:
      "the pulse counts the last day's deaths across the whole dead_jobs archive, so archiving any job may change it; its other reads are graphile-worker's private queue tables, outside the schema the change feed covers, which the queue-activity signal and the next-change timer notify instead",
  },
  loader: loadQueuePulse,
  throttleMs: 1000,
  whileSubscribed: (_params, notify) => {
    pulseNotify = notify;
    const stopActivity = onQueueActivity(notify);
    return () => {
      pulseNotify = undefined;
      stopActivity();
      clearChangeTimer();
    };
  },
});
