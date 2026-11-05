import { z } from "zod";
import { CLI_NAME } from "@plugins/framework/plugins/cli/plugins/cli-name/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { defineSupervisedJob } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";

const backstopLog = defineLogSink({
  id: "type-check-backstop",
  description:
    "Type-check backstop ops log: the daily dual run on main (the two-program check beside a full check) and its divergences.",
});

/**
 * The two-program type check's BACKSTOP. A check run re-checks only the files
 * whose key moved — and what their changed names reach — and trusts the store
 * for the rest (type-check's `shared/name-run.ts`), so nothing in it would
 * notice a key or an affected set that misses something a file's check reads.
 * Once a day, on main, this runs the worker in `dual` mode: the two-program
 * check, then a full check of a fresh whole program, compared file by file.
 * Every divergence is logged and filed as a `type-check-divergence` report, and
 * on any divergence a cold run rewrites the store, so the next run on any
 * worktree reads the right answer.
 *
 * In a supervised child, so a restart does not kill it part-way and no job
 * slot is held for its minutes. Admitted like any worker: a grant (inherited,
 * or a background one of its own), then `spawnTypeCheckWorker`'s host-wide
 * slot. Not part of any build.
 *
 * The child is the `type-check-backstop` command (`../../cli`), not a `run`
 * body: a `run` body is imported by the backend that schedules it, and this
 * one would carry the check runner's barrel (`repoProgram`) and the
 * type-check worker plumbing into the serving backend's closure
 * (`boot:closure-digestable`).
 *
 * `runAttempts: 1`: the next daily tick is the retry.
 */
export const typeCheckBackstopJob = defineSupervisedJob({
  name: "type-check.backstop",
  description:
    "Runs the two-program type check beside a full check on main and reports any file where they disagree.",
  input: z.object({}),
  channel: backstopLog,
  schedule: { cron: "30 4 * * *" }, // daily at 04:30 UTC; main only
  runAttempts: 1,
  argv: () => ({
    argv: [`./${CLI_NAME}`, "type-check-backstop"],
    cwd: REPO_ROOT,
  }),
});
