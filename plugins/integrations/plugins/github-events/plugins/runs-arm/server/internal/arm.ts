import { sql } from "drizzle-orm";
import { expr } from "@plugins/network/plugins/live/plugins/query-resource/core";
import {
  nullable,
  parsed,
} from "@plugins/database/plugins/sql-projection/server";
import { runsServed } from "@plugins/runs/server";
import { RunOutcomeSchema } from "@plugins/runs/plugins/run-outcome/core";
import { _githubRuns } from "@plugins/integrations/plugins/github-events/server";
import { githubRunArm } from "../../core";
import { githubOutcomeExpr } from "./outcome-sql";

/**
 * Watched GitHub workflow runs, as an arm of the merged run space.
 *
 * - `label` — the workflow and what it ran on: "Installer release · main",
 *   "installer-release · v2026.11.18.4". GitHub's `name` of a run is its
 *   `run-name` when the workflow sets one — installer-release.yml's is the ref
 *   itself — so where the name only repeats the head, the workflow's file
 *   (without `.yml`) names it instead.
 * - `trigger` — GitHub's `event` (`push`, `workflow_dispatch`, `schedule`).
 * - `namespace` — null: a GitHub run belongs to no worktree. `github_runs` is
 *   written only by main's backend; a worktree reads the rows its database
 *   was forked with.
 * - `message` — the failed jobs' names, the run's own account of what broke
 *   (null while none failed).
 */
export const githubRunKind = runsServed.arm(githubRunArm, {
  from: _githubRuns,
  id: _githubRuns.id,
  base: (j) => ({
    label: expr(
      sql`concat_ws(' · ', case when ${j.base.workflowName} = ${j.base.head} then regexp_replace(${j.base.workflowPath}, '^.*/|\\.ya?ml$', '', 'g') else ${j.base.workflowName} end, ${j.base.head})`,
      { decoder: String, sqlType: "text", notNull: true },
    ),
    outcome: expr(githubOutcomeExpr(j.base.status, j.base.conclusion), {
      decoder: parsed(RunOutcomeSchema, "runs.github.outcome"),
      sqlType: "text",
      notNull: true,
    }),
    trigger: j.base.event,
    startedAt: j.base.startedAt,
    finishedAt: j.base.finishedAt,
    namespace: null,
    message: expr(
      sql`(select nullif(string_agg(f ->> 'name', ', '), '') from jsonb_array_elements(${j.base.failedJobs}) as f)`,
      { decoder: nullable(String), sqlType: "text" },
    ),
  }),
  // Every listed field is picked from the entity and binds by name; `url` is
  // carried.
  extra: (j) => ({ url: j.base.url }),
});
