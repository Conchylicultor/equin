import { z } from "zod";
import { CLI_NAME } from "@plugins/framework/plugins/cli/plugins/cli-name/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { defineSupervisedJob } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";

const reclaimLog = defineLogSink({
  id: "plugin-records-reclaim",
  description:
    "Plugin-record store reclaim log: one line per daily run — key rows read and deleted, values deleted, pages freed.",
});

/**
 * Keeps the shared plugin-record store bounded without any build paying for
 * it. The reclaim used to run inside the first store open of each day — one
 * write transaction deleting every stale key row and sweeping every value of
 * a multi-GB file — so whichever build, push or check opened first held the
 * store while every other one waited, past their busy timeout (2026-11-08).
 *
 * Daily, main only (a schedule's default: the store is host-global, and N
 * backends reclaiming would only queue on its write lock). In a supervised
 * child, so the synchronous SQLite work never blocks a backend's event loop.
 * `runAttempts: 1`: tomorrow's run is the retry.
 */
export const reclaimRecordsJob = defineSupervisedJob({
  name: "plugin-records.reclaim",
  description:
    "Deletes the plugin records no build has read for a week, and returns their space to the filesystem.",
  input: z.object({}),
  channel: reclaimLog,
  schedule: { cron: "43 4 * * *" },
  runAttempts: 1,
  argv: () => ({
    argv: [`./${CLI_NAME}`, "plugin-records-reclaim"],
    cwd: REPO_ROOT,
  }),
});
