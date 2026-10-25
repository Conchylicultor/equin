import { createContext, useContext, useMemo } from "react";
import {
  extentOf,
  type FieldCellContext,
  type FieldExtent,
} from "@plugins/network/plugins/live/core";
import type { FieldDef } from "../../core";

// The extents of a view's `extent: true` fields (`FieldDef.extent`), computed
// ONCE per view by the body over the rows it hands the view, and read by
// every `FieldCell` of such a field. A schema with no such field costs one
// `some` per render: no row is visited.

/** Field id → its extent over the view's rows (`null`: no row holds a number). */
export type FieldExtents = ReadonlyMap<string, FieldExtent | null>;

const NONE: FieldExtents = new Map();

/** The extents of `fields`' `extent: true` fields over `rows`. */
export function computeFieldExtents(
  rows: readonly unknown[],
  fields: readonly FieldDef<unknown>[],
): FieldExtents {
  const asking = fields.filter((f) => f.extent === true);
  if (asking.length === 0) return NONE;
  return new Map(
    asking.map((f) => {
      const value = f.value;
      if (value === undefined) {
        throw new Error(
          `data-view: field "${f.id}" declares \`extent: true\` but has no \`value\` — an extent is the range of its numeric values`,
        );
      }
      return [f.id, extentOf(rows.map((row) => value(row)))];
    }),
  );
}

/** {@link computeFieldExtents}, memoized on its inputs. */
export function useFieldExtents(
  rows: readonly unknown[],
  fields: readonly FieldDef<unknown>[],
): FieldExtents {
  return useMemo(() => computeFieldExtents(rows, fields), [rows, fields]);
}

/** Provided by the body around its view. Outside one (a lone cell), none. */
export const FieldExtentsContext = createContext<FieldExtents>(NONE);

const NO_EXTENT: FieldCellContext = { extent: null };

/**
 * The context a field's cell is handed: its extent when it declares
 * `extent: true` (from the enclosing view), else none. One constant object
 * for every other field, so it costs them nothing.
 */
export function useFieldCellContext(
  field: FieldDef<unknown>,
): FieldCellContext {
  const extents = useContext(FieldExtentsContext);
  const extent = field.extent === true ? (extents.get(field.id) ?? null) : null;
  return useMemo(() => (extent === null ? NO_EXTENT : { extent }), [extent]);
}
