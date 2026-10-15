import { createContext, useContext, useMemo, type ReactNode } from "react";
import type {
  DataViewId,
  FieldDef,
  FieldGrouping,
  ViewState,
} from "../../../core";
import type { ReadyViewModel } from "../../internal/use-data-view-model";
import type { FilterController } from "../../internal/use-filter-controller";
import type { SortController } from "../../internal/use-sort-controller";

/**
 * Everything a toolbar control or a settings contribution needs, in ONE context.
 *
 * There is one context and not two (a "controls" one for the toolbar and a
 * "settings" one for the gear) because the settings menu is itself a control: it
 * is a `DataViewSlots.Control` contribution whose panel body happens to host
 * `DataViewSlots.Setting` contributions. Splitting them would mean deciding, per
 * new field, which of two contexts it belongs in — and every answer that got it
 * wrong would only show up as a missing value at the call site.
 *
 * Nothing here is derived: every field is computed once in `DataViewBodyInner`
 * and merely re-homed. In particular `filter` / `sort` are the SAME controller
 * objects the row pipeline reads, so a control's summary and what actually
 * filters can never come from two different computations.
 *
 * Provided around **the toolbar only** — not around the view body. View children
 * have a deliberate contract (`DataViewRenderProps`), and an ambient back door to
 * `viewModel` would be a second, undocumented seam into the same state. Popovers
 * portal out of the DOM but stay React children, so the context still reaches
 * every panel opened from the toolbar.
 */
export interface DataViewControlsContextValue {
  storageKey: DataViewId;
  /** The merged field schema (incl. custom columns + field extensions). */
  fields: FieldDef<unknown>[];
  activeViewId: string;
  activeState: ViewState;
  viewModel: ReadyViewModel;
  /** Whether the active view supports group-by (false → group-by control hides). */
  activeSupportsGroupBy: boolean;
  /** Whether the active view draws fold lines (false → the fold setting hides). */
  activeSupportsFold: boolean;
  /**
   * Can the view be grouped by this field — its type buckets it
   * (`isGroupableField` over the `Grouping` slot) AND at least one of its
   * groupings is {@link offersGrouping offered}? The group-by setting's
   * `isApplicable` is a pure function and cannot read a slot itself, so the
   * host resolves it once here.
   */
  groupableField: (field: FieldDef<unknown>) => boolean;
  /**
   * Is this grouping of this field offered? Always in memory; under a live
   * source only a pair that lowers (`liveGroupLowering`: server sections, an
   * order prefix, or buckets over a sortable column) — a grouping that could
   * only partition what happens to be loaded is never offered.
   */
  offersGrouping: (
    field: FieldDef<unknown>,
    grouping: FieldGrouping,
  ) => boolean;
  /** Whether the active view honors `ViewState.sort` (false → no Sort control). */
  activeSupportsSort: boolean;
  /** Whether the active view can render a flat rank-ordered, draggable body. */
  activeSupportsManualOrder: boolean;
  /** A manual drag order EXISTS for this view but a sort is shadowing it — the
   *  sort panel says so, since that is the last silent cause of "drag stopped
   *  working". */
  manualOrderOverridden: boolean;
  /** The live filter-tree controller (filter, setFilter, filterableFields,
   *  resolveOperatorSet, ruleCount). */
  filter: FilterController<unknown>;
  /** The live sort-rule controller (rules, sortableFields, ruleCount, add/remove/…). */
  sort: SortController<unknown>;
}

const DataViewControlsContext =
  createContext<DataViewControlsContextValue | null>(null);

/**
 * Takes the value FIELD BY FIELD rather than as one `value` object, and memoizes
 * it here. The host builds this inside a plain render function (the body's
 * surface, beside the `RowOrderReader`), which may hold no hooks — so this
 * component is the only place with somewhere to put the memo, and passing it a pre-built
 * object would hand every consumer a new identity on every render of the body.
 */
export function DataViewControlsProvider({
  children,
  storageKey,
  fields,
  activeViewId,
  activeState,
  viewModel,
  activeSupportsGroupBy,
  activeSupportsFold,
  groupableField,
  offersGrouping,
  activeSupportsSort,
  activeSupportsManualOrder,
  manualOrderOverridden,
  filter,
  sort,
}: DataViewControlsContextValue & { children: ReactNode }): ReactNode {
  const value = useMemo<DataViewControlsContextValue>(
    () => ({
      storageKey,
      fields,
      activeViewId,
      activeState,
      viewModel,
      activeSupportsGroupBy,
      activeSupportsFold,
      groupableField,
      offersGrouping,
      activeSupportsSort,
      activeSupportsManualOrder,
      manualOrderOverridden,
      filter,
      sort,
    }),
    [
      storageKey,
      fields,
      activeViewId,
      activeState,
      viewModel,
      activeSupportsGroupBy,
      activeSupportsFold,
      groupableField,
      offersGrouping,
      activeSupportsSort,
      activeSupportsManualOrder,
      manualOrderOverridden,
      filter,
      sort,
    ],
  );
  return (
    <DataViewControlsContext value={value}>{children}</DataViewControlsContext>
  );
}

/** Read the DataView controls context. Throws outside a DataView toolbar. */
export function useDataViewControls(): DataViewControlsContextValue {
  const ctx = useContext(DataViewControlsContext);
  if (!ctx) {
    throw new Error(
      "useDataViewControls must be used within a DataView toolbar (a control " +
        "panel, or a DataViewSlots.Setting contribution inside one) or the " +
        "surface's `aside`",
    );
  }
  return ctx;
}
