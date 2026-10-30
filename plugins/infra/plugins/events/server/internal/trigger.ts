import { and, eq, sql } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import type { z } from "zod";
import type { JobFactory } from "@plugins/infra/plugins/jobs/server";
import { db } from "@plugins/database/server";
import type { EventSource } from "./event";
import { triggerTableRegistry } from "./registry";

export interface TriggerSpec<P, I> {
  on: EventSource<P>;
  do: JobFactory<string, z.ZodType<I>, z.ZodType>;
  /**
   * The target job's full `input` value. Stored verbatim in the trigger row
   * and passed as `input` to the job's run handler at dispatch time. The
   * event payload reaches the job through a separate `event` argument, so
   * key collisions between `with` and event fields are impossible.
   */
  with: I;
  oneShot?: boolean;
}

// Persist a subscription. Inserts one row into the event's per-type table
// with the filter values, job name, and serialized `with` config.
export async function trigger<P, I>(spec: TriggerSpec<P, I>): Promise<string> {
  return insertTriggerRow({
    on: spec.on,
    jobName: spec.do.name,
    with: spec.with as Record<string, unknown>,
    oneShot: spec.oneShot,
  });
}

export interface UnsafeTriggerByNameSpec<P> {
  on: EventSource<P>;
  /**
   * Target job, identified by registered name. Used by infrastructure code
   * (the @plugins/jobs durable-hook bridge) that can't hold a typed
   * `JobFactory` reference back to its own builtin without closing the
   * plugin DAG. Plugin authors should prefer `trigger()` — passing the
   * typed factory keeps `with` linked to the target's input schema.
   */
  jobName: string;
  with?: Record<string, unknown>;
  oneShot?: boolean;
}

// Same row-insert as `trigger()`, but typed for infra callers that only
// carry a job name. The `UNSAFE_` prefix is the contract: `with` is
// unconstrained and the dispatcher will error at runtime if it doesn't
// satisfy the target job's `input` schema. Reserved for cycle-breaking
// uses (e.g. `install-jobs-hooks.ts`); feature plugins use `trigger()`.
export async function UNSAFE_triggerByName<P>(
  spec: UnsafeTriggerByNameSpec<P>,
): Promise<string> {
  return insertTriggerRow(spec);
}

interface RowInsertSpec<P> {
  on: EventSource<P>;
  jobName: string;
  with?: Record<string, unknown>;
  oneShot?: boolean;
}

/**
 * A trigger as the row its event's table stores — the table it goes in and the
 * values: the filter values, job name and serialized `with` config. The one
 * spelling of a trigger row, for the single insert and the boot sync's batch.
 */
export function triggerRow<P, I>(
  spec: TriggerSpec<P, I>,
): { table: PgTable; values: Record<string, unknown> } {
  return rowOf({
    on: spec.on,
    jobName: spec.do.name,
    with: spec.with as Record<string, unknown>,
    oneShot: spec.oneShot,
  });
}

function rowOf<P>(spec: RowInsertSpec<P>): {
  table: PgTable;
  values: Record<string, unknown>;
} {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- forward-compat guard; more source kinds may be added
  if (spec.on.__kind !== "event") {
    throw new Error(
      `[events] trigger({ on }) got unsupported source kind: ${(spec.on as { __kind: string }).__kind}`,
    );
  }

  const { def, filter } = spec.on;
  const oneShot = spec.oneShot ?? true;

  const values: Record<string, unknown> = {
    jobName: spec.jobName,
    jobWith: spec.with ?? {},
    oneShot,
  };
  for (const key of Object.keys(def.filterColumns)) {
    values[key] = filter[key] ?? null;
  }
  return { table: def.table, values };
}

async function insertTriggerRow<P>(spec: RowInsertSpec<P>): Promise<string> {
  const { table, values } = rowOf(spec);
  const rows = await db
    .insert(table)
    .values(values)
    .returning({
      // biome-ignore lint/suspicious/noExplicitAny: dynamic id column access on untyped PgTable.
      id: (table as any).id as AnyPgColumn,
    });

  const row = rows[0];
  if (!row) throw new Error(`[events] trigger insert returned no rows`);
  return row.id as string;
}

// Delete a trigger row by id. UUIDs are globally unique so we sweep every
// registered trigger table; the first match deletes, the rest are no-ops.
export async function deleteTrigger(id: string): Promise<void> {
  for (const table of triggerTableRegistry.values()) {
    await db
      .delete(table)
      // biome-ignore lint/suspicious/noExplicitAny: dynamic id column access on untyped PgTable.
      .where(eq((table as any).id as AnyPgColumn, id));
  }
}

// Sweep every trigger table, deleting rows whose target job matches and whose
// persisted `jobWith` contains every key in `configMatch` (JSONB `@>`). Omit
// `configMatch` to remove every trigger that binds this job.
export async function deleteTriggersFor<N extends string, S extends z.ZodType>(
  job: JobFactory<N, S>,
  configMatch?: Partial<z.input<S>>,
): Promise<void> {
  const matchJson =
    configMatch && Object.keys(configMatch).length > 0
      ? JSON.stringify(configMatch)
      : null;
  for (const table of triggerTableRegistry.values()) {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic column access on base-columns.
    const jobNameCol = (table as any).jobName as AnyPgColumn;
    if (matchJson) {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic column access on base-columns.
      const jobWithCol = (table as any).jobWith as AnyPgColumn;
      await db
        .delete(table)
        .where(
          and(
            eq(jobNameCol, job.name),
            sql`${jobWithCol} @> ${matchJson}::jsonb`,
          ),
        );
    } else {
      await db.delete(table).where(eq(jobNameCol, job.name));
    }
  }
}
