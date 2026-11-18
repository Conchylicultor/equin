import {
  fitReportBody,
  trimText,
  type ReportBody,
} from "@plugins/reports/core";
import { SITE_REPORT_LIMITS as L } from "@plugins/apps/plugins/deploy/plugins/site-reports/plugins/intake/core";
import type { BatchedReport } from "./batcher";

/**
 * A stamped report as the site's channel sends it — anonymous: no client id,
 * no user agent, the page's pathname only (never its query or hash) — and
 * fitted to the intake's bounds (reports/core's fitReportBody): a report too
 * large is sent trimmed, saying so, never dropped.
 */
export function toSiteReport(body: ReportBody, pageUrl: string): BatchedReport {
  const fitted = fitReportBody(body, {
    maxMessage: L.maxMessage,
    maxDataBytes: L.maxDataBytes,
    maxDataString: L.maxDataString,
    maxUrl: 2_048,
  });
  return {
    kind: body.kind,
    source: body.source,
    message: fitted.message,
    data: fitted.data,
    path: trimText(new URL(body.url ?? pageUrl, pageUrl).pathname, 512),
    buildId: body.buildId ? trimText(body.buildId, 128) : null,
    commit: body.commit ? trimText(body.commit, 64) : null,
  };
}
