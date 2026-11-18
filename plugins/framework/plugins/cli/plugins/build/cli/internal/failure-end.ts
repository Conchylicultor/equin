import { BUILD_EXIT_SUPERSEDED } from "@plugins/build/plugins/build-status/core";
import { signalExitCode } from "@plugins/infra/plugins/spawn/core";

/**
 * How a failed build ends — the one code its ledger row, its receipts and its
 * own exit status are stamped with:
 *
 * - `superseded` (75): its checkout moved mid-build, so it judged no tree.
 * - `killed` (`128 + signo`): every failure is a process killed by a signal —
 *   on a Linux host the OOM killer takes the biggest process, a build's child
 *   (a type-check worker, a check pass), not the build. Nothing judged the
 *   code, so the ledger reads it as `killed` (`buildStatusOf`), a no-verdict
 *   attempt main's convergence retries, the same as a build that took the
 *   signal itself. The code is first-party, authored here from a typed step
 *   outcome — the licence `BUILD_EXIT_SIGNAL_BASE` requires.
 * - `failed` (1): anything else — a check that found something, a compile
 *   error, a backend that did not come up. One such failure makes the whole
 *   build a verdict, killed steps beside it or not.
 */
export type BuildFailureEnd =
  | { kind: "superseded"; exitCode: number }
  | { kind: "killed"; signal: string; exitCode: number }
  | { kind: "failed"; exitCode: number };

export function buildFailureEnd(i: {
  /** The commit the checkout moved to mid-build, or null. */
  supersededBy: string | null;
  /**
   * Each failure the build is ending on, as the signal it is made of when it
   * is only killed processes (`killedBy`), else null. Empty is a failure with
   * no named cause, never a kill.
   */
  failures: readonly { killedBy: string | null }[];
}): BuildFailureEnd {
  if (i.supersededBy !== null)
    return { kind: "superseded", exitCode: BUILD_EXIT_SUPERSEDED };
  const first = i.failures[0]?.killedBy ?? null;
  if (first !== null && i.failures.every((f) => f.killedBy !== null))
    return { kind: "killed", signal: first, exitCode: signalExitCode(first) };
  return { kind: "failed", exitCode: 1 };
}
