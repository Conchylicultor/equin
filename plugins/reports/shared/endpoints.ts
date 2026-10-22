import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { ReportBodySchema } from "./types";

// What became of the submitted report, as a discriminated union: the engine can
// take ownership of an occurrence (duress shedding, fan-out collapse) and those
// outcomes must not be readable as "recorded, with no id". Mirrors
// RecordReportResult in the server's record-report.ts.
export const ReportResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("recorded"),
    // The id of the persisted report row, so the crash boundary reporter can
    // hand it to launch-fix (which creates the investigation task on demand).
    reportId: z.string(),
    // No report auto-creates a task; this stays null until the user clicks
    // "investigate". Kept so existing rows / dedup reads still flow through.
    taskId: z.string().nullable(),
    rateLimited: z.boolean(),
  }),
  // Buffered by the duress shed engine and replayed after the episode clears.
  z.object({ outcome: z.literal("shed") }),
  // Folded into a fan-out storm rollup of kind `stormKind`: no row of its own,
  // no notification. The budget refills next window, so a persistent problem
  // still mints its own row shortly.
  z.object({ outcome: z.literal("collapsed"), stormKind: z.string() }),
]);
export type ReportResult = z.infer<typeof ReportResultSchema>;

export const submitReport = defineEndpoint({
  route: "POST /api/reports",
  // Error reports (and the bell notification they raise) — an agent session's
  // failures must still be recorded on main, which is otherwise read-only for it.
  agentWrite: "telemetry",
  body: ReportBodySchema,
  response: ReportResultSchema,
});

export const InvestigateResultSchema = z.object({
  taskId: z.string(),
});
export type InvestigateResult = z.infer<typeof InvestigateResultSchema>;

export const investigateReport = defineEndpoint({
  route: "POST /api/reports/:id/investigate",
  response: InvestigateResultSchema,
});
