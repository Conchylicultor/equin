import { useLayoutEffect, useMemo, type ReactNode } from "react";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import { renderIsolated } from "@plugins/primitives/plugins/slot-render/web";
import type {
  DataViewId,
  FieldDef,
  FilterOperatorSet,
  ManualOrderConfig,
  ViewState,
} from "../../core";
import { useFlatRows } from "./use-flat-rows";
import { DataViewSlots, type GlobalRowOrderProps } from "../slots";

/** What the reader reports: the order the contributors resolved for `viewId`. */
export interface ReportedRowOrder {
  viewId: string;
  order: ManualOrderConfig<unknown> | null;
}

/**
 * Host fold for the global `DataViewSlots.RowOrder` slot — the row-order twin of
 * `CollectFieldExtensions`. Reads the slot's contributions and **recursively**
 * mounts each one, threading the accumulated order through nested
 * render-callbacks: every contributor mounts (running its own hooks), hands back
 * a `ManualOrderConfig` (or `null` to abstain) via `render`, and that recurses to
 * the next contributor — finally REPORTING the order up through `onOrder`.
 *
 * It is a reader that renders nothing, mounted BESIDE the surface, never around
 * it (the `FacetRead` pattern): the contributors are not ancestors of the
 * band, the aside or the view, so a view switch that turns the fold on or off
 * (gallery → list) changes no element above the surface and remounts nothing
 * — not the aside's state, not an overlay surface's backdrop (a map's camera).
 * The report is a layout effect, so the host re-renders with the order before
 * the browser paints: no frame shows the view without it. On unmount (the fold
 * turned off, the view switched) it reports `null` for its view.
 *
 * Unlike the field fold it does not accumulate a list: it folds a single
 * `ManualOrderConfig | null`, and **the first non-null wins** (`acc ?? order`).
 * The slot is a `defineRenderSlot`, so that precedence is a committed reorder
 * override rather than an import-order accident.
 *
 * Written as a recursive COMPONENT, never a `.map` over contributed hooks:
 * mounting each contributor as its own React element keeps the per-component hook
 * order stable (the contribution set is fixed at build time → recursion depth is
 * stable → `react-hooks/rules-of-hooks` is satisfied).
 *
 * `enabled: false` short-circuits **before** `useContributions()` AND before the
 * ordered set is derived — so a DataView that cannot use a row order (a
 * tree/gallery view, a live `source` surface, an aggregated view, or one
 * whose consumer already owns a domain order) never mounts a contributor, never
 * subscribes to its live resource, and never pays for a filter pass it discards.
 * That is why the fold takes the RAW rows plus the pipeline's ingredients rather
 * than a pre-computed ordered set: deriving it in the host would cost every
 * DataView an extra `useFlatRows` on every render.
 */
export function RowOrderReader(props: {
  enabled: boolean;
  storageKey: DataViewId;
  viewId: string;
  rowKey: (row: unknown, index: number) => string;
  /** RAW rows — the fold derives the ordered set itself, only when enabled. */
  rows: readonly unknown[];
  fields: FieldDef<unknown>[];
  /** The active view's state; only its `filter` reaches the ordered set. */
  state: ViewState;
  resolveOperatorSet: (typeId: string) => FilterOperatorSet | undefined;
  searchAccessor?: (row: unknown) => string;
  /** Receives the resolved order (stable identity: it is called in effects). */
  onOrder: (reported: ReportedRowOrder) => void;
}): ReactNode {
  const { enabled, onOrder, ...rest } = props;
  if (!enabled) return null;
  return (
    <RowOrderFold
      {...rest}
      emit={(order) => (
        <ReportOrder viewId={rest.viewId} order={order} onOrder={onOrder} />
      )}
    />
  );
}

/** The fold's base case: hands the resolved order up (renders nothing). */
function ReportOrder(
  props: ReportedRowOrder & {
    onOrder: (reported: ReportedRowOrder) => void;
  },
): ReactNode {
  const { viewId, order, onOrder } = props;
  useLayoutEffect(() => {
    onOrder({ viewId, order });
    return () => onOrder({ viewId, order: null });
  }, [viewId, order, onOrder]);
  return null;
}

/** Surface coordinates every fold level threads through to each contributor. */
interface RowOrderSurface {
  storageKey: DataViewId;
  viewId: string;
  rowKey: (row: unknown, index: number) => string;
  rows: readonly unknown[];
}

type RowOrderContributions = ReturnType<
  typeof DataViewSlots.RowOrder.useContributions
>;

/**
 * Derives the view's **ordered set** — filter-applied, search-EXCLUDED,
 * sort-suppressed — then reads `useContributions()` once and kicks off the fold.
 *
 * Search only changes what is *rendered*, so excluding it keeps a drag under an
 * active search rebuilding the full order (no hidden row is dropped). Suppressing
 * the sort is what makes the set "the order a contributor's rank must describe".
 * Rows the filter excludes never enter the set, so they never receive a rank.
 */
function RowOrderFold(
  props: Omit<RowOrderSurface, "rows"> & {
    rows: readonly unknown[];
    fields: FieldDef<unknown>[];
    state: ViewState;
    resolveOperatorSet: (typeId: string) => FilterOperatorSet | undefined;
    searchAccessor?: (row: unknown) => string;
    emit: (order: ManualOrderConfig<unknown> | null) => ReactNode;
  },
): ReactNode {
  const {
    rows,
    fields,
    state,
    resolveOperatorSet,
    searchAccessor,
    emit,
    ...ids
  } = props;
  // Only `filter` survives into the ordered set (sort and search are excluded
  // by contract), so key the memo on it alone — a change to the view's sort or
  // query must not rebuild the ordered set.
  const orderedState = useMemo<ViewState>(
    () => ({ sort: [], query: "", filter: state.filter }),
    [state.filter],
  );
  const orderedRows = useFlatRows<unknown>(
    rows,
    fields,
    orderedState,
    resolveOperatorSet,
    searchAccessor,
  );
  const contributions = DataViewSlots.RowOrder.useContributions();
  return (
    <RowOrderStep
      {...ids}
      rows={orderedRows}
      contributions={contributions}
      index={0}
      acc={null}
      emit={emit}
    />
  );
}

/** One fold level: mount contribution `index` isolated; its `render` recurses to
 *  the next level carrying the first non-null order seen so far. Base case →
 *  emit the resolved order (possibly `null` — nobody claimed it). */
function RowOrderStep(
  props: RowOrderSurface & {
    contributions: RowOrderContributions;
    index: number;
    acc: ManualOrderConfig<unknown> | null;
    emit: (order: ManualOrderConfig<unknown> | null) => ReactNode;
  },
): ReactNode {
  const { contributions, index, acc, emit, ...surface } = props;
  // Every contributor has mounted and had its chance to claim the order → emit.
  if (index >= contributions.length) return <>{emit(acc)}</>;

  const contribution = contributions[index]!;
  const renderProps: GlobalRowOrderProps = {
    ...surface,
    render: (order) => (
      <RowOrderStep
        {...surface}
        contributions={contributions}
        index={index + 1}
        // First non-null wins: an earlier contributor's order is never displaced.
        acc={acc ?? order}
        emit={emit}
      />
    ),
  };
  // `renderIsolated` unseals the contribution's component and wraps it in the
  // error-boundary item middleware, so a broken contributor never crashes the
  // whole DataView (and never poisons the resolved order).
  return renderIsolated(
    DataViewSlots.RowOrder,
    contribution as unknown as Contribution,
    renderProps,
  );
}
