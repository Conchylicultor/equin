import type { ReactNode } from "react";
import type { LiveCollection } from "@plugins/network/plugins/live/core";
import {
  foldResource,
  ResourceErrorInline,
  type ResourceResult,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  PARENT_FIELD_ID,
  type FieldDef,
  type HierarchyConfig,
  type LiveTreeSpec,
} from "../../core";
import { pickPrimaryField } from "./pick-primary-field";
import { rowRead } from "./row-reads";

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
  assertParentFieldFree(fields);
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
 * The Parent field of a LIVE tree drawn flat: the parent is mostly not
 * loaded, so it is a per-row read (`rowRead`, a collection row) — the rows on
 * screen read their parents by id in one `{ ids }` read, each cell drawing its
 * parent's label (the primary field), loading while it is not known. Display
 * only: it has no column, so it neither sorts, filters nor groups.
 */
export function withLiveParentField<TRow>(
  fields: FieldDef<TRow>[],
  collection: LiveCollection<unknown, unknown, string>,
  tree: LiveTreeSpec,
): FieldDef<TRow>[] {
  assertParentFieldFree(fields);
  const primary = pickPrimaryField(fields);
  const parentOf = (row: TRow): string | null => {
    const p = (row as Record<string, unknown>)[tree.parent];
    return p === null || p === undefined || p === "" ? null : String(p);
  };
  const label = (parent: TRow, id: string): string => {
    const v = primary?.value?.(parent);
    return v == null || v === "" ? id : String(v);
  };
  const parent: FieldDef<TRow> = {
    id: PARENT_FIELD_ID,
    label: "Parent",
    type: "text",
    rowRead: rowRead({
      collection: collection as LiveCollection<TRow, unknown, string>,
      id: parentOf,
      cell: (
        row: TRow,
        read: ResourceResult<TRow | null> | undefined,
      ): ReactNode => {
        const id = parentOf(row);
        // A root has no parent: nothing to read, nothing to draw.
        if (id === null) return null;
        // Off screen: not read yet.
        if (read === undefined) return PENDING_PARENT;
        return foldResource(read, {
          // Not in the collection (its served `where`): its id still names it.
          ready: (p) => (p === null ? id : label(p, id)),
          loading: () => PENDING_PARENT,
          error: (error, stale) =>
            stale != null ? (
              label(stale, id)
            ) : (
              <ResourceErrorInline
                variant="icon"
                error={error}
                refetch={read.refetch}
                subject="this row's parent"
              />
            ),
        });
      },
    }),
  };
  return [...fields, parent];
}

const PENDING_PARENT = <Loading variant="block" className="h-3 w-16" />;

function assertParentFieldFree<TRow>(fields: readonly FieldDef<TRow>[]): void {
  if (fields.some((f) => f.id === PARENT_FIELD_ID)) {
    throw new Error(
      `DataView: field id "${PARENT_FIELD_ID}" is reserved for the derived Parent ` +
        "field of a hierarchical source; rename the consumer's field.",
    );
  }
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
