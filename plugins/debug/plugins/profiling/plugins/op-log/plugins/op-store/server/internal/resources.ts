import { isNull } from "drizzle-orm";
import { serveCollection } from "@plugins/network/plugins/live/server";
import { opsHistory, opsInFlight } from "../../core/internal/resources";
import { _opLogOps } from "./tables";

// Both collections are the same table seen two ways. Every row field binds to
// its `op_log_ops` column by name (the jsonb waits / open wait / steps decode
// through `parsedJson`). No hand-notify: the change feed on `op_log_ops` moves
// the in-flight set and every subscribed history window on each ingested
// batch.

// In flight = not yet closed. `closed_by`, not `completed_at`: a reconciler
// close has no real end, so its `completed_at` stays null. The partial index
// `op_log_ops_in_flight_idx` serves exactly this predicate.
export const opsInFlightWhere = isNull(_opLogOps.closedBy);

export const opsInFlightServed = serveCollection(opsInFlight, {
  from: _opLogOps,
  where: opsInFlightWhere,
});

export const opsHistoryServed = serveCollection(opsHistory, {
  from: _opLogOps,
});
