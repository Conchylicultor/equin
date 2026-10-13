import { useMemo } from "react";
import { exposedColumns } from "@plugins/network/plugins/live/core";
import { useExposures } from "@plugins/network/plugins/live/web";
import type {
  DataViewRowsCollection,
  FieldDef,
  FieldOption,
  FieldValue,
} from "../../core";

// The exposed fields of a list (`network/live` CLAUDE.md, "Exposed fields"):
// every field an entity extension exposes, for every entity the list's
// collection reaches — derived here once, so no list names an extension and no
// extension names a list. Under a live source a field binds to its exposed
// column (the server sorts, filters and groups by it); over in-memory rows it
// reads the same `$columns` slice and filters in memory.

/**
 * The exposed fields `collection` reaches, in registration then declaration
 * order: id the bare field key (what a saved view names), the exposure's label
 * and options (an `enum` field when it declares options, else its field type),
 * the value read off the row's `$columns`, the registration's cell / width /
 * align — and, under a live source (`live`), the column it lowers to.
 */
export function useExposedFields(
  collection: DataViewRowsCollection | undefined,
  live: boolean,
): FieldDef<unknown>[] {
  const registrations = useExposures();
  return useMemo(() => {
    const reached = new Set(
      Object.values(collection?.exposes ?? {}).map((ref) => ref.name),
    );
    const out: FieldDef<unknown>[] = [];
    for (const { exposure, present } of registrations) {
      if (!reached.has(exposure.parent.name)) continue;
      const columns = exposedColumns(exposure);
      const read = (row: unknown) =>
        columns.read(row as Parameters<typeof columns.read>[0]);
      for (const [id, field] of Object.entries(exposure.fields)) {
        const shown = present?.[id];
        const cell = shown?.cell;
        const options: FieldOption[] | undefined =
          field.options === null
            ? undefined
            : Object.entries(field.options).map(([value, o]) => ({
                value,
                label: o.label,
                ...(o.variant !== undefined ? { variant: o.variant } : {}),
                ...(o.hint !== undefined ? { hint: o.hint } : {}),
              }));
        out.push({
          id,
          label: field.label,
          type: options !== undefined ? "enum" : field.typeId,
          ...(options !== undefined ? { options } : {}),
          value: (row) => read(row)[id] as FieldValue,
          ...(cell !== undefined ? { cell: (row) => cell(read(row)[id]) } : {}),
          ...(shown?.width !== undefined ? { width: shown.width } : {}),
          ...(shown?.align !== undefined ? { align: shown.align } : {}),
          ...(live ? { column: columns.column(id) } : {}),
        });
      }
    }
    return out;
  }, [registrations, collection, live]);
}

/**
 * The host's schema with the exposed fields appended — throws on a field id
 * the host and an exposure (or two exposures) both use: one id, one field, or
 * a saved view's rule could mean either.
 */
export function withExposedFields(
  fields: readonly FieldDef<unknown>[],
  exposed: readonly FieldDef<unknown>[],
  collectionKey: string | undefined,
): FieldDef<unknown>[] {
  if (exposed.length === 0) return fields as FieldDef<unknown>[];
  const seen = new Set(fields.map((f) => f.id));
  for (const field of exposed) {
    if (seen.has(field.id)) {
      throw new Error(
        `data-view: field "${field.id}" is exposed by an extension that "${collectionKey}" reaches, and is also declared by the list or another exposure — one id, one field.`,
      );
    }
    seen.add(field.id);
  }
  return [...fields, ...exposed];
}
