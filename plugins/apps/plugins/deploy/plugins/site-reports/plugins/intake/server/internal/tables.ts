import {
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  parsedJson,
  parsedText,
} from "@plugins/database/plugins/sql-column/server";
import { SITE_REPORT_DROP_REASONS } from "../../core";

/**
 * One row per error fingerprint a site's visitors hit — never one per
 * occurrence: a repeat only adds to `count` and moves `last_seen_at`. The
 * first occurrence's kind payload is kept as the sample. Nothing here names a
 * visitor: no IP, no client id, no user agent, the page's pathname only.
 *
 * Bounded by construction: at most `SITE_REPORT_LIMITS.maxRows` rows (a new
 * fingerprint past it is dropped and counted), rows unseen for
 * `retentionDays` swept (`retention.ts`).
 */
export const siteReports = pgTable(
  "site_reports",
  {
    /** `<kind>:<the kind's own fingerprint>`. */
    fingerprint: text("fingerprint").primaryKey(),
    kind: text("kind").notNull(),
    source: text("source").notNull(),
    message: text("message").notNull(),
    data: parsedJson("data", z.record(z.string(), z.unknown())).notNull(),
    path: text("path").notNull(),
    buildId: text("build_id"),
    commit: text("commit"),
    count: integer("count").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("site_reports_last_seen_at_idx").on(t.lastSeenAt)],
);

/**
 * What the intake refused, counted per (window, reason): over budget it drops
 * and counts, it never queues. Bounded: one row per window and reason, swept
 * with the reports.
 */
export const siteReportDrops = pgTable(
  "site_report_drops",
  {
    windowStartedAt: timestamp("window_started_at", {
      withTimezone: true,
    }).notNull(),
    reason: parsedText("reason", z.enum(SITE_REPORT_DROP_REASONS)).notNull(),
    count: integer("count").notNull(),
  },
  (t) => [primaryKey({ columns: [t.windowStartedAt, t.reason] })],
);
