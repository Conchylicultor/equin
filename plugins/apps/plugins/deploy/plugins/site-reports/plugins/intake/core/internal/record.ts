import { z } from "zod";
import { REPORT_CATEGORIES } from "@plugins/reports/core";

/** One aggregated report: a `site_reports` row, as the mirror's change stream carries it to site-reports/import. */
export const SiteReportRecordSchema = z
  .object({
    fingerprint: z.string(),
    kind: z.string(),
    /**
     * The kind's own category, from the site's registry; null on a row last
     * written before the site kept it (or by a box that does not).
     */
    category: z.enum(REPORT_CATEGORIES).nullable(),
    source: z.string(),
    message: z.string(),
    /** The kind payload of the latest occurrence. */
    data: z.record(z.string(), z.unknown()),
    path: z.string(),
    buildId: z.string().nullable(),
    commit: z.string().nullable(),
    count: z.number().int(),
    /** ISO instants. */
    firstSeenAt: z.string().datetime(),
    lastSeenAt: z.string().datetime(),
  })
  .strict();
export type SiteReportRecord = z.infer<typeof SiteReportRecordSchema>;
