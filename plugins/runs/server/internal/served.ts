import { sql } from "drizzle-orm";
import {
  expr,
  type ColumnRef,
  type ExprField,
} from "@plugins/infra/plugins/query-resource/core";
import { serveUnionCollection } from "@plugins/network/plugins/live/server";
import { runs } from "../../core";

/**
 * Wall-clock milliseconds, derived rather than stored: `finishedAt −
 * startedAt`, NULL while the run is in flight (the browser ticks a running
 * run's elapsed time itself — `<RunDuration>`). Cast to `double precision`
 * because `extract(epoch …)` yields `numeric`, which `pg` decodes as a string.
 */
function durationOf(reads: {
  startedAt: ColumnRef;
  finishedAt: ColumnRef;
}): ExprField<number | null> {
  return expr(
    sql`(extract(epoch from (${reads.finishedAt} - ${reads.startedAt})) * 1000)::double precision`,
    { decoder: Number, sqlType: "double precision" },
  );
}

/**
 * The merged run space, served: every run kind is one arm of the `runs`
 * union window, bound by its own plugin through `runsServed.arm(arm, { from,
 * id, base, extra, where? })` — `runs` never names one, and adding a kind is
 * one folder. Two base fields are the union's own, so no arm supplies them and
 * no two arms can disagree about what they are:
 *
 * - `id` — the row's id within its own ledger: the arm's primary key;
 * - `duration` — derived from `startedAt` / `finishedAt` (which every arm
 *   therefore binds to columns).
 */
export const runsServed = serveUnionCollection(runs, {
  derive: {
    id: { reads: [], bind: (_reads, { id }) => id },
    duration: { reads: ["startedAt", "finishedAt"], bind: durationOf },
  },
});
