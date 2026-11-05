import { sinkHandler } from "@plugins/framework/plugins/server-core/core";
import { queryDeadlineSink } from "@plugins/database/plugins/connection/server";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import { captureTrace } from "@plugins/debug/plugins/trace/plugins/engine/server";
import { dbLog } from "@plugins/database/server";
import { createQueryDeadlineHandler } from "./handler";
import { dbQueryDeadlinesServed, deadlineHitRing } from "./resource";

/**
 * Route the database plugin's deadline announcements into reports and the
 * Database health row.
 *
 * A `sinkHandlers` entry, so the framework attaches it in every boot mode — an
 * exec child (a supervised job's body, where much background DB work runs)
 * included. The seam HOLDS what is emitted before a handler attaches, so a
 * deadline that fires during boot is replayed here rather than lost.
 */
export const queryDeadlineReports = sinkHandler(queryDeadlineSink, () =>
  createQueryDeadlineHandler({
    recordReport,
    captureTrace,
    ring: deadlineHitRing,
    notify: () => dbQueryDeadlinesServed.notify(),
    log: (line) => dbLog.publish(line, "stderr"),
  }),
);
