import type { IconRef } from "@plugins/ui/plugins/icons/core";
import {
  defineSlot,
  type SealContributions,
} from "@plugins/framework/plugins/web-sdk/core";
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";
import type { ComponentType, ReactNode } from "react";
import type { ViewTypeMeta } from "@plugins/primitives/plugins/data-view/plugins/view-core/core";
import type { LoadingVariant } from "@plugins/primitives/plugins/loading/web";
import type {
  DataViewId,
  DataViewRenderProps,
  ManualOrderConfig,
} from "../core";
import type { ControlPanelSize } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import type { DataViewControlsContextValue } from "./components/controls/controls-context";
import { defineFieldExtensions } from "./internal/field-extensions";
import { Cell } from "./cell-slot";
import { CellEditor } from "./cell-editor-slot";
import { Filter } from "./filter-slot";
import { ValueCodec } from "./value-codec-slot";
import { Grouping } from "./grouping-slot";
import { ColumnConfig } from "./column-config-slot";

/**
 * A registered view-*type*: the generic `ViewTypeMeta` (type/title/icon/order/
 * configSchema — owned by view-core) plus data-view's own render
 * contract, the `component`.
 */
export interface DataViewContribution extends ViewTypeMeta {
  component: ComponentType<DataViewRenderProps<unknown>>;
  /** Whether this view honors `ViewState.sort` (flat field sort). Default true;
   *  a view sets false when it has no meaningful field-sort axis, and the host
   *  hides the Sort pill for it. A nesting view honors sort by ordering each
   *  sibling group by the field (defaulting to manual/rank order). */
  supportsSort?: boolean;
  /** Skeleton shape the host renders while this view is loading (the host owns
   *  the loading→empty precedence so view children never see a loading state).
   *  Default "rows"; gallery declares "cards". */
  loadingVariant?: LoadingVariant;
  /** Skeleton item count for the loading variant (forwarded to <Loading count>). */
  loadingCount?: number;
  /** Whether this view supports group-by sections. Default true (every built-in
   *  view; a nesting view partitions its ROOTS into sections); a view
   *  with no meaningful group axis sets false and the host hides the group-by
   *  control for it. Mirrors `supportsSort`. */
  supportsGroupBy?: boolean;
  /** Whether this view draws fold lines (`ViewState.fold`). Default true — the
   *  flat views render against `useDataViewSections`, which folds; a view with
   *  no flat section of rows to fold sets false, so the host neither applies a
   *  fold for it nor offers the "Fold rows" setting. Mirrors `supportsGroupBy`. */
  supportsFold?: boolean;
  /** Whether this view supports flat manual-order (rank-based drag reorder).
   *  Default **false** (unlike `supportsSort`/`supportsGroupBy`): the flat views
   *  list/table opt IN (`true`); gallery does not. When false the host never
   *  passes `manualOrder` into the view and keeps the Sort control. */
  supportsManualOrder?: boolean;
  /**
   * Whether this view NESTS its rows when the source has a `hierarchy` (the
   * table), while still drawing a flat source flat. Over a hierarchical source
   * the host then applies no fold and no flat manual order (a nested row's order
   * is its rank, moved by the tree's own drag), and its `filterScope` decides
   * `hideWhenEmpty`. Default false.
   */
  nestsHierarchy?: boolean;
  /** Under an `overlay` toolbar arrangement, whether this view starts at the
   *  surface's very top-left edge, UNDER the floating band and aside (a map
   *  that is the surface's canvas). Default false: the host insets the view by
   *  the band's height and the aside's reach, so its first row clears the
   *  floating cards. No effect beside an in-flow band. */
  fullBleed?: boolean;
}

/**
 * A contribution to the DataView settings menu (the gear popover). A plain data
 * contribution (NOT a render slot — settings aren't force-reorderable), mirroring
 * the `View` slot's shape. `scope` places it in the "Current view" section
 * (per-instance settings like group-by / properties) or the "DataView" section
 * (surface-wide settings like custom-columns). The `component` reads everything it
 * needs from `DataViewControlsContext` — no props are threaded.
 *
 * A `Setting` is one section INSIDE the settings control's panel; a `Control` (see
 * below) is a whole toolbar affordance. The two levels are deliberate: flattening
 * settings into controls would put Properties / Group by / Fields in competition
 * for the toolbar's single line.
 */
export interface DataViewSettingContribution {
  /** Stable id (React key + reorder/doc identity). */
  id: string;
  /** Which menu section this setting renders in. */
  scope: "global" | "view";
  /** Ordering within its scope's section (ascending; default 0). */
  order?: number;
  /**
   * Whether this setting has anything to render for the current context — the
   * generic applicability signal the menu uses to decide gear/section visibility
   * without ever naming a specific contribution (group-by hides when no field is
   * groupable, properties hides on a single-field surface). Must mirror the
   * component's own self-hide so an "applicable" setting always renders. Absent =
   * always applicable.
   */
  isApplicable?: (ctx: DataViewControlsContextValue) => boolean;
  component: ComponentType;
}

/**
 * What a control says about itself when it is narrowing what you see.
 *
 * It is **text, never chrome**: the wide toolbar's trigger is icon-only and
 * spends this on its tooltip + accessible name, the compact fold spends it as the
 * trailing text of the control's row, and the `count` feeds the fold's aggregate
 * badge. Nothing here is allowed to grow the toolbar's one line.
 *
 * It is ONE object returned by ONE function, rather than a `summary` string plus
 * a separate `count`, because two independent functions over the same state can
 * disagree: that is exactly the bug `rule-resolution.ts` exists to close (the
 * summary reading "0 rules" while a value-less `bool` rule silently filtered). One
 * function, one object, and the disagreement is unrepresentable.
 */
export interface DataViewControlSummary {
  /** What the control is doing, in words: "Status is none of 2", "Updated ↓". */
  label: string;
  /** Spoken form for a label that leans on a glyph — "Updated, descending". */
  spoken?: string;
  /** How many further things this control is doing, rendered as "+N". */
  more?: number;
  /** This control's contribution to the compact fold's aggregate badge.
   *  Default `1 + (more ?? 0)` — the whole thing the summary describes. */
  count?: number;
}

/**
 * One toolbar control: a trigger the user opens, plus the panel behind it.
 *
 * This is what makes the toolbar name no control. It used to take three props —
 * `sortControl`, `filterControl`, `fieldsControl` — which is the collection-consumer
 * rule broken in the most literal way, and meant no plugin could ever add a fourth.
 *
 * It is a plain `defineSlot` + `renderIsolated` (the `View` / `Setting` precedent),
 * NOT a `defineRenderSlot`. A render slot would mount EVERY control's panel on
 * EVERY DataView on every page — each running `useFilterPresets`, the live
 * custom-values resource, and so on — just to draw a closed trigger. The host
 * instead reads the metadata (`label`, `icon`, `isApplicable`, `summary`), builds
 * each trigger itself, and mounts exactly the one panel that is open. A render
 * slot would also be unconditionally reorderable, owing an authored
 * `config/…/primitives.data-view.control.jsonc` with a build-blocking `// @review`
 * marker — for a fixed reading order that `order` already expresses.
 */
export interface DataViewControlContribution {
  /** Stable id (React key + doc identity), e.g. `data-view.filter`. */
  id: string;
  /** The control's name: trigger tooltip + accessible name, compact-fold row
   *  label, and the back-header title of a panel pushed from it. */
  label: string;
  icon: IconRef;
  /** Reading order in the toolbar (ascending; default 0). */
  order?: number;
  /** Width ROLE of this control's panel — `menu` for a list of choices,
   *  `builder` for a rule row. Not a measurement, and there is no third option. */
  size?: ControlPanelSize;
  /** Whether this control applies at all to the active view + schema. Absent =
   *  always applicable. Pure: it is asked before any panel mounts. */
  isApplicable?: (ctx: DataViewControlsContextValue) => boolean;
  /**
   * What this control is doing when it is active, in words, or `null` when it is
   * not — the trigger's tooltip + accessible name and the compact fold's row
   * text. **A pure function, never a hook** — the trigger has to render without
   * mounting the panel, and computing N summaries by mounting N panels would make
   * every DataView subscribe to every control's data on first paint.
   */
  summary?: (
    ctx: DataViewControlsContextValue,
  ) => DataViewControlSummary | null;
  /** The panel body. Prop-less — it reads `useDataViewControls()`. */
  component: ComponentType;
}

/**
 * A registered control as the toolbar actually reads it. Every declared field
 * stays readable — that is what lets the host build a trigger without mounting
 * anything — except `component`, which the loader seals: the only way to draw it
 * is `renderIsolated`, so a control's panel cannot be mounted outside the
 * error-boundary chain.
 */
export type DataViewControl = SealContributions<DataViewControlContribution>;

/**
 * Props a **global** row-order contribution receives. The twin of the global
 * `FieldExtension` slot's props: a single always-on slot every eligible DataView
 * folds, so the host threads the surface coordinates a contributor needs to key
 * a per-view-instance row order — the `storageKey` (which surface), the
 * `viewId` (which view instance owns this order), and `rowKey` (how to identify
 * a row). The row type is erased to `unknown` (a global slot spans disjoint
 * consumer row types).
 *
 * `rows` is the view's **ordered set**: filter-applied, search-EXCLUDED,
 * sort-suppressed. Search only affects what is *rendered*, never which rows the
 * order covers — so a drag under an active search still rebuilds the full order
 * and no hidden row is dropped.
 */
export interface GlobalRowOrderProps {
  storageKey: DataViewId;
  /** The ACTIVE view-instance id — the order's scope. */
  viewId: string;
  rowKey: (row: unknown, index: number) => string;
  /** The view's ordered set: filter-applied, search-EXCLUDED, sort-suppressed. */
  rows: readonly unknown[];
  /** Hand the host this contributor's order, or `null` to defer to the next
   *  contributor (called in render — the component is mounted, so it may load
   *  hook-backed data first). */
  render: (order: ManualOrderConfig<unknown> | null) => ReactNode;
}

export interface GlobalRowOrderContribution {
  /** Stable id (React key + reorder/doc identity). */
  id: string;
  component: ComponentType<GlobalRowOrderProps>;
  order?: number;
}

export const DataViewSlots = {
  View: defineSlot<DataViewContribution>({
    docLabel: (p) => p.title,
  }),
  /**
   * Global, always-on field-extension slot: the global-registered instance of the
   * same `defineFieldExtensions` factory (minted at `<unknown>`, since a global
   * slot spans disjoint consumer row types). Every DataView folds its
   * contributions into the schema (before the sort/filter controllers), threading
   * `{ storageKey, rowKey }` so a contributor can key its per-row `FieldDef.value`
   * over the surface. This is the cross-plugin, always-on case of field extensions
   * — used by custom-columns to add every surface's user-defined columns without
   * the host importing it — as opposed to the per-consumer `fieldExtensions` prop
   * (Sonata's typed/scoped fields). Both share one contribution shape and one fold.
   */
  FieldExtension: defineFieldExtensions<unknown>(),
  /**
   * Global, always-on row-order slot: every DataView eligible for a manual order
   * (list/table, no consumer `manualOrder`, no live `source`, no `aggregate`)
   * folds its contributions, threading `{ storageKey, viewId, rowKey, rows }` so
   * a contributor can key a per-view-instance drag order over the surface.
   * **First non-null wins** (the fold order is a committed reorder override), and
   * a consumer-supplied `DataViewProps.manualOrder` still outranks every
   * contributor.
   */
  RowOrder: defineRenderSlot<GlobalRowOrderContribution>({
    docLabel: (p) => p.id,
  }),
  /** Contributable DataView settings menu entries (group-by, future per-view /
   *  surface-wide settings). Plain data slot, read by the host's settings menu. */
  Setting: defineSlot<DataViewSettingContribution>({
    docLabel: (p) => p.id,
  }),
  /** Contributable toolbar controls (filter, sort, settings, and anything a
   *  plugin adds). Plain data slot: the toolbar reads each contribution's
   *  metadata to build its trigger and mounts only the open panel. */
  Control: defineSlot<DataViewControlContribution>({
    docLabel: (p) => p.label,
  }),
  /** Per-type table cell. Contribute `{ match, component }`, plus the optional
   *  self-description `chip: true` when the cell renders a `Badge` rather than a
   *  text run (see `CellContributionMeta`). */
  Cell,
  /** Per-type inline cell editor. Contribute `{ match, component }`. */
  CellEditor,
  /** Per-type filter. Contribute one `FilterOperatorSet` ({ match, operators, defaultOperator? }). */
  Filter,
  /** Per-type native↔text value codec for custom columns. Contribute `{ match, codec }`. */
  ValueCodec,
  /** Per-type grouping strategies. Contribute `{ match, label, groupings }` —
   *  the granularity band's label plus the ways this type buckets its values.
   *  Declaring any also makes the type groupable by default (`isGroupableField`). */
  Grouping,
  /** Per-type add-time custom-column config editor. Contribute `{ match, component }`. */
  ColumnConfig,
};
