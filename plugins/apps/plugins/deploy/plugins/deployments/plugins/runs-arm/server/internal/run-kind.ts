import { sql, type SQL } from "drizzle-orm";
import {
  expr,
  type LookupJoin,
} from "@plugins/infra/plugins/query-resource/core";
import { parsed } from "@plugins/database/plugins/sql-projection/server";
import { _deployServers } from "@plugins/apps/plugins/deploy/plugins/servers/server";
import { _deployRuns } from "@plugins/apps/plugins/deploy/plugins/deployments/server";
import { defineRunKind } from "@plugins/runs/server";
import { RunOutcomeSchema } from "@plugins/runs/plugins/run-outcome/core";
import { DEPLOY_STATUS_OUTCOME, deployRunArm } from "../../core";

/**
 * `deploy_runs.status` → the shared outcome vocabulary, folded out of the typed
 * map in `core/`: a fourth status added to `deploy_runs` without a mapping is
 * a `tsc` error there, and one that escaped it projects NULL, which the arm's
 * `RunOutcomeSchema` decoder refuses loudly.
 */
function outcomeExpr(status: unknown): SQL {
  const branches = Object.entries(DEPLOY_STATUS_OUTCOME).map(
    ([from, to]) => sql`when ${from}::text then ${to}::text`,
  );
  return sql`(case ${status} ${sql.join(branches, sql` `)} end)`;
}

/**
 * The server a run went to, LEFT-joined by id: the label names it. A lookup,
 * not a correlated subquery — so a server RENAME routes (a `reverse` route on
 * `deploy_servers`, resolved to the runs naming it) and relabels exactly those
 * rows. LEFT, because `server_id` is copied onto the run rather than a foreign
 * key: the server row can be gone while the run record remains.
 */
const serverJoin: LookupJoin<"server", typeof _deployServers> = {
  kind: "lookup",
  alias: "server",
  table: _deployServers,
  pk: _deployServers.id,
  on: { from: "base", col: _deployRuns.serverId },
  required: false,
};

/**
 * The deploy arm of the merged run space.
 *
 * - `label` — `<composition> on <server name>`, falling back to the server id
 *   when the server is gone (`label` is non-nullable).
 * - `namespace` is null: a deploy targets a **remote server**, not a worktree.
 * - `trigger` is the verb: a deploy records no separate initiator, and the verb
 *   is the closest thing to "how did this start".
 * - `message` is the CLI's own words, verbatim.
 */
export const deployRunKind = defineRunKind({
  columns: deployRunArm,
  from: _deployRuns,
  id: _deployRuns.id,
  joins: [serverJoin],
  base: (j) => ({
    label: expr(
      sql`${j.base.compositionId} || ' on ' || coalesce(${j.server.name}, ${j.base.serverId})`,
      { decoder: String, sqlType: "text", notNull: true },
    ),
    outcome: expr(outcomeExpr(j.base.status), {
      decoder: parsed(RunOutcomeSchema, "runs.deploy.outcome"),
      sqlType: "text",
      notNull: true,
    }),
    trigger: j.base.verb,
    startedAt: j.base.startedAt,
    finishedAt: j.base.finishedAt,
    namespace: null,
    message: j.base.message,
  }),
  extra: (j) => ({
    verb: j.base.verb,
    phaseFailed: j.base.phaseFailed,
    serverId: j.base.serverId,
    deploymentId: j.base.deploymentId,
    compositionId: j.base.compositionId,
    commitSha: j.base.commitSha,
    releaseRunId: j.base.releaseRunId,
    exitCode: j.base.exitCode,
  }),
});
