import { z } from "zod";
import { CLI_NAME } from "@plugins/framework/plugins/cli/plugins/cli-name/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { defineSupervisedJob } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";

const pruneLog = defineLogSink({
  id: "check-cache-prune",
  description:
    "Check-cache prune log: one line per hourly run — entries and flight files seen, entries removed.",
});

/**
 * Keeps the host-global check cache bounded without any check run paying for
 * it. The sweep lists and stats every entry (~18k) and every flight file
 * (~56k) — O(the whole cache) — so it used to open every check run (a 127 s
 * readdir during a file-metadata stall).
 *
 * Hourly, main only (a schedule's default: the cache is host-global). In a
 * supervised child, so the synchronous sweep never blocks a backend's event
 * loop and no job slot is held. `runAttempts: 1`: the next tick is the retry.
 *
 * The child is the `check-cache-prune` command (`../../cli`), not a `run`
 * body: a `run` body is imported by the backend that schedules it, and this
 * one would carry the check runner's barrel — the whole check registry — into
 * the serving backend's closure (`boot:closure-digestable`).
 */
export const checkCachePruneJob = defineSupervisedJob({
  name: "checks.cache-prune",
  description:
    "Deletes old check results and leftover check coordination files, keeping the shared check cache bounded.",
  input: z.object({}),
  channel: pruneLog,
  schedule: { cron: "47 * * * *" },
  runAttempts: 1,
  argv: () => ({
    argv: [`./${CLI_NAME}`, "check-cache-prune"],
    cwd: REPO_ROOT,
  }),
});
