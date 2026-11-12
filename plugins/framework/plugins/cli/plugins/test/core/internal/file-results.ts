import type { JunitSummary } from "./junit";
import {
  TEST_FAILURE_DETAIL_MAX,
  type TestCaseFailure,
  type TestFileResult,
} from "@plugins/framework/plugins/cli/plugins/test/plugins/record/core";
import type { TestRunnerName } from "./test-status";

/** One runner's run, as `fileResults` attributes it to files. */
export interface RunnerHarvestInput {
  runner: TestRunnerName;
  /** The files this runner was given (repo-relative). */
  files: readonly string[];
  exitCode: number;
  /** The runner was declared wedged and killed. */
  wedged: boolean;
  /** Its parsed JUnit report, or null when it wrote none. */
  report: JunitSummary | null;
  /** Each given file's digest (`test/plugins/digest`). */
  digests: ReadonlyMap<string, string>;
}

export interface RunnerHarvest {
  files: TestFileResult[];
  failures: TestCaseFailure[];
  /** True when no per-file row could be derived (wedged, or no report). */
  unattributed: boolean;
}

/**
 * Thrown when a report names a file the runner was not given: its path
 * attributes are not what the harvest assumes (repo-relative, from the
 * checkout root), and attributing anything would guess.
 */
export class JunitPathMismatchError extends Error {
  constructor(runner: TestRunnerName, paths: readonly string[]) {
    super(
      `[test harvest] the ${runner} JUnit report names ${paths.length} file(s) the run never gave it, e.g. ${paths.slice(0, 3).join(", ")} — its path attributes are not repo-relative`,
    );
    this.name = "JunitPathMismatchError";
  }
}

/**
 * Attribute one runner's JUnit report to its files — only what the report
 * establishes:
 *
 * - a file in the report → `passed` / `failed`, with its case counts and time;
 * - a file missing from the report of a runner that exited non-zero →
 *   `not-loaded` (it threw while loading — the run failed and no case explains
 *   it); missing from a GREEN runner's report it registered no cases, which
 *   says nothing about it: no row;
 * - a runner that wedged or wrote no report → no rows at all: a runner-level
 *   failure stays on the run, never on files it may never have reached.
 */
export function fileResults(input: RunnerHarvestInput): RunnerHarvest {
  const { runner, report, exitCode } = input;
  if (input.wedged || report === null)
    return { files: [], failures: [], unattributed: true };
  const given = new Set(input.files);
  const foreign = report.files.filter((f) => !given.has(f));
  if (foreign.length > 0) throw new JunitPathMismatchError(runner, foreign);
  const digestOf = (path: string): string => {
    const d = input.digests.get(path);
    if (d === undefined)
      throw new Error(`[test harvest] no digest for ${path}`);
    return d;
  };
  const files: TestFileResult[] = [];
  for (const path of [...input.files].sort()) {
    const stats = report.byFile[path];
    if (stats === undefined) {
      if (exitCode === 0) continue;
      files.push({
        path,
        runner,
        digest: digestOf(path),
        outcome: "not-loaded",
        cases: 0,
        failedCases: 0,
        durationMs: 0,
      });
      continue;
    }
    files.push({
      path,
      runner,
      digest: digestOf(path),
      outcome: stats.failed > 0 ? "failed" : "passed",
      cases: stats.cases,
      failedCases: stats.failed,
      durationMs: stats.timeMs,
    });
  }
  const failures: TestCaseFailure[] = report.failureDetails.map((f) => ({
    path: f.file,
    caseId: f.caseId,
    message: f.message.slice(0, TEST_FAILURE_DETAIL_MAX),
    detail: f.detail.slice(0, TEST_FAILURE_DETAIL_MAX),
  }));
  return { files, failures, unattributed: false };
}
