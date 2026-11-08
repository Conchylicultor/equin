import {
  getTableColumns,
  getTableName,
  type HasDefault,
  type HasGenerated,
  type NotNull,
} from "drizzle-orm";
import {
  getTableConfig,
  timestamp,
  type PgInsertBase,
  type PgInsertBuilder,
  type PgQueryResultHKT,
  type PgTable,
  type PgTimestampBuilderInitial,
} from "drizzle-orm/pg-core";
import { compileDerivedUpdatedAt } from "./compile";
import { registerDerivedUpdatedAt } from "./registry";
import type { DerivedUpdatedAtSpec, TouchRule } from "./types";

// ── The declaration, read off a drizzle table ───────────────────────────────
//
// `compileFromTable` is the ONE path from "a drizzle table + its touchedBy" to a
// compiled spec: it reads the physical column names and SQL types off the table,
// so a JS key renamed in the DB (`lastViewedAt` → `seen_at`) cannot drift from
// the trigger. `defineEntity` (infra/entities) calls it for an entity;
// `deriveUpdatedAt` wraps a raw `pgTable` with it.

/**
 * A TOTAL classification of every column of `T` but `updatedAt` itself, each
 * rule typed against its column's own select value — the raw-table twin of
 * entities' `TouchedBy`. A new column nobody classified is a tsc error.
 */
export type TableTouchedBy<T extends PgTable> = {
  [K in Exclude<keyof T["$inferSelect"], "updatedAt">]: TouchRule<
    T["$inferSelect"][K]
  >;
};

/**
 * A raw table's derived `updated_at` column: `timestamptz NOT NULL DEFAULT
 * now()`, typed as never written by the app — `HasGenerated` takes it out of
 * the table's insert model, so a typed `.values()` / `.set()` /
 * `onConflictDoUpdate({ set })` naming `updatedAt` is a tsc error (the trigger
 * would refuse the UPDATE at runtime). Type-only: the runtime column is a plain
 * defaulted timestamp, so the DDL is unchanged.
 */
export function derivedUpdatedAt() {
  return timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull() as DerivedUpdatedAtColumn;
}
type DerivedUpdatedAtColumn = HasGenerated<
  NotNull<HasDefault<PgTimestampBuilderInitial<"updated_at">>>,
  { type: "always" }
>;

/**
 * A drizzle table whose `updatedAt` column is unwritten (`derivedUpdatedAt()`)
 * — the only kind that can derive one, so a raw table cannot declare a derived
 * `updatedAt` its typed writes may still name.
 */
export type TableWithUpdatedAt = PgTable & {
  readonly $inferSelect: { readonly updatedAt: unknown };
  readonly _: {
    readonly columns: {
      readonly updatedAt: {
        readonly _: { readonly generated: { type: "always" } };
      };
    };
  };
};

type DrizzleColumn = { readonly name: string; getSQLType(): string };

/**
 * Compile `table`'s derived-`updatedAt` trigger from `touchedBy`, keyed by the
 * table's JS column keys. Does not register it.
 *
 * Runtime-checks what the types promise (for callers typed against a widened
 * record): the table has an `updatedAt` column, and `touchedBy` classifies every
 * other column exactly once. `where` prefixes that totality error so it names
 * the declaration site (default `deriveUpdatedAt("<table>"): touchedBy`).
 */
export function compileFromTable(
  table: PgTable,
  touchedBy: Readonly<Record<string, TouchRule<unknown>>>,
  where?: string,
): DerivedUpdatedAtSpec {
  const name = getTableName(table);
  const schema = getTableConfig(table).schema;
  if (schema !== undefined) {
    throw new Error(
      `derived updatedAt on "${name}": the table is in schema "${schema}"; ` +
        `only public-schema tables are supported.`,
    );
  }
  const columns = getTableColumns(table) as Record<string, DrizzleColumn>;
  const updatedAt = columns.updatedAt;
  if (!updatedAt) {
    throw new Error(
      `derived updatedAt on "${name}": the table has no updatedAt column.`,
    );
  }
  const expected = Object.keys(columns).filter((k) => k !== "updatedAt");
  const missing = expected.filter((k) => !(k in touchedBy));
  const extra = Object.keys(touchedBy).filter((k) => !expected.includes(k));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${where ?? `deriveUpdatedAt("${name}"): touchedBy`} must classify ` +
        `every column but updatedAt exactly once` +
        (missing.length > 0 ? `; missing: ${missing.join(", ")}` : "") +
        (extra.length > 0 ? `; not a column: ${extra.join(", ")}` : "") +
        `.`,
    );
  }
  return compileDerivedUpdatedAt({
    table: name,
    updatedAtColumn: updatedAt.name,
    columns: expected.map((key) => {
      const col = columns[key] as DrizzleColumn;
      return {
        key,
        name: col.name,
        sqlType: col.getSQLType(),
        rule: touchedBy[key] as TouchRule<unknown>,
      };
    }),
  });
}

/**
 * Declare how a raw drizzle table's `updatedAt` moves: compiles `touchedBy` into
 * the table's BEFORE UPDATE trigger, registers it for the boot installer (at
 * module eval, like `defineEntity`), and returns the table unchanged — so the
 * declaration wraps the `pgTable(…)` it describes:
 *
 *   export const agents = deriveUpdatedAt(pgTable("agents", { … }), {
 *     touchedBy: { name: true, …, id: false, createdAt: false },
 *   });
 */
export function deriveUpdatedAt<T extends TableWithUpdatedAt>(
  table: T,
  declaration: { readonly touchedBy: TableTouchedBy<T> },
): T {
  registerDerivedUpdatedAt(
    compileFromTable(
      table,
      declaration.touchedBy as Readonly<Record<string, TouchRule<unknown>>>,
    ),
  );
  return table;
}

/** A row of `T` to insert with its `updatedAt` given (`insertWithUpdatedAt`). */
export type RowWithUpdatedAt<T extends TableWithUpdatedAt> =
  T["$inferInsert"] & {
    readonly updatedAt: Date;
  };

/**
 * INSERT rows whose `updatedAt` is given rather than now() — history being
 * written (a seed, an import), which Postgres takes: the derived-updatedAt
 * trigger is BEFORE UPDATE only. The one spelling of a typed write naming
 * `updatedAt`, and an INSERT only: the builder it returns still takes no
 * `updatedAt` in an `onConflictDoUpdate({ set })`, where the trigger would
 * refuse it.
 */
export function insertWithUpdatedAt<
  T extends TableWithUpdatedAt,
  Q extends PgQueryResultHKT,
>(
  exec: { insert<U extends PgTable>(table: U): PgInsertBuilder<U, Q> },
  table: T,
  rows: readonly RowWithUpdatedAt<T>[],
): PgInsertBase<T, Q> {
  // The cast is the point: the insert model leaves `updatedAt` out so no other
  // write can name it, and the runtime column takes a value like any other.
  return exec.insert(table).values(rows as never);
}
