import { useCallback, useMemo } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import {
  customColumnValues,
  setCustomColumnValue,
  deleteCustomColumnValues,
  type SetCustomColumnValueBody,
  type DeleteCustomColumnValuesBody,
} from "@plugins/primitives/plugins/data-view/plugins/custom-columns/plugins/values/core";

/** `Map<rowKey, Map<columnId, value>>` for O(1) per-cell reads. */
export type CustomColumnValueIndex = Map<string, Map<string, string>>;

/**
 * A surface's custom-column values, as a read: loading until the first value
 * lands, failed if it cannot load (the last index seen, if any, as `stale`),
 * then the settled index. A state, so "not loaded yet" can never be read as
 * "no cell has a value" — the caller decides what a cell shows meanwhile.
 */
export type CustomColumnValues = ResourceResult<CustomColumnValueIndex>;

function indexValues(
  rows: readonly { rowKey: string; columnId: string; value: string }[],
): CustomColumnValueIndex {
  const index: CustomColumnValueIndex = new Map();
  for (const row of rows) {
    let byColumn = index.get(row.rowKey);
    if (!byColumn) {
      byColumn = new Map();
      index.set(row.rowKey, byColumn);
    }
    byColumn.set(row.columnId, row.value);
  }
  return index;
}

/**
 * Subscribe to a surface's custom-column values and index them by
 * `(rowKey, columnId)`.
 */
export function useCustomColumnValues(dataViewId: string): CustomColumnValues {
  const result = useLive(customColumnValues, { dataViewId });
  return useMemo(() => mapResource(result, indexValues), [result]);
}

/** Upsert (or delete-on-empty) a single custom-column cell value. */
export function useSetCustomColumnValue(): (
  args: SetCustomColumnValueBody,
) => void {
  const { mutate } = useEndpointMutation(setCustomColumnValue);
  return useCallback((args) => mutate({ body: args }), [mutate]);
}

/** Delete every per-row value for one column across a surface (column removal). */
export function useDeleteCustomColumnValues(): (
  args: DeleteCustomColumnValuesBody,
) => void {
  const { mutate } = useEndpointMutation(deleteCustomColumnValues);
  return useCallback((args) => mutate({ body: args }), [mutate]);
}
