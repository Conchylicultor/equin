import { z } from "zod";
import { CLI_NAME } from "@plugins/framework/plugins/cli/plugins/cli-name/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { envEntries } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { defineSupervisedJob } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { hash53 } from "@plugins/packages/plugins/string-hash/core";
import { TESTS_FAILED_EXIT } from "@plugins/framework/plugins/cli/plugins/test/plugins/record/core";
import { runTestsNow, RUN_NOW_MAX_PATHS } from "../../core";

const runNowLog = defineLogSink({
  id: "tests-run-now",
  description:
    "Test-status page: the `./equin test` runs its Run now / Run stale / Run all buttons started.",
});

/**
 * Run now: an ordinary `./equin test <paths…>` in this checkout, as a
 * supervised child, marked `run-now` (`EQUIN_TEST_ORIGIN`) so its harvest
 * record says who asked. Its verdicts reach the page like any run's — through
 * the record it writes and the ingest — so nothing here reads its outcome.
 * Locked per set of files: the same request twice is one run.
 */
export const runNowJob = defineSupervisedJob({
  name: "tests.run-now",
  description:
    "Runs the test files the Debug → Tests page asked for (Run now, Run stale, Run all) with `./equin test`, so their verdicts are harvested onto the page.",
  input: z.object({
    paths: z.array(z.string()).max(RUN_NOW_MAX_PATHS),
  }),
  channel: runNowLog,
  runAttempts: 1,
  // Failing tests are the page's data (the run's record), never a failed job.
  verdictExits: [TESTS_FAILED_EXIT],
  lock: (input) => String(hash53([...input.paths].sort().join("\n"))),
  argv: (input) => ({
    argv: [`./${CLI_NAME}`, "test", ...input.paths],
    cwd: REPO_ROOT,
    envOverrides: envEntries({ TEST_ORIGIN: "run-now" }),
  }),
});

export const handleRunNow = implementMachine(runTestsNow, async ({ body }) => {
  const paths = [...new Set(body.paths)];
  await runNowJob.enqueue({ paths });
  return { files: paths.length };
});
