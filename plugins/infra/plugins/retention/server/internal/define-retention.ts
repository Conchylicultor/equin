import { getTableName, is, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  PgTransaction,
  type PgColumn,
  type PgTable,
} from "drizzle-orm/pg-core";
import { z } from "zod";
import { db } from "@plugins/database/server";
import { changeProducerFor } from "@plugins/network/plugins/live/plugins/change-feed/server";
import { defineJob, type JobFactory } from "@plugins/infra/plugins/jobs/server";
import { declareGrowthBound } from "./growth-bounds";
import { retentionCutoff, retentionPredicate } from "./retention-sql";

// Daily at 04:00 UTC — off the interactive peak, mirroring debug.trace-cleanup's
// nightly-sweep cadence. Retention is a slow-moving bound; a missed tick is
// harmless (next tick sweeps the accumulated backlog).
const DEFAULT_CRON = "0 4 * * *";
const DEFAULT_COLUMN = "createdAt";
// A transiently-broken sweep must not become a dead-job storm; kept low like
// the trace-cleanup precedent.
const MAX_ATTEMPTS = 3;

// Cron payloads are built from `input.parse({})`, so the input schema must parse
// an empty object. Retention jobs carry no per-run input and ignore events.
const RETENTION_INPUT = z.object({});
const RETENTION_EVENT = z.never();

export type RetentionJob = JobFactory<
  string,
  typeof RETENTION_INPUT,
  typeof RETENTION_EVENT
>;

/**
 * A retention policy, generic in the table it sweeps.
 *
 * `T` exists solely so `beforeDelete` receives the table's OWN row type. Erasing
 * it to `Record<string, unknown>[]` made every teardown hook re-assert the row
 * shape by hand — a cast that is exactly the class of claim this repo's column
 * decoders exist to remove, and one the primitive was manufacturing rather than
 * the consumer choosing. Inference does the work: `defineRetention({ table: _x,
 * … })` binds `T` from the argument, so no call site names it.
 */
export interface RetentionSpec<T extends PgTable = PgTable> {
  /** The table to sweep. Its name (drizzle `getTableName`) derives the job id. */
  table: T;
  /** Timestamp column compared against the cutoff. Defaults to `"createdAt"`. */
  column?: string;
  /** Rows older than this many days are deleted. */
  ttlDays: number;
  /** Cron (5-field UTC). Defaults to nightly `"0 4 * * *"`. */
  cron?: string;
  /**
   * Run the sweep in EVERY worktree backend, not just main. Default `false`
   * (main-only). Set `true` only for tables that live in the per-worktree DB
   * fork (`_reports`, `entity_versions`) — a table in the shared/main DB must
   * stay main-only so N worktrees don't race N sweeps over the same rows.
   */
  perWorktree?: boolean;
  /** Extra scope AND-ed onto the age predicate (e.g. only a subset of rows). */
  where?: SQL;
  /**
   * Coordinated-teardown seam: runs over the rows about to be swept, BEFORE the
   * DELETE (e.g. the trash purge runs each source's destroy hooks + hard-deletes
   * the domain roots here). Callback-first ordering makes the sweep retry-safe:
   * a throw leaves the rows in place for the next tick, so the callback must be
   * idempotent. When the callback is set and no rows are expired, neither the
   * callback nor the DELETE runs. Retention stays generic — the CALLER supplies
   * the callback; this plugin never imports a consumer registry.
   */
  beforeDelete?: (rows: T["$inferSelect"][]) => Promise<void>;
}

// Any drizzle executor the sweep can ride on (global handle, tx, or a test
// fixture's throwaway-DB handle), so `sweepExpired` is testable against a real
// scratch database. The plain `NodePgDatabase` branch (doc-store's executor
// precedent) accepts both the global proxy and a fixture DB.
export type RetentionExecutor =
  NodePgDatabase | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * One sweep tick's body, extracted from the job for direct testing (the
 * `findCascadeFk` precedent: barrel-private, exported only for its test).
 * `beforeDelete` sees exactly the rows the DELETE predicate matches at select
 * time; a row aging past the cutoff between the two statements waits for the
 * next tick (the predicate is time-based, so the set can only grow, never lose
 * a row the callback already handled).
 *
 * A table with an in-process change producer (change-feed's
 * `defineChangeProducer`) has no trigger, so its rows' deletion reaches live
 * readers only if the producer routes it: the DELETE then runs through the
 * producer's `mutate`, which returns the deleted PKs and emits them. That path
 * needs the pool (a producer write is one autocommit statement), so a
 * transaction executor throws for a produced table. A table with no producer
 * takes the plain DELETE below, unchanged.
 */
export async function sweepExpired<T extends PgTable>(
  dbx: RetentionExecutor,
  args: {
    table: T;
    column: PgColumn;
    cutoff: Date;
    where?: SQL;
    beforeDelete?: (rows: T["$inferSelect"][]) => Promise<void>;
  },
): Promise<void> {
  const predicate = retentionPredicate(args.column, args.cutoff, args.where);
  if (args.beforeDelete) {
    const rows = await dbx.select().from(args.table).where(predicate);
    if (rows.length === 0) return;
    await args.beforeDelete(rows);
  }
  const producer = changeProducerFor(args.table);
  if (producer === undefined) {
    await dbx.delete(args.table).where(predicate);
    return;
  }
  if (is(dbx, PgTransaction)) {
    throw new Error(
      `[retention] "${getTableName(args.table)}" has a change producer: its sweep must run on the pool, not inside a transaction (the producer emits after its own autocommit statement)`,
    );
  }
  await producer.mutate(
    dbx as NodePgDatabase,
    (q, t) => q.delete(t).where(predicate),
    { latency: "background" },
  );
}

/**
 * The sweep's user-facing description, DERIVED from the spec so no retention
 * policy has a sentence for its author to forget or let drift: the table name
 * made readable (`_reports` → "reports", `entity_versions` → "entity versions"),
 * the TTL, and whether a `where` narrows the sweep to a subset of rows.
 */
export function retentionDescription(
  tableName: string,
  ttlDays: number,
  scoped: boolean,
): string {
  const human = tableName.replace(/^_+/, "").replace(/_+/g, " ").trim();
  const days = ttlDays === 1 ? "1 day" : `${ttlDays} days`;
  const subset = scoped ? "matching " : "";
  return `Deletes ${subset}${human} rows older than ${days}.`;
}

/**
 * Thin wrapper over `defineJob`: a scheduled sweep that deletes rows older than
 * `ttlDays`. Returns the same `JobFactory` `defineJob` returns — the consumer
 * mounts it via `register: [retentionJob]` on its `ServerPluginDefinition`.
 *
 * The `defineRetention` call itself IS the table's growth bound. But the bound
 * is recorded only in the returned factory's `register()` (below), never here —
 * see the comment there.
 */
export function defineRetention<T extends PgTable>(
  spec: RetentionSpec<T>,
): RetentionJob {
  const tableName = getTableName(spec.table);
  const columnKey = spec.column ?? DEFAULT_COLUMN;
  const column = (
    spec.table as unknown as Record<string, PgColumn | undefined>
  )[columnKey];
  if (!column) {
    throw new Error(
      `[retention] table "${tableName}" has no column "${columnKey}" — pass a valid \`column\` to defineRetention`,
    );
  }

  const job = defineJob({
    name: `retention.${tableName}`,
    description: retentionDescription(
      tableName,
      spec.ttlDays,
      spec.where !== undefined,
    ),
    factory: "defineRetention",
    // Every sweep is one bounded `DELETE ... WHERE <column> < cutoff` against an
    // indexed column — no network, no spawn — so the wrapper decides the class
    // and `RetentionSpec` deliberately has no `hold` for a consumer to get wrong.
    // That extends to `beforeDelete`: a teardown hook that spawns, uploads, or
    // calls a model does not belong in a sweep, and `queue-slot-hog` names this
    // job if one ever appears.
    hold: "instant",
    input: RETENTION_INPUT,
    event: RETENTION_EVENT,
    dedup: "singleton",
    schedule: {
      cron: spec.cron ?? DEFAULT_CRON,
      perWorktree: spec.perWorktree ?? false,
    },
    maxAttempts: MAX_ATTEMPTS,
    run: async () => {
      // Cutoff computed per tick (not captured at define time) so a long-lived
      // worker sweeps against a fresh "now" each run.
      const cutoff = retentionCutoff(new Date(), spec.ttlDays);
      await sweepExpired(db, {
        table: spec.table,
        column,
        cutoff,
        where: spec.where,
        beforeDelete: spec.beforeDelete,
      });
    },
  });

  return {
    ...job,
    // Coverage ⇔ mounted, BY CONSTRUCTION. The bound is recorded here — next to
    // the wrapped job's own registry write — so it exists iff the consumer put
    // this factory in `register: [...]`. A policy that is defined but never
    // mounted (its sweep never runs) records NOTHING, so it can never masquerade
    // as a covered table. Recording at call time instead would let a dead policy
    // lie about coverage. (See growth-bounds.ts for why a true set matters.)
    //
    // `Registration.register()` is `void | Promise<void>`, so the inner write is
    // awaited: the bound is declared only once the job registry write has
    // actually landed (it throws on a duplicate job name), never before.
    async register() {
      await job.register();
      declareGrowthBound(tableName, { kind: "ttl", ttlDays: spec.ttlDays });
    },
  };
}
