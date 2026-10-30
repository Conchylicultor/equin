import { sql } from "drizzle-orm";
import { text, type AnyPgColumn, type PgColumn } from "drizzle-orm/pg-core";
import {
  columnSchema,
  parsedText,
} from "@plugins/database/plugins/sql-column/server";
import {
  storedIdSchema,
  type AnyIdKind,
  type IdKind,
  type IdShape,
} from "../../core";
import { externalReasonOfDecoder, idKindOfDecoder } from "../../core";

type FkAction =
  "cascade" | "restrict" | "no action" | "set null" | "set default";

/**
 * A table's primary-key id column for `kind`: a `text` column (DDL identical to
 * `text(name)`) whose decoder is `storedIdSchema(kind)`, so the column's type is
 * `Id<P>` because that is what its decoder produces — it brands, it does not
 * validate: the database is the authority on the ids it already holds.
 *
 * `{ sqlDefault: true }` (uuid-shape kinds only) lets the DATABASE mint the id
 * — `'<prefix>-' || gen_random_uuid()` — for plumbing tables written by
 * `INSERT … DEFAULT` rather than through the kind's own `mint()`.
 */
export function idColumn<P extends string, S extends IdShape>(
  kind: IdKind<P, S>,
  opts?: { name?: string; sqlDefault?: S extends "uuid" ? boolean : never },
) {
  const column = parsedText(
    opts?.name ?? "id",
    storedIdSchema(kind),
  ).primaryKey();
  return opts?.sqlDefault
    ? column.default(sql.raw(`'${kind.prefix}-' || gen_random_uuid()`))
    : column;
}

/**
 * A foreign-key column holding a `kind` id. `onUpdate` defaults to `"cascade"`
 * — the one thing that lets a later rewrite of the parent's ids (prepending a
 * prefix to a legacy bare uuid) carry every child row along with it.
 */
export function idRef<P extends string, S extends IdShape>(
  kind: IdKind<P, S>,
  name: string,
  target: () => AnyPgColumn,
  opts: { onDelete: FkAction; onUpdate?: FkAction },
) {
  return parsedText(name, storedIdSchema(kind)).references(target, {
    onDelete: opts.onDelete,
    onUpdate: opts.onUpdate ?? "cascade",
  });
}

/**
 * A primary-key id column whose values are NOT minted here — Gmail message ids,
 * YouTube video ids, a natural key. `reason` says whose id it is; it exists to
 * be read by the next person, and by `ids:pk-declared`, which accepts exactly
 * four spellings of a table's `id` primary key: `idColumn`, `idKindField`, this,
 * and its field-record twin `externalIdField` (core).
 */
export function externalIdColumn(name: string, opts: { reason: string }) {
  const builder = text(name).primaryKey();
  // Recorded against the built column (the `withWire` technique): shadow
  // `build` on this one builder.
  const target = builder as unknown as { build: (table: unknown) => PgColumn };
  const build = target.build.bind(builder);
  target.build = (table) => {
    const column = build(table);
    externals.set(column, opts.reason);
    return column;
  };
  return builder;
}

const externals = new WeakMap<PgColumn, string>();

/** What a table's id column says it holds — read by `ids:pk-declared`. */
export type IdColumnDeclaration =
  | { kind: "id-kind"; idKind: AnyIdKind }
  | { kind: "external"; reason: string }
  | { kind: "undeclared" };

/**
 * Whether a built column was declared as an id: an `idColumn(kind)` /
 * `idKindField(kind)` column (its decoder is a kind's `storedIdSchema`), an
 * `externalIdColumn` / `externalIdField`, or neither. Read off the column itself, so a table
 * counts however it was spelled — a raw `pgTable` or a `defineEntity` whose
 * field record lives in another module.
 */
export function idColumnDeclaration(column: PgColumn): IdColumnDeclaration {
  const reason = externals.get(column);
  if (reason !== undefined) return { kind: "external", reason };
  const decoder = columnSchema(column);
  const externalReason = decoder ? externalReasonOfDecoder(decoder) : undefined;
  if (externalReason !== undefined)
    return { kind: "external", reason: externalReason };
  const idKind = decoder ? idKindOfDecoder(decoder) : undefined;
  return idKind ? { kind: "id-kind", idKind } : { kind: "undeclared" };
}
