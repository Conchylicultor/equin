import { ReportKind, type ReportRow } from "@plugins/reports/server";
import {
  STEP_REGRESSION_KIND,
  StepRegressionPayloadSchema,
  stepRegressionFingerprint,
} from "../../core";
import { renderStepRegressionTask } from "./render";

// Re-alert at most once per 6 h per row: a step that stays slow bumps its row
// on every main build (~100 a day), and one ring per lasting slowdown is the
// signal; the count and the last-seen time carry the rest.
const NOTIF_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** The `build-step-regression` report kind — see this plugin's CLAUDE.md. */
export const stepRegressionKind = ReportKind({
  kind: STEP_REGRESSION_KIND,
  schema: StepRegressionPayloadSchema,
  fingerprint: stepRegressionFingerprint,
  meta: {
    tag: "[build-step]",
    notif: "A build step jumped against its own baseline",
    variant: "warning",
    category: "slow-op",
    notifCooldownMs: NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) =>
    renderStepRegressionTask(row, StepRegressionPayloadSchema.parse(row.data)),
});
