import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ExcludeFromChangeFeed } from "@plugins/network/plugins/live/plugins/change-feed/server";
import { siteReportsEndpoint, siteReportsListEndpoint } from "../core";
import {
  siteReportDropsRetention,
  siteReportsRetention,
} from "./internal/retention";
import {
  handleListSiteReports,
  handleSubmitSiteReports,
} from "./internal/routes";
import { siteReportDrops, siteReports } from "./internal/tables";

export default {
  description:
    "Owns site_reports and site_report_drops: the public POST /api/site-reports endpoint a site page's report channel posts batches to (body capped at 64 KB, at most 10 reports; per-visitor and global batch budgets per minute keyed by a per-process salted IP hash, never stored; each report identified by its ReportKind's own schema and fingerprint and a new fingerprint admitted through the reports fan-out ceiling), aggregated in memory and flushed once a minute as one upsert per fingerprint, the table capped at 2,000 rows, every refusal counted per minute and reason, a 30-day sweep, and the host-only list the deploy app reads over SSH.",
  httpRoutes: {
    [siteReportsEndpoint.route]: handleSubmitSiteReports,
    [siteReportsListEndpoint.route]: handleListSiteReports,
  },
  contributions: [
    // Public traffic writes them; nothing renders them live (the deploy app
    // reads the host-only list on demand).
    ExcludeFromChangeFeed({
      table: siteReports,
      reason:
        "Written by a site's public report intake; no live-state resource reads it — the deploy app reads the host-only list over SSH on demand.",
    }),
    ExcludeFromChangeFeed({
      table: siteReportDrops,
      reason:
        "Drop counts of a site's public report intake; read only through the host-only list.",
    }),
  ],
  register: [siteReportsRetention, siteReportDropsRetention],
} satisfies ServerPluginDefinition;
