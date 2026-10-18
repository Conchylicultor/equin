import { getTableName } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { EntityTable } from "@plugins/infra/plugins/entities/server";
import type { AnyExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import type { LiveFrom } from "@plugins/network/plugins/live/core";
import type { ColumnWire } from "@plugins/database/plugins/sql-column/server";
import type {
  EntitySource,
  RoutedSource,
} from "@plugins/infra/plugins/query-resource/server";

// What a served collection reads from, and the type-level reads of it every
// single-table form shares — the window / lookup forms (`./serve-collection`)
// and the `all` form (`./serve-all`). A leaf: it imports neither, so the two
// never import each other's module for a binding.

/** A table, or an `infra/entities` Entity (read through its table). Never a view. */
export type CollectionSource = RoutedSource;

/**
 * What `serveCollection` reads: an entity — `defineEntity`'s (or an
 * extension's) handle, or the table it built. Never a raw `pgTable`: a
 * collection over a table is `from` its entity, so the table has one (tsc —
 * `EntityTable`; `compileCollection`, a test derivation, takes any table).
 */
export type ServedSource = EntitySource | EntityTable;

/** The table `from` reads. */
export type TableOf<T> = T extends EntitySource
  ? T["table"]
  : T extends PgTable
    ? T
    : never;

/** The columns `from` exposes, by property name. */
export type ColumnsOf<T> = T extends EntitySource
  ? T["wireColumns"]
  : T extends PgTable
    ? T["_"]["columns"]
    : never;

/** The column property names `from` exposes. */
export type ColumnNamesOf<T> = keyof ColumnsOf<T> & string;

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * Row fields bound by name to a column that declares a wire form (sql-column's
 * `withWire`) whose wire type the field is not — e.g. a `bytea` column's field
 * typed as bytes instead of its base64 `string`.
 */
type WireMismatch<T, Row> = {
  [K in keyof Row & ColumnNamesOf<T>]: ColumnWire<ColumnsOf<T>[K]> extends {
    wire: infer W;
  }
    ? Same<Row[K], W> extends true
      ? never
      : K
    : never;
}[keyof Row & ColumnNamesOf<T>];

/** A wire-type mismatch is a REQUIRED property of type `never`, naming the field: a tsc error. */
export type WireCheck<T, Row> = [WireMismatch<T, Row>] extends [never]
  ? unknown
  : {
      [
        K in WireMismatch<T, Row> &
          string as `row field "${K}" must be its column's wire type (sql-column withWire)`
      ]: never;
    };

/** Whether `from` is an `infra/entities` Entity (read through its table). */
export function isEntitySource(from: CollectionSource): from is EntitySource {
  return "wireColumns" in from && "table" in from;
}

/**
 * A served collection reads the rows it is declared `from`: an entity ref
 * names the table read (`from.name` — an entity, or an extension's
 * `<parent>_ext_<name>`), an extension shape is the one the served extension
 * was built from (its wire schema, by identity). A collection declared by its
 * own fields alone reads no table — it is served from outside Postgres
 * (`source: "external"`) or is a union. So a list over a table derives its
 * fields from the table's entity: nothing restates them.
 */
export function assertServesItsRows(
  collection: { key: string; rowsFrom: LiveFrom | null },
  from: CollectionSource,
): void {
  const table = isEntitySource(from) ? from.table : from;
  const name = getTableName(table);
  const fail = (message: string): never => {
    throw new Error(`serveCollection("${collection.key}"): ${message}`);
  };
  const rowsFrom = collection.rowsFrom;
  if (rowsFrom === null) {
    fail(
      `it is declared by its own fields, but reads table "${name}" — a collection over a table is \`from\` its entity (\`from: <entityRef>, pick: [...]\`, or \`from: <extension shape>\`); own \`fields\` are only for what it computes.`,
    );
  } else if ("kind" in rowsFrom && rowsFrom.kind === "entity") {
    if (rowsFrom.name !== name) {
      fail(
        `it is \`from\` entity "${rowsFrom.name}", but reads table "${name}" — serve it from that entity.`,
      );
    }
  } else if (
    !isEntitySource(from) ||
    from.schema !== (rowsFrom as AnyExtensionShape).schema
  ) {
    fail(
      `it is \`from\` an extension shape, but reads "${name}", which is not that shape's extension — serve it from the \`defineExtension\` handle built from the shape.`,
    );
  }
}
