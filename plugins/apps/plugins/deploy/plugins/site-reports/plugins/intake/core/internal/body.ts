import { z } from "zod";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";
import { CLIENT_REPORT_SOURCES } from "@plugins/reports/core";
import { SITE_REPORT_LIMITS as L } from "./limits";

/**
 * One report a site page sends: anonymous by construction — no client id, no
 * user agent, no query string. `path` is the page's pathname; `count` is how
 * many occurrences of this fingerprint the page folded since it last sent.
 */
export const SiteReportEntrySchema = z
  .object({
    kind: z.string().min(1).max(64),
    source: z.enum(CLIENT_REPORT_SOURCES),
    // Never blank, like every report (reports/core's ReportBodySchema): a
    // report with nothing in it cannot be diagnosed, so it cannot be filed.
    message: z
      .string()
      .max(L.maxMessage)
      .refine((m) => m.trim() !== "", "a report needs a message"),
    data: z
      .record(z.string(), z.unknown())
      .refine((d) => JSON.stringify(d).length <= L.maxDataBytes, {
        message: `data is over ${L.maxDataBytes} bytes serialized`,
      }),
    path: z.string().startsWith("/").max(512),
    count: z.number().int().min(1).max(L.maxCount),
    buildId: z.string().max(128).nullable(),
    commit: z.string().max(64).nullable(),
  })
  .strict();
export type SiteReportEntry = z.infer<typeof SiteReportEntrySchema>;

export const SiteReportsBodySchema = z
  .object({
    reports: cappedList(SiteReportEntrySchema, { max: L.maxBatch }).min(1),
  })
  .strict();
export type SiteReportsBody = z.infer<typeof SiteReportsBodySchema>;

/**
 * What became of a batch. `accepted` counts the entries that were aggregated
 * (they may still share a row with earlier ones); `dropped` the rest, each
 * counted server-side under its reason. `rate-limited` means nothing was read:
 * the page waits `retryAfterS` before it sends again.
 */
export const SiteReportsResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("accepted"),
    accepted: z.number().int(),
    dropped: z.number().int(),
  }),
  z.object({
    kind: z.literal("rate-limited"),
    retryAfterS: z.number().int().min(1),
  }),
]);
export type SiteReportsResponse = z.infer<typeof SiteReportsResponseSchema>;
