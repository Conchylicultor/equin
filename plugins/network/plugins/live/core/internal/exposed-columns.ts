import type { EntityExposure } from "@plugins/infra/plugins/entity-extensions/core";
import type { FilterColumn } from "@plugins/network/plugins/live/plugins/filter/core";
import type { LiveColumnRef } from "./column-ref";
import { schemaDomain } from "./field-domain";
import type { LiveRowSchema } from "./live-collection";
import {
  typedColumns,
  type ContributedColumns,
  type LiveColumnsDeclaration,
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

/** An exposure as a column set (see {@link exposedColumns}). */
export interface LiveExposedColumns<
  R extends Record<string, unknown> = Record<string, unknown>,
> extends LiveColumnsDeclaration {
  readonly owner: { readonly kind: "exposed"; readonly entity: string };
  /** The exposure it is built from (labels, options, `absent`). */
  readonly exposure: EntityExposure<R>;
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
export function exposedColumns<R extends Record<string, unknown>>(
  exposure: EntityExposure<R>,
): LiveExposedColumns<R> {
  const known = memo.get(exposure as EntityExposure);
  if (known !== undefined) return known as unknown as LiveExposedColumns<R>;
  const fail = (message: string): never => {
    throw new Error(`exposedColumns("${exposure.slice}"): ${message}`);
  };
  const filterable: Record<string, FilterColumn> = {};
  const sortable: string[] = [];
  for (const [field, f] of Object.entries(exposure.fields)) {
    const domain = schemaDomain(f.wire);
    if (domain === null) continue;
    filterable[field] = { domain } as FilterColumn;
    if (domain !== "stringArray") sortable.push(field);
  }
  const owner = { kind: "exposed", entity: exposure.parent.name } as const;
  const parts = typedColumns<R, Record<string, FilterColumn>, string>(
    owner,
    exposure.slice,
    { row: exposure.row, filterable, sortable },
    fail,
    () => handle,
  );
  const parsed = new WeakMap<object, R>();
  const handle: LiveExposedColumns<R> = {
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
  memo.set(exposure as EntityExposure, handle as LiveExposedColumns);
  return handle;
}
