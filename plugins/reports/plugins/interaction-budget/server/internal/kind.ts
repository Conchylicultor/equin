import { ReportKind, type ReportRow } from "@plugins/reports/server";
import {
  INTERACTION_BUDGET_KIND,
  InteractionBudgetPayloadSchema,
  interactionBudgetFingerprint,
} from "../../core";
import { renderInteractionBudgetTask } from "./render";

// Re-alert the bell at most once per 6 h per row. A budget run follows each of
// main's builds, so an unfixed regression re-files on every deploy.
const NOTIF_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** The `interaction-budget` report kind — see this plugin's CLAUDE.md. */
export const interactionBudgetKind = ReportKind({
  kind: INTERACTION_BUDGET_KIND,
  schema: InteractionBudgetPayloadSchema,
  fingerprint: interactionBudgetFingerprint,
  meta: {
    tag: "[interaction-budget]",
    notif: "An interaction went over its work budget",
    variant: "warning",
    category: "slow-op",
    notifCooldownMs: NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) =>
    renderInteractionBudgetTask(
      row,
      InteractionBudgetPayloadSchema.parse(row.data),
    ),
});
