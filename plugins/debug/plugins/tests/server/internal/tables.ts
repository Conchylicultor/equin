import { index } from "drizzle-orm/pg-core";
import { defineEntity } from "@plugins/infra/plugins/entities/server";
import {
  testCaseFailuresEntityRef,
  testCheckoutDigestsEntityRef,
  testDigestGenerationEntityRef,
  testFileResultsEntityRef,
  testFileStatusEntityRef,
  testRunsEntityRef,
} from "../../core";

// The test-status page's tables. Harvested facts (runs, results, failures) are
// written once by the ingest; the checkout digests and their generation row by
// the checkout-digests job; `test_file_status` is DERIVED from both, written
// only by `recomputeFileStatus`.

const testRuns = defineEntity(testRunsEntityRef, { primaryKey: "opId" });
export const _testRuns = testRuns.table;

const testFileResults = defineEntity(testFileResultsEntityRef, {
  primaryKey: "id",
  indexes: (t) => [
    // The status recompute reads one file's results; the cap job and Recent
    // runs read them newest first.
    index("test_file_results_path_finished_idx").on(
      t.path,
      t.finishedAt.desc(),
    ),
    index("test_file_results_path_digest_idx").on(t.path, t.digest),
    index("test_file_results_op_idx").on(t.opId),
  ],
});
export const _testFileResults = testFileResults.table;

const testCaseFailures = defineEntity(testCaseFailuresEntityRef, {
  primaryKey: "id",
  indexes: (t) => [index("test_case_failures_op_path_idx").on(t.opId, t.path)],
});
export const _testCaseFailures = testCaseFailures.table;

const testCheckoutDigests = defineEntity(testCheckoutDigestsEntityRef, {
  primaryKey: "path",
});
export const _testCheckoutDigests = testCheckoutDigests.table;

const testDigestGeneration = defineEntity(testDigestGenerationEntityRef, {
  primaryKey: "id",
});
export const _testDigestGeneration = testDigestGeneration.table;

const testFileStatus = defineEntity(testFileStatusEntityRef, {
  primaryKey: "path",
});
export const _testFileStatus = testFileStatus.table;
