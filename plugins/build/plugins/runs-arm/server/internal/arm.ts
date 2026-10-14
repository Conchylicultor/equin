import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { expr } from "@plugins/infra/plugins/query-resource/core";
import { parsed } from "@plugins/database/plugins/sql-projection/server";
import { defineRunKind } from "@plugins/runs/server";
import { RunOutcomeSchema } from "@plugins/runs/plugins/run-outcome/core";
import { _buildRuns } from "@plugins/build/plugins/run-ledger/server";
import { buildRunArm, BuildStatusSchema } from "../../core";
import { buildOutcomeExpr, buildStatusExpr } from "./status-sql";

/**
 * Builds, as an arm of the merged run space.
 *
 * `label` is the targets joined, because that is what a build *is of*:
 * `./singularity build --composition sonata website` is one invocation carrying
 * two target chips, and the ledger records it as one row. A plain build reads
 * `singularity`.
 *
 * - `message: null` — `build_runs` has no error column. A build's own words
 *   about why it failed live in its transcript (`build-logs`), a file on disk;
 *   the exit code carries what the row knows, as `build.exitCode`.
 * - `status` and `outcome` are two projections of ONE expression, so a row can
 *   never be `canceled` on one column and `failed` on the other.
 */
export const buildRunKind = defineRunKind({
  columns: buildRunArm,
  from: _buildRuns,
  id: _buildRuns.id,
  base: (j) => {
    const status = buildStatusExpr(j.base.finishedAt, j.base.exitCode);
    return {
      // `array_to_string`, not the array: `label` is a title, and a title is
      // text. The array survives as `build.targets`, a `tags` field.
      label: expr(sql`array_to_string(${j.base.targets}, ', ')`, {
        decoder: String,
        sqlType: "text",
        notNull: true,
      }),
      outcome: expr(buildOutcomeExpr(status), {
        decoder: parsed(RunOutcomeSchema, "runs.build.outcome"),
        sqlType: "text",
        notNull: true,
      }),
      trigger: j.base.trigger,
      startedAt: j.base.startedAt,
      finishedAt: j.base.finishedAt,
      namespace: j.base.namespace,
      message: null,
    };
  },
  extra: (j) => ({
    status: expr(buildStatusExpr(j.base.finishedAt, j.base.exitCode), {
      decoder: parsed(BuildStatusSchema, "runs.build.status"),
      sqlType: "text",
      notNull: true,
    }),
    // The ledger's `text[]` as a jsonb string array: the `tags` field filters
    // in the `stringArray` domain, whose containment ops are jsonb ops.
    targets: expr(sql`to_jsonb(${j.base.targets})`, {
      decoder: parsed(z.array(z.string()), "runs.build.targets"),
      sqlType: "jsonb",
      notNull: true,
    }),
    commitHash: j.base.commitHash,
    exitCode: j.base.exitCode,
  }),
  // THIS WORKTREE'S builds only. A worktree DB is FORKED from main, so it
  // inherits every row main had at fork time; unscoped, the merged list would
  // open on main's stale history. `runtimeNamespace()` is declared once at
  // this process's entry point and never changes, so evaluating it at module
  // eval is correct.
  where: (j) => eq(j.base.namespace, runtimeNamespace()),
});
