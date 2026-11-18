import type { CheckResult } from "@plugins/framework/plugins/tooling/core";

/**
 * The signal a failed pass ended on, when its failure is no verdict at all:
 * every fatal non-passing check says a process it ran was killed
 * (`killedBy`), so nothing judged the code. `null` when any check failed on
 * its own (a real failure wins), or when nothing failed.
 *
 * The first check's signal names the pass: they are usually the same (one
 * OOM kill), and a caller needs one exit code.
 */
export function passKilledBy(failures: readonly CheckResult[]): string | null {
  const fatal = failures.flatMap((f) =>
    !f.ok && f.inconclusive !== true ? [f] : [],
  );
  if (fatal.length === 0) return null;
  const signals = fatal.map((f) => f.killedBy);
  return signals.every((s) => s !== undefined) ? signals[0]! : null;
}
