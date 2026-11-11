import type { ReportBody } from "@plugins/reports/core";
import { SITE_REPORT_LIMITS as L } from "@plugins/apps/plugins/deploy/plugins/site-reports/plugins/intake/core";
import type { BatchedReport } from "./batcher";

function clampString(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function clampStrings(value: unknown, max: number, depth = 0): unknown {
  if (typeof value === "string") return clampString(value, max);
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((v) => clampStrings(v, max, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, clampStrings(v, max, depth + 1)]),
  );
}

/**
 * A stamped report as the site's channel sends it — anonymous: no client id,
 * no user agent, the page's pathname only (never its query or hash), the
 * message and every string of the kind payload clamped. `null` when the
 * payload is still over the intake's size bound with its strings at their
 * shortest: such a report is not sent.
 */
export function toSiteReport(
  body: ReportBody,
  pageUrl: string,
): BatchedReport | null {
  let data = clampStrings(body.data, L.maxDataString) as Record<
    string,
    unknown
  >;
  if (JSON.stringify(data).length > L.maxDataBytes) {
    data = clampStrings(body.data, 200) as Record<string, unknown>;
    if (JSON.stringify(data).length > L.maxDataBytes) return null;
  }
  return {
    kind: body.kind,
    source: body.source,
    message: clampString(body.message ?? "", L.maxMessage),
    data,
    path: clampString(new URL(body.url ?? pageUrl, pageUrl).pathname, 512),
    buildId: body.buildId ? clampString(body.buildId, 128) : null,
    commit: body.commit ? clampString(body.commit, 64) : null,
  };
}
