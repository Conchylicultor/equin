import { fetchEndpointOver } from "@plugins/infra/plugins/endpoints/web";
import { pageTransport } from "@plugins/primitives/plugins/networking/plugins/page-transport/web";
import { getTabId } from "@plugins/primitives/plugins/scope/plugins/tab-id/web";
import { submitReport, type ReportBody, type ReportResult } from "../core";

export type { ReportResult };

// The caller-supplied portion of a report: the browser picks the kind, the
// source (client-reportable only — enforced by ReportBodySchema's enum), the
// generic summary, and the kind's `data` payload; report() stamps
// clientId/buildId itself.
export type ClientReportBody = Omit<ReportBody, "clientId" | "buildId">;

// Shape of the `context` value the reports plugin's boundary reporter returns.
// Action contributors (e.g. launch-fix) cast `context: unknown` down to this
// type. A report no longer auto-creates a task, so the Fix button investigates
// the report on demand via `reportId`; `taskId` stays null until then.
export interface ReportContext {
  reportId: string | null;
  taskId: string | null;
}

// Retry budget for one report: 6 retries sleeping 0.5, 1, 2, 4, 8, 16 s
// (backoffMs * 2^attempt, ±15% jitter) — about 31.5 s across 7 attempts, enough
// to outlast a backend hot restart or a host-overload stall. Only a network
// error or a 502/503/504 is retried; a 4xx is the server rejecting the report
// and is final. A retry after a lost response cannot duplicate a row: reports
// dedupe by fingerprint, so a second landing only bumps the existing row's count.
const REPORT_RETRY = { retries: 6, backoffMs: 500 };

// POST to /api/reports via the typed endpoint. Never throws: we're in an error
// path already. `keepalive: true` lets the request survive page unload.
// `report: false` stops fetchEndpoint from invoking the error-reporter, which
// would recurse (a failing report beacon must not file a report about itself).
// Returns null if every attempt failed (warned to the console, so a report the
// server never received still leaves a trace) or the request was discarded
// during unload.
export async function report(
  body: ClientReportBody,
): Promise<ReportResult | null> {
  // Reports are page-wide telemetry (window.onerror, boot, the crash beacon):
  // they belong to the page and always reach the page's own server, whatever
  // subtree raised them.
  const fetchEndpoint = fetchEndpointOver(pageTransport);
  try {
    const stamped = {
      ...body,
      clientId: getTabId(),
      // The ARTIFACT this tab is running — the graph hash baked into the bundle,
      // not the id of the run that produced it. The server compares it against
      // the graph it is currently serving to tell a version-skew report from a
      // live one, and only a content identity can answer that: a rebuild that
      // changed nothing used to make every in-flight tab look outdated. The wire
      // field keeps its `buildId` name; what fills it is what changed.
      buildId: import.meta.env.VITE_BUILD_GRAPH ?? null,
    };
    return await fetchEndpoint(
      submitReport,
      {},
      { body: stamped, keepalive: true, report: false, retry: REPORT_RETRY },
    );
    // eslint-disable-next-line promise-safety/no-absorbed-failure -- this is called during crash/error handling (keepalive fetch at page unload); propagating here would hide the original error and crash the error handler itself. The failure is not silent: it is warned below, after the retries above ran out
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    console.warn(
      `[reports] report not delivered (${body.kind}/${body.source}): ${body.message ?? "(no message)"} — ${cause}`,
    );
    return null;
  }
}
