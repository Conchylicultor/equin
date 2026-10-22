import { defineChangeProducer } from "@plugins/database/plugins/change-feed/server";
import { _reports } from "@plugins/reports/server";

// The `reports` table's change source. It carries no change-feed trigger: every
// write is made by this backend (`recordReport`, `investigateReport`, the noise
// backfill, the retention sweep — an exec child files through the outbox), and
// a crash storm UPDATEs one hot row thousands of times a minute, which a
// per-statement trigger + changelog row + NOTIFY would amplify during exactly
// the incidents the table records. So every write goes through
// `reportsProducer.mutate`, which routes the ids the statement returned straight
// into the live-state cascade, coalesced to one flush per 2 s window.
//
// Volatile: a change still pending when the backend restarts is lost, and an
// open reader reloads in full on resubscribe. Hence no reader of `reports` may
// be L2-persisted (A6, live-state-snapshot) — `reports.list` is a window, which
// never is.
export const reportsProducer = defineChangeProducer({
  table: _reports,
  durability: "volatile",
  reason:
    "High-churn deduped crash/report counter: a crash storm UPDATEs its hot rows thousands of times a minute, and a per-statement trigger + changelog + NOTIFY would amplify load during the exact storms it records. Every writer runs in the serving backend.",
  coalesce: {
    ms: 2000,
    reason:
      "Crash storms UPDATE hot rows thousands of times a minute; one scoped refill per 2 s per reading tuple.",
  },
});
