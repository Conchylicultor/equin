import { sinkHandler } from "@plugins/framework/plugins/server-core/core";
import { idleTransactionEndedSink } from "@plugins/database/plugins/connection/server";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import { dbLog } from "@plugins/database/server";
import { createIdleTransactionEndedHandler } from "./idle-ended-handler";

/**
 * Route the connections' idle-transaction ends into `db.jsonl` and reports.
 * A `sinkHandlers` entry, so the framework attaches it in every boot mode — an
 * exec child (a supervised job's body, where background transactions run)
 * included. The seam HOLDS what is emitted before a handler attaches, so an
 * end during boot is replayed here, not lost.
 */
export const idleTransactionReports = sinkHandler(
  idleTransactionEndedSink,
  () =>
    createIdleTransactionEndedHandler({
      recordReport,
      log: (line) => dbLog.publish(line, "stderr"),
    }),
);
