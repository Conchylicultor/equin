import { and, eq, isNull, or, type SQL, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  index,
  type PgColumnBuilderBase,
  type PgTable,
  pgTable,
} from "drizzle-orm/pg-core";
import { type EnqueueTx } from "@plugins/infra/plugins/jobs/server";
import { db } from "@plugins/database/server";
import type { Registration } from "@plugins/framework/plugins/server-core/core";
import { eventTriggerColumns } from "./base-columns";
import {
  enqueueDelivery,
  enqueuesOnCallerTx,
  resolveDelivery,
  type TriggerDelivery,
} from "./deliver";
import { eventsDispatchJob } from "./dispatch-job";
import { triggerTableRegistry } from "./registry";
import { EMISSIONS_CAP } from "../../core";
import { _event_emissions } from "./tables";

/**
 * Drizzle node-postgres database/transaction handle, threaded through
 * `emit(payload, { tx })` to make the trigger SELECT, the emission audit
 * insert, and the `graphile_worker.jobs` INSERT all run on the caller's
 * transaction client. Rollback drops all three atomically.
 */
export type EmitTx = EnqueueTx;

// A filter slot is either a plain column builder (identity-or-null match on
// the same-named payload key) or an object with an explicit match predicate.
export type FilterSlot<T> =
  | PgColumnBuilderBase
  | {
      column: PgColumnBuilderBase;
      match: (col: AnyPgColumn, payload: T) => SQL;
    };

export interface DefineTriggerEventSpec<
  T extends Record<string, unknown>,
  F extends Record<string, FilterSlot<T>>,
> {
  name: string;
  filters: F;
  matchFn?: (table: PgTable, payload: T) => SQL;
}

// Normalized per-event definition held in-memory. `trigger`, `emit`, and
// `.where` all close over one of these.
interface EventDef<T> {
  name: string;
  table: PgTable;
  filterColumns: Record<string, AnyPgColumn>;
  filterMatchers: Record<string, (col: AnyPgColumn, payload: T) => SQL>;
  matchFn?: (table: PgTable, payload: T) => SQL;
}

export interface EventSource<T = unknown> {
  readonly __kind: "event";
  readonly def: EventDef<T>;
  readonly filter: Record<string, unknown>;
}

// The event handle returned from `defineTriggerEvent`. It IS a match-any
// Source and additionally exposes `.emit` (owner-only), `.where` (subscriber),
// and the `Registration` interface (`.register()` writes the table into
// `triggerTableRegistry`; the framework calls it during the plugin register
// phase).
export type EventHandle<T, F extends Record<string, unknown>> = EventSource<T> &
  Registration & {
    readonly name: string;
    /**
     * Announce a fact. Pass `{ tx }` when emitting from inside a Drizzle
     * transaction — the trigger SELECT, the emission audit, and the job
     * INSERT all run on the same connection, so a rollback drops all three
     * atomically. Without `tx`, dispatch goes through Graphile's own pool
     * (correct for post-commit emit).
     */
    emit(payload: T, opts?: { tx?: EmitTx }): Promise<void>;
    where(filter: Partial<{ [K in keyof F & keyof T]: T[K] }>): EventSource<T>;
  };

function isObjectSlot<T>(v: FilterSlot<T>): v is {
  column: PgColumnBuilderBase;
  match: (col: AnyPgColumn, payload: T) => SQL;
} {
  return (
    typeof v === "object" &&
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime null guard; typeof null === "object"
    v !== null &&
    "match" in v &&
    // biome-ignore lint/suspicious/noExplicitAny: runtime brand check.
    typeof (v as any).match === "function"
  );
}

export function defineTriggerEvent<
  T extends Record<string, unknown>,
  F extends Record<string, FilterSlot<T>> = Record<string, FilterSlot<T>>,
>(
  spec: DefineTriggerEventSpec<T, F>,
): {
  table: PgTable;
  event: EventHandle<T, F>;
} {
  const tableName = spec.name.replace(/\./g, "_") + "_triggers";

  const columnBuilders: Record<string, PgColumnBuilderBase> = {};
  const matcherBuilders: Record<string, (col: AnyPgColumn, payload: T) => SQL> =
    {};

  for (const key of Object.keys(spec.filters)) {
    const slot = spec.filters[key as keyof F] as FilterSlot<T>;
    if (isObjectSlot(slot)) {
      columnBuilders[key] = slot.column;
      matcherBuilders[key] = slot.match;
    } else {
      columnBuilders[key] = slot;
      matcherBuilders[key] = (col, payload) =>
        // biome-ignore lint/style/noNonNullAssertion: or() with 2 args never returns undefined.
        or(isNull(col), eq(col, (payload as Record<string, unknown>)[key]))!;
    }
  }

  const table = pgTable(
    tableName,
    {
      ...eventTriggerColumns(),
      ...columnBuilders,
    },
    (t) =>
      Object.keys(columnBuilders).map((key) =>
        index(`${tableName}_${key}_idx`)
          // biome-ignore lint/suspicious/noExplicitAny: dynamic column access on untyped Record.
          .on((t as any)[key])
          .where(sql`enabled`),
      ),
  );

  // Resolve column references on the built table.
  const resolvedCols: Record<string, AnyPgColumn> = {};
  for (const key of Object.keys(columnBuilders)) {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic column access on untyped PgTable.
    resolvedCols[key] = (table as any)[key] as AnyPgColumn;
  }

  const def: EventDef<T> = {
    name: spec.name,
    table,
    filterColumns: resolvedCols,
    filterMatchers: matcherBuilders,
    matchFn: spec.matchFn,
  };

  // Registry write moved into `event.register()` (called by the framework
  // during the plugin register phase). The Drizzle `table` itself is built
  // here at construction time so it can be exported as a schema (drizzle-kit
  // discovers it via glob) and so the closure captures a stable reference.
  const event: EventHandle<T, F> = Object.assign(
    {
      __kind: "event" as const,
      def,
      filter: {} as Record<string, unknown>,
    },
    {
      name: spec.name,
      _kind: "trigger-event" as const,
      _factory: "defineTriggerEvent",
      _doc: { label: spec.name },
      emit: async (payload: T, opts?: { tx?: EmitTx }) => {
        await dispatch(def, payload, opts?.tx);
      },
      where: (filter: Partial<{ [K in keyof F & keyof T]: T[K] }>) => ({
        __kind: "event" as const,
        def,
        filter: filter as Record<string, unknown>,
      }),
      register() {
        if (triggerTableRegistry.has(spec.name)) {
          throw new Error(`[events] duplicate event name: ${spec.name}`);
        }
        triggerTableRegistry.set(spec.name, table);
      },
    },
  );

  return { table, event };
}

// ─── Dispatch ────────────────────────────────────────────────────────────

async function dispatch<T>(
  def: EventDef<T>,
  payload: T,
  tx?: EmitTx,
): Promise<void> {
  const exec = tx ?? db;
  // biome-ignore lint/suspicious/noExplicitAny: base-column property access on PgTable.
  const enabledCol = (def.table as any).enabled as AnyPgColumn;
  const predicates: SQL[] = [eq(enabledCol, true)];

  if (def.matchFn) {
    predicates.push(def.matchFn(def.table, payload));
  } else {
    for (const key of Object.keys(def.filterColumns)) {
      const col = def.filterColumns[key]!;
      const matcher = def.filterMatchers[key]!;
      predicates.push(matcher(col, payload));
    }
  }

  const rows = await exec
    .select()
    .from(def.table)
    .where(and(...predicates))
    // biome-ignore lint/suspicious/noExplicitAny: base-column property access on PgTable.
    .orderBy((def.table as any).id as AnyPgColumn);

  // biome-ignore lint/suspicious/noExplicitAny: row shape is dynamic per table.
  const matchedIds = rows.map((r) => (r as any).id as string);
  await recordEmission(def.name, payload, matchedIds, tx);

  if (rows.length === 0) return;

  // Deliver to every matched trigger: each target job gets its own queue row,
  // run id and dedup key, the same path as a direct `.enqueue()`. emit()
  // resolves once they are durable in the queue, not when the targets finish.
  //
  // Without `tx`, every target is enqueued right here. With one, a target is
  // enqueued on the caller's transaction (so it lives or dies with the
  // emitter's writes) only when that locks nothing other emitters share — a
  // `dedup: "none"` row. Keyed and singleton targets go into ONE outbox row
  // (`events.dispatch`) on the transaction, which enqueues them after commit
  // (see `enqueuesOnCallerTx`). Sequential: on a transaction they share one
  // connection anyway, and the id order keeps the lock order stable.
  const deferred: TriggerDelivery[] = [];
  for (const row of rows) {
    // biome-ignore lint/suspicious/noExplicitAny: row shape is dynamic per table.
    const r = row as any;
    const resolved = await resolveDelivery(
      {
        eventName: def.name,
        triggerId: r.id as string,
        jobName: r.jobName as string,
        jobWith: (r.jobWith ?? {}) as Record<string, unknown>,
        eventPayload: (payload ?? {}) as Record<string, unknown>,
        oneShot: r.oneShot as boolean,
      },
      tx,
    );
    if (!resolved) continue;
    if (tx && !enqueuesOnCallerTx(resolved.target)) {
      deferred.push(resolved.delivery);
    } else {
      await enqueueDelivery(resolved, tx);
    }
  }
  if (deferred.length > 0) {
    await eventsDispatchJob.enqueue({ deliveries: deferred }, { tx });
  }
}

// Append to the emission log and trim back to the cap. Runs inside dispatch()
// before jobs are enqueued so the log reflects "what fired" even when the
// matched triggers are zero (the most interesting debug case).
async function recordEmission(
  eventName: string,
  payload: unknown,
  matchedTriggerIds: string[],
  tx?: EmitTx,
): Promise<void> {
  const exec = tx ?? db;
  await exec.insert(_event_emissions).values({
    eventName,
    payload: (payload ?? {}) as Record<string, unknown>,
    matchedCount: matchedTriggerIds.length,
    matchedTriggerIds,
  });
  // Cap at EMISSIONS_CAP rows — cheap single DELETE instead of a window.
  await exec.execute(
    sql`DELETE FROM ${_event_emissions}
        WHERE ${_event_emissions.id} IN (
          SELECT id FROM ${_event_emissions}
          ORDER BY ${_event_emissions.emittedAt} DESC
          OFFSET ${EMISSIONS_CAP}
        )`,
  );
}
