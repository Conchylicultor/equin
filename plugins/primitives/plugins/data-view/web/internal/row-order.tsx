import { useLayoutEffect, useMemo, type ReactNode } from "react";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import {
  renderIsolated,
  useSlotOrder,
} from "@plugins/primitives/plugins/slot-render/web";
import type {
  DataViewId,
  FieldDef,
  FilterOperatorSet,
  ManualOrderConfig,
  ViewState,
} from "../../core";
import { useFlatRows } from "./use-flat-rows";
import { slotLayout, type SlotLayoutFailure } from "./slot-layout";
import { DataViewSlots, type GlobalRowOrderProps } from "../slots";

/**
 * Where the fold stands for `viewId`: `known` — the order the contributors
 * resolved (`null`: nobody claimed it); `pending` — not known yet (the slot's
 * layout is still loading, or the fold has not reported since it mounted), so
 * the host shows its loading state rather than the rows in an order that then
 * jumps; `failed` — the slot's layout failed with none ever known.
 */
export type RowOrderState =
  | { state: "pending" }
  | { state: "known"; order: ManualOrderConfig<unknown> | null }
  | { state: "failed"; failure: SlotLayoutFailure };

/** What the reader reports: where the fold stands for `viewId`. */
export type ReportedRowOrder = RowOrderState & { viewId: string };

const PENDING: RowOrderState = { state: "pending" };

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
      emit={(report) => (
        <ReportOrder viewId={rest.viewId} report={report} onOrder={onOrder} />
      )}
    />
  );
}

/** The fold's base case: hands where it stands up (renders nothing). On
 *  unmount the order is no longer known for its view: `pending`. Keyed on the
 *  report's FIELDS, never on its object — a fold level builds a new one per
 *  render (the host's `sameReport` keeps its state when nothing changed). */
function ReportOrder(props: {
  viewId: string;
  report: RowOrderState;
  onOrder: (reported: ReportedRowOrder) => void;
}): ReactNode {
  const { viewId, report, onOrder } = props;
  const { state } = report;
  const order = report.state === "known" ? report.order : null;
  const failure = report.state === "failed" ? report.failure : null;
  useLayoutEffect(() => {
    onOrder(
      state === "known"
        ? { viewId, state, order }
        : state === "failed" && failure !== null
          ? { viewId, state, failure }
          : { viewId, state: "pending" },
    );
    return () => onOrder({ viewId, state: "pending" });
  }, [viewId, state, order, failure, onOrder]);
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
 * sort-suppressed — then reads the contributions once, in the slot's layout
 * order (`useSlotOrder`), and kicks off the fold.
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
    emit: (report: RowOrderState) => ReactNode;
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
  // The contributors' precedence is the slot's layout: not known yet, the
  // fold reports `pending` (the body's loading state) — mounting them in raw
  // order could let the wrong one claim the order and the rows jump.
  const layout = slotLayout(useSlotOrder(DataViewSlots.RowOrder));
  if (layout.kind === "loading") return <>{emit(PENDING)}</>;
  if (layout.kind === "failed") {
    return <>{emit({ state: "failed", failure: layout.failure })}</>;
  }
  return (
    <RowOrderStep
      {...ids}
      rows={orderedRows}
      contributions={layout.items}
      index={0}
      acc={null}
      emit={(resolved) => emit({ state: "known", order: resolved })}
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
