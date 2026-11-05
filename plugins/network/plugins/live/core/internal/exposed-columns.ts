import type { EntityExposure } from "@plugins/infra/plugins/entity-extensions/core";
import type {
  FilterColumn,
  Filterable,
} from "@plugins/network/plugins/live/plugins/filter/core";
import type { LiveColumnRef } from "./column-ref";
import {
  schemaDomain,
  type DomainOfValue,
  type OperandOfValue,
} from "./field-domain";
import type { LiveRowSchema } from "./live-collection";
import {
  typedColumns,
  type ContributedColumns,
  type LiveColumnsDeclaration,
  type WireFilterable,
  type WireSortable,
} from "./live-columns";

// Exposed columns: an entity extension's exposed fields
// (`defineExtensionShape({ exposes })`, entity-extensions) as a column set —
// read by EVERY collection whose `exposes` reaches the exposure's parent
// entity, never named by one. Its name is the exposure's slice (the
// extension's table name, `tasks_ext_track`), so its wire names are
// `<slice>.<field>` and its rows carry it under `$columns[<slice>]`. Every
// exposed field with a filter domain filters in it (`./field-domain` — the one
// derivation every live field shares, read off its wire schema) and sorts,
// but a string array; a groupable one (text / number / boolean) groups on the
// server like a collection's own column. A field with no domain (a JSON
// value) is carried and shown, never filtered or sorted.

/**
 * An exposed slice's filterable fields — each with a filter domain, read off
 * its wire value as `exposedColumns` reads it off the wire schema at runtime
 * (`./field-domain`, the one derivation).
 */
export type ExposedFilterable<R> = {
  readonly [
    K in keyof R as [DomainOfValue<NonNullable<R[K]>>] extends [never]
      ? never
      : K
  ]: FilterColumn<
    DomainOfValue<NonNullable<R[K]>>,
    OperandOfValue<NonNullable<R[K]>>
  >;
};

/** An exposed slice's sortable fields — every filterable one but a string array. */
export type ExposedSortable<R> = {
  [K in keyof ExposedFilterable<R> & string]: DomainOfValue<
    NonNullable<R[K]>
  > extends "stringArray"
    ? never
    : K;
}[keyof ExposedFilterable<R> & string];

/**
 * An exposure's wire filter vocabulary — open (any wire name) for an erased
 * exposure (`LiveExposedColumns` over any row), whose fields are not known
 * statically.
 */
type ExposedWireFilterable<R, Sl extends string> = string extends keyof R
  ? Filterable
  : WireFilterable<Sl, ExposedFilterable<R>>;

/** An exposure's sortable wire names — any for an erased exposure. */
type ExposedWireSortable<R, Sl extends string> = string extends keyof R
  ? string
  : WireSortable<Sl, ExposedSortable<R>>;

/**
 * An exposure as a column set (see {@link exposedColumns}). Its wire
 * vocabulary is typed from the exposure (`Sl` its literal slice), so a query
 * bringing it may name `<slice>.<field>` in `where` / `orderBy` like an own
 * column.
 */
export interface LiveExposedColumns<
  R extends Record<string, unknown> = Record<string, unknown>,
  Sl extends string = string,
> extends LiveColumnsDeclaration<
  ExposedWireFilterable<R, Sl>,
  ExposedWireSortable<R, Sl>
> {
  readonly owner: { readonly kind: "exposed"; readonly entity: string };
  /** The exposure it is built from (labels, options, `absent`). */
  readonly exposure: EntityExposure<R, Sl>;
  /** The slice's row schema, parsed by `read`. */
  readonly row: LiveRowSchema<R>;
  readonly fields: readonly (keyof R & string)[];
  /** A column ref a list binds a field to (`FieldDef.column`), carrying this set. */
  column(field: keyof R & string): LiveColumnRef;
  /**
   * This exposure's slice of a row, parsed (once per row object). Throws on a
   * row carrying no slice for it — a collection that does not reach the
   * entity, or whose server half did not fold the exposure.
   */
  read(row: { readonly $columns: ContributedColumns }): R;
}

const memo = new WeakMap<EntityExposure, LiveExposedColumns>();

/**
 * An exposure's column set — one object per exposure (memoized), so a codec
 * keyed on the set it is handed sees one set.
 */
export function exposedColumns<
  R extends Record<string, unknown>,
  Sl extends string,
>(exposure: EntityExposure<R, Sl>): LiveExposedColumns<R, Sl> {
  const known = memo.get(exposure as EntityExposure);
  if (known !== undefined) return known as unknown as LiveExposedColumns<R, Sl>;
  const fail = (message: string): never => {
    throw new Error(`exposedColumns("${exposure.slice}"): ${message}`);
  };
  const filterable: Record<string, FilterColumn> = {};
  const sortable: string[] = [];
  const order: Record<string, readonly string[]> = {};
  for (const [field, f] of Object.entries(exposure.fields)) {
    const domain = schemaDomain(f.wire);
    if (domain === null) continue;
    filterable[field] = { domain } as FilterColumn;
    if (domain !== "stringArray") {
      sortable.push(field);
      if (f.order !== null) order[field] = f.order;
    }
  }
  const owner = { kind: "exposed", entity: exposure.parent.name } as const;
  // The runtime derivation (`schemaDomain` over each wire schema) is the
  // type-level one (`ExposedFilterable`) read off the same fact.
  const parts = typedColumns(
    owner,
    exposure.slice,
    {
      row: exposure.row,
      filterable: filterable as unknown as ExposedFilterable<R>,
      sortable: sortable as ExposedSortable<R>[],
      order,
    },
    fail,
    () => handle,
  );
  const parsed = new WeakMap<object, R>();
  const handle: LiveExposedColumns<R, Sl> = {
    ...parts,
    owner,
    exposure,
    read: (row) => {
      const cached = parsed.get(row);
      if (cached !== undefined) return cached;
      const slice = row.$columns[exposure.slice];
      if (slice === undefined) {
        return fail(
          `the row carries no "${exposure.slice}" slice under \`$columns\` — does its collection's \`exposes\` reach "${exposure.parent.name}", and is the extension served (\`LiveColumns.Expose\`)?`,
        );
      }
      const value = exposure.row.parse(slice);
      parsed.set(row, value);
      return value;
    },
  };
  memo.set(exposure as EntityExposure, handle as unknown as LiveExposedColumns);
  return handle;
}
