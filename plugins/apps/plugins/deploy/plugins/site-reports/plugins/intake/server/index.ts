import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ExcludeFromChangeFeed } from "@plugins/network/plugins/live/plugins/change-feed/server";
import { MirrorSet } from "@plugins/database/plugins/table-mirror/plugins/source/server";
import { siteReportsEndpoint } from "../core";
import {
  siteReportDropsRetention,
  siteReportsRetention,
} from "./internal/retention";
import { handleSubmitSiteReports } from "./internal/routes";
import { siteReportsMirror } from "./internal/mirror";
import { siteReportDrops, siteReports } from "./internal/tables";

export default {
  description:
    "Owns site_reports and site_report_drops: the public POST /api/site-reports endpoint a site page's report channel posts batches to (body capped at 64 KB, at most 10 reports; per-visitor and global batch budgets per minute keyed by a per-process salted IP hash, never stored; each report identified by its ReportKind's own schema and fingerprint and a new fingerprint admitted through the reports fan-out ceiling), aggregated in memory and flushed once a minute as one upsert per fingerprint, the table capped at 2,000 rows, every refusal counted per minute and reason, a 30-day sweep, and the site_reports mirror set (the change stream the deploy app's site-reports/import reduces).",
  httpRoutes: {
    [siteReportsEndpoint.route]: handleSubmitSiteReports,
  },
  contributions: [
    // Read by this computer's site-reports/import as a change stream (the
    // deploy app's site-mirror, over SSH), reduced before anything is kept.
    MirrorSet(siteReportsMirror),
    // Public traffic writes them; nothing renders them live.
    ExcludeFromChangeFeed({
      table: siteReports,
      reason:
        "Written by a site's public report intake; no live-state resource reads it — the deploy app reads its mirror change stream over SSH.",
    }),
    ExcludeFromChangeFeed({
      table: siteReportDrops,
      reason:
        "Drop counts of a site's public report intake; kept on the box for inspection there, never mirrored.",
    }),
  ],
  register: [siteReportsRetention, siteReportDropsRetention],
} satisfies ServerPluginDefinition;
