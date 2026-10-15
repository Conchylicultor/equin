import { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { nullable } from "@plugins/fields/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import type { Standing } from "@plugins/tasks/plugins/attempt-work/core";

/**
 * Where the attempt's work stood when the report was submitted — attempt-work's
 * `Standing`, measured from git at submit time: `landed` (in main), `pending`
 * (a built branch waiting for its push), `none` (nothing committed). Stored
 * rather than a `pushed` bool because "stopped at a built branch" is exactly
 * the case the reader has to act on.
 */
export const REPORT_STANDINGS = [
  "none",
  "pending",
  "landed",
] as const satisfies readonly Standing[];
export type ReportStanding = (typeof REPORT_STANDINGS)[number];

// The `tasks_ext_outcome_report` row: the latest report an agent submitted for
// its task (one per task; a later submit replaces it). `server/internal/
// tables.ts` builds the side-table from this shape; the wire row is its
// `schema`. `answers` are one-click labels for `question` — empty when there is
// no question.
export const outcomeReportShape = defineExtensionShape({
  key: "taskId",
  fields: {
    conversationId: textField(),
    body: textField(),
    standing: enumTextField(REPORT_STANDINGS),
    question: nullable(textField()),
    answers: jsonField({ schema: z.array(z.string()), default: [] }),
    submittedAt: dateField(),
  },
});
export const OutcomeReportSchema = outcomeReportShape.schema;
export type OutcomeReport = z.infer<typeof OutcomeReportSchema>;

// ONE task's report, read by the task's id: lookup-only (nothing lists every
// report), minting `outcome-reports:rows` alone. A reader asks with
// `useLiveRow(outcomeReportRows, taskId)`; `found: false` is "no report yet".
// The `:rows` point routing sends a submit only to the readers of that task.
// Served from the extension handle in `server/internal/resource.ts`.
export const outcomeReportRows = liveCollection("outcome-reports", {
  from: outcomeReportShape,
  id: "taskId",
});
