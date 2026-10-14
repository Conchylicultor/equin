import { sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Registration } from "@plugins/framework/plugins/server-core/core";
import {
  expr,
  type ExprField,
  type JoinColumns,
  type JoinRefs,
  type JoinSpec,
  type TypedColumnRef,
} from "@plugins/infra/plugins/query-resource/core";
import type { LiveArmColumnsHandle } from "@plugins/network/plugins/live/core";
import type {
  UnionArmBinding,
  UnionArmColumns,
  UnionFieldBinding,
} from "@plugins/network/plugins/live/server";
import type { RunOutcome } from "@plugins/runs/plugins/run-outcome/core";
import type { RunRow } from "../../core";

/** `j` of an arm over table `T` and joins `J`: each relation's wire columns, as refs. */
export type RunArmRefs<
  T extends PgTable,
  J extends readonly JoinSpec[],
> = JoinRefs<T["_"]["columns"], J>;

/** The value a column reads as: its data type, `| null` unless it is NOT NULL. */
type ColumnValue<C extends PgColumn> = C["_"]["notNull"] extends true
  ? C["_"]["data"]
  : C["_"]["data"] | null;

/**
 * The refs `j` offers whose column reads as a `V` — `JoinRef` narrowed by the
 * column's own type, so binding an integer column to a text field (or a
 * nullable one to a NOT NULL field) is a tsc error rather than a row the
 * browser's parse refuses. (A non-required join's column is NULL on a miss
 * whatever its type says; serve-union checks that nullability at bind.)
 */
export type TypedJoinRef<Refs, V> = {
  [R in keyof Refs]: {
    [K in keyof Refs[R]]: Refs[R][K] extends TypedColumnRef<string, infer C>
      ? [ColumnValue<C>] extends [V]
        ? Refs[R][K]
        : never
      : never;
  }[keyof Refs[R]];
}[keyof Refs];

/**
 * One field's binding: a column ref `j` offers whose column reads as the
 * field's type, or an expression over them whose VALUE type is the field's
 * (`ExprField<V>`) — both checked by tsc.
 */
export type RunFieldBinding<
  T extends PgTable,
  J extends readonly JoinSpec[],
  V,
> = TypedJoinRef<RunArmRefs<T, J>, V> | ExprField<V>;

/**
 * Where an arm's base fields come from — one key per base field, derived from
 * the row (T9). `id` and `duration` are absent: the id is the arm's primary key
 * (`spec.id`) and the duration is derived from `startedAt` / `finishedAt`, so no
 * arm can supply either and no two arms can disagree about what they are.
 *
 * `startedAt` / `finishedAt` are columns (the duration is computed from them);
 * a nullable field (`trigger`, `namespace`, `message`) may be `null` — "this
 * kind has no such notion" — and a non-nullable one may not.
 */
export interface RunArmBase<T extends PgTable, J extends readonly JoinSpec[]> {
  label: RunFieldBinding<T, J, string>;
  outcome: RunFieldBinding<T, J, RunOutcome>;
  trigger: RunFieldBinding<T, J, string | null> | null;
  startedAt: TypedJoinRef<RunArmRefs<T, J>, Date>;
  finishedAt: TypedJoinRef<RunArmRefs<T, J>, Date | null>;
  namespace: RunFieldBinding<T, J, string | null> | null;
  message: RunFieldBinding<T, J, string | null> | null;
}

/**
 * What a domain hands `defineRunKind` (T9).
 *
 * - `columns` is the arm (`liveArm(runs, kind, { label, fields })`, in the
 *   arm's core): the kind is ITS arm, so the discriminator, the row key's
 *   prefix and the web field ids cannot drift apart.
 * - `extra` binds exactly that set's fields, each to a value of the field's
 *   type — a declared field with no column, or a column with no field, is a
 *   tsc error.
 * - `id` is the ledger's single-column primary key — the row key encodes it.
 */
export interface RunKindSpec<
  T extends PgTable,
  J extends readonly JoinSpec[],
  CRow,
  F,
  S extends string,
> {
  columns: LiveArmColumnsHandle<RunRow, CRow, F, S>;
  /** The domain's own ledger table. Stays plugin-private; only bound here. */
  from: T;
  id: PgColumn;
  joins?: J;
  base: (j: RunArmRefs<T, J>) => RunArmBase<T, J>;
  extra: (j: RunArmRefs<T, J>) => {
    [K in keyof CRow & string]-?: RunFieldBinding<T, J, CRow[K]>;
  };
  /** Always-on scope for this arm — a namespace, a soft-delete flag. */
  where?: (j: JoinColumns<T, J>) => SQL;
}

/**
 * A registered arm: its kind, and its binding into the union
 * (network/live's `serveUnionCollection`).
 *
 * There is deliberately **no `label`** here. The kind's human name is the
 * arm's (`liveArm`, core), and the filter chip's options must list every
 * registered kind, not the ones on the loaded page — so the web reads it off
 * the arms registered on `Runs.Kind`.
 */
export interface RunKind {
  kind: string;
  binding: UnionArmBinding;
}

// Module-load-time registry. Populated by `defineRunKind`'s `register()` during
// the framework's register phase (mirrors `defineTrashSource` /
// `defineHistorySource`), read once by the union's deferred compile.
const runKindRegistry = new Map<string, RunKind>();

/**
 * Wall-clock milliseconds, derived rather than stored: `finishedAt −
 * startedAt`, NULL while the run is in flight (the browser ticks a running
 * run's elapsed time itself — `<RunDuration>`). Cast to `double precision`
 * because `extract(epoch …)` yields `numeric`, which `pg` decodes as a string.
 */
function durationOf(
  startedAt: unknown,
  finishedAt: unknown,
): ExprField<number | null> {
  return expr(
    sql`(extract(epoch from (${finishedAt} - ${startedAt})) * 1000)::double precision`,
    { decoder: Number, sqlType: "double precision" },
  );
}

/**
 * Register a run kind — one arm of the merged run space.
 *
 * Returns a {@link Registration}: a lazy registry write the framework applies
 * when the token sits in a plugin's `register: [...]` array. `runs` never names
 * an arm and an arm never edits `runs`; adding a kind is one folder.
 */
export function defineRunKind<
  T extends PgTable,
  CRow,
  F,
  S extends string,
  // No `joins` → no join relations, not the constraint's open set (whose
  // string index would swallow `base`, so no column could bind).
  const J extends readonly JoinSpec[] = readonly [],
>(spec: RunKindSpec<T, J, CRow, F, S>): RunKind & Registration {
  const kind = spec.columns.owner.arm;
  // The facade's typed `j` and bindings, erased to the union's loose shape:
  // every binding was type-checked against the row and the arm's column set
  // above (T9), and `serveUnionCollection` re-checks the key sets at bind.
  const binding: UnionArmBinding = {
    columns: spec.columns,
    from: spec.from,
    id: spec.id,
    ...(spec.joins ? { joins: spec.joins } : {}),
    base: (j) => {
      const b = spec.base(j as unknown as RunArmRefs<T, J>);
      return {
        id: { from: "base", col: spec.id },
        label: b.label,
        outcome: b.outcome,
        trigger: b.trigger,
        startedAt: b.startedAt,
        finishedAt: b.finishedAt,
        duration: durationOf(b.startedAt, b.finishedAt),
        namespace: b.namespace,
        message: b.message,
      } as unknown as Readonly<Record<string, UnionFieldBinding | null>>;
    },
    extra: (j) =>
      spec.extra(j as unknown as RunArmRefs<T, J>) as unknown as Readonly<
        Record<string, UnionFieldBinding>
      >,
    ...(spec.where
      ? {
          where: (j: UnionArmColumns) =>
            spec.where!(j as unknown as JoinColumns<T, J>),
        }
      : {}),
  };
  const run: RunKind = { kind, binding };
  return {
    ...run,
    _kind: "run-kind",
    _factory: "defineRunKind",
    _doc: { label: kind },
    register() {
      if (runKindRegistry.has(kind)) {
        throw new Error(`[runs] duplicate run kind: ${kind}`);
      }
      runKindRegistry.set(kind, run);
    },
  };
}

/** Every registered arm, in load order. */
export function getRunKinds(): RunKind[] {
  return [...runKindRegistry.values()];
}
