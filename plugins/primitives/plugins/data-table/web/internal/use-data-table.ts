import { useCallback, useMemo, useState } from "react";
import type { ColumnDef } from "./types";

export interface SortState {
  columnId: string;
  direction: "asc" | "desc";
}

export function useDataTable<TRow>(
  data: readonly TRow[],
  columns: ColumnDef<TRow>[],
  filter: string | undefined,
  controlledSort?: SortState | null,
  onToggleSort?: (columnId: string) => void,
  /**
   * The rows are already in their final order (a flattened tree, in paint
   * order): the sort state still drives the header arrows, but nothing
   * reorders or filters `data`.
   */
  keepOrder = false,
) {
  const [internalSort, setInternalSort] = useState<SortState | null>(null);

  const isControlled = onToggleSort !== undefined;
  const sortState = isControlled ? (controlledSort ?? null) : internalSort;

  const toggleSort = useCallback(
    (columnId: string) => {
      if (onToggleSort) {
        onToggleSort(columnId);
        return;
      }
      setInternalSort((prev) => {
        if (prev?.columnId !== columnId) return { columnId, direction: "asc" };
        if (prev.direction === "asc") return { columnId, direction: "desc" };
        return null;
      });
    },
    [onToggleSort],
  );

  const rows = useMemo(() => {
    if (keepOrder) return data;
    let result = [...data];

    if (filter) {
      const lc = filter.toLowerCase();
      const valueFns = columns.filter((c) => c.value).map((c) => c.value!);
      result = result.filter((row) =>
        valueFns.some((fn) =>
          String(fn(row) ?? "")
            .toLowerCase()
            .includes(lc),
        ),
      );
    }

    if (sortState) {
      const col = columns.find((c) => c.id === sortState.columnId);
      if (col?.value) {
        const valueFn = col.value;
        result.sort((a, b) => {
          const va = valueFn(a);
          const vb = valueFn(b);
          const cmp =
            typeof va === "number" && typeof vb === "number"
              ? va - vb
              : String(va ?? "").localeCompare(String(vb ?? ""));
          return sortState.direction === "desc" ? -cmp : cmp;
        });
      }
    }

    return result;
  }, [data, columns, filter, sortState, keepOrder]);

  return { rows, sortState, toggleSort };
}
