import { z } from "zod";
import type { StepRegression } from "./detect";

/**
 * The report kind, spelled once: the server registers its `ReportKind` under
 * it, the web dispatches its `Reports.KindView` on it, and `./equin build`
 * files under it through the report outbox.
 */
export const STEP_REGRESSION_KIND = "build-step-regression";

const FsCallsSchema = z.object({
  stat: z.number(),
  readdir: z.number(),
  read: z.number(),
  glob: z.number(),
  total: z.number(),
  top: z.array(z.object({ prefix: z.string(), calls: z.number() })).max(5),
});

/** One step of one build that jumped against its own recent baseline. */
export const StepRegressionPayloadSchema = z.object({
  step: z.string(),
  metric: z.enum(["time", "fs-calls"]),
  value: z.number(),
  baseline: z.number(),
  samples: z.number(),
  calls: FsCallsSchema.nullable(),
  increases: z
    .array(
      z.object({
        prefix: z.string(),
        calls: z.number(),
        baselineCalls: z.number(),
      }),
    )
    .max(5),
  /** The build that showed it, and the checkout it ran in. */
  buildId: z.string(),
  checkout: z.string(),
}) satisfies z.ZodType<StepRegression & { buildId: string; checkout: string }>;
export type StepRegressionPayload = z.infer<typeof StepRegressionPayloadSchema>;

/**
 * One row per step and metric: every build the step stays slow in bumps its
 * count, so a lasting regression is one row, not one per build.
 */
export function stepRegressionFingerprint(d: StepRegressionPayload): string {
  return `${STEP_REGRESSION_KIND}:${d.metric}:${d.step}`;
}

function seconds(ms: number): string {
  return ms >= 10_000
    ? `${Math.round(ms / 1000)} s`
    : `${(ms / 1000).toFixed(1)} s`;
}

function count(n: number): string {
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));
}

/**
 * One line: `artifacts:detect took 171 s, its baseline 20 s (×8.5, 20 builds)`
 * or `… made 452k file calls, its baseline 2.4k (…) — +450k under ~/.equin/…`.
 */
export function stepRegressionLine(d: StepRegression): string {
  const ratio = d.baseline > 0 ? `×${(d.value / d.baseline).toFixed(1)}, ` : "";
  if (d.metric === "time")
    return `${d.step} took ${seconds(d.value)}, its baseline ${seconds(d.baseline)} (${ratio}${d.samples} builds)`;
  const where = d.increases[0];
  return (
    `${d.step} made ${count(d.value)} file calls in a build that rebuilt nothing, ` +
    `its baseline ${count(d.baseline)} (${ratio}${d.samples} builds)` +
    (where
      ? ` — +${count(where.calls - where.baselineCalls)} under ${where.prefix}`
      : "")
  );
}
