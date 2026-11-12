import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ExcludeFromChangeFeed } from "@plugins/network/plugins/live/plugins/change-feed/server";
import { importSiteReportsJob } from "./internal/import-job";
import { websiteVisitorErrorKind } from "./internal/kind";
import { siteReportImports } from "./internal/tables";

export default {
  description:
    "Pulls the errors a deployed site's visitors hit into this computer's Reports: the hourly main-only site-reports.import job reads each deployment's host-only list over SSH (outbound only; answer capped at 1 MB and 100 rows), reduces every row to typed, clamped fields (the site's payload never copied) and records at most 50 per deployment per run as ONE incident of the website-visitor-error kind, source website-visitor — untrusted: never on the worklist automations read, fenced as data when investigated by hand. Keeps a per-deployment watermark (site_report_imports).",
  contributions: [
    websiteVisitorErrorKind,
    ExcludeFromChangeFeed({
      table: siteReportImports,
      reason:
        "The import job's own bookkeeping (watermark, last outcome per deployment); no live-state resource reads it.",
    }),
  ],
  register: [importSiteReportsJob],
} satisfies ServerPluginDefinition;
