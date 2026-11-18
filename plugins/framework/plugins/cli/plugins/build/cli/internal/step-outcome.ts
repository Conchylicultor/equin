import type { CheckSubprocessResult } from "@plugins/framework/plugins/cli/plugins/op-runtime/cli";
import { killedByOf } from "@plugins/infra/plugins/spawn/core";

/**
 * How a step ended. `killed`: a process the step ran died of a signal (the
 * Linux OOM killer takes the biggest process, which is a build's child — a
 * type-check worker, a check pass — not the build), so the step judged
 * nothing. Only `failed` is a verdict on the code; the build's funnel turns a
 * failure made only of `killed` steps into a killed build, which the ledger
 * records as no verdict (`buildFailureEnd`, ./failure-end.ts).
 */
export type StepOutcome =
  { kind: "ok" } | { kind: "failed" } | { kind: "killed"; signal: string };

/**
 * The signal a set of steps' failure is made of, when every step that did not
 * pass was `killed` — nothing judged the code — else `null` (one real failure
 * is a verdict; all passing is no failure). The first killed step names it.
 */
export function stepsKilledBy(
  steps: readonly { outcome: StepOutcome }[],
): string | null {
  const notOk = steps.filter((s) => s.outcome.kind !== "ok");
  const first = notOk[0];
  if (first === undefined || first.outcome.kind !== "killed") return null;
  return notOk.every((s) => s.outcome.kind === "killed")
    ? first.outcome.signal
    : null;
}

/** The step outcome of a check pass run as a subprocess. */
export function checkStepOutcome(
  ended: CheckSubprocessResult["ended"],
): StepOutcome {
  switch (ended.kind) {
    case "passed":
      return { kind: "ok" };
    case "failed":
      return { kind: "failed" };
    case "killed":
      return { kind: "killed", signal: ended.signal };
  }
}

/**
 * A step's outcome from a thrown error: `killed` when the error is (or wraps)
 * a `ChildKilledError`, else `failed`.
 */
export function stepOutcomeOfError(err: unknown): StepOutcome {
  const killed = killedByOf(err);
  return killed === null
    ? { kind: "failed" }
    : { kind: "killed", signal: killed.signal };
}
