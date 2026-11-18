import { z } from "zod";
import { CLI_NAME } from "@plugins/framework/plugins/cli/plugins/cli-name/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { defineSupervisedJob } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";

const pruneLog = defineLogSink({
  id: "check-grep-index-prune",
  description:
    "Grep-index prune log: one line per daily run — rows read and deleted, transactions taken and the longest one.",
});

/**
 * Keeps the shared grep index bounded without any check run paying for it.
 * The prune used to run inside each process's first store open of the UTC
 * day — whole-table DELETEs over a GB-sized file under the write lock — so
 * the check runs opening it just after midnight raced for it and waited
 * behind it (source-digest's facts store failed builds the same way,
 * 2026-11-18).
 *
 * Daily, main only (a schedule's default: the store is host-global). In a
 * supervised child, so the synchronous SQLite work never blocks a backend's
 * event loop. `runAttempts: 1`: tomorrow's run is the retry.
 */
export const grepIndexPruneJob = defineSupervisedJob({
  name: "checks.grep-index-prune",
  description:
    "Deletes the grep-check answers no check run has read for two weeks, keeping the shared grep index bounded.",
  input: z.object({}),
  channel: pruneLog,
  schedule: { cron: "13 5 * * *" },
  runAttempts: 1,
  argv: () => ({
    argv: [`./${CLI_NAME}`, "check-grep-index-prune"],
    cwd: REPO_ROOT,
  }),
});
