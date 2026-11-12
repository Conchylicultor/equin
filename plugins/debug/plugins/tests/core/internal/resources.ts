import { z } from "zod";
import {
  liveCollection,
  liveValue,
  type LiveRowsCollection,
} from "@plugins/network/plugins/live/core";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";
import {
  DIGEST_GENERATION_STATES,
  testCaseFailuresEntityRef,
  testFileResultsEntityRef,
  testFileStatusEntityRef,
} from "./entities";

/**
 * Every test file of the checkout with its status — the whole set, because the
 * page's summary counts and its plugin tree are over every file. Bounded by
 * the checkout's test files: ~2,600 on main (2026-11-11), budget with
 * headroom.
 */
export const testFileStatus = liveCollection("tests.file-status", {
  from: testFileStatusEntityRef,
  carry: {
    pick: [
      "path",
      "pluginId",
      "runner",
      "digest",
      "status",
      "lastOutcome",
      "lastRanAt",
      "lastOpId",
      "lastOrigin",
      "lastSlug",
      "cases",
      "failedCases",
      "durationMs",
      "currentPassed",
      "currentFailed",
      "history",
    ],
  },
  baseExposures: false,
  id: "path",
  all: {
    orderBy: [["path", "asc"]],
    unbounded: {
      reason:
        "the page's summary and plugin tree read every test file of the checkout (2,571 on main, 2026-11-11)",
      budget: 4000,
    },
  },
});
export type TestFileStatusRow =
  typeof testFileStatus extends LiveRowsCollection<infer R> ? R : never;

/** How many results the cap job keeps per file (`tests.results-cap`). */
export const RESULTS_KEPT_PER_FILE = 32;

/**
 * Every recorded result, newest first — read one file at a time
 * (`scoped({ where: { path } })`): the detail pane's Recent runs.
 */
export const testFileRuns = liveCollection("tests.file-runs", {
  from: testFileResultsEntityRef,
  pick: [
    "path",
    "outcome",
    "origin",
    "slug",
    "runner",
    "cases",
    "failedCases",
    "durationMs",
    "finishedAt",
  ],
  carry: { pick: ["id", "opId", "digest"] },
  id: "id",
  sortable: ["finishedAt", "durationMs"],
  default: { orderBy: [["finishedAt", "desc"]], limit: RESULTS_KEPT_PER_FILE },
  maxLimit: RESULTS_KEPT_PER_FILE * 4,
});
export type TestFileRunRow =
  typeof testFileRuns extends LiveRowsCollection<infer R> ? R : never;

/** The failing cases one run recorded for one file. */
export const testCaseFailures = liveCollection("tests.case-failures", {
  from: testCaseFailuresEntityRef,
  carry: { pick: ["id", "opId", "path", "caseId", "message", "detail"] },
  baseExposures: false,
  id: "id",
  all: {
    by: ["opId", "path"],
    orderBy: [["caseId", "asc"]],
    unbounded: {
      reason: "one file's failing cases in one run (a few, at most its cases)",
      budget: 500,
    },
  },
});
export type TestCaseFailureRow =
  typeof testCaseFailures extends LiveRowsCollection<infer R> ? R : never;

/**
 * Which tree the checkout digests describe, and whether they are being
 * computed. Reading it is what keeps them current: while it has a subscriber,
 * the checkout's tree is compared with the stored one at subscribe and on
 * every ref advance, and a moved tree recomputes them. `none` before the
 * first computation landed.
 */
export const DigestGenerationSchema = z.object({
  state: z.enum(["none", ...DIGEST_GENERATION_STATES]),
  generation: z.string().nullable(),
  headSha: z.string().nullable(),
  computedAt: z.string().nullable(),
  computingSince: z.string().nullable(),
  fileCount: z.number().int(),
  elapsedMs: z.number().int().nullable(),
  error: z.string().nullable(),
});
export type DigestGeneration = z.infer<typeof DigestGenerationSchema>;

export const testDigestGeneration = liveValue("tests.digest-generation", {
  schema: DigestGenerationSchema,
});

/** A Run now / Run stale / Run all request: the files to run. */
export const RUN_NOW_MAX_PATHS = 4000;
export const runTestsNow = defineEndpoint({
  route: "POST /api/debug/tests/run-now",
  body: z.object({
    paths: cappedList(z.string().min(1), { max: RUN_NOW_MAX_PATHS }),
  }),
  response: z.object({ files: z.number().int() }),
  needsMachine: { feature: "Running tests" },
});
