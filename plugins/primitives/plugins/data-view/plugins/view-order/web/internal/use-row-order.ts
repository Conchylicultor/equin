import { useCallback, useMemo } from "react";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import type { Rank } from "@plugins/primitives/plugins/rank/core";
import { rowOrder, setRowOrder, type SetRowOrderBody } from "../../core";

/**
 * One view instance's persisted row order, as a read: loading until the first
 * value lands, failed if it cannot load (the last map seen, if any, as
 * `stale`), then the settled `rowKey → Rank` map, rank-ascending (the value's
 * own order). A state, so "no order loaded yet" can never be read as "this view
 * has genuinely never been reordered" — the two must render differently (defer
 * vs. seed-everything), and only the settled arm HAS a map.
 */
export type RowOrderState = ResourceResult<Map<string, Rank>>;

/** Subscribe to one view instance's persisted row order. */
export function useRowOrder(dataViewId: string, viewId: string): RowOrderState {
  const result = useLive(rowOrder, { dataViewId, viewId });
  return useMemo(
    () =>
      mapResource(
        result,
        (rows) => new Map(rows.map((row) => [row.rowKey, row.rank])),
      ),
    [result],
  );
}

/**
 * Upsert a view instance's bounded row-order write set (the moved row + seeds).
 * Resolves once the write lands and rejects when it fails (after the mutation's
 * own error toast), so the DataView's pending-move overlay can release the row.
 */
export function useSetRowOrder(): (args: SetRowOrderBody) => Promise<void> {
  const { mutateAsync } = useEndpointMutation(setRowOrder);
  return useCallback(
    async (args) => {
      await mutateAsync({ body: args });
    },
    [mutateAsync],
  );
}
