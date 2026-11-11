import { fetchEndpointOver } from "@plugins/infra/plugins/endpoints/web";
import { pageTransport } from "@plugins/primitives/plugins/networking/plugins/page-transport/web";
import type { ReportChannel } from "@plugins/reports/web";
import { siteReportsEndpoint } from "@plugins/apps/plugins/deploy/plugins/site-reports/plugins/intake/core";
import { createReportBatcher } from "./batcher";
import { toSiteReport } from "./to-entry";

// Page-wide telemetry: a site page's reports always reach the page's own
// server (D3) — the site's public intake, whatever subtree (the live demo
// included) raised them.
const fetchEndpoint = fetchEndpointOver(pageTransport);

/** The page's one batcher: its caps are per visit (page load). */
export const siteReportBatcher = createReportBatcher({
  send: (reports, { keepalive }) =>
    fetchEndpoint(
      siteReportsEndpoint,
      {},
      // `report: false`: a failed batch must never file a report about itself.
      { body: { reports }, keepalive, report: false },
    ),
  schedule: (fn, delayMs) => {
    setTimeout(fn, delayMs);
  },
  warn: (message) => console.warn(message),
});

/** report() on a site page: into the batcher, never one request per report. */
export const siteReportChannel: ReportChannel = (body) => {
  const entry = toSiteReport(body, window.location.href);
  if (entry === null) return Promise.resolve({ outcome: "dropped" });
  return Promise.resolve({ outcome: siteReportBatcher.add(entry) });
};
