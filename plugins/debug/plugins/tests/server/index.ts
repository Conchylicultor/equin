import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { TaskCategory } from "@plugins/tasks/plugins/task-category/server";
import { TESTS_CATEGORY_ID } from "../core";
import { resultsCapJob } from "./internal/cap-job";
import { testDigestsSettled } from "./internal/tables-events";
import {
  testCaseFailuresServed,
  testFileRunsServed,
  testFileStatusServed,
} from "./internal/resources";

export {
  _testCaseFailures,
  _testCheckoutDigests,
  _testDigestGeneration,
  _testFileResults,
  _testFileStatus,
  _testRuns,
} from "./internal/tables";
export { recomputeFileStatus } from "./internal/recompute";
export {
  _testDigestsSettledTriggers,
  testDigestsSettled,
} from "./internal/tables-events";
export { ingestedOpIds, ingestRunRecord } from "./internal/ingest-record";
export type { DbExec } from "./internal/db-exec";

export default {
  description:
    "Debug → Tests, portable half: the harvested test verdicts (test_runs, test_file_results, test_case_failures), the checkout's test digests and their generation, the derived test_file_status (recomputeFileStatus, its only writer), the collections the page reads, the daily tests.results-cap job, the tests.digestsSettled event (a digest computation ended), and the Tests task category Investigate files under.",
  register: [resultsCapJob, testDigestsSettled],
  contributions: [
    ...testFileStatusServed.declare,
    ...testFileRunsServed.declare,
    ...testCaseFailuresServed.declare,
    TaskCategory({ id: TESTS_CATEGORY_ID, label: "Tests", order: 20 }),
  ],
} satisfies ServerPluginDefinition;
