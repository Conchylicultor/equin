import {
  PARENT_FIELD_ID,
  type FieldDef,
  type HierarchyConfig,
} from "../../core";
import { pickPrimaryField } from "./pick-primary-field";

/**
 * A hierarchical source drawn by a view that does not nest it (`nesting`
 * `flat`, or a view type that never nests). Two pure halves the host body
 * applies: the derived Parent field (`flat`), and the `roots` row narrowing.
 */

/**
 * The schema plus the host-derived Parent field: each row's parent's label
 * (the parent's primary field, picked over `fields` BEFORE the Parent field is
 * added, so it never labels by itself), `null` for a top-level row. A text
 * field, so it sorts, filters, groups and searches like any other. Throws when
 * a consumer field already claims the reserved id — shadowing it either way
 * would silently drop one of them.
 */
export function withParentField<TRow>(
  fields: FieldDef<TRow>[],
  rows: readonly TRow[],
  rowKey: (row: TRow, index: number) => string,
  hierarchy: HierarchyConfig<TRow>,
): FieldDef<TRow>[] {
  if (fields.some((f) => f.id === PARENT_FIELD_ID)) {
    throw new Error(
      `DataView: field id "${PARENT_FIELD_ID}" is reserved for the derived Parent ` +
        "field of a hierarchical source; rename the consumer's field.",
    );
  }
  const primary = pickPrimaryField(fields);
  const byKey = new Map<string, TRow>();
  rows.forEach((row, i) => byKey.set(rowKey(row, i), row));
  const parent: FieldDef<TRow> = {
    id: PARENT_FIELD_ID,
    label: "Parent",
    type: "text",
    groupable: true,
    value: (row) => {
      const pid = hierarchy.getParentId(row);
      if (pid == null) return null;
      const p = byKey.get(pid);
      // A parent outside the loaded rows still has an id worth showing.
      if (p === undefined) return pid;
      const label = primary?.value?.(p);
      return label == null || label === "" ? pid : String(label);
    },
  };
  return [...fields, parent];
}

/**
 * The top-level rows of a hierarchy — `nesting: "roots"`: a row whose parent is
 * `null` or absent from `rows` (the tree's orphan rule, so a child whose parent
 * is not loaded is one).
 */
export function rootRows<TRow>(
  rows: readonly TRow[],
  rowKey: (row: TRow, index: number) => string,
  hierarchy: HierarchyConfig<TRow>,
): readonly TRow[] {
  const keys = new Set(rows.map((row, i) => rowKey(row, i)));
  return rows.filter((row) => {
    const pid = hierarchy.getParentId(row);
    return pid == null || !keys.has(pid);
  });
}
