import { z } from "zod";
import { CLI_NAME } from "@plugins/framework/plugins/cli/plugins/cli-name/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { defineSupervisedJob } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";

const verifyLog = defineLogSink({
  id: "plugin-records-verify",
  description:
    "Plugin-records verifier log: one transcript per daily run of `check --verify-records` on main.",
});

/**
 * The net under the shared plugin-record store. Every build and check pass
 * reads records another checkout made, trusting that a key is the hash of
 * every input its value is a function of. Once a day, on main (a schedule's
 * default), this computes every record a tree check pass makes again and
 * compares each with the store's value under the same key
 * (`./equin check --verify-records`): a disagreement is a key that missed an
 * input, and fails the run — loudly, through the job's failure report — rather
 * than being papered over by a cache bypass.
 *
 * A supervised child, so the pass's synchronous work never blocks a backend's
 * event loop. `runAttempts: 1`: tomorrow's run is the retry.
 */
export const verifyRecordsJob = defineSupervisedJob({
  name: "plugin-records.verify",
  description:
    "Recomputes every plugin record a check pass reads and fails when one disagrees with the shared store.",
  input: z.object({}),
  channel: verifyLog,
  schedule: { cron: "17 5 * * *" },
  runAttempts: 1,
  argv: () => ({
    argv: [`./${CLI_NAME}`, "check", "--scope", "tree", "--verify-records"],
    cwd: REPO_ROOT,
  }),
});
