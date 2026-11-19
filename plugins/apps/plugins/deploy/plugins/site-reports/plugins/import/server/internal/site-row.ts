import { z } from "zod";
import { REPORT_CATEGORIES } from "@plugins/reports/core";
import type { MirrorRow } from "@plugins/database/plugins/table-mirror/core";
import {
  SiteReportRecordSchema,
  type SiteReportRecord,
} from "@plugins/apps/plugins/deploy/plugins/site-reports/plugins/intake/core";

/** The one table of the `site_reports` mirror set: what this sink reduces. */
export const SITE_REPORTS_TABLE = "site_reports";

// A `site_reports` row as the box's change stream carries it: `to_jsonb` of
// the row, database column names, timestamps with their UTC offset. Columns a
// newer box adds are dropped unread (nothing here would read them).
const SiteReportRowSchema = z.object({
  fingerprint: z.string(),
  kind: z.string(),
  // Absent from a box released before the intake kept it.
  category: z.enum(REPORT_CATEGORIES).nullable().optional(),
  source: z.string(),
  message: z.string(),
  data: z.record(z.string(), z.unknown()),
  path: z.string(),
  build_id: z.string().nullable(),
  commit: z.string().nullable(),
  count: z.number().int(),
  first_seen_at: z.string().datetime({ offset: true }),
  last_seen_at: z.string().datetime({ offset: true }),
});

/**
 * One mirrored `site_reports` row, strictly parsed into the intake's record
 * shape — the input `reduceSiteReport` takes. A row that does not parse
 * throws (the page applies nothing, and the pull says so): the box's own
 * typed columns cannot produce one.
 */
export function siteReportRecordOfRow(row: MirrorRow): SiteReportRecord {
  const r = SiteReportRowSchema.parse(JSON.parse(row));
  return SiteReportRecordSchema.parse({
    fingerprint: r.fingerprint,
    kind: r.kind,
    category: r.category ?? null,
    source: r.source,
    message: r.message,
    data: r.data,
    path: r.path,
    buildId: r.build_id,
    commit: r.commit,
    count: r.count,
    firstSeenAt: new Date(r.first_seen_at).toISOString(),
    lastSeenAt: new Date(r.last_seen_at).toISOString(),
  });
}
