import { queryDeadlineSink } from "@plugins/database/plugins/connection/server";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import { dbLog } from "@plugins/database/server";
import { createQueryDeadlineHandler } from "./handler";
import { dbQueryDeadlinesServed, deadlineHitRing } from "./resource";

/**
 * Route the database plugin's deadline announcements into reports and the
 * Database health row.
 *
 * Registered in `onReady` and cleared in `onShutdown`, like
 * `jobs/deadline-audit`. The seam is a fire-and-forget report sink that HOLDS
 * what is emitted before a handler registers, so a deadline that fires during
 * boot is replayed here rather than lost.
 */
export function registerQueryDeadlineReports(): void {
  queryDeadlineSink.register(
    createQueryDeadlineHandler({
      recordReport,
      ring: deadlineHitRing,
      notify: () => dbQueryDeadlinesServed.notify(),
      log: (line) => dbLog.publish(line, "stderr"),
    }),
  );
}

export function unregisterQueryDeadlineReports(): void {
  queryDeadlineSink.register(null);
}
