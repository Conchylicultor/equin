import { defineChangeProducer } from "@plugins/database/plugins/change-feed/server";
import { _slowOpCallers, _slowOps } from "./tables";

// The change sources of `slow_ops` and `slow_op_callers`. Neither carries a
// change-feed trigger: both are written EXACTLY while the app is slow (every
// threshold-exceeding span), and a per-statement trigger + changelog row +
// NOTIFY on them was the largest source of change-feed churn — a
// self-amplifying loop (slow app → more slow-op writes → more notify cascade →
// slower app). Every write is made by this backend — `recordSlowOpBatch` (fed
// by the slow-span hook installed in `onReady`, the client-slow-op endpoint,
// the boot-monitor job and duress-shed replay, all in the serving backend) and
// the retention sweeps (which delete through `changeProducerFor`) — and each
// is ONE statement per batch, so every write goes through `mutate`, which
// routes the ids it returned straight into the live-state cascade, coalesced
// to one flush per 2 s window however many occurrences land.
//
// Volatile: a change still pending when the backend restarts is lost, and an
// open reader reloads in full on resubscribe. Hence no reader of either table
// may be L2-persisted (A6, live-state-snapshot) — `slow-ops.ops` and
// `slow-ops.callers` are windows and `slow-ops.op` a point lookup, none of
// which is.
export const slowOpsProducer = defineChangeProducer({
  table: _slowOps,
  durability: "volatile",
  reason:
    "Written exactly while the app is slow; a per-statement trigger + changelog + NOTIFY was the self-amplifying churn loop. One upsert per batch; every writer runs in the serving backend.",
  coalesce: {
    ms: 2000,
    reason:
      "Slow occurrences land in bursts during an incident; one scoped refill per 2 s per reading tuple.",
  },
});

export const slowOpCallersProducer = defineChangeProducer({
  table: _slowOpCallers,
  durability: "volatile",
  reason:
    "Written alongside slow_ops, exactly while the app is slow; a trigger would rebuild the self-amplifying churn loop. One upsert per batch; every writer runs in the serving backend.",
  coalesce: {
    ms: 2000,
    reason:
      "Caller rows land in the same bursts as their ops; one scoped refill per 2 s per reading tuple.",
  },
});
