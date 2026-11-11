import { desc } from "drizzle-orm";
import type { SiteReportsListQuery, SiteReportsPage } from "../../core";
import type { SiteReportsDb } from "./db";
import { siteReportDrops, siteReports } from "./tables";

/** The most recently seen reports and the newest drop-count rows, bounded by `limit`. */
export async function listSiteReports(
  dbx: SiteReportsDb,
  query: SiteReportsListQuery,
): Promise<SiteReportsPage> {
  const reports = await dbx
    .select()
    .from(siteReports)
    .orderBy(desc(siteReports.lastSeenAt))
    .limit(query.limit);
  const drops = await dbx
    .select()
    .from(siteReportDrops)
    .orderBy(desc(siteReportDrops.windowStartedAt))
    .limit(query.limit);
  return {
    kind: "site-reports",
    reports: reports.map((r) => ({
      fingerprint: r.fingerprint,
      kind: r.kind,
      source: r.source,
      message: r.message,
      data: r.data,
      path: r.path,
      buildId: r.buildId,
      commit: r.commit,
      count: r.count,
      firstSeenAt: r.firstSeenAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
    })),
    drops: drops.map((d) => ({
      windowStartedAt: d.windowStartedAt.toISOString(),
      reason: d.reason,
      count: d.count,
    })),
  };
}
