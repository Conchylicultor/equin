import { count, sql, type SQL } from "drizzle-orm";
import { db as realDb } from "@plugins/database/server";
import type {
  ReachPlan,
  ResourceParams,
  ServerResourceOptions,
} from "@plugins/network/plugins/live/plugins/resource-runtime/core";
import { planGroupArm, type GroupsQuerySpec } from "./compile-groups";
import { compiledReachPlan } from "./routes";
import type { QueryDb } from "./spec";

// The count compiler — a collection's `:count` sibling (network/live's
// `serveCollection`, declared `count: true`): one push value per filter,
//
//   SELECT count(*) FROM <table> WHERE <where>
//
// A grouping with no grouped column: planned by the grouping planner
// (`planGroupArm`) — the same `full` routes (any written row of a relation it
// reads may move the total), the same per-tuple joins (only the ones its
// `where` reads, and the required lookups) — and rendered here without the
// GROUP BY, so it is always exactly one row, `0` for no match.

/** One tuple's total, decoded from its params by the caller. */
export interface CountQuery {
  /** The collection's base membership ∧ the tuple's filter; `undefined` = none. */
  where: SQL | undefined;
}

export type CountQuerySpec<P extends ResourceParams> = Omit<
  GroupsQuerySpec<P>,
  "query"
> & {
  /** The per-tuple count query. */
  query: (params: P) => CountQuery;
};

/** The compiled `:count` server half — the two-arg `defineResource` opts. */
export type CompiledCount<P extends ResourceParams> = ServerResourceOptions<
  number,
  P
> & { mode: "push"; reach: ReachPlan<P> };

/**
 * Compile a count spec into push `defineResource` opts carrying its `reach`
 * plan. Misuse (a view `from`) throws here, at module eval.
 */
export function compileCountQuery<P extends ResourceParams>(
  key: string,
  spec: CountQuerySpec<P>,
): CompiledCount<P> {
  const db: QueryDb = spec.db ?? (realDb as unknown as QueryDb);
  const arm = planGroupArm<{ value: unknown; count: number }, P>(
    `countQuery("${key}")`,
    {
      ...spec,
      // No grouped column: a constant reads no relation, so the tuple's
      // joins are exactly its `where`'s (and the required lookups).
      query: (params) => ({
        column: sql`NULL`,
        where: spec.query(params).where,
        limit: 1,
        check: () => {},
      }),
    },
  );
  const loader = async (params: P): Promise<number> => {
    const t = arm.tuple(params);
    let step = arm.joins.apply(
      db.select<{ count: number }>({ count: count() }).from(arm.base.table),
      t.included,
    );
    if (t.q.where) step = step.where(t.q.where);
    const [row] = await step;
    if (row === undefined) {
      throw new Error(`countQuery("${key}"): count(*) returned no row`);
    }
    return row.count;
  };
  return {
    mode: "push",
    loader,
    reach: compiledReachPlan<P>(arm.routes, (params) => arm.tuple(params).uses),
  };
}
