/**
 * A test file's status on the checkout the page describes, from the results
 * recorded for it (a pure function — the one place the rule lives; the
 * recompute in `server/` applies it, the page only reads its answer).
 *
 * Among the results on the file's CURRENT digest (its import closure and
 * runner inputs as the checkout has them now):
 *
 * - both a pass and a failure → `flaky`
 * - only failures (a failed case, or a file that never loaded) → `failing`
 * - only passes → `passing`
 * - none on the current digest, older ones exist → `stale` (the last known
 *   verdict rides along as `lastOutcome`)
 * - no result at all → `never`
 */
export const TEST_STATUSES = [
  "failing",
  "flaky",
  "stale",
  "passing",
  "never",
] as const;
export type TestStatus = (typeof TEST_STATUSES)[number];

/** Worst first: the order a plugin row takes its status from its subtree. */
export const TEST_STATUS_SEVERITY: Record<TestStatus, number> = {
  failing: 0,
  flaky: 1,
  stale: 2,
  passing: 3,
  never: 4,
};

export function worstStatus(a: TestStatus, b: TestStatus): TestStatus {
  return TEST_STATUS_SEVERITY[a] <= TEST_STATUS_SEVERITY[b] ? a : b;
}

/** One recorded result, as the status rule reads it. */
export interface StatusInput {
  digest: string;
  outcome: "passed" | "failed" | "not-loaded";
}

export function deriveStatus(
  currentDigest: string,
  results: readonly StatusInput[],
): TestStatus {
  if (results.length === 0) return "never";
  let passed = 0;
  let failed = 0;
  for (const r of results) {
    if (r.digest !== currentDigest) continue;
    if (r.outcome === "passed") passed++;
    else failed++;
  }
  if (passed > 0 && failed > 0) return "flaky";
  if (failed > 0) return "failing";
  if (passed > 0) return "passing";
  return "stale";
}
