import {
  BUILD_EXIT_OUT_OF_MEMORY,
  BUILD_EXIT_SUPERSEDED,
} from "@plugins/build/plugins/build-status/core";
import type { OomKillCount } from "@plugins/packages/plugins/host-memory/core";
import type { ScopeOomdKill } from "@plugins/packages/plugins/systemd-scope/core";
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
 * - `out-of-memory` (`BUILD_EXIT_OUT_OF_MEMORY`, 71): a `killed` end in
 *   which at least one kill is a SIGKILL and the host's OOM-kill counter rose
 *   between the build's start and its end — the kernel's OOM killer sends a
 *   plain SIGKILL, so the counter is the only evidence of who sent it. Still
 *   no verdict (retried like `killed`), but the user is told: nothing
 *   deployed, and only free memory changes the next attempt. A counter either
 *   reading could not state (macOS, an unreadable `/proc/vmstat`) never
 *   upgrades a kill — the build stays `killed` rather than guess.
 * - `failed` (1): anything else — a check that found something, a compile
 *   error, a backend that did not come up. One such failure makes the whole
 *   build a verdict, killed steps beside it or not.
 */
export type BuildFailureEnd =
  | { kind: "superseded"; exitCode: number }
  | { kind: "killed"; signal: string; exitCode: number }
  | { kind: "out-of-memory"; oomKills: number; exitCode: number }
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
  /**
   * The host's OOM-kill counter read when the build started and when it is
   * ending (`readOomKillCount`): what tells a kernel OOM kill from any other
   * SIGKILL.
   */
  oomKills: { atStart: OomKillCount; atEnd: OomKillCount };
}): BuildFailureEnd {
  if (i.supersededBy !== null)
    return { kind: "superseded", exitCode: BUILD_EXIT_SUPERSEDED };
  const first = i.failures[0]?.killedBy ?? null;
  if (first !== null && i.failures.every((f) => f.killedBy !== null)) {
    const newOomKills = oomKillsBetween(i.oomKills.atStart, i.oomKills.atEnd);
    if (
      newOomKills !== null &&
      newOomKills > 0 &&
      i.failures.some((f) => f.killedBy === "SIGKILL")
    )
      return {
        kind: "out-of-memory",
        oomKills: newOomKills,
        exitCode: BUILD_EXIT_OUT_OF_MEMORY,
      };
    return { kind: "killed", signal: first, exitCode: signalExitCode(first) };
  }
  return { kind: "failed", exitCode: 1 };
}

/**
 * The code the convergence run closes a build's row with when the build
 * PROCESS ended without recording its own: a SIGKILL that either out-of-memory
 * killer accounts for is `out-of-memory`. Without this, an OOM kill that took
 * the build itself (not a step — it is the biggest kill-first process when a
 * user's apps fill the machine) was a `killed` row, told to a developer only:
 * measured on an 8 GB Ubuntu VM with 5.3 GB held by another app, three
 * attempts in a row (2026-11-19).
 *
 * Two killers, two pieces of evidence:
 *
 * - the kernel's OOM killer moves the host's OOM-kill counter (`oomKills`,
 *   read before and after the build);
 * - systemd-oomd (Ubuntu desktop) kills the build's whole cgroup and moves no
 *   counter; the build runs in a systemd scope of its own, and the user
 *   journal's record of oomd killing that scope is the evidence (`scope`,
 *   `packages/systemd-scope`'s `readScopeOomdKill`).
 *
 * An unknown on either side never upgrades a kill. Any other code is returned
 * unchanged.
 */
export function deadBuildExitCode(
  exitCode: number,
  evidence: {
    oomKills: { atStart: OomKillCount; atEnd: OomKillCount };
    scope: ScopeOomdKill;
  },
): number {
  if (exitCode !== signalExitCode("SIGKILL")) return exitCode;
  if (evidence.scope.kind === "oomd-killed") return BUILD_EXIT_OUT_OF_MEMORY;
  const newOomKills = oomKillsBetween(
    evidence.oomKills.atStart,
    evidence.oomKills.atEnd,
  );
  return newOomKills !== null && newOomKills > 0
    ? BUILD_EXIT_OUT_OF_MEMORY
    : exitCode;
}

/**
 * How many OOM kills the host counted between two readings, or null when
 * either reading is not a count — unknown, which must never read as 0. A
 * count that went DOWN means a reboot between the readings, not a kill the
 * build saw: also unknown.
 */
function oomKillsBetween(
  atStart: OomKillCount,
  atEnd: OomKillCount,
): number | null {
  if (atStart.kind !== "read" || atEnd.kind !== "read") return null;
  const delta = atEnd.count - atStart.count;
  return delta >= 0 ? delta : null;
}
