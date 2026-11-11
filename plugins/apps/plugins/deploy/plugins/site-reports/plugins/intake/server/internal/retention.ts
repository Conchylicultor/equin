import { defineRetention } from "@plugins/infra/plugins/retention/server";
import { SITE_REPORT_LIMITS } from "../../core";
import { siteReportDrops, siteReports } from "./tables";

/**
 * A fingerprint no visitor hit for `retentionDays` goes, and so do old drop
 * counts. `perWorktree: true` because a deployed release is never main, and
 * only perWorktree crons install there.
 */
export const siteReportsRetention = defineRetention({
  table: siteReports,
  column: "lastSeenAt",
  ttlDays: SITE_REPORT_LIMITS.retentionDays,
  perWorktree: true,
});

export const siteReportDropsRetention = defineRetention({
  table: siteReportDrops,
  column: "windowStartedAt",
  ttlDays: SITE_REPORT_LIMITS.retentionDays,
  perWorktree: true,
});
