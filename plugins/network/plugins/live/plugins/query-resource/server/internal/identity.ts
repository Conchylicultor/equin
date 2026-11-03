import { getTableColumns, is } from "drizzle-orm";
import { PgTable, getTableConfig, type PgColumn } from "drizzle-orm/pg-core";
import { projectedField } from "./joins";
import type { EntitySource, RoutedSource, SelectMap } from "./spec";

// The resolved identity of a routed source: the table to select from, the
// single-column primary key, the client keyField (the JS/alias key the pk is
// exposed under on the wire), and the projection (undefined ⇒ select-all).
export interface ResolvedIdentity {
  rel: PgTable;
  pkColumn: PgColumn;
  keyField: string;
  selectMap?: SelectMap;
  /**
   * The relation's full column record (JS property name → column) — the wire
   * field namespace when no projection is declared. Lets consumers resolve
   * OTHER columns' wire fields with `projectedField` (arm-plan's
   * order-signature derivation) without re-deriving the source shape.
   */
  columns: Record<string, PgColumn>;
}

// Structural entity detection — an `infra/entities` Entity is the only source
// shape carrying all four of these; a raw PgTable carries none of
// `wireColumns`. (See the collection-consumer note: we detect by shape, never by
// importing the concrete entity type.)
function isEntitySource(from: RoutedSource): from is EntitySource {
  return (
    typeof from === "object" &&
    from !== null &&
    "table" in from &&
    "name" in from &&
    "wireColumns" in from &&
    "schema" in from
  );
}

// The single primary-key column of a table, or a loud throw. A composite PK
// (declared via `primaryKey({ columns })`) or >1 inline `.primaryKey()` cannot
// key a single-column keyed resource — the caller must pass `identity.pk` to
// pick one.
function singlePrimary(
  table: PgTable,
  columns: Record<string, PgColumn>,
  label: string,
): PgColumn {
  const primaries = Object.values(columns).filter((c) => c.primary);
  const compositeWide = getTableConfig(table).primaryKeys.some(
    (pk) => pk.columns.length > 1,
  );
  if (compositeWide || primaries.length > 1) {
    throw new Error(
      `query-resource: ${label} has a composite primary key — a keyed ` +
        `resource needs a single-column identity. Pass identity.pk to pick one.`,
    );
  }
  if (primaries.length === 0) {
    throw new Error(
      `query-resource: ${label} has no primary-key column — cannot derive a ` +
        `keyed identity. Pass identity.pk.`,
    );
  }
  return primaries[0]!;
}

// The pk's wire field, or a loud throw — a keyed resource must project its
// identity column so the client keyOf can read it.
function keyFieldFor(
  selectMap: SelectMap | undefined,
  columns: Record<string, PgColumn>,
  pkColumn: PgColumn,
  label: string,
): string {
  // Relation-exact: the pk is the base table's own column, so a joined column
  // of the same name never stands for it (`projectedField`).
  const field = projectedField(selectMap ?? columns, pkColumn);
  if (field !== undefined) return field;
  throw new Error(
    `query-resource: ${label} — the primary-key column "${pkColumn.name}" is not ` +
      `present in the ${selectMap ? "select projection" : "column set"}. A keyed ` +
      `resource must project its identity column so the client keyOf can read it.`,
  );
}

/**
 * Resolve the identity of a routed source:
 * - **Entity** → pk = the single primary of `getTableColumns(entity.table)`;
 *   default projection = `wireColumns`.
 * - **PgTable** → pk = its single primary; default projection = select-all.
 *
 * Never a view: `RoutedSource` has no spelling for one (a view's changes arrive
 * under its base tables' names, which no route of the view could state).
 * `identity.pk` overrides the derived pk; a composite / missing pk (with no
 * override) throws.
 */
export function resolveIdentity(
  from: RoutedSource,
  identity: { pk: PgColumn } | undefined,
  select: SelectMap | undefined,
): ResolvedIdentity {
  // The `is()` check runs FIRST (entityKind-branded, unforgeable); the
  // structural entity check runs LAST — so a table whose COLUMNS happen to be
  // named `name`/`table`/`schema`/`wireColumns` can never be misdetected as an
  // entity (an Entity object itself is never `is()` a PgTable).
  if (is(from, PgTable)) {
    const columns = getTableColumns(from);
    const label = `table "${getTableConfig(from).name}"`;
    const pkColumn = identity?.pk ?? singlePrimary(from, columns, label);
    return {
      rel: from,
      pkColumn,
      keyField: keyFieldFor(select, columns, pkColumn, label),
      selectMap: select,
      columns,
    };
  }

  if (isEntitySource(from)) {
    const columns = getTableColumns(from.table);
    const label = `entity "${from.name}"`;
    const pkColumn = identity?.pk ?? singlePrimary(from.table, columns, label);
    const selectMap = select ?? from.wireColumns;
    return {
      rel: from.table,
      pkColumn,
      keyField: keyFieldFor(selectMap, columns, pkColumn, label),
      selectMap,
      columns,
    };
  }

  throw new Error(
    `query-resource: unsupported \`from\` source — expected a drizzle PgTable ` +
      `or an infra/entities Entity.`,
  );
}
