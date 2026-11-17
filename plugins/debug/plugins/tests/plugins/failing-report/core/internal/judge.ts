import type { TestOutcome } from "@plugins/debug/plugins/tests/core";

/** One recorded result of a file, as the judge reads it. */
export interface JudgedResult {
  opId: string;
  digest: string;
  outcome: TestOutcome;
  finishedAt: Date;
  /** The run was this checkout's (main's) own — not another worktree's. */
  ownCheckout: boolean;
  /** The commit the run tested; null when its record named none. */
  commit: string | null;
}

/** A run a verdict points at. */
export interface JudgedRun {
  opId: string;
  commit: string | null;
  at: Date;
}

/** Failures on the current code needed before a report is filed. */
export const CONFIRMING_FAILURES = 2;

/**
 * What the file's existing `test-failing` report already established: its
 * last pass on main and its first failure after it. Stands in for a pass the
 * results cap has since dropped, so a file broken for many runs keeps being
 * reported (and can be marked Regressed after a fix).
 */
export interface KnownBreak {
  lastPassed: JudgedRun;
  firstFailed: JudgedRun;
}

export type FailingVerdict =
  /** Nothing to file: the reason, for logs and tests. */
  | {
      kind: "quiet";
      reason:
        | "no-verdict-on-current-code"
        | "passes-on-current-code"
        | "not-seen-failing-here"
        | "never-passed-here";
    }
  /** One failure of main's after a pass: run the file once more before saying anything. */
  | { kind: "confirm" }
  /** Went from passing to failing, confirmed: file (or bump) its report. */
  | {
      kind: "report";
      lastPassed: JudgedRun;
      firstFailed: JudgedRun;
      latest: JudgedRun & { outcome: Exclude<TestOutcome, "passed"> };
      failuresOnCurrentCode: number;
    };

const runOf = (r: JudgedResult): JudgedRun => ({
  opId: r.opId,
  commit: r.commit,
  at: r.finishedAt,
});

/**
 * Whether a test file of main went from passing to failing — the one rule the
 * `test-failing` report is filed by (pure; the machine half applies it after
 * each idle batch). `results` are the file's recorded results, NEWEST FIRST.
 *
 * - Only the file's CURRENT code counts as "failing now": every result on the
 *   current digest failed. A pass on it (any checkout's: same digest, same
 *   code) means the file is flaky (the Tests page says so), never a report.
 * - Only what MAIN's checkout saw counts: the failures are this checkout's own
 *   runs, and the file passed in this checkout before — a file that never
 *   passed on main is not a regression, and a worktree's run says nothing
 *   about main. `known` (the file's existing report) stands in for a pass the
 *   results cap has dropped.
 * - Flakiness: one failure is not enough. A single failure of main's on the
 *   current code answers `confirm` — the idle runner runs the file once more —
 *   and only {@link CONFIRMING_FAILURES} of main's failures with no pass
 *   report. A flaky file passes the confirmation run and files nothing.
 *
 * `firstFailed` is the oldest of this checkout's failures after its last pass
 * — the first commit where the file was seen failing.
 */
export function judgeFailingFile(
  currentDigest: string,
  results: readonly JudgedResult[],
  known: KnownBreak | null = null,
): FailingVerdict {
  const current = results.filter((r) => r.digest === currentDigest);
  if (current.length === 0)
    return { kind: "quiet", reason: "no-verdict-on-current-code" };
  if (current.some((r) => r.outcome === "passed"))
    return { kind: "quiet", reason: "passes-on-current-code" };
  const own = current.filter((r) => r.ownCheckout);
  const latest = own[0];
  if (latest === undefined || latest.outcome === "passed")
    return { kind: "quiet", reason: "not-seen-failing-here" };
  const lastPass = results.find((r) => r.ownCheckout && r.outcome === "passed");
  if (lastPass === undefined && known === null)
    return { kind: "quiet", reason: "never-passed-here" };
  if (own.length < CONFIRMING_FAILURES) return { kind: "confirm" };
  let lastPassed: JudgedRun;
  let firstFailed: JudgedRun;
  if (lastPass !== undefined) {
    const since = lastPass.finishedAt.getTime();
    const ownFailuresSincePass = results.filter(
      (r) =>
        r.ownCheckout &&
        r.outcome !== "passed" &&
        r.finishedAt.getTime() > since,
    );
    lastPassed = runOf(lastPass);
    firstFailed = runOf(ownFailuresSincePass.at(-1) ?? latest);
  } else if (known !== null) {
    ({ lastPassed, firstFailed } = known);
  } else {
    return { kind: "quiet", reason: "never-passed-here" };
  }
  return {
    kind: "report",
    lastPassed,
    firstFailed,
    latest: { ...runOf(latest), outcome: latest.outcome },
    failuresOnCurrentCode: current.length,
  };
}
