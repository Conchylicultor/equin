import { z } from "zod";
import { BuildSubStepId, InstallStepId, type InstallEvent } from "./events";
import estimatesJson from "../estimates.json";

/**
 * Per-step medians from clean installs, in seconds — `core/estimates.json`,
 * written only by `./equin installer estimates` from the timing files real
 * installs leave (`~/.equin/install/<run>/timing.json`). A step with no
 * measured run is null: a renderer then shows no number for it, never a
 * guess. install.sh carries a generated copy (its `estimates` block), held
 * equal to this file by the `installer:estimates-in-sync` check.
 */
export const InstallEstimates = z.strictObject({
  /**
   * How many timing files the medians were taken over — the most any step's
   * was, when steps were measured in separate passes (`--only`).
   */
  installs: z.number().int().nonnegative(),
  steps: z.record(InstallStepId, z.number().nonnegative().nullable()),
});
export type InstallEstimates = z.infer<typeof InstallEstimates>;

export const INSTALL_ESTIMATES: InstallEstimates =
  InstallEstimates.parse(estimatesJson);

/**
 * What one install measured, written beside its events when it ends
 * (`~/.equin/install/<run>/timing.json`): every step that ran to `done`, with
 * how long it took. Skipped, failed and never-reached steps are absent — a
 * median is taken only over steps that really ran — except a build sub-step
 * skipped inside a build that ran to `done`: it is part of that measured
 * build, and took 0 (a fresh install's build finds main already built by the
 * service, so every sub-step is skipped; leaving them out would keep their
 * estimates null, and with them the whole time left).
 */
export const InstallTiming = z.strictObject({
  v: z.literal(1),
  /** A `--dry-run`'s: scripted timings, never a median's input. */
  dryRun: z.boolean(),
  release: z.string().nullable(),
  platform: z.string().min(1),
  /** When the install finished: an ISO-8601 instant. */
  at: z.iso.datetime(),
  steps: z.partialRecord(InstallStepId, z.number().int().nonnegative()),
});
export type InstallTiming = z.infer<typeof InstallTiming>;

/** The median of a non-empty list. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The estimate table medians over `timings` (ms → whole seconds). */
export function estimatesFrom(
  timings: readonly InstallTiming[],
): InstallEstimates {
  const steps = Object.fromEntries(
    InstallStepId.options.map((id) => {
      const runs = timings
        .map((t) => t.steps[id])
        .filter((ms): ms is number => ms !== undefined);
      return [id, runs.length === 0 ? null : Math.round(median(runs) / 1000)];
    }),
  ) as InstallEstimates["steps"];
  return { installs: timings.length, steps };
}

/**
 * The timing an install's own event stream records (`<run>/events.jsonl`),
 * for a run that left no `timing.json` — an install whose run dir was copied
 * off another machine before its timing file existed, say. The same reading
 * install.sh's `write_timing` makes: each step's last `done` time (a retry
 * keeps its last), a build sub-step's last `skipped` as 0 when the build ran
 * to `done`, only for a stream that reached `done` (a finished install). A
 * stream that did not is an error, never an empty timing.
 */
export function timingFromEvents(
  events: readonly InstallEvent[],
): { ok: true; timing: InstallTiming } | { ok: false; error: string } {
  const plan = events[0];
  if (plan?.type !== "plan")
    return { ok: false, error: "the stream does not start with its plan" };
  const done = events.find((e) => e.type === "done");
  if (done === undefined)
    return { ok: false, error: "the install never finished (no done event)" };
  const steps: InstallTiming["steps"] = {};
  const skippedSubSteps = new Set<BuildSubStepId>();
  for (const e of events) {
    if (e.type !== "step") continue;
    const sub = BuildSubStepId.safeParse(e.id);
    if (e.state === "done" && e.ms !== undefined) {
      steps[e.id] = e.ms;
      if (sub.success) skippedSubSteps.delete(sub.data);
    } else if (e.state === "skipped" && sub.success) {
      skippedSubSteps.add(sub.data);
      delete steps[sub.data];
    }
  }
  if (steps.build !== undefined)
    for (const id of skippedSubSteps) steps[id] = 0;
  return {
    ok: true,
    timing: {
      v: 1,
      dryRun: plan.dryRun === true,
      release: plan.release,
      platform: plan.platform,
      at: done.t,
      steps,
    },
  };
}
