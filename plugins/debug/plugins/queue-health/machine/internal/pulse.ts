import { serveValue } from "@plugins/network/plugins/live/server";
import { getConfig } from "@plugins/config_v2/server";
import { _deadJobs } from "@plugins/infra/plugins/jobs/server";
import {
  PICKUP_WINDOW_MS,
  getForfeitedSlots,
  getOccupiedSlots,
  getPickupStats,
  onQueueActivity,
  queryOldestWaiting,
  queryQueuePulse,
  queryRecentDeadJobs,
} from "@plugins/infra/plugins/jobs/machine";
import {
  PULSE_DEAD_LIMIT,
  PULSE_DEAD_WINDOW_MS,
  PULSE_WAITING_LIMIT,
  queueHealthConfig,
  queuePulse,
  queueVerdictValue,
  type QueuePulse,
  type QueueVerdict,
} from "../../core";
import { assemblePulse, assembleVerdict } from "./assemble-pulse";
import { createVerdictFacts } from "./verdict-facts";

// The health report's Job queue row, as two live values: the verdict every
// tab holds (the dot), and the full pulse the open report reads.
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
// The two loads differ in what they read. The pulse re-runs its three queries
// on every load: it is subscribed only while the report is open, and most of
// what it shows (locked counts, the listed waiting rows) moves on every start
// and finish. The verdict — every tab's, always — needs two of them, and holds
// their answers between loads (`verdict-facts.ts`): each activity says which
// database reads it may have moved (`QueueActivity`), so a successful finish
// re-reads nothing, a pickup or an insert the per-class aggregate alone, and
// only a failure the deaths. The slot ledger is memory, read on every load.
//
// The loader reads the database only through the jobs plugin's introspection
// API. Its one public read, the `dead_jobs` archive, is declared in `reads`;
// graphile's own `_private_*` tables are a schema the change feed never
// captures, which the reason says. Deaths need nothing extra: graphile emits
// `job:complete` after writing a final failure, and the dead-job GC that moves
// rows into the `dead_jobs` archive announces activity itself.

// setTimeout's largest delay; anything longer fires immediately in Bun/Node.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

// The served values' notify wiring: each value (pulse, verdict) has its own —
// set for exactly as long as a tab subscribes to it (`whileSubscribed`), and
// its own change timer, re-armed by each of its loads. Both values are
// param-less, so each has at most one subscribed tuple.
interface Subscription {
  notify: (() => void) | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
}

function clearChangeTimer(sub: Subscription): void {
  if (sub.timer !== undefined) clearTimeout(sub.timer);
  sub.timer = undefined;
}

// The verdict's held database reads. Tracked only while the verdict is
// subscribed; the pulse's loads refresh them, so an open report pays for them
// once, not twice. Expired by queue activity alone: the change feed's
// `dead_jobs` changes come from the dead-job GC, which announces activity too.
const verdictFacts = createVerdictFacts({
  classes: () => queryQueuePulse(),
  dead: () =>
    queryRecentDeadJobs({
      since: Date.now() - PULSE_DEAD_WINDOW_MS,
      limit: PULSE_DEAD_LIMIT,
    }),
  onActivity: onQueueActivity,
});

// One timer per value, re-armed by every load. Armed only while someone is
// subscribed: a load with no subscriber (an HTTP read) must not leave a timer
// behind. Its firing is a change no event announced — a scheduled row became
// due — so it also expires the verdict's held reads.
function armChangeTimer(sub: Subscription, at: number | null): void {
  clearChangeTimer(sub);
  const notify = sub.notify;
  if (notify === undefined || at === null) return;
  const delay = Math.min(Math.max(0, at - Date.now()), MAX_TIMEOUT_MS);
  sub.timer = setTimeout(() => {
    sub.timer = undefined;
    verdictFacts.invalidateAll();
    notify();
  }, delay);
}

// `track` keeps the verdict's held reads current while it is subscribed. Its
// activity listener is added before `notify`'s, so a held read has already
// expired when the load an activity triggers runs.
function whileSubscribedTo(sub: Subscription, track?: () => () => void) {
  return (_params: unknown, notify: () => void) => {
    sub.notify = notify;
    const untrack = track?.();
    const stopActivity = onQueueActivity(notify);
    return () => {
      sub.notify = undefined;
      stopActivity();
      untrack?.();
      clearChangeTimer(sub);
    };
  };
}

async function loadQueuePulse(sub: Subscription): Promise<QueuePulse> {
  const [classes, oldestWaiting, dead] = await Promise.all([
    verdictFacts.classes.refresh(),
    queryOldestWaiting(PULSE_WAITING_LIMIT),
    verdictFacts.dead.refresh(),
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
  armChangeTimer(sub, nextChangeAt);
  return pulse;
}

const DEAD_JOBS_READ = {
  tables: [_deadJobs],
  reason:
    "the pulse counts the last day's deaths across the whole dead_jobs archive, so archiving any job may change it; its other reads are graphile-worker's private queue tables, outside the schema the change feed covers, which the queue-activity signal and the next-change timer notify instead",
};

const pulseSub: Subscription = { notify: undefined, timer: undefined };
const verdictSub: Subscription = { notify: undefined, timer: undefined };

// The full pulse: subscribed only while the health report is open (the row's
// glance and detail). It moves on nearly every job start and finish.
// The runtime starts `whileSubscribed` before the first subscriber's load, so
// that load already sees the notify and arms its timer.
export const queuePulseServed = serveValue(queuePulse, {
  source: "external",
  changes: "notified",
  reads: DEAD_JOBS_READ,
  loader: () => loadQueuePulse(pulseSub),
  throttleMs: 1000,
  whileSubscribed: whileSubscribedTo(pulseSub),
});

async function loadQueueVerdict(sub: Subscription): Promise<QueueVerdict> {
  const [classes, dead] = await Promise.all([
    verdictFacts.classes.read(),
    verdictFacts.dead.read(),
  ]);
  // Memory after the database, as in the pulse.
  const now = Date.now();
  const { verdict, nextChangeAt } = assembleVerdict(
    {
      slots: getOccupiedSlots(),
      forfeits: getForfeitedSlots(),
      classes,
      dead,
    },
    getConfig(queueHealthConfig),
    now,
  );
  armChangeTimer(sub, nextChangeAt);
  return verdict;
}

// The verdict alone: every tab's always-on subscription (the dot). Its own
// loader over held reads (above), its own timer. A load whose verdict did not
// change pushes nothing — the runtime compares it against the value its
// holders hold.
export const queueVerdictServed = serveValue(queueVerdictValue, {
  source: "external",
  changes: "notified",
  reads: DEAD_JOBS_READ,
  loader: () => loadQueueVerdict(verdictSub),
  throttleMs: 1000,
  whileSubscribed: whileSubscribedTo(verdictSub, () => verdictFacts.track()),
});
