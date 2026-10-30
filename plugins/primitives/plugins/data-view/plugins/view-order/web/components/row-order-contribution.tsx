import { useMemo, type ReactNode } from "react";
import type { ManualOrderConfig } from "@plugins/primitives/plugins/data-view/core";
import type { GlobalRowOrderProps } from "@plugins/primitives/plugins/data-view/web";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import type { Rank } from "@plugins/primitives/plugins/rank/core";
import { seedRanks, computeMoveWrites, computeInsertWrites } from "../../core";
import { useRowOrder, useSetRowOrder } from "../internal/use-row-order";

/**
 * Global row-order contribution: turns the persisted `(dataViewId, viewId)` rank
 * rows into the `ManualOrderConfig` the host hands to the active view, so every
 * eligible DataView becomes drag-reorderable with zero per-consumer wiring.
 *
 * The order is a property of the **view instance**, not of the data — two view
 * instances over the same rows hold different orders, which is why `viewId` is
 * part of the key.
 */
export function RowOrderContribution({
  storageKey,
  viewId,
  rowKey,
  rows,
  render,
}: GlobalRowOrderProps): ReactNode {
  const order = useRowOrder(storageKey, viewId);
  const setRowOrder = useSetRowOrder();

  // `rowKey` is an inline arrow at the consumer's call site (new identity every
  // render). Left raw it would re-key every memo below on every render, and
  // `useDataViewSections` — which memoizes on `manualRank`'s identity — would
  // re-sort the sections forever. `useEventCallback` gives it a stable identity
  // that always dispatches to the latest `rowKey`, so the memos below key on the
  // data (`rows`, `order`) rather than on a closure's identity.
  //
  // Deliberately NOT `useLatestRef` (custom-columns' choice): that hands back a
  // ref, and unlike custom-columns — which only *captures* `rowKeyRef` inside
  // lazily-invoked `FieldDef.value` closures — we must call the projection during
  // render to build `orderedKeys`. Reading `ref.current` there is exactly what
  // `react-hooks/refs` forbids.
  const stableRowKey = useEventCallback(rowKey);

  // Always `rowKey(row, 0)`: `FieldDef.value` gets no index, so a surface whose
  // row keys are index-derived cannot persist an order (its keys would shift
  // under the very reorder they encode). Identical documented edge case as
  // custom-columns; every DataView in the repo passes an id-derived `rowKey`.
  const orderedKeys = useMemo(
    () => rows.map((row) => stableRowKey(row, 0)),
    [rows, stableRowKey],
  );

  // Never render a half-order: until the first value lands there is no
  // persisted order to seed from, so the contributor abstains (`null`) —
  // seeding would show pure source order, and a drag would persist it as if it
  // were the user's arrangement. A failed read keeps the last order seen; with
  // none, it abstains the same way.
  const config = useMemo<ManualOrderConfig<unknown> | null>(() => {
    const persisted = foldResource(order, {
      loading: () => undefined,
      error: (_error, stale) => stale,
      ready: (data) => data,
    });
    if (persisted === undefined) return null;
    const rankByKey = seedRanks(orderedKeys, persisted);

    const getRank = (row: unknown): Rank | null =>
      rankByKey.get(stableRowKey(row, 0)) ?? null;

    const onMove = (
      id: string,
      dest: { targetId?: string; zone?: "before" | "after" },
    ) => {
      // Deliberately ignore `dest.rank`. `RankReorderProvider` computes it
      // against the RENDERED items, which under an active search is a subset of
      // the view's ordered set — a rank between two visible neighbours can land
      // on the wrong side of a hidden row. `computeMoveWrites` re-derives the
      // display order from `orderedKeys` (source order) + `persisted` and mints
      // the ranks itself — the server cannot reproduce seeds, so ranks are
      // client-minted here (precedent: `computeFlatReorder`).
      if (!dest.targetId || !dest.zone) {
        throw new Error(
          "view-order: onMove requires neighbour coordinates (dest.targetId / dest.zone)",
        );
      }
      const writes = computeMoveWrites({
        orderedKeys,
        persisted,
        id,
        targetId: dest.targetId,
        zone: dest.zone,
      });
      if (writes === null) {
        throw new Error(
          `view-order: onMove got a row outside the ordered set (id=${id}, targetId=${dest.targetId})`,
        );
      }
      if (writes.length === 0) return; // legitimate no-op (onto itself / adjacent)
      // Returned so a failed write releases the DataView's pending-move overlay.
      return setRowOrder({ dataViewId: storageKey, viewId, writes });
    };

    // A drop from elsewhere (`rowDrop` under `placement: "between"`): the keys
    // may name rows the consumer has not created yet — they take their ranks
    // now, so the rows render in the gap they were dropped in once they land.
    const onInsert = async (
      keys: readonly string[],
      dest: { targetId: string; zone: "before" | "after" },
    ): Promise<void> => {
      const writes = computeInsertWrites({
        orderedKeys,
        persisted,
        keys,
        targetId: dest.targetId,
        zone: dest.zone,
      });
      if (writes === null) {
        throw new Error(
          `view-order: onInsert anchored on a row outside the ordered set (targetId=${dest.targetId})`,
        );
      }
      if (writes.length === 0) return; // legitimate no-op
      await setRowOrder({ dataViewId: storageKey, viewId, writes });
    };

    return { getRank, onMove, onInsert };
  }, [order, orderedKeys, stableRowKey, setRowOrder, storageKey, viewId]);

  return <>{render(config)}</>;
}
