import type { ReportRow } from "@plugins/reports/server";
import { SlowPageLoadPayloadSchema, slowPageLoadSummary } from "../../core";

/**
 * The kind's investigation task. The site's server has no reports engine, so
 * nothing on the box renders it; it exists because every kind names one, and
 * says what a reader of the row needs.
 */
export function renderSlowPageLoadTask(row: ReportRow): {
  title: string;
  description: string;
} {
  // Validated by the schema at intake: a failure here is a corrupted row.
  const p = SlowPageLoadPayloadSchema.parse(row.data);
  return {
    title: `[slow-page-load] ${p.phase} on ${p.client.os}`,
    description: [
      slowPageLoadSummary(p),
      "",
      "Milestones are ms from the navigation's start (first byte, first contentful paint, the route's content commit).",
    ].join("\n"),
  };
}
