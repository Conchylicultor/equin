import type { CheckResult } from "@plugins/framework/plugins/tooling/core";
import type { ChildKilledError } from "@plugins/infra/plugins/spawn/core";

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

/**
 * A check's result, read against the children it spawned that died of a
 * signal (`watchChildKills`, `infra/spawn`, recorded by the spawn primitives
 * themselves). A fatal failure that does not already say `killedBy` and saw
 * such a kill is read as caused by it: the check was cut off before it could
 * answer — a `git` the OOM killer took reads as "git failed", whatever the
 * check then says — so it carries `killedBy` (the first kill's signal), and
 * the pass is no verdict on the code when nothing else failed.
 *
 * Generic on purpose: a check that spawns needs no code of its own to be read
 * right. A real failure that coincides with a kill is read as killed too; a
 * killed build is retried a bounded number of times (`build/converge`), so
 * the misread costs a retry, never a verdict that keeps a broken tree out.
 */
export function withKillsSeen(
  result: CheckResult,
  kills: readonly ChildKilledError[],
): CheckResult {
  if (result.ok || result.inconclusive === true) return result;
  if (result.killedBy !== undefined || kills.length === 0) return result;
  const first = kills[0]!;
  return {
    ...result,
    killedBy: first.signal,
    message: `${result.message}\n\n${kills.map((k) => k.message).join("\n")}`,
    hint:
      "A process this check ran was killed by a signal (the OOM killer, a crash) before it answered: " +
      "no verdict on the code. Re-run it.",
  };
}
