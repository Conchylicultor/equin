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
// summary shown in lists / notifications — required, never blank.
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
  data: z.record(z.string(), z.unknown()),
  // Required and never blank: the one line a report is read — and a stackless
  // crash identified — by. A report with nothing in it cannot be diagnosed, so
  // it cannot be filed: a collector whose catch carries no message says what it
  // did see (the event's type and target, the status and route) instead.
  message: z
    .string()
    .refine(
      (m) => m.trim() !== "",
      "a report needs a message saying what happened",
    ),
  url: z.string().nullable().optional(),
  userAgent: z.string().nullable().optional(),
  // Tab that produced the report (sessionStorage-backed) and the build id of the
  // bundle that produced it. Used for attribution + stale-frontend detection.
  // Stamped by web/report.ts, not by the caller.
  clientId: z.string().nullable().optional(),
  buildId: z.string().nullable().optional(),
  // The commit the reporting code ran: the bundle's build commit for a tab
  // (stamped by web/report.ts), the backend's pin for an in-process report
  // (stamped by recordReport), the writer's HEAD for an outbox entry. What a
  // regression of a fixed report is judged on.
  commit: z.string().nullable().optional(),
  // A load the report is about failed, and the tab found which file of its own
  // build it needed that the server answered 404 for: that file's URL path
  // (`/artifacts/<name>/<file>`). The tab's half of the proof that version
  // skew explains the report — the server re-checks it against what it serves
  // and the builds it retired (reports/core's version-skew), never trusting it
  // alone. Absent when the tab proved no such file (all served, a network
  // error, another status): then nothing explains the failure but a bug.
  missingFile: z
    .string()
    .regex(/^\/artifacts\/[^/]+\/.+$/)
    .optional(),
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
