import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { dataViewConfigContributions } from "./internal/config-registrations";
import { DataViewSlots } from "./slots";
import { GroupByControl } from "./components/settings/group-by-control";
import { PropertiesControl } from "./components/settings/properties-control";
import { FoldControl } from "./components/settings/fold-control";
import { FilterControlPanel } from "./components/filter/filter-control-panel";
import { SortControlPanel } from "./components/sort/sort-control-panel";
import { SettingsControlPanel } from "./components/settings/settings-control-panel";
import { summarizeFilter } from "./internal/summarize-filter";
import { summarizeSort } from "./internal/summarize-sort";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { IdKinds } from "@plugins/ids/web";
import { presetIdKind, filterNodeIdKind } from "../core";

export { DataView } from "./components/data-view";
export { MergedDataView } from "./components/merged-data-view";
export type { MergedDataViewProps } from "./components/merged-data-view";
export { defineDataViewSources } from "./internal/define-data-view-sources";
export type {
  DataViewSources,
  DataViewSourceContribution,
  DataViewSourceProps,
} from "./internal/define-data-view-sources";
export type { DataViewSourceBundle } from "./internal/body-types";
export {
  useLivePagedValuePaging,
  useLivePagesPaging,
} from "./internal/use-live-pages-paging";
export type { LivePagesPaging } from "./internal/use-live-pages-paging";
export {
  defineDataView,
  DATA_VIEW_HEADER_OFFSET_VAR,
  fieldOverrides,
  IDENTITY_CODEC,
  UNGROUPED_FOLD_KEY,
} from "../core";
export type {
  DataViewId,
  FieldOverride,
  FieldOverrides,
  DataViewPaging,
  DataViewPagingTotal,
  DataViewPageNotice,
  DataViewViewportSink,
} from "../core";
export type {
  FieldGrouping,
  FieldGroupingSet,
  GroupingPlanContext,
  GroupBucket,
  GroupByRule,
} from "../core";
export { DataViewSlots } from "./slots";
export type {
  DataViewContribution,
  DataViewSettingContribution,
  DataViewControlContribution,
  DataViewControlSummary,
  GlobalRowOrderProps,
  GlobalRowOrderContribution,
  CollectionItemActionContribution,
  CollectionItemActionOwner,
} from "./slots";
export { getDataViewDescriptor } from "./internal/descriptors";
export { useDataViewControls } from "./components/controls/controls-context";
export type { DataViewControlsContextValue } from "./components/controls/controls-context";
export { useResolveCell, useIsChipField } from "./cell-slot";
export type { CellContributionMeta } from "./cell-slot";
export { useResolveCellEditor } from "./cell-editor-slot";
export { useResolveOperatorSet } from "./filter-slot";
export { useResolveValueCodec } from "./value-codec-slot";
export {
  useResolveColumnConfig,
  useResolveColumnDerive,
} from "./column-config-slot";
export { useFieldIdentities } from "./internal/use-field-identities";
export { EditableCell } from "./components/editable-cell";
export { FieldCell } from "./components/field-cell";
export { EditableTreeLabel } from "./components/editable-tree-label";
export type { FieldCellProps } from "./components/field-cell";
export { MissingDataCellError, readFallback } from "./components/field-cell";
export { leadingSlot } from "./components/leading-slot";
export type { LeadingSlotProps } from "./components/leading-slot";
export { FilterValueInput } from "./components/filter/filter-value-input";
export { ChipSelectFilterInput } from "./components/filter/chip-select-filter-input";
export { useFlatRows } from "./internal/use-flat-rows";
export { useHierarchyTree } from "./internal/hierarchy/use-hierarchy-tree";
export type {
  HierarchyTree,
  HierarchyTreeOptions,
} from "./internal/hierarchy/use-hierarchy-tree";
export type { ProjectedRow } from "./internal/hierarchy/project-rows";
export { makeSortComparator } from "./internal/sort-rows";
export {
  useDataViewSections,
  partitionIntoSections,
  isGroupableField,
} from "./internal/use-data-view-sections";
export type { PartitionOptions } from "./internal/use-data-view-sections";
export { useResolveGroupings, useGroupingRegistry } from "./grouping-slot";
export type { GroupingRegistry } from "./grouping-slot";
export {
  IDENTITY_GROUPING,
  IDENTITY_GROUPING_SET,
} from "./internal/identity-grouping";
export { useGroupingClock } from "./internal/use-grouping-clock";
export { GroupedSections } from "./internal/grouped-sections";
export { DataViewGroupHeader } from "./internal/group-header";
export { SectionBody } from "./components/section-body";
export { useGridPhase } from "./internal/grid-phase";
export type { GridLine, GridPhase } from "./internal/grid-phase";
export type { SectionBodyProps } from "./components/section-body";
export type { GroupedSectionsProps } from "./internal/grouped-sections";
export { useGroupByController } from "./internal/use-group-by-controller";
export type { GroupByController } from "./internal/use-group-by-controller";
export { liveDataSource } from "./internal/live-data-source";
export { applyFilter } from "./internal/evaluate-filter";
export type { LoweredFilter } from "./internal/evaluate-filter";
export { useRowFilter } from "./internal/use-row-filter";
export { useFilterClock } from "./internal/use-filter-clock";
export { isFilterGroup } from "./internal/filter-shape";
export { useFilterController } from "./internal/use-filter-controller";
export type { FilterController } from "./internal/use-filter-controller";
export { useSortController } from "./internal/use-sort-controller";
export type { SortController } from "./internal/use-sort-controller";
export { pickPrimaryField } from "./internal/pick-primary-field";
export { pickLeadingField } from "./internal/pick-leading-field";
export { resolveBodyFields } from "./internal/resolve-body-fields";
export { rowToneClass } from "./internal/row-tone";
export { defineItemActions } from "./internal/define-item-actions";
export type {
  ItemActions,
  ItemActionContribution,
} from "./internal/define-item-actions";
export { useItemActionZones } from "./internal/use-item-action-zones";
export type { FieldExtensionContribution } from "./internal/field-extensions";
export type {
  FieldValue,
  FilterFieldValue,
  ValueCodec,
  ColumnConfigProps,
  ColumnConfigDerive,
  FieldDef,
  FieldOption,
  RowTone,
  HierarchyConfig,
  SelectionConfig,
  CreateOption,
  ManualOrderConfig,
  SortRule,
  SortPreset,
  FilterPreset,
  ViewState,
  FoldRule,
  DataViewFoldLines,
  DataViewSection,
  DataViewRowEntry,
  DataViewAggregateConfig,
  DataViewRenderProps,
  DataViewProps,
  DataViewDensity,
  TableCellProps,
  CellEditorProps,
  FilterValueInputProps,
  FilterOperator,
  FilterLowerContext,
  FilterOperatorSet,
  FilterConjunction,
  FilterRule,
  FilterGroup,
  FilterNode,
  ItemActionProps,
  ItemActionsDescriptor,
  ItemActionZone,
  FieldExtensionProps,
} from "../core";

export default {
  description:
    "Notion-like multi-view data surface: one typed field schema rendered through swappable views with per-view sort/search/filter.",
  // One config_v2 `views` descriptor per DataView id (scraped from
  // `defineDataView(...)` markers into data-views.generated.ts), all registered
  // under the `primitives.data-view` plugin. Mirrors reorder's central
  // per-slot registration — no per-consumer barrel boilerplate.
  contributions: [
    IdKinds.Kind({ kind: presetIdKind }),
    IdKinds.Kind({ kind: filterNodeIdKind }),
    ...dataViewConfigContributions,
    // Per-view (view scope) DataView settings, rendered in the gear menu's
    // "Current view" section. Each reads what it needs from
    // DataViewSettingsContext and declares its own `isApplicable` so the menu
    // gates visibility generically (never naming a specific setting).
    // Properties: which fields render in the body + their order (Notion-style).
    DataViewSlots.Setting({
      id: "data-view.properties",
      scope: "view",
      order: 0,
      isApplicable: (ctx) => ctx.fields.length > 1,
      component: PropertiesControl,
    }),
    // Group-by: sections the rows by a groupable field.
    DataViewSlots.Setting({
      id: "data-view.group-by",
      scope: "view",
      order: 1,
      isApplicable: (ctx) =>
        ctx.activeSupportsGroupBy &&
        ctx.fields.some((f) => ctx.groupableField(f)),
      component: GroupByControl,
    }),
    // Fold rows: rows not matching a filter rule fold behind "… N more" at the
    // end of their section. Needs a filterable field to write a rule over, and a
    // view that draws fold lines (not the tree).
    DataViewSlots.Setting({
      id: "data-view.fold",
      scope: "view",
      order: 2,
      isApplicable: (ctx) =>
        ctx.activeSupportsFold && ctx.filter.filterableFields.length > 0,
      component: FoldControl,
    }),
    // The three built-in toolbar controls. The toolbar names none of them: it
    // reads this slot, asks each `isApplicable`, and builds one identical trigger
    // per survivor. A plugin adds a fourth by contributing here.
    //
    // Filter and sort are NOT extracted into sub-plugins in this pass: both pull
    // heavily on `web/internal/` (the controllers, `filter-tree-ops`,
    // `rule-resolution`, `filter-slot`, `sort-presets`) and the evaluator is
    // shared with `useFlatRows`, so extraction would push a large slice of
    // `internal/` out through this barrel for no user-visible gain.
    DataViewSlots.Control({
      id: "data-view.filter",
      label: "Filter",
      icon: symbol("filter-list"),
      order: 0,
      size: "builder",
      // A literal transcription of the host's old `hasFilters`.
      isApplicable: (ctx) => ctx.filter.filterableFields.length > 0,
      summary: (ctx) =>
        summarizeFilter(
          ctx.filter.filter,
          ctx.fields,
          ctx.filter.resolveOperatorSet,
        ),
      component: FilterControlPanel,
    }),
    DataViewSlots.Control({
      id: "data-view.sort",
      label: "Sort",
      icon: symbol("swap-vert"),
      order: 1,
      size: "builder",
      // A literal transcription of the host's old `hasSort`.
      isApplicable: (ctx) =>
        ctx.activeSupportsSort && ctx.sort.sortableFields.length > 0,
      summary: (ctx) => summarizeSort(ctx.sort.rules, ctx.sort.sortableFields),
      component: SortControlPanel,
    }),
    // Settings carries no summary on purpose: view settings are configuration,
    // not a narrowing of what you see. A summary answers "what am I not seeing,
    // and why" — "Group by: Status" answers neither, and it would still count
    // itself into the compact fold's badge as if something were being hidden.
    DataViewSlots.Control({
      id: "data-view.settings",
      label: "View settings",
      icon: symbol("tune"),
      order: 2,
      component: SettingsControlPanel,
    }),
  ],
  slots: DataViewSlots,
} satisfies PluginDefinition;
