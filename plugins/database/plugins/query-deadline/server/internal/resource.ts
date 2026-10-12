import { serveValue } from "@plugins/network/plugins/live/server";
import { QUERY_DEADLINE_RING_CAPACITY, dbQueryDeadlines } from "../../core";
import { createHitRing } from "./hit-ring";

/** This backend's recent query-deadline hits. Process memory: a restart empties it. */
export const deadlineHitRing = createHitRing(QUERY_DEADLINE_RING_CAPACITY);

// External, not DB-backed: the truth is the ring above, which the change-feed
// can never observe — so it is served on the external arm, the one whose
// served value carries `notify()`. Pushed (the `liveValue` default): the value
// is a handful of small rows, identical for every tab, and read by the
// always-mounted health dot whenever it changes.
//
// The push rides the same live-state flush that a lost query can freeze. That
// is safe by construction: the deadline is what unfreezes the flush (the stuck
// loader gets its error within one deadline), and the hit's notify is queued
// behind it. The "stalled right now" case is the Connection row's job.
export const dbQueryDeadlinesServed = serveValue(dbQueryDeadlines, {
  source: "external",
  changes: "notified",
  loader: () => ({ hits: deadlineHitRing.snapshot() }),
});
