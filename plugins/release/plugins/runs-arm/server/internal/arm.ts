import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { eq, sql } from "drizzle-orm";
import { expr } from "@plugins/infra/plugins/query-resource/core";
import { parsed } from "@plugins/database/plugins/sql-projection/server";
import { runsServed } from "@plugins/runs/server";
import { RunOutcomeSchema } from "@plugins/runs/plugins/run-outcome/core";
import { _releaseRuns } from "@plugins/release/server";
import { releaseRunArm } from "../../core";
import { releaseOutcomeExpr } from "./outcome-sql";

/**
 * Releases, as an arm of the merged run space.
 *
 * - `label` — composition **and** target: a release is of a composition *for*
 *   a target, and the composition alone would put two rows of the same name
 *   next to each other in a list whose job is telling runs apart.
 * - `trigger` is **null**: `release_runs` records nothing that set it off. Its
 *   `kind` (`staged` / `candidate`) is *why the run was cut*, not what
 *   started it — it is `release.kind`, where it is exactly itself.
 * - `message` is `error`, the run's own words about the failure, verbatim.
 */
export const releaseRunKind = runsServed.arm(releaseRunArm, {
  from: _releaseRuns,
  id: _releaseRuns.id,
  base: (j) => ({
    label: expr(
      sql`concat_ws(' · ', ${j.base.composition}, ${j.base.target})`,
      {
        decoder: String,
        sqlType: "text",
        notNull: true,
      },
    ),
    outcome: expr(releaseOutcomeExpr(j.base.status), {
      decoder: parsed(RunOutcomeSchema, "runs.release.outcome"),
      sqlType: "text",
      notNull: true,
    }),
    trigger: null,
    startedAt: j.base.startedAt,
    finishedAt: j.base.finishedAt,
    namespace: j.base.namespace,
    message: j.base.error,
  }),
  extra: (j) => ({
    kind: j.base.kind,
    composition: j.base.composition,
    target: j.base.target,
    platform: j.base.platform,
    commitSha: j.base.commitSha,
    commitDirty: j.base.commitDirty,
    artifactPath: j.base.artifactPath,
  }),
  // THIS WORKTREE'S releases only — a worktree DB inherits main's rows, and
  // `release_runs` carries its producing namespace for exactly that reason.
  where: (j) => eq(j.base.namespace, runtimeNamespace()),
});
