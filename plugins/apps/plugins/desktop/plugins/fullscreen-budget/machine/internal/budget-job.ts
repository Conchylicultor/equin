import { z } from "zod";
import { CLI_NAME } from "@plugins/framework/plugins/cli/plugins/cli-name/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { defineSupervisedJob } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";

/** The budget script, repo-relative: run in main's checkout, against main's deploy. */
export const BUDGET_SCRIPT =
  "plugins/apps/plugins/desktop/plugins/fullscreen-budget/e2e/fullscreen-switch-budget.ts";

const budgetLog = defineLogSink({
  id: "desktop-fullscreen-budget",
  description:
    "Desktop full-screen budget log: one transcript per run of the switch's work budget on main's deploy, and the interaction-budget report it filed.",
});

/**
 * One measurement of main's deploy at `commit`: the budget script in main's
 * checkout (its target is main's deploy, read from the registry main's build
 * wrote), `--file-reports` so an over-budget verdict is filed as an
 * `interaction-budget` report — the exit code then says whether the run
 * worked, not whether the switch was within budget.
 *
 * `lock` = the commit: one run per deployed commit, and `latestSupervisedRun`
 * by commit is how the trigger knows a commit was already measured.
 * `runAttempts: 1`: the next deploy is the retry.
 */
export const fullscreenBudgetJob = defineSupervisedJob({
  name: "desktop.fullscreen-budget",
  description:
    "Measures how much work the desktop's full-screen switch does on the newly deployed app, and files a report when it is over budget.",
  input: z.object({ commit: z.string().regex(/^[0-9a-f]{40}$/) }),
  channel: budgetLog,
  lock: (input) => input.commit,
  runAttempts: 1,
  argv: (input) => ({
    argv: [
      `./${CLI_NAME}`,
      "run",
      BUDGET_SCRIPT,
      "--file-reports",
      "--commit",
      input.commit,
    ],
    cwd: REPO_ROOT,
  }),
});
