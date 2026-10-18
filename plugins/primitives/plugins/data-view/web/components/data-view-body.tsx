import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  useDeferredLoadComplete,
  type Contribution,
} from "@plugins/framework/plugins/web-sdk/core";
import { renderIsolated } from "@plugins/primitives/plugins/slot-render/web";
import {
  isHostedToolbar,
  isSectionsToolbar,
  scopeFilterRows,
  type DataViewRenderProps,
  type FieldDef,
  type FieldGrouping,
  type FilterGroup,
  type ItemActionsDescriptor,
  type LiveDataSource,
  type ManualOrderConfig,
  type DataViewFoldLines,
  type DataViewPaging,
  type DataViewSectioning,
  type DataViewPageNotice,
  type DataViewViewportSink,
  type SortRule,
  type ViewState,
} from "../../core";
import type { ResolvedViewInstance } from "@plugins/primitives/plugins/data-view/plugins/view-core/web";
import { DataViewSlots, type DataViewContribution } from "../slots";
import {
  InfiniteScrollFooter,
  useInfiniteScroll,
} from "@plugins/primitives/plugins/cursor-pagination/web";
import { fieldsReadByView, resolveBodyState } from "../internal/body-state";
import { BodyFallback } from "./body-fallback";
import { useHeldHeight } from "../internal/use-held-height";
import {
  useFilterController,
  type FilterController,
} from "../internal/use-filter-controller";
import {
  useSortController,
  type SortController,
} from "../internal/use-sort-controller";
import { useGroupingRegistry } from "../grouping-slot";
import { useLiveSource, type SourceView } from "../internal/live-source";
import {
  unavailableRules,
  UnavailableFilterRuleError,
} from "../internal/live-filter";
import { pruneRules } from "../internal/filter-tree-ops";
import type { UnavailableRule } from "../internal/evaluate-filter";
import { useCollectionItemActions } from "../internal/collection-item-actions";
import {
  checkFieldColumns,
  liveColumnScopeOf,
  liveGroupLowering,
  resolveLiveFields,
  type LiveFieldPlan,
} from "../internal/live-fields";
import { pickPrimaryField } from "../internal/pick-primary-field";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useResolveOperatorSet } from "../filter-slot";
import { useGroupingClock } from "../internal/use-grouping-clock";
import { bodyRowMatcher, useRowFilter } from "../internal/use-row-filter";
import { useRowMatcher } from "../internal/use-flat-rows";
import {
  isGroupableField,
  partitionIntoSections,
} from "../internal/use-data-view-sections";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { PendingMoveOverlay } from "../internal/use-pending-move-overlay";
import { CollectFieldExtensions } from "../internal/field-extensions";
import {
  CollectFieldOptions,
  listSchema,
  useDerivedFields,
  CollectClientValues,
} from "../internal/derived-fields";
import { CollectFacetOptions } from "../internal/facet-options";
import { RowOrderReader, type ReportedRowOrder } from "../internal/row-order";
import {
  effectiveFold,
  isTailFolded,
  makeFoldKeep,
} from "../internal/fold-sections";
import { summarizeFilter } from "../internal/summarize-filter";
import {
  PAGE_PLACEHOLDER_ATTR,
  useVisibleRowKeys,
  visibleRowsOf,
} from "../internal/use-visible-row-keys";
import { KeepAnchorAcross } from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";
import {
  PagePlaceholders,
  PlaceholderHeightContext,
} from "./page-placeholders";
import {
  type PagedReadLayout,
  usePlaceholderHeights,
} from "../internal/placeholder-heights";
import type {
  DataViewBodyProps,
  DistributiveOmit,
} from "../internal/body-types";
import { DataViewToolbar } from "./toolbar/data-view-toolbar";
import { BandSurface } from "./band-surface";
import { HostedOptions } from "./toolbar/hosted-options";
import { hostedCreators } from "./creators-control";
import { ViewSection } from "./view-section";
import {
  afterOpen,
  beforeOpen,
  runActivation,
  type Activation,
} from "@plugins/primitives/plugins/link-gesture/core";
import { CollectRowActivation } from "../internal/collection-row-activation";
import type { CollectionActivation } from "../internal/fold-activations";
import {
  DataViewControlsProvider,
  type DataViewControlsContextValue,
} from "./controls/controls-context";

/**
 * The per-active-instance body: everything downstream of "which instance is
 * active". The shell mounts exactly one body inside its root; the body never
 * mounts when the surface has zero instances (the shell's placeholder branch
 * early-returns first).
 */
export function DataViewBody<TRow>(props: DataViewBodyProps<TRow>): ReactNode {
  return (
    <CollectRowActivation
      collection={props.source?.collection ?? props.collection}
    >
      {(collectionActivation) => (
        <CollectBodyFields source={props}>
          {(fields, rowKeyOf) => (
            <DataViewBodyInner
              {...props}
              fields={fields as FieldDef<TRow>[]}
              rowKeyOf={rowKeyOf}
              collectionActivation={collectionActivation}
            />
          )}
        </CollectBodyFields>
      )}
    </CollectRowActivation>
  );
}

/**
 * The `{ kind: "sections" }` body: EVERY instance, stacked in config order,
 * each a full `DataViewBodyInner` (its own controllers, live source, row
 * order and view) rendered under its own section header. The inner body is
 * already keyed by view id through the id-parameterised `ReadyViewModel`, so a
 * section is simply the body with that instance as its "active" one — and the
 * model stays ONE hook in the shell (per-section models would each hold their
 * own copy of the ephemeral map and overwrite each other's writes).
 *
 * The field-extension fold is hoisted ABOVE the sections, so contributed
 * fields (custom columns) subscribe once per surface, not once per section.
 */
export function DataViewSectionsBody<TRow>(
  props: DistributiveOmit<DataViewBodyProps<TRow>, "activeInstance"> & {
    instances: readonly ResolvedViewInstance<DataViewContribution>[];
  },
): ReactNode {
  const { instances } = props;
  // Which section the last row activation came from. A row can show in several
  // sections at once (a starred page in Favorites AND in the tree), and the
  // selection highlights in all of them — but only the section the user
  // clicked in may reveal it. Without this, clicking a favourite made the tree
  // below expand to the page and scroll the sidebar away from the click.
  const [activatedIn, setActivatedIn] = useState<SectionActivation | null>(
    null,
  );
  return (
    <CollectRowActivation
      collection={props.source?.collection ?? props.collection}
    >
      {(collectionActivation) => (
        <CollectBodyFields source={props}>
          {(fields, rowKeyOf) =>
            instances.map((instance) => (
              <DataViewBodyInner
                key={instance.instance.id}
                {...props}
                activeInstance={instance}
                fields={fields as FieldDef<TRow>[]}
                rowKeyOf={rowKeyOf}
                collectionActivation={collectionActivation}
                sectionActivation={{
                  last: activatedIn,
                  record: setActivatedIn,
                }}
              />
            ))
          }
        </CollectBodyFields>
      )}
    </CollectRowActivation>
  );
}

/**
 * Fold cross-plugin field contributions into `fields` BEFORE the controllers,
 * so the merged schema reaches `useSortController`, `useFilterController`, and
 * `renderProps.fields` uniformly (automatic once it is the `fields` prop). ONE
 * fold over the **global** `DataViewSlots.FieldExtension` slot — every
 * DataView's, the cross-cutting contributor case (custom-columns' user-defined
 * columns); the fold threads `{ storageKey, rowKey }` to every contributor.
 * The host names no individual contributor. Fields of an entity, an exposure,
 * an arm, a row kind or client fields are DERIVED before it (`deriveFields`,
 * `CollectClientValues`) — there is no per-list field slot.
 *
 * The fold runs in `unknown` row space (the global slot spans disjoint consumer
 * row types), so `props.fields`/`rowKey` and the merged result cross a safe
 * `FieldDef<unknown>`↔`FieldDef<TRow>` boundary cast.
 *
 * It also resolves the origin's row key (a live source keys rows by its
 * collection's id), checks every field against a live source, and hands each
 * field over one of the source's facets its read option state
 * (`CollectFacetOptions`).
 */
function CollectBodyFields<TRow>(props: {
  source: Pick<
    DataViewBodyProps<TRow>,
    | "fields"
    | "overrides"
    | "extraFields"
    | "storageKey"
    | "rowKey"
    | "source"
    | "collection"
    | "rows"
  >;
  children: (
    fields: FieldDef<unknown>[],
    rowKeyOf: (row: TRow, index: number) => string,
  ) => ReactNode;
}): ReactNode {
  const { source, children } = props;
  const live = source.source;
  const resolveOperatorSet = useResolveOperatorSet();
  // A collection taking scoped columns (custom columns) names the ONE surface
  // it is listed on — asserted here, at mount.
  const liveColumnScope = liveColumnScopeOf(live, source.storageKey);
  // A live source keys rows by its collection's id — the id the runtime keys
  // its deltas by, so the two cannot disagree.
  const rowKey = useMemo(
    () =>
      live !== undefined
        ? liveRowKey(live)
        : (source.rowKey as (row: TRow, index: number) => string),
    [live, source.rowKey],
  );
  // The schema: derived from the rows' collection (a live source's, or the
  // in-memory rows' declared `collection`) — its own fields, the exposed fields
  // of every entity it reaches, its arms' — with the list's `overrides` and
  // `extraFields`; or the host's hand `fields` for rows of no collection
  // declared by fields. A duplicate id throws.
  const collection = live?.collection ?? source.collection;
  const derived = useDerivedFields(collection, live !== undefined);
  const base = useMemo(
    () =>
      listSchema({
        collection,
        derived: derived.fields,
        fields: source.fields as FieldDef<unknown>[] | undefined,
        overrides: source.overrides as
          Parameters<typeof listSchema>[0]["overrides"] | undefined,
        extraFields: source.extraFields as FieldDef<unknown>[] | undefined,
      }),
    [collection, derived, source.fields, source.overrides, source.extraFields],
  );
  // Fields are checked where they are declared: the host's own (and the
  // exposed ones) here, each field-extension contributor's inside its own
  // `render(fields)` (its error boundary contains the crash and names it).
  checkFieldColumns(
    base,
    live as LiveDataSource<unknown> | undefined,
    resolveOperatorSet,
    "the host's fields",
  );
  const validate = useCallback(
    (fields: FieldDef<unknown>[], contributor: string) =>
      checkFieldColumns(
        fields,
        live as LiveDataSource<unknown> | undefined,
        resolveOperatorSet,
        `field extension "${contributor}"`,
      ),
    [live, resolveOperatorSet],
  );
  return (
    <CollectClientValues
      readers={derived.clientReaders}
      rows={(source.rows ?? NO_CLIENT_ROWS) as readonly unknown[]}
      fields={base}
    >
      {(withValues) => (
        <CollectFieldOptions
          readers={derived.optionReaders}
          fields={withValues}
        >
          {(presented) => (
            <CollectFieldExtensions
              sources={[DataViewSlots.FieldExtension]}
              base={presented}
              storageKey={source.storageKey}
              rowKey={rowKey as (row: unknown, index: number) => string}
              liveColumnScope={liveColumnScope}
              validate={validate}
            >
              {(folded) => (
                <CollectFacetOptions
                  source={live as LiveDataSource<unknown> | undefined}
                  fields={folded}
                  resolveOperatorSet={resolveOperatorSet}
                >
                  {(fields) => children(fields, rowKey)}
                </CollectFacetOptions>
              )}
            </CollectFieldExtensions>
          )}
        </CollectFieldOptions>
      )}
    </CollectClientValues>
  );
}

/** A live origin holds no rows here: its client fields are refused at derivation. */
const NO_CLIENT_ROWS: readonly unknown[] = [];

/** A live source's row key: its collection's `id` field. */
function liveRowKey<TRow>(
  source: LiveDataSource<TRow>,
): (row: TRow, index: number) => string {
  const id = source.collection.id as string;
  return (row) => String((row as Record<string, unknown>)[id]);
}

/** A row activation made inside one section of a `sections` surface. */
interface SectionActivation {
  viewId: string;
  rowKey: string;
}

/** All body hooks, unconditional — the only gate is the shell's placeholder
 *  early-return, which unmounts the whole body (a separate component). */
function DataViewBodyInner<TRow>(
  // The origin's own `fields` (hand-declared, or `never` beside a collection)
  // is replaced by the folded schema.
  props: DistributiveOmit<DataViewBodyProps<TRow>, "fields"> & {
    /** The whole schema — derived, hand-declared and contributed, folded. */
    fields: FieldDef<TRow>[];
    /** The row key the origin implies (`rowKey`, or a live collection's id). */
    rowKeyOf: (row: TRow, index: number) => string;
    /** Where its collection (or a union arm) sends a row — `CollectRowActivation`. */
    collectionActivation: CollectionActivation | undefined;
    /** Present only on a `sections` surface: the surface-wide record of which
     *  section the last row activation came from. */
    sectionActivation?: {
      last: SectionActivation | null;
      record: (activation: SectionActivation) => void;
    };
  },
): ReactNode {
  const {
    rows,
    rowKeyOf: rowKey,
    collectionActivation,
    searchAccessor,
    rowTone,
    onRowActivate,
    rowActivation,
    onRowOpen,
    search,
    selectedRowId,
    emptyState,
    loadingState,
    readiness,
    paging: heldPaging,
    errorState,
    hierarchy,
    viewOptions,
    manualOrder,
    aggregate,
    selection,
    itemActions,
    creators,
    storageKey,
    viewModel,
    activeInstance,
    chrome,
    sectionActivation,
  } = props;

  // The backdrop's view type (`DataViewProps.backdrop`): resolved from the
  // same registry the instances resolve from, so the host names no view type.
  const viewTypes = DataViewSlots.View.useContributions();
  const backdropType =
    chrome.backdrop === undefined
      ? undefined
      : viewTypes.find((c) => c.type === chrome.backdrop);
  if (chrome.backdrop !== undefined && backdropType?.fullBleed !== true) {
    throw new Error(
      `DataView(${storageKey}): backdrop "${chrome.backdrop}" ` +
        (backdropType === undefined
          ? "is not a registered view type."
          : "is not a full-bleed view type — a backdrop is the surface's canvas."),
    );
  }

  // The schema is already fully merged: `props.fields` here arrives AFTER
  // `DataViewBody` derived it and folded the global `DataViewSlots.FieldExtension`
  // slot (custom columns, keyed by `{ storageKey, rowKey }`) into it. So the merged fields reach the
  // controllers and render-props uniformly with no custom-columns knowledge here.
  const fields = props.fields;

  // Derive the `hasChildren` predicate once from `hierarchy.getParentId` over
  // `rows` (absent hierarchy → always `false`). Flat views (table/gallery) use
  // it for a correct per-row `hasChildren`; the tree uses its own node count.
  const hasChildren = useMemo(() => {
    const parents = new Set<string>();
    if (hierarchy && rows) {
      for (const row of rows) {
        const pid = hierarchy.getParentId(row);
        if (pid != null) parents.add(pid);
      }
    }
    return (rowId: string) => parents.has(rowId);
  }, [rows, hierarchy]);

  // The list's own row actions plus every one its collection declares
  // (`DataViewSlots.CollectionItemAction`) — one set to the views.
  const allItemActions = useCollectionItemActions(
    (props.source?.collection ?? props.collection)?.key,
    itemActions as ItemActionsDescriptor<unknown> | undefined,
  );

  const activeViewId = activeInstance.instance.id;
  // Re-merge the bundle's code-supplied `viewOptions[type]` UNDER the instance
  // options. Idempotent on the single-source path (the model already merged
  // them into `instance.options`); on the merged path the model built its
  // entries from static metadata only, so this is where code-only options
  // (`renderRow`, `renderBody`, …) reach the view. Memoized so the `options`
  // identity stays stable across renders (as `instance.options` was).
  const mergedOptions = useMemo(
    () => ({
      ...((viewOptions?.[activeInstance.instance.type] as object | undefined) ??
        {}),
      ...((activeInstance.instance.options as object | undefined) ?? {}),
    }),
    [viewOptions, activeInstance],
  );
  // ONE per-row activation resolver, so no view ever sees the two host props and
  // no view can re-invent the "is this row clickable" question. `onRowActivate`
  // is the every-row case folded into the same shape; `rowActivation` is the
  // per-row one. Passing both is a bug, not a precedence question — two props
  // asserting whether a row activates can disagree — so it throws rather than
  // picking a winner.
  const resolveRowActivation = useMemo<
    ((row: TRow) => Activation | undefined) | undefined
  >(() => {
    if (rowActivation && onRowActivate) {
      throw new Error(
        "DataView: pass `onRowActivate` (every row activates) or `rowActivation` " +
          "(per row), never both — they are two answers to one question.",
      );
    }
    const own: ((row: TRow) => Activation | undefined) | undefined =
      rowActivation ??
      (onRowActivate ? (row) => () => onRowActivate(row) : undefined);
    // The owner's destination (a collection's, or the row's arm's) is the
    // navigation; the list's own activation runs after it — a host's business
    // with its own chrome, never instead of where the row goes.
    const base: ((row: TRow) => Activation | undefined) | undefined =
      collectionActivation === undefined
        ? own
        : (row) => {
            const link = collectionActivation(row);
            const mine = own?.(row);
            if (link === undefined) return mine;
            return mine === undefined
              ? link
              : afterOpen(link, () => runActivation(mine));
          };
    const record = sectionActivation?.record;
    if (!base || !record) return base;
    // `undefined` passes straight through: a non-activating row stays one.
    return (row) => {
      const activation = base(row);
      return activation === undefined
        ? undefined
        : beforeOpen(activation, () =>
            record({ viewId: activeViewId, rowKey: rowKey(row, 0) }),
          );
    };
  }, [
    rowActivation,
    onRowActivate,
    collectionActivation,
    sectionActivation?.record,
    activeViewId,
    rowKey,
  ]);
  // Reveal the selection unless it was just activated in ANOTHER section.
  const lastActivation = sectionActivation?.last;
  const revealSelection = !(
    lastActivation != null &&
    lastActivation.viewId !== activeViewId &&
    lastActivation.rowKey === selectedRowId
  );

  // `stateFor` is a ViewGetter: the same object until this view's state
  // changes, so everything memoised on `activeState` downstream holds. A
  // controlled `search` replaces this tab's stored query: the surface's own
  // field owns it, and every part that shows or applies a query reads this one
  // — derived in a memo, so the override keeps that identity guarantee.
  const storedState = viewModel.stateFor(activeViewId);
  const searchQuery = search?.query;
  const activeState = useMemo(
    () =>
      searchQuery === undefined
        ? storedState
        : { ...storedState, query: searchQuery },
    [storedState, searchQuery],
  );

  // The fold in effect: suspended while a search is typed (a match must never
  // hide behind "…"). Computed from `activeState` BEFORE the live branch below
  // zeroes `query`, and carried through that branch like `properties`.
  // A view that draws no fold lines gets no fold at all — applying one would
  // hold its live paging for rows it never set aside.
  // The active view nests THIS source's rows (the table over a hierarchy).
  // Nested, a view has no flat section of rows to fold and no flat rank to drag.
  const activeNests =
    hierarchy != null && activeInstance.viewType.nestsHierarchy === true;
  const activeSupportsFold =
    activeInstance.viewType.supportsFold !== false && !activeNests;
  const fold = activeSupportsFold ? effectiveFold(activeState) : undefined;
  // Which sections' fold lines are open. Ephemeral on purpose — in memory, keyed
  // by the view it was opened in, so switching views or reloading re-closes
  // every fold (a fold is a standing narrowing; an open one is a glance).
  const [openFoldState, setOpenFoldState] = useState<{
    viewId: string;
    keys: ReadonlySet<string>;
  }>({ viewId: activeViewId, keys: NO_OPEN_FOLDS });
  const openFolds =
    openFoldState.viewId === activeViewId ? openFoldState.keys : NO_OPEN_FOLDS;
  const setFoldOpen = useCallback(
    (sectionKey: string, open: boolean) =>
      setOpenFoldState((prev) => {
        const next = new Set(
          prev.viewId === activeViewId ? prev.keys : NO_OPEN_FOLDS,
        );
        if (open) next.add(sectionKey);
        else next.delete(sectionKey);
        return { viewId: activeViewId, keys: next };
      }),
    [activeViewId],
  );

  // The operator-set resolver, read here (not off the filter controller below)
  // because the live source's paging hold needs it before that exists.
  const resolveOperatorSet = useResolveOperatorSet();
  // The fold rule's `keep` tree as a row filter. One naming an unavailable
  // rule never folds: the body renders the rule error instead (below).
  const foldKeepFilter = useRowFilter(
    fold?.keep ?? null,
    fields,
    resolveOperatorSet,
  );
  const matchesFoldKeep = bodyRowMatcher(foldKeepFilter);

  // A live source: its fields resolved against the collection (what the Sort
  // and Filter controls offer, and each field's column).
  const liveSource = props.source;
  const livePlan = useMemo(
    () =>
      liveSource
        ? resolveLiveFields(fields, liveSource, resolveOperatorSet, "fields")
        : null,
    [liveSource, fields, resolveOperatorSet],
  );

  // Optional live source (always called; `null` without one). When present,
  // filter/sort/search/paginate run server-side over the live `activeState`,
  // so its pages replace `rows` and the client pipeline (`useFlatRows`) is
  // neutralized into a pass-through below.
  const groupingRegistry = useGroupingRegistry();
  // The grouping clock, read ONCE per surface: one quantized `now` (local
  // midnight) shared by every view child, re-armed at the day boundary. Reading
  // it per view would give two views of the same surface two different memo keys
  // for the same day.
  const now = useGroupingClock();
  const collapsedSections = viewModel.collapsedSectionsFor(activeViewId);
  const live = useLiveSource({
    source: liveSource,
    plan: livePlan,
    fields,
    state: activeState,
    resolveOperatorSet,
    resolveGrouping: groupingRegistry.resolve,
    now,
    collapsedSections,
  });
  // The server-ordered origin in effect, as the body renders it.
  const origin: SourceView<TRow> | null = live;

  // Filter controller — the popover builder consumes the full surface (filter,
  // setFilter, filterableFields, resolveOperatorSet, ruleCount).
  const setActiveFilter = useCallback(
    (filter: FilterGroup | null) => viewModel.setFilter(activeViewId, filter),
    [viewModel, activeViewId],
  );
  const filterController = useFilterController(
    livePlan?.filterFields ?? fields,
    activeState.filter,
    setActiveFilter,
  );

  // Sort controller — the popover builder consumes the flat surface (rules,
  // sortableFields, ruleCount, add/remove/setDirection/setField/move/clear).
  const setActiveSortRules = useCallback(
    (rules: SortRule[]) => viewModel.setSortRules(activeViewId, rules),
    [viewModel, activeViewId],
  );
  const sortController = useSortController(
    livePlan?.sortFields ?? fields,
    activeState.sort,
    setActiveSortRules,
  );
  // The fields a column header may sort by: exactly the Sort control's.
  const sortableIds = useMemo(
    () => new Set(sortController.sortableFields.map((f) => f.id)),
    [sortController.sortableFields],
  );
  // Saved sort/filter presets are NOT read here. They are config a user only
  // ever looks at with a panel open, and each panel is a mounted component that
  // can hook freely — so `useSortPresets` / `useFilterPresets` live in the sort
  // and filter panels. Reading them here made every DataView on the page
  // subscribe to its presets config just to draw a closed icon.

  // A view opts out of the Sort pill via `supportsSort: false`. Every current
  // view honors sort (the tree sorts each sibling group by field, defaulting to
  // manual/rank order), so this stays enabled; the flag remains for future
  // sort-less view types. Default (undefined) = honors sort.
  const activeSupportsSort = activeInstance.viewType.supportsSort !== false;
  // Whether the active view can render a flat rank-ordered, drag-reorderable
  // body at all (list/table opt in; gallery/tree do not). It says nothing about
  // whether an order is *available* — see `manualOrderActive` below.
  const activeSupportsManualOrder =
    !!activeInstance.viewType.supportsManualOrder && !activeNests;
  // Whether the sort control applies at all is the SORT CONTROL's own
  // `isApplicable` now (`activeSupportsSort && sortableFields.length > 0`, both
  // published on the controls context) — the host no longer decides which
  // controls exist. Manual order does not suppress it: a sort simply overrides
  // the manual order (Notion's model), so the control must stay reachable to
  // clear it.

  // Group-by support mirrors sort: every built-in view (including the tree,
  // which partitions its ROOTS into sections) supports it today; the opt-out
  // flag remains for future group-less view types. The settings menu hides the
  // group-by control accordingly.
  const activeSupportsGroupBy =
    activeInstance.viewType.supportsGroupBy !== false;

  // Which end of a bucket's ordinal the sections read from: the direction of the
  // view's own sort ON THE GROUPED FIELD, so "Upcoming" (startsAt asc) reads
  // Today → Tomorrow → Later, and "All" (startsAt desc) reads newest first, with
  // no second config axis.
  //
  // It reads `activeState.sort` and NOT `effectiveState.sort`, which a
  // live source zeroes out (the SQL already sorted) — the views can
  // therefore no longer see the direction themselves, which is exactly why this
  // is computed here and threaded down.
  const groupOrder: "asc" | "desc" =
    activeState.sort.find((r) => r.fieldId === activeState.groupBy?.fieldId)
      ?.direction ?? "asc";
  // The `Grouping` registry read, likewise once per surface: the toolbar's
  // group-by control asks "which fields can group?" through it (the settings
  // contribution's `isApplicable` is a pure function and cannot read a slot).
  // Which groupings the Group-by control offers: every one in memory; under a
  // live source only a pair that lowers (`liveGroupLowering`) — the picker
  // can then never write a grouping whose sections would only say what
  // happens to be loaded.
  const offersGrouping = useCallback(
    (field: FieldDef<unknown>, grouping: FieldGrouping): boolean =>
      livePlan === null ||
      liveGroupLowering(livePlan as LiveFieldPlan<unknown>, field, grouping)
        .kind !== "none",
    [livePlan],
  );
  const groupableField = useCallback(
    (field: FieldDef<unknown>): boolean =>
      isGroupableField(field, groupingRegistry.has) &&
      groupingRegistry
        .setFor(field.type ?? "text")
        .groupings.some((g) => offersGrouping(field, g)),
    [groupingRegistry, offersGrouping],
  );

  // The paged read behind the rows, if any: a live source's own pages, or
  // the consumer's `paging` over the rows it holds. A sectioned origin has no
  // single read to page — each section pages its own (`DataViewSection.paging`)
  // — so the body's footer is its groups read's, which never pages and says
  // when it is full.
  const paging: DataViewPaging<TRow> | undefined = origin
    ? origin.kind === "sectioned"
      ? origin.groupsPaging
      : origin.paging
    : heldPaging;
  const loadedRows: readonly TRow[] = origin
    ? origin.rows
    : (rows ?? (NO_ROWS as readonly TRow[]));
  // The read's tail — its last loaded row (the last paged one, in `rows`
  // order) — and how many of the rows it has loaded.
  const pagedTail = useMemo(() => {
    if (!paging) return null;
    const isPaged = paging.isPaged;
    if (!isPaged) {
      const i = loadedRows.length - 1;
      return {
        tail:
          i < 0
            ? null
            : { row: loadedRows[i]!, key: rowKey(loadedRows[i]!, i) },
        count: loadedRows.length,
      };
    }
    let tail: { row: TRow; key: string } | null = null;
    let count = 0;
    loadedRows.forEach((row, i) => {
      if (!isPaged(row)) return;
      count++;
      tail = { row, key: rowKey(row, i) };
    });
    return { tail, count };
  }, [paging, loadedRows, rowKey]);
  const tail = pagedTail?.tail ?? null;
  // Paging waits while the tail is off screen — the next page would land
  // where nobody can see it, and the sentinel, still in view, would page the
  // whole read in. A gate on `hasNextPage`, not a hidden footer: unmounting
  // the sentinel behind the observer's back would never re-observe it.
  //  - folded: the fold is closed everywhere and the tail is folded (opening
  //    any fold lifts the hold);
  const tailFolded =
    tail !== null &&
    isTailFolded([tail.row], {
      fold,
      openCount: openFolds.size,
      isKept: fold
        ? makeFoldKeep(matchesFoldKeep, {
            selectedRowId,
            rowKey: (row) => rowKey(row, 0),
          })
        : () => true,
      rowKey,
    });
  //  - in a collapsed section (a sectioned origin has no single tail: each
  //    section's read stops with it);
  const tailCollapsed =
    tail !== null &&
    origin?.kind !== "sectioned" &&
    activeState.groupBy !== undefined &&
    collapsedSections.size > 0 &&
    isSectionCollapsed(
      partitionIntoSections(loadedRows, fields, activeState.groupBy, rowKey, {
        resolveGrouping: groupingRegistry.resolve,
        now,
        order: groupOrder,
      }),
      tail.key,
      collapsedSections,
    );
  //  - hidden by the view's search or filter (in memory: a live source
  //    already searched and filtered in SQL).
  const matchesView = useRowMatcher(
    fields,
    origin ? NO_QUERY : activeState,
    resolveOperatorSet,
    searchAccessor,
  );
  //  - or not drawn at all: no paged row is on screen yet (the consumer's
  //    other reads still loading), so there is no tail to page past.
  const tailHidden =
    tail === null ||
    tailFolded ||
    tailCollapsed ||
    (matchesView !== null && !matchesView(tail.row));
  const scrollHandle = useInfiniteScroll({
    hasNextPage: (paging?.canGrow ?? false) && !tailHidden,
    isFetchingNextPage: paging?.growing ?? false,
    isFetchNextPageError: paging?.stalled != null,
    fetchNextPage: paging?.loadMore ?? NOOP,
    ...(paging?.stalled ? { retry: paging.stalled.retry } : {}),
  });

  // Whether a row-order contributor may own this view's order. Each clause is a
  // structural exclusion, not a preference:
  const rowOrderEnabled =
    activeSupportsManualOrder && // list / table only
    manualOrder == null && // a consumer's domain order wins
    props.source == null && // a live source is server-sorted ⇒ the client cannot own the order
    aggregate == null; // an aggregate representative's rank cannot stand for its members
  // Group-by is deliberately NOT a clause. Reordering WITHIN a section is
  // well-defined (the contributed order covers the whole unpartitioned set, so a
  // drop anchored on a same-section neighbour resolves globally), and a drop into
  // ANOTHER section — which would need the group field written — is refused by
  // the view unless the config supplies `ManualOrderConfig.onReseat`. Suspending
  // the whole order because one kind of drop is unsupported is what made
  // reordering silently stop working under a group-by.

  // The per-view Properties control (which fields render in the body + their
  // order) now lives in the settings gear as a `view`-scope `DataViewSlots.Setting`
  // contribution (see `PropertiesControl`), reading/writing the same
  // `activeState.properties` / `viewModel.setProperties` via
  // `DataViewSettingsContext` — no host wiring needed here.

  // Live substitution: when a `source` drives this DataView, the SQL already
  // applied sort/filter/search, so feed the loaded pages' rows and neutralize the client pipeline (`useFlatRows` collapses to a pass-through
  // when sort/filter/query are empty). Absent → the in-memory path is untouched.
  const effectiveRows: readonly unknown[] = origin
    ? origin.rows
    : ((rows ?? NO_ROWS) as readonly unknown[]);
  // Neutralize ONLY the server-owned dimensions (sort/filter/query already ran in
  // SQL). `properties` is display-only — it never touches the query — so the
  // `...activeState` spread deliberately PRESERVES it so the views still honor
  // Properties on the live path.
  const serverOrdered = origin != null;
  const effectiveState = useMemo<ViewState>(
    () =>
      serverOrdered
        ? { ...activeState, sort: [], filter: null, query: "", fold }
        : { ...activeState, fold },
    [serverOrdered, activeState, fold],
  );
  // What renders in place of the view, if anything: server error > failed
  // read > failed field > loading > pending field > the view (see
  // `resolveBodyState`).
  // A field the view is laid out by (group / sort / filter / fold) whose own
  // values are pending or failed holds the body too (see `resolveBodyState`).
  // The fold passed is the one in EFFECT (`fold` above: suspended while a
  // search is typed, absent in a view without fold lines), not the stored one.
  const readFields = fieldsReadByView(
    fields as FieldDef<unknown>[],
    activeState,
    fold,
  );
  // A rule the in-memory evaluation cannot resolve would be dropped — every
  // row shown (the filter) or nothing folded (the fold IN EFFECT): loading
  // while the deferred tier may still contribute it, the rule error after.
  // A live origin lowers its filter itself (its `error`); its fold, like
  // every fold, runs here.
  const deferredComplete = useDeferredLoadComplete();
  const filterUnavailable = useMemo(
    () =>
      origin == null
        ? unavailableRules(activeState.filter, fields, resolveOperatorSet)
        : NO_UNAVAILABLE,
    [origin, activeState.filter, fields, resolveOperatorSet],
  );
  const unavailable = useMemo(
    () => ({
      filter: filterUnavailable,
      fold:
        foldKeepFilter.kind === "unavailable"
          ? foldKeepFilter.rules
          : NO_UNAVAILABLE,
    }),
    [filterUnavailable, foldKeepFilter],
  );
  const bodyState = resolveBodyState({
    server: origin,
    readiness,
    readFields,
    unavailable,
    deferredComplete,
  });
  // The rule error's way out: drop its rules from the tree they sit in and
  // save the view, like any filter / fold / sort edit.
  const removeUnavailableRules = useCallback(
    (error: Extract<typeof bodyState, { kind: "rule-error" }>["error"]) => {
      if (!(error instanceof UnavailableFilterRuleError)) {
        const gone = new Set(error.fieldIds);
        viewModel.setSortRules(
          activeViewId,
          activeState.sort.filter((r) => !gone.has(r.fieldId)),
        );
        return;
      }
      const ids = error.rules.map((r) => r.id);
      if (error.tree === "filter") {
        viewModel.setFilter(
          activeViewId,
          activeState.filter && pruneRules(activeState.filter, ids),
        );
        return;
      }
      // The STORED fold: the one in effect is it, unless a search suspends it
      // (and then no fold rule error is shown).
      const stored = activeState.fold;
      const keep = stored ? pruneRules(stored.keep, ids) : null;
      viewModel.setFold(
        activeViewId,
        stored && keep ? { ...stored, keep } : null,
      );
    },
    [viewModel, activeViewId, activeState],
  );

  // A sections surface renders this view as one section, and a section whose
  // config row says `hideWhenEmpty` is decided HERE, before the view mounts:
  // hidden while the rows are not known yet (a loading section would otherwise
  // paint "empty" for an unknown — or flash in and vanish), hidden once they
  // are known and none survive the view's filter, shown otherwise (a failed
  // read included, so its error is not swallowed). The same predicate the views
  // apply — `useRowFilter` over the same fields — under the same scope
  // (`scopeFilterRows`, the tree's own function), so a section can never be
  // shown empty or hidden while its view would render rows.
  const sectioned = isSectionsToolbar(chrome.toolbar);
  const presentation = viewModel.sectionFor(activeViewId);
  const decideEmptiness = sectioned && presentation.hideWhenEmpty;
  // An unavailable rule never reaches `hasNoRows`'s answer: the body state is
  // then the rule error (or loading), which decides the section first.
  const emptinessFilter = bodyRowMatcher(
    useRowFilter(
      decideEmptiness && !origin ? activeState.filter : null,
      fields,
      resolveOperatorSet,
    ),
  );
  const rootsScoped = activeState.filterScope === "roots" && activeNests;
  const hasNoRows = useMemo(() => {
    if (!decideEmptiness) return false;
    // A live origin already filtered in SQL — and a sectioned one says how
    // many sections exist whether or not any of their rows are loaded.
    if (origin) {
      return origin.kind === "sectioned"
        ? origin.sections.length === 0
        : origin.rows.length === 0;
    }
    const matches = emptinessFilter ?? (() => true);
    if (!rows) return true;
    if (!rootsScoped || !hierarchy) return !rows.some((row) => matches(row));
    const items = rows.map((row, i) => ({ row, key: rowKey(row, i) }));
    return (
      scopeFilterRows(items, "roots", {
        key: (item) => item.key,
        parentOf: (item) => hierarchy.getParentId(item.row),
        matches: (item) => matches(item.row),
      }).length === 0
    );
  }, [
    decideEmptiness,
    origin,
    emptinessFilter,
    rootsScoped,
    rows,
    rowKey,
    hierarchy,
  ]);
  const sectionHidden =
    decideEmptiness &&
    (bodyState.kind === "loading" || (bodyState.kind === "view" && hasNoRows));

  // The fold line's controls, handed to every view — present exactly when a fold
  // is in effect, so a view never draws a line for a rule that is suspended.
  const foldSummary = fold
    ? summarizeFilter(
        fold.keep,
        fields as FieldDef<unknown>[],
        resolveOperatorSet,
      )
    : null;
  const foldLines: DataViewFoldLines | undefined = fold
    ? {
        open: openFolds,
        setOpen: setFoldOpen,
        // The same words the filter control's tooltip uses for a filter tree:
        // "Folding all but: Updated is within past 30 days +1".
        summary: foldSummary
          ? `Folding all but: ${foldSummary.label}${foldSummary.more ? ` +${foldSummary.more}` : ""}`
          : undefined,
      }
    : undefined;

  // Where grouped sections come from: declared by a sectioned origin, else
  // partitioned from the rows (by appearance when the server orders by the
  // grouped column).
  // Keyed on the parts, not the origin object (a fresh one each render), so
  // the views' section pipeline re-partitions only when they change.
  const declaredSections =
    origin?.kind === "sectioned" ? origin.sections : null;
  const rowSectionOrder =
    origin?.kind === "flat" ? origin.sectionOrder : "bucket";
  const sectioning = useMemo(
    (): DataViewSectioning<TRow> =>
      declaredSections !== null
        ? { kind: "declared", sections: declaredSections }
        : { kind: rowSectionOrder },
    [declaredSections, rowSectionOrder],
  );

  // The flat read's pages drawn as placeholders, around the view — only when
  // every row of the view is the read's: with `isPaged` the read's rows sit
  // among others', so a placeholder above the view would stand above rows
  // that are not the read's (its far pages then simply leave the screen, and
  // come back as the read's first or last drawn page nears the viewport).
  // A declared section's are drawn by its `SectionBody`.
  const flatPlaceholders =
    paging && !paging.isPaged ? paging.placeholders : null;

  // The rows on screen, reported to every paged read behind them — each read
  // keeps the pages near its visible rows live and releases the rest. One
  // measurement per DataView (the rows the view draws, `[data-row-key]`, and
  // the placeholders, which carry their key the same way), split per read by
  // the keys it supplies, in its own order: the flat read's placeholders and
  // paged rows, or each declared section's own.
  const [rowsHost, setRowsHost] = useState<HTMLElement | null>(null);
  const viewportTargets = useMemo(() => {
    const out: (PagedReadLayout & { sink: DataViewViewportSink })[] = [];
    if (declaredSections !== null) {
      for (const section of declaredSections) {
        const { before, after } = section.paging.placeholders;
        out.push({
          id: `section:${section.key}`,
          sink: section.paging.viewport,
          keys: [
            ...before.map((p) => p.key),
            ...section.rows.map((row, i) => rowKey(row, i)),
            ...after.map((p) => p.key),
          ],
          placeholders: [...before, ...after],
        });
      }
    } else if (paging) {
      const isPaged = paging.isPaged;
      const keys: string[] = [];
      for (const p of flatPlaceholders?.before ?? []) keys.push(p.key);
      loadedRows.forEach((row, i) => {
        if (!isPaged || isPaged(row)) keys.push(rowKey(row, i));
      });
      for (const p of flatPlaceholders?.after ?? []) keys.push(p.key);
      out.push({
        id: "flat",
        sink: paging.viewport,
        keys,
        placeholders: flatPlaceholders
          ? [...flatPlaceholders.before, ...flatPlaceholders.after]
          : [],
      });
    }
    return out;
  }, [declaredSections, paging, flatPlaceholders, loadedRows, rowKey]);
  // The rows the measurement is matched against, per read: a measurement
  // taken before they were drawn says nothing about them (`useVisibleRowKeys`
  // is `measuring` again until one taken after), so a head that just landed
  // — or a new query's — is never reported off screen by the rows it
  // replaced.
  const viewportReads = useMemo(
    () =>
      viewportTargets.length === 0 ? null : viewportTargets.map((t) => t.keys),
    [viewportTargets],
  );
  // …and how much room each row takes (its advance), which a placeholder of
  // released rows is sized by.
  const {
    keys: visibleKeys,
    advances,
    rowPitch,
  } = useVisibleRowKeys(rowsHost, viewportReads);
  // The room the rows last took: a query starting over holds it while it
  // loads, so the page never shrinks under a reader scrolled down.
  const heldHeight = useHeldHeight(rowsHost, bodyState.kind === "view");
  useEffect(() => {
    if (visibleKeys === "measuring") return;
    for (const t of viewportTargets) {
      t.sink.report(visibleRowsOf(t.keys, visibleKeys));
    }
  }, [visibleKeys, viewportTargets]);
  // Every placeholder drawn at exactly the room its rows took when they were
  // released — so a page turning into one changes no layout.
  const placeholderHeight = usePlaceholderHeights(
    viewportTargets,
    advances,
    rowPitch,
  );
  // What may resize the content above the reader: a page turning into a
  // placeholder or back — drawn or not (under `isPaged` the page's rows just
  // leave `rows`, which shrinks what is above all the same). A placeholder
  // takes its rows' exact room, so a release moves nothing; a page's rows
  // landing may still differ from its placeholder (rows that changed, or
  // were never measured), and under `isPaged` nothing stands in at all. A
  // change of it keeps the first row on screen where it is
  // (`KeepAnchorAcross`), so rows released or landing above the viewport
  // never move what is being read.
  const anchorKey = useMemo(
    () =>
      JSON.stringify([
        paging?.placeholders ?? null,
        declaredSections?.map((s) => s.paging.placeholders) ?? null,
      ]),
    [paging, declaredSections],
  );

  // The contributed row order, as the `RowOrderReader` beside the surface
  // last reported it — only ever for the active view, and only while the fold
  // is on (a report for another view, or a fold turned off, is no order).
  const [reportedOrder, setReportedOrder] = useState<ReportedRowOrder | null>(
    null,
  );
  const onRowOrder = useCallback((next: ReportedRowOrder) => {
    setReportedOrder((prev) =>
      prev?.viewId === next.viewId && prev.order === next.order ? prev : next,
    );
  }, []);
  const contributedRowOrder =
    rowOrderEnabled && reportedOrder?.viewId === activeViewId
      ? reportedOrder.order
      : null;

  // A hidden section still runs a sectioned origin's reads: whether it has
  // any section is what those reads answer.
  if (sectionHidden) {
    return origin?.kind === "sectioned" ? origin.readers : null;
  }

  // The global `RowOrder` slot's fold is a reader BESIDE the surface, never
  // around it: a view switch that turns it on or off must not change any
  // element above the band, the aside or the view (it would remount them all).
  // The surface below is a plain function call, NOT a component — so it
  // contains no hooks; every hook above stays in this component's body.
  //
  // The fold takes the RAW rows and derives the ordered set itself, but only when
  // `enabled` — deriving it here would cost EVERY DataView (tree, gallery,
  // server-paginated) an extra `useFlatRows` pass per render for a set it discards.
  return (
    <>
      <RowOrderReader
        enabled={rowOrderEnabled}
        storageKey={storageKey}
        viewId={activeViewId}
        rowKey={rowKey as (row: unknown, index: number) => string}
        rows={effectiveRows}
        fields={fields as FieldDef<unknown>[]}
        state={activeState}
        resolveOperatorSet={filterController.resolveOperatorSet}
        searchAccessor={
          searchAccessor as ((row: unknown) => string) | undefined
        }
        onOrder={onRowOrder}
      />
      {(() => {
        // One rule everywhere — the render path never branches on where the order
        // came from. The consumer's domain order outranks any contributor.
        const cfg =
          (manualOrder as ManualOrderConfig<unknown> | undefined) ??
          contributedRowOrder ??
          null;
        // A field sort OVERRIDES the manual order and suspends drag; clearing it
        // restores the order. The sort test lives here and NOT in `rowOrderEnabled`
        // on purpose: toggling a sort off/on must not tear down the contributor's
        // live subscription, and `useDataViewSections`'s `manualRank ⇒ sort: []`
        // rule stays untouched — the host simply withholds the config while a sort
        // is set.
        const manualOrderActive =
          cfg != null &&
          activeSupportsManualOrder &&
          activeState.sort.length === 0;
        // The mirror image: an order EXISTS for this view but a sort is
        // shadowing it. After grouping stopped suspending drag, this is the last
        // silent cause of "dragging stopped working", so the sort popover says so.
        const manualOrderOverridden =
          cfg != null &&
          activeSupportsManualOrder &&
          activeState.sort.length > 0;

        // The host passes RAW rows; each view applies the processing matching its own
        // semantics (gallery/list call `useFlatRows`, the table nests over a hierarchy).
        const renderProps: DataViewRenderProps<unknown> = {
          rows: effectiveRows,
          fields: fields as DataViewRenderProps<unknown>["fields"],
          rowKey: rowKey as DataViewRenderProps<unknown>["rowKey"],
          state: effectiveState,
          setSort: (fieldId) => {
            if (!sortableIds.has(fieldId)) {
              throw new Error(
                `DataView "${storageKey}": setSort("${fieldId}") names a field this list cannot sort by`,
              );
            }
            viewModel.setSort(activeViewId, fieldId);
          },
          sortHeader: { active: activeState.sort, sortable: sortableIds },
          setFilter: (filter) => viewModel.setFilter(activeViewId, filter),
          rowActivation:
            resolveRowActivation as DataViewRenderProps<unknown>["rowActivation"],
          onRowOpen: onRowOpen as DataViewRenderProps<unknown>["onRowOpen"],
          selectedRowId,
          revealSelection,
          options: mergedOptions,
          searchAccessor:
            searchAccessor as DataViewRenderProps<unknown>["searchAccessor"],
          rowTone: rowTone as DataViewRenderProps<unknown>["rowTone"],
          hierarchy: hierarchy as DataViewRenderProps<unknown>["hierarchy"],
          // `manualOrderActive` already implies `cfg != null` (TS cannot see it
          // through the boolean), hence the assertion.
          manualOrder: manualOrderActive
            ? (cfg as ManualOrderConfig<unknown>)
            : undefined,
          // Aggregate is a pure pipeline transform (orthogonal to the supports* flags):
          // hand it to every flat view; only those rendering via `useDataViewSections`
          // (list/table/gallery) act on it — the tree ignores it.
          aggregate: aggregate as DataViewRenderProps<unknown>["aggregate"],
          selection,
          expanded: activeState.expanded,
          setExpanded: (changes) =>
            viewModel.setExpanded(activeViewId, changes),
          now,
          groupOrder,
          // In memory without paging the rows are the whole set; a paged read
          // says when it has read to the end, which of the held rows it
          // pages, and — while no search or filter hides rows of it (a live
          // source asks for one only then) — its total.
          rowsComplete: (!paging || paging.complete
            ? true
            : {
                growable: paging.isPaged ?? ALL_ROWS,
                total: matchesView === null ? (paging.total ?? null) : null,
              }) as DataViewRenderProps<unknown>["rowsComplete"],
          sectioning: sectioning as DataViewRenderProps<unknown>["sectioning"],
          collapsedSections: viewModel.collapsedSectionsFor(activeViewId),
          setSectionCollapsed: (key, collapsed) =>
            viewModel.setSectionCollapsed(activeViewId, key, collapsed),
          foldLines,
          // The flat read's placeholders, drawn around the view below — a grid
          // view keeps its cards' columns across a release above them.
          placeholders: flatPlaceholders ?? undefined,
          emptyState,
          itemActions:
            allItemActions as DataViewRenderProps<unknown>["itemActions"],
          hasChildren,
          creators,
          // The surface's own declaration, straight off the chrome (the ONE
          // place both hosts set it) — the view child decides what to tighten.
          density: chrome.density,
          groupHeaders: chrome.groupHeaders,
        };

        // The ONE context every toolbar control and settings contribution reads —
        // no prop-threading. Nothing here is derived: every field was computed
        // above (or, for `manualOrderOverridden`, a few lines up) and is merely
        // re-homed, so a control's summary and what actually filters/sorts come
        // from the very same controller objects the row pipeline uses.
        //
        // Provided around the TOOLBAR only (below), never around the view body:
        // view children have a deliberate contract (`DataViewRenderProps`), and an
        // ambient back door to `viewModel` would be a second undocumented seam.
        const controlsContext: DataViewControlsContextValue = {
          storageKey,
          fields: fields as DataViewRenderProps<unknown>["fields"],
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
          filter: filterController as FilterController<unknown>,
          sort: sortController as SortController<unknown>,
        };

        const onQueryChange =
          search?.onQueryChange ??
          ((next: string) => viewModel.setQuery(activeViewId, next));
        const body = (
          <>
            {/* One density for every view type, so a row's controls and decorations
                (avatars, status dots, chips, buttons) look identical whether the same
                data is shown as a table, tree, list, or gallery. The table view's
                `data-table` primitive already defaults to `xs`; declaring it here once
                brings tree/list/gallery in line instead of each falling through to the
                ambient `md` default. */}
            {/* The host owns the loading→empty precedence: while loading it renders the
                view-type's declared skeleton and NEVER calls `renderIsolated`, so a view
                child only ever renders in the confirmed-not-loading state (it can no
                longer mishandle loading and let a skeleton-less empty state leak through). */}
            {/* Keyed by the active instance id so switching view instances remounts
                the view child (and its loading skeleton): virtualizer measurement
                caches, inline editors, and local tree expand state are per-instance
                and must not leak between two instances of the same view type. */}
            <ControlSizeProvider key={activeViewId} size="xs">
              {/* The box the rows on screen are measured in, and the region
                  anchored across a page released or landing above the reader
                  — its own anchoring alone (the box opts out of the
                  browser's). */}
              <KeepAnchorAcross
                changeKey={anchorKey}
                hostRef={setRowsHost}
                anchorAttr="data-row-key"
                weakAttr={PAGE_PLACEHOLDER_ATTR}
                // A full-bleed view (a map under an overlay band) fills the
                // surface: the region passes the body's height through.
                fill={activeInstance.viewType.fullBleed === true}
              >
                <PlaceholderHeightContext.Provider value={placeholderHeight}>
                  {bodyState.kind !== "view" ? (
                    <div
                      style={
                        bodyState.kind === "loading" && heldHeight !== null
                          ? { minHeight: heldHeight }
                          : undefined
                      }
                    >
                      <BodyFallback
                        state={bodyState}
                        errorState={errorState}
                        loadingState={loadingState}
                        loadingVariant={activeInstance.viewType.loadingVariant}
                        loadingCount={activeInstance.viewType.loadingCount}
                        onRemoveRules={removeUnavailableRules}
                      />
                    </div>
                  ) : (
                    // Holds a dropped row at its new slot until the producer's
                    // own order carries the move — no snap-back while the write
                    // is in flight, for every producer (see the hook).
                    <>
                      {/* The paged read's far pages, above its rows. */}
                      {flatPlaceholders ? (
                        <PagePlaceholders
                          placeholders={flatPlaceholders.before}
                        />
                      ) : null}
                      {/* A live page that could not refresh keeps its rows on
                      screen; its notice sits above them, naming where. */}
                      {paging && paging.notices.length > 0 ? (
                        <PageNotices
                          notices={paging.notices}
                          rows={effectiveRows}
                          fields={fields as FieldDef<unknown>[]}
                          rowKey={
                            rowKey as (row: unknown, index: number) => string
                          }
                        />
                      ) : null}
                      <PendingMoveOverlay
                        config={renderProps.manualOrder}
                        rows={effectiveRows}
                        rowKey={renderProps.rowKey}
                      >
                        {(manualOrder) =>
                          renderIsolated(
                            DataViewSlots.View,
                            activeInstance.viewType as unknown as Contribution,
                            { ...renderProps, manualOrder },
                          )
                        }
                      </PendingMoveOverlay>
                      {flatPlaceholders ? (
                        <PagePlaceholders
                          placeholders={flatPlaceholders.after}
                        />
                      ) : null}
                    </>
                  )}
                </PlaceholderHeightContext.Provider>
              </KeepAnchorAcross>
            </ControlSizeProvider>
            {/* Infinite scroll over a paged read (a live source, or the
                consumer's `paging`): the error-gated footer (loading-more
                spinner, Retry on a failed page, the IntersectionObserver
                sentinel, and — for a read at its cap — the line saying it
                stops). */}
            {/* A sectioned origin's reads (they draw nothing). Mounted
                beside the view, so a read starting or stopping never
                remounts it. */}
            {origin?.kind === "sectioned" ? origin.readers : null}
            {paging ? (
              <InfiniteScrollFooter
                handle={scrollHandle}
                truncated={
                  paging.truncated === false
                    ? false
                    : {
                        shown:
                          origin?.kind === "sectioned"
                            ? origin.sections.length
                            : (pagedTail?.count ?? 0),
                        hint: paging.truncated.hint,
                      }
                }
              />
            ) : null}
          </>
        );

        // Sections: this view is one section of the surface, under its own
        // header — no band, no frame. The header's `⋯` holds this view's
        // controls, so the controls provider wraps that panel alone, exactly as
        // it wraps a hosted frame's options trigger.
        if (isSectionsToolbar(chrome.toolbar)) {
          return (
            <ViewSection
              instance={activeInstance}
              presentation={presentation}
              setCollapsed={(collapsed) =>
                viewModel.setViewCollapsed(activeViewId, collapsed)
              }
              header={chrome.toolbar.forms?.header ?? "eyebrow"}
              creators={creators?.filter(
                (c) => c.views === undefined || c.views.includes(activeViewId),
              )}
              controls={controlsContext}
              query={activeState.query}
              onQueryChange={onQueryChange}
              searchPlaceholder={chrome.searchPlaceholder}
              actions={viewModel.actions}
            >
              {body}
            </ViewSection>
          );
        }

        // Hosted: no band. The surface's frame is its own header and places the
        // options trigger; the controls provider wraps that trigger alone, so the
        // view body still sees only its `DataViewRenderProps` contract.
        if (isHostedToolbar(chrome.toolbar)) {
          const Frame = chrome.toolbar.frame;
          return (
            <Frame
              options={
                <DataViewControlsProvider {...controlsContext}>
                  <HostedOptions
                    query={activeState.query}
                    onQueryChange={onQueryChange}
                    searchPlaceholder={chrome.searchPlaceholder}
                    revealOnHover={
                      (chrome.toolbar.forms?.options ?? "revealed") ===
                      "revealed"
                    }
                  />
                </DataViewControlsProvider>
              }
              switcher={chrome.switcherCount > 1 ? chrome.switcher.chip : null}
              creators={hostedCreators(creators)}
              body={body}
              stickyRef={chrome.stickyRef}
            />
          );
        }

        // Narrowed here, outside the band's closure (which would lose it).
        const arrangement = chrome.toolbar;
        // The backdrop is the active view while the active view is of its
        // type; otherwise it draws the active view's rows, state and
        // selection with its type's code options, under the active view's
        // card. A body not showing its view (loading, an error) keeps its card
        // even then, so the state is never hidden behind the canvas.
        const backdropIsActive =
          backdropType !== undefined &&
          activeInstance.viewType.type === backdropType.type;
        const backdrop =
          backdropType === undefined
            ? undefined
            : {
                node: (
                  <ControlSizeProvider size="xs">
                    {renderIsolated(
                      DataViewSlots.View,
                      backdropType as unknown as Contribution,
                      {
                        ...renderProps,
                        manualOrder: undefined,
                        options: backdropIsActive
                          ? mergedOptions
                          : (viewOptions?.[backdropType.type] ??
                            NO_VIEW_OPTIONS),
                      },
                    )}
                  </ControlSizeProvider>
                ),
                panel: !backdropIsActive || bodyState.kind !== "view",
                reserve: chrome.reserve,
              };
        return (
          // The band, the surface's `aside` and the body — laid out per the
          // arrangement (in flow, or floating over the body); the controls
          // provider wraps the band and the aside, never the body.
          <BandSurface
            overlay={arrangement?.overlay === true}
            aside={chrome.aside}
            fullBleed={activeInstance.viewType.fullBleed === true}
            backdrop={backdrop}
            controls={controlsContext}
            band={(asideInset) => (
              // The toolbar folds when the surface ASKS for it (`density`) or
              // when it is genuinely too narrow for the wide inline row
              // (`COMPACT_BREAKPOINT`) — the folded single-bar compact form
              // (search + every control inside one `MdTune` options popover,
              // single-view switcher hidden). The host hands it NO control —
              // the toolbar reads `DataViewSlots.Control` itself and each
              // control's panel reads the provider's context, so adding a
              // control is a contribution and never an edit here.
              <DataViewToolbar
                stickyRef={chrome.stickyRef}
                title={chrome.title}
                query={activeState.query}
                onQueryChange={onQueryChange}
                switcher={chrome.switcher}
                switcherCount={chrome.switcherCount}
                actions={chrome.actions}
                creators={creators}
                density={chrome.density}
                arrangement={arrangement}
                searchPlaceholder={chrome.searchPlaceholder}
                asideInset={asideInset}
              />
            )}
          >
            {body}
          </BandSurface>
        );
      })()}
    </>
  );
}

/**
 * A live page's failed refresh, above the rows it could not refresh: named
 * by the last row before it (the head's, when there is none), with its own
 * Retry. One notice per failing page, in the body — a notice BETWEEN two
 * rows would need a non-row entry kind in every view.
 */
function PageNotices(props: {
  notices: readonly DataViewPageNotice[];
  rows: readonly unknown[];
  fields: FieldDef<unknown>[];
  rowKey: (row: unknown, index: number) => string;
}): ReactNode {
  const { notices, rows, fields, rowKey } = props;
  const primary = pickPrimaryField(fields);
  const labelOf = (id: string): string => {
    const row = rows.find((r, i) => rowKey(r, i) === id);
    const value = row === undefined ? undefined : primary?.value?.(row);
    return value === undefined || value === null || value === ""
      ? id
      : String(value);
  };
  return (
    <Stack gap="xs" className="rail-follow py-xs">
      {notices.map((n) => (
        <Placeholder key={n.key} tone="error">
          {n.afterRowId === null
            ? "The first rows could not refresh"
            : `Rows after “${labelOf(n.afterRowId)}” could not refresh`}
          {` — ${n.error.message} `}
          <Button variant="ghost" onClick={() => n.retry()}>
            Retry
          </Button>
        </Placeholder>
      ))}
    </Stack>
  );
}

const NO_ROWS: readonly unknown[] = [];
// A backdrop type the surface gives no code options.
const NO_VIEW_OPTIONS = {};

/** Whether the section holding the entry keyed `key` is collapsed. */
function isSectionCollapsed(
  sections: readonly {
    key: string | null;
    entries: readonly { key: string }[];
  }[],
  key: string,
  collapsed: ReadonlySet<string>,
): boolean {
  const section = sections.find((s) => s.entries.some((e) => e.key === key));
  return section?.key != null && collapsed.has(section.key);
}
const NO_QUERY = { query: "", filter: null };
const NO_UNAVAILABLE: readonly UnavailableRule[] = [];
// Every row of a read with no `isPaged` is the read's.
const ALL_ROWS = (): boolean => true;
const NOOP = () => {};

/** The shared "no fold open" set — one identity, so an idle view's `openFolds`
 *  never changes between renders. */
const NO_OPEN_FOLDS: ReadonlySet<string> = new Set();
