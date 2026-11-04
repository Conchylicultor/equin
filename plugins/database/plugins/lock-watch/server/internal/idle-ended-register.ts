import { idleTransactionEndedSink } from "@plugins/database/plugins/connection/server";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import { dbLog } from "@plugins/database/server";
import { createIdleTransactionEndedHandler } from "./idle-ended-handler";

/**
 * Route the connections' idle-transaction ends into `db.jsonl` and reports.
 * Registered in `onReady`, cleared in `onShutdown`, like
 * `database/query-deadline`'s sink: the seam HOLDS what is emitted before a
 * handler registers, so an end during boot is replayed here, not lost.
 */
export function registerIdleTransactionReports(): void {
  idleTransactionEndedSink.register(
    createIdleTransactionEndedHandler({
      recordReport,
      log: (line) => dbLog.publish(line, "stderr"),
    }),
  );
}

export function unregisterIdleTransactionReports(): void {
  idleTransactionEndedSink.register(null);
}
