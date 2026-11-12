import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod";
import { parsedText } from "@plugins/database/plugins/sql-column/server";
import { _deployDeployments } from "@plugins/apps/plugins/deploy/plugins/deployments/server";
// The specific module, not the `core` barrel: drizzle-kit loads this file.
import { IMPORT_OUTCOMES } from "../../core/internal/outcome";

/**
 * Where the pull from each deployment's box stands: one row per deployment,
 * cascading with it. `watermark` is the newest site `lastSeenAt` already
 * imported — the next pull takes only rows seen after it. Bounded by the
 * deployments table.
 */
export const siteReportImports = pgTable("site_report_imports", {
  deploymentId: text("deployment_id")
    .primaryKey()
    .references(() => _deployDeployments.id, { onDelete: "cascade" }),
  watermark: timestamp("watermark", { withTimezone: true }),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }).notNull(),
  lastOutcome: parsedText("last_outcome", z.enum(IMPORT_OUTCOMES)).notNull(),
});
