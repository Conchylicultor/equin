import { z } from "zod";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";

/**
 * The report kind string, spelled once: the server registers its `ReportKind`
 * under it, the web dispatches its `Reports.KindView` on it, and main's idle
 * test runner files under it.
 */
export const TEST_FAILING_KIND = "test-failing";

/** At most this many failing cases ride on one occurrence. */
export const TEST_FAILING_MAX_CASES = 10;

const RunRefSchema = z.object({
  /** The `./equin test` run (its op id). */
  opId: z.string(),
  /** The commit the run tested; null when its record named none. */
  commit: z.string().nullable(),
  /** When the run finished (ISO). */
  at: z.string(),
});
export type TestRunRef = z.infer<typeof RunRefSchema>;

/**
 * One test file that went from passing to failing on main, as main's idle
 * test runner confirmed it. The row keeps the latest occurrence's payload, so
 * the cases are the ones failing NOW.
 */
export const TestFailingPayloadSchema = z.object({
  /** The test file, repo-relative. */
  path: z.string(),
  /** The plugin the file belongs to (null when the digest named none). */
  pluginId: z.string().nullable(),
  /** The newest run of main's checkout in which the file passed. */
  lastPassed: RunRefSchema,
  /** The first run of main's checkout after that pass in which it failed. */
  firstFailed: RunRefSchema,
  /** The run this occurrence is about (the newest failure on the current code). */
  latest: RunRefSchema.extend({
    outcome: z.enum(["failed", "not-loaded"]),
  }),
  /** Failures recorded on the file's current code (all failures: no pass). */
  failuresOnCurrentCode: z.number().int(),
  /** The latest run's failing cases (case id and the runner's first message line). */
  failingCases: cappedList(
    z.object({ caseId: z.string(), message: z.string() }),
    { max: TEST_FAILING_MAX_CASES },
  ),
  /** How many cases failed in the latest run (may exceed `failingCases`). */
  failedCaseCount: z.number().int(),
});
export type TestFailingPayload = z.infer<typeof TestFailingPayloadSchema>;

/** One row per test file: every confirmed failing run of it bumps that row. */
export function testFailingFingerprint(
  d: Pick<TestFailingPayload, "path">,
): string {
  return `${TEST_FAILING_KIND}:${d.path}`;
}

/** A commit as a short sha, or a placeholder when the run named none. */
export function shortCommit(commit: string | null): string {
  return commit === null ? "(unknown commit)" : commit.slice(0, 10);
}

/**
 * The one-line summary — the report row's `message`, and the KindView's text:
 * `test plugins/x/y.test.ts fails on main (2 cases) — passed at abc, failing since def`.
 */
export function testFailingMessage(d: TestFailingPayload): string {
  const what =
    d.latest.outcome === "not-loaded"
      ? "does not load"
      : `fails (${d.failedCaseCount} case${d.failedCaseCount === 1 ? "" : "s"})`;
  return (
    `test ${d.path} ${what} on main — passed at ${shortCommit(d.lastPassed.commit)}, ` +
    `failing since ${shortCommit(d.firstFailed.commit)}`
  );
}
