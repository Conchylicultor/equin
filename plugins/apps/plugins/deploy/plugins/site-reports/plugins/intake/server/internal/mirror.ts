import { defineMirrorSet } from "@plugins/database/plugins/table-mirror/plugins/source/server";
import { SITE_REPORTS_MIRROR_SET_ID } from "../../core";
import { siteReports } from "./tables";

/**
 * The `site_reports` mirror set: every change to a site's aggregated error
 * rows (a new fingerprint, a recurrence moving `count` and `last_seen_at`),
 * read by this computer's site-reports/import as a change stream — through a
 * reduce step, never as a copy of the rows (`site-mirror` / table-mirror's
 * custom sink). `site_report_drops` is not in it: nothing reads it there.
 */
export const siteReportsMirror = defineMirrorSet({
  id: SITE_REPORTS_MIRROR_SET_ID,
  tables: [siteReports],
});
