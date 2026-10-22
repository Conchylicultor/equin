import { recordReport } from "./record-report";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import { submitReport } from "@plugins/reports/core";

// `body` is the validated ReportBody — its field list is single-sourced from
// ReportBodySchema and it is structurally a ReportInput (client sources ⊂
// ReportSource), so every reported field flows through with no per-field
// hand-map (which previously silently dropped new fields like clientId/buildId).
// Invalid sources are rejected by the schema's z.enum at the validation layer
// (clean 400), so no manual source check is needed here.
export const handleReport = implement(submitReport, async ({ body }) =>
  recordReport(body),
);
