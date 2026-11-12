import { fetchEndpointOver } from "@plugins/infra/plugins/endpoints/web";
import { pageTransport } from "@plugins/primitives/plugins/networking/plugins/page-transport/web";
import { getTabId } from "@plugins/primitives/plugins/scope/plugins/tab-id/web";
import { defineRequestSink } from "@plugins/primitives/plugins/report-sink/core";
import {
  ReportBodySchema,
  reportMessageOrDerived,
  submitReport,
  type ReportBody,
  type ReportResult,
} from "../core";

export type { ReportResult };

/**
 * What became of one `report()` call, as far as the page can say: the server's
 * answer (`ReportResult`); `batched` — a channel that batches (the website's)
 * took the report and will send it with others, so there is no row id yet; or
 * `dropped` — that channel refused it over its own per-visit caps (counted on
 * the page). `null` is "not delivered" (warned to the console).
 */
export type ClientReportOutcome =
  ReportResult | { outcome: "batched" } | { outcome: "dropped" };

/**
 * Where a stamped report goes. The default sends it to the page's own reports
 * engine (`POST /api/reports`, one request per report, retried). A composition
 * whose server has no engine — the standalone website, whose visitors are
 * anonymous — installs its own channel at register time
 * (`apps/deploy/site-reports/channel`): bounded, batched, deduped, to its own
 * public intake. A channel that throws is caught by report(), which warns.
 */
export type ReportChannel = (body: ReportBody) => Promise<ClientReportOutcome>;

// Retry budget for one report: 6 retries sleeping 0.5, 1, 2, 4, 8, 16 s
// (backoffMs * 2^attempt, ±15% jitter) — about 31.5 s across 7 attempts, enough
// to outlast a backend hot restart or a host-overload stall. Only a network
// error or a 502/503/504 is retried; a 4xx is the server rejecting the report
// and is final. A retry after a lost response cannot duplicate a row: reports
// dedupe by fingerprint, so a second landing only bumps the existing row's count.
const REPORT_RETRY = { retries: 6, backoffMs: 500 };

async function sendToEngine(body: ReportBody): Promise<ClientReportOutcome> {
  // Reports are page-wide telemetry (window.onerror, boot, the crash beacon):
  // they belong to the page and always reach the page's own server, whatever
  // subtree raised them.
  const fetchEndpoint = fetchEndpointOver(pageTransport);
  return await fetchEndpoint(
    submitReport,
    {},
    { body, keepalive: true, report: false, retry: REPORT_RETRY },
  );
}

/**
 * Where every report() on this page goes, when a composition says otherwise
 * (a request sink: one handler, its answer returned). Nobody registered →
 * report() sends to the page's reports engine. The website's channel
 * (`apps/deploy/site-reports/channel`) registers in its register phase —
 * before anything renders, so no report of the page goes elsewhere first.
 */
export const reportChannel = defineRequestSink<
  ReportBody,
  Promise<ClientReportOutcome>
>();

// The caller-supplied portion of a report: the browser picks the kind, the
// source (client-reportable only — enforced by ReportBodySchema's enum), the
// generic summary, and the kind's `data` payload; report() stamps
// clientId/buildId/commit itself. `clientId` defaults to this tab; a report filed ON
// BEHALF of another tab (a main-thread stall a live tab files for the tab that
// froze) names that tab instead, so its origin reads as the page it is about.
// `url` defaults to this page's.
export type ClientReportBody = Omit<
  ReportBody,
  "clientId" | "buildId" | "commit"
> & {
  clientId?: string;
};

// Shape of the `context` value the reports plugin's boundary reporter returns.
// Action contributors (e.g. launch-fix) cast `context: unknown` down to this
// type. A report no longer auto-creates a task, so the Fix button investigates
// the report on demand via `reportId`; `taskId` stays null until then.
export interface ReportContext {
  reportId: string | null;
  taskId: string | null;
}

// Stamp the report and send it through the registered channel
// (`reportChannel`;
// by default POST /api/reports via the typed endpoint, `keepalive: true` so it
// survives page unload, `report: false` so a failing report beacon never files
// a report about itself). Never throws: we're in an error path already.
// Returns null if the channel failed (warned to the console, so a report the
// server never received still leaves a trace).
export async function report(
  body: ClientReportBody,
): Promise<ClientReportOutcome | null> {
  try {
    const stamped = {
      ...body,
      // A blank message is a collector bug: filed anyway, saying so, so the bug
      // reaches Reports instead of vanishing with the report.
      message: reportMessageOrDerived(body),
      url: body.url ?? window.location.href,
      clientId: body.clientId ?? getTabId(),
      // The ARTIFACT this tab is running — the graph hash baked into the bundle,
      // not the id of the run that produced it. The server compares it against
      // the graph it is currently serving to tell a version-skew report from a
      // live one, and only a content identity can answer that: a rebuild that
      // changed nothing used to make every in-flight tab look outdated. The wire
      // field keeps its `buildId` name; what fills it is what changed.
      buildId: import.meta.env.VITE_BUILD_GRAPH ?? null,
      // The commit the bundle was built from — what a fixed report's
      // regression is judged on. "" (unresolvable at build) and a dev server's
      // undefined both mean "cannot name it".
      commit: import.meta.env.VITE_BUILD_COMMIT || null,
    };
    // Checked before any channel: a body the engine or a site's intake would
    // refuse must not take a site's batch of good ones with it.
    const parsed = ReportBodySchema.parse(stamped);
    return await (reportChannel.emit(parsed) ?? sendToEngine(parsed));
    // eslint-disable-next-line promise-safety/no-absorbed-failure -- this is called during crash/error handling (keepalive fetch at page unload); propagating here would hide the original error and crash the error handler itself. The failure is not silent: it is warned below, after the retries above ran out
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    console.warn(
      `[reports] report not delivered (${body.kind}/${body.source}): ${body.message} — ${cause}`,
    );
    return null;
  }
}
