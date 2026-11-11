import { z } from "zod";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";
import { SITE_REPORT_DROP_REASONS } from "./limits";

/** One aggregated report, as the host-only list answers it. */
export const SiteReportRecordSchema = z
  .object({
    fingerprint: z.string(),
    kind: z.string(),
    source: z.string(),
    message: z.string(),
    /** The kind payload of the first occurrence. */
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

/** One window's dropped entries for one reason. */
export const SiteReportDropRecordSchema = z
  .object({
    windowStartedAt: z.string().datetime(),
    reason: z.enum(SITE_REPORT_DROP_REASONS),
    count: z.number().int(),
  })
  .strict();
export type SiteReportDropRecord = z.infer<typeof SiteReportDropRecordSchema>;

export const SITE_REPORTS_PAGE_DEFAULT = 100;
export const SITE_REPORTS_PAGE_MAX = 200;

export const SiteReportsListQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(SITE_REPORTS_PAGE_MAX)
    .default(SITE_REPORTS_PAGE_DEFAULT),
});
export type SiteReportsListQuery = z.infer<typeof SiteReportsListQuerySchema>;

/** The most recently seen reports, and the newest drop-count rows. */
export const SiteReportsPageSchema = z
  .object({
    kind: z.literal("site-reports"),
    reports: cappedList(SiteReportRecordSchema, { max: SITE_REPORTS_PAGE_MAX }),
    drops: cappedList(SiteReportDropRecordSchema, {
      max: SITE_REPORTS_PAGE_MAX,
    }),
  })
  .strict();
export type SiteReportsPage = z.infer<typeof SiteReportsPageSchema>;
