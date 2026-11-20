import { fetchEndpointOver } from "@plugins/infra/plugins/endpoints/web";
import { pageTransport } from "@plugins/primitives/plugins/networking/plugins/page-transport/web";
import type { ReportChannel } from "@plugins/reports/web";
import { AUTOMATED_BROWSER } from "@plugins/primitives/plugins/scope/plugins/automation/web";
import {
  siteReportsEndpoint,
  type PageDropReason,
} from "@plugins/apps/plugins/deploy/plugins/site-reports/plugins/intake/core";
import { createReportBatcher } from "./batcher";
import { toSiteReport } from "./to-entry";

// Page-wide telemetry: a site page's reports always reach the page's own
// server (D3) — the site's public intake, whatever subtree (the live demo
// included) raised them.
const fetchEndpoint = fetchEndpointOver(pageTransport);

/** The page's one batcher: its caps are per visit (page load). */
export const siteReportBatcher = createReportBatcher({
  send: (reports, dropped, { keepalive }) =>
    fetchEndpoint(
      siteReportsEndpoint,
      {},
      // `report: false`: a failed batch must never file a report about itself.
      // `automated`: a page under automation says so, and the intake counts
      // its batch as such instead of storing it beside visitors' reports.
      {
        body: {
          reports,
          ...(Object.keys(dropped).length > 0 ? { dropped } : {}),
          automated: AUTOMATED_BROWSER,
        },
        keepalive,
        report: false,
      },
    ),
  schedule: (fn, delayMs) => {
    setTimeout(fn, delayMs);
  },
  warn: (message) => console.warn(message),
});

/** report() on a site page: into the batcher, never one request per report. */
export const siteReportChannel: ReportChannel = (body) => {
  const entry = toSiteReport(body, window.location.href);
  return Promise.resolve({ outcome: siteReportBatcher.add(entry) });
};

/**
 * Count, on a site page, one measurement the page judged not to be one (a
 * load no one waited for): it reaches the intake's drop counts under its
 * reason with the page's next batch, and is never filed.
 */
export function countPageDrop(reason: PageDropReason): void {
  siteReportBatcher.drop(reason);
}
