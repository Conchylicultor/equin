import { z } from "zod";
import { CLI_NAME } from "@plugins/framework/plugins/cli/plugins/cli-name/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { defineSupervisedJob } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";

const pruneLog = defineLogSink({
  id: "source-digest-prune",
  description:
    "Source-facts store prune log: one line per daily run — rows read and deleted, transactions taken and the longest one.",
});

/**
 * Keeps the shared source-facts store bounded without any reader paying for
 * it. The prune used to run inside each process's first store open of the UTC
 * day — one DELETE scanning the whole multi-GB table under the write lock — so
 * the processes opening it just after midnight raced for it and the losers
 * threw "database is locked" past their busy timeout (2026-11-18: two checks
 * of an unrelated build).
 *
 * Daily, main only (a schedule's default: the store is host-global). In a
 * supervised child, so the synchronous SQLite work never blocks a backend's
 * event loop. `runAttempts: 1`: tomorrow's run is the retry.
 */
export const pruneSourceFactsJob = defineSupervisedJob({
  name: "source-digest.prune",
  description:
    "Deletes the source-file facts no process has read for two weeks, keeping the shared facts store bounded.",
  input: z.object({}),
  channel: pruneLog,
  schedule: { cron: "29 5 * * *" },
  runAttempts: 1,
  argv: () => ({
    argv: [`./${CLI_NAME}`, "source-facts-prune"],
    cwd: REPO_ROOT,
  }),
});
