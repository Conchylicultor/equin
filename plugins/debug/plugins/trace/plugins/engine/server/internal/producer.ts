import { defineChangeProducer } from "@plugins/database/plugins/change-feed/server";
import { _traces } from "./tables";

// The `traces` table's change source. It carries no change-feed trigger: a
// trace is inserted EXACTLY when the system is already slow, so a
// per-statement trigger + changelog row + NOTIFY would add load at the worst
// moment and could self-amplify (slow app → more traces → more notify → slower
// app). Every write is made by this backend — `persistTrace` (fed by
// captureTrace, whose callers all run in the serving backend: the slow-span
// hook and the stall / stuck-span / sentinel monitors start from `onReady`,
// which an exec child skips; the boot-monitor and op-rate jobs and the
// client-slow-op / test-trigger endpoints run in the backend) and the 7-day
// retention sweep (which deletes through `changeProducerFor`). So every write
// goes through `tracesProducer.mutate`, which routes the inserted ids straight
// into the live-state cascade, coalesced to one flush per 2 s window.
//
// Volatile: a change still pending when the backend restarts is lost, and an
// open reader reloads in full on resubscribe. Hence no reader of `traces` may
// be L2-persisted (A6, live-state-snapshot) — `debug.traces` is a window and
// `debug.trace` a point lookup, neither of which is.
export const tracesProducer = defineChangeProducer({
  table: _traces,
  durability: "volatile",
  reason:
    "Written exactly when the system is slow; a per-statement trigger + changelog + NOTIFY would amplify the very slowness it records. Every writer runs in the serving backend.",
  coalesce: {
    ms: 2000,
    reason:
      "Traces land in bursts during an incident; one scoped refill per 2 s per reading tuple.",
  },
});
