import { z } from "zod";
import { CLIENT_REPORT_SOURCES, type ReportSource } from "./sources";

// THE canonical report field list — fully generic. This is the HTTP body the
// browser POSTs; the server fills in worktree + count + timestamps. `source` is
// restricted to client-reportable origins — server-* sources only arise from
// in-process recordReport callers, never over HTTP.
//
// `kind` discriminates the type of event recorded; each kind owns the shape of
// its `data` payload (validated server-side by its ReportKindSpec.schema). The
// engine treats `data` as opaque jsonb. `message` is the generic one-line
// summary shown in lists / notifications.
//
// Every other boundary (the endpoint contract, the recordReport input type) is
// derived from this schema, so adding a field here can't silently drop it
// downstream.
export const ReportBodySchema = z.object({
  kind: z.string(),
  source: z.enum(CLIENT_REPORT_SOURCES),
  // The kind's payload, validated server-side by its ReportKindSpec.schema.
  // Every caller sends it (often `{}` for payload-less kinds); the engine never
  // inspects it before handing it to the matching spec.
  data: z.record(z.unknown()),
  message: z.string().optional(),
  url: z.string().nullable().optional(),
  userAgent: z.string().nullable().optional(),
  // Tab that produced the report (sessionStorage-backed) and the build id of the
  // bundle that produced it. Used for attribution + stale-frontend detection.
  // Stamped by web/report.ts, not by the caller.
  clientId: z.string().nullable().optional(),
  buildId: z.string().nullable().optional(),
});
export type ReportBody = z.infer<typeof ReportBodySchema>;

// recordReport input: the same field list as the HTTP body (single-sourced from
// the schema), but `source` widened to every origin since server hooks report
// server-* sources the HTTP endpoint rejects.
export type ReportInput = Omit<ReportBody, "source"> & {
  source: ReportSource;
  // The instant the reported event actually happened (epoch ms). Stamped by
  // recordReport itself BEFORE the duress shed gate, so a report buffered
  // during a duress episode replays with its true in-freeze instant instead of
  // the post-episode flush time. Not part of the HTTP body — callers omit it.
  occurredAt?: number;
};
