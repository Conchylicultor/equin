import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import type { LazyChildren } from "@plugins/primitives/plugins/tree/core";
import type { TreeModelArgs } from "@plugins/primitives/plugins/tree/web";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import {
  activationHref,
  runActivation,
} from "@plugins/primitives/plugins/link-gesture/core";
import {
  scopeFilterRows,
  type DataViewRenderProps,
  type DataViewSection,
  type FieldDef,
  type HierarchyConfig,
} from "../../../core";
import { useResolveOperatorSet } from "../../filter-slot";
import { useGroupingRegistry } from "../../grouping-slot";
import { bodyRowMatcher, useRowFilter } from "../use-row-filter";
import { makeSortComparator } from "../sort-rows";
import { partitionIntoSections } from "../use-data-view-sections";
import {
  isAliasNodeId,
  projectRows,
  realNodeId,
  type ProjectedRow,
} from "./project-rows";
import {
  bucketRowsByRootSection,
  fieldsForProjected,
  projectedRoots,
} from "./group-rows";

/** The per-view options the hierarchy pipeline reads, whichever view renders it. */
export interface HierarchyTreeOptions {
  /** Expansion for rows with no entry in the view's expand map. Default `false`. */
  defaultExpanded?: boolean;
  /** Rows whose activation toggles their expansion instead (aliases never do). */
  expandOnActivate?: (row: unknown) => boolean;
  /** Rows a single click opens (`onRowOpen`) instead of activating. */
  openOnActivate?: (row: unknown) => boolean;
  /** The floating drag chip's content. Default: the primary field's text. */
  dragOverlay?: (row: unknown) => ReactNode;
}

/** A hierarchical view's rows, ready for the tree primitive's `useTreeModel`. */
export interface HierarchyTree {
  /** The projected rows the view's filter keeps, in the view's sort (a stable
   *  global sort, which `buildTree` turns into a sort within each sibling group). */
  rows: readonly ProjectedRow<unknown>[];
  /** The view's search, subtree-preserving (`useTreeModel`'s `search`): the
   *  host's `searchAccessor`, else the primary field's text. */
  search: {
    accessor: (row: ProjectedRow<unknown>) => string;
    query: string;
  };
  /** A field sort overrides the manual (rank) order — DnD is suspended. */
  sortActive: boolean;
  /**
   * Group-by over the ROOTS, every descendant following its root's section;
   * `null` when the view is ungrouped (or its group field cannot group).
   */
  grouped: {
    sections: DataViewSection<ProjectedRow<unknown>>[];
    rowsBySectionKey: ReadonlyMap<string, readonly ProjectedRow<unknown>[]>;
  } | null;
  /**
   * Everything else the tree model takes, alias-aware: alias node ids are a
   * projection-internal encoding, translated back to real row ids before any
   * callback reaches the consumer. `onMove` is absent while a sort is active.
   */
  treeArgs: Omit<
    TreeModelArgs<ProjectedRow<unknown>>,
    "rows" | "search" | "rootId" | "guides" | "multiSelect"
  >;
}

/**
 * The hierarchy pipeline every view that nests a `HierarchyConfig` source runs
 * (the tree, and the table when the source is hierarchical):
 *
 * `projectRows` (aliases included) → the view's filter under its `filterScope`
 * (`scopeFilterRows`) → a stable global sort → the tree model's arguments, with
 * every callback translated from the projection back to the consumer's rows.
 *
 * - **Filter**: the same `useRowFilter` lowering the flat views use. `rows`
 *   (default) keeps matches plus their ancestor chain; `roots` tests the roots
 *   and keeps each kept root's whole subtree.
 * - **Sort**: empty → manual (rank) order. A rule reorders each sibling group
 *   (`buildTree` keeps each parent's incoming child order, and the sort is
 *   stable, so rank is the final tie-break) and suspends DnD — a drop would move
 *   a row with no visible effect.
 * - **Group-by** partitions the roots; a cross-section drag is the renderer's to
 *   refuse.
 */
export function useHierarchyTree(args: {
  props: DataViewRenderProps<unknown>;
  /** The view's label field: the search fallback and the default drag chip. */
  primaryField: FieldDef<unknown> | undefined;
  options: HierarchyTreeOptions;
}): HierarchyTree {
  const { props, primaryField, options } = args;
  const hierarchy = props.hierarchy as HierarchyConfig<unknown> | undefined;
  const fields = props.fields as FieldDef<unknown>[];
  const { rows, rowKey, expanded, setExpanded } = props;
  const { defaultExpanded, expandOnActivate, openOnActivate, dragOverlay } =
    options;
  const resolveOperatorSet = useResolveOperatorSet();

  // Project each raw row → a TreeItem-shaped row, keeping a map back to the
  // original so the tree's callbacks recover the concrete row.
  const { projected, originalById } = useMemo(() => {
    if (!hierarchy) {
      return {
        projected: [] as ProjectedRow<unknown>[],
        originalById: new Map<string, unknown>(),
      };
    }
    return projectRows({ rows, rowKey, hierarchy, expanded, defaultExpanded });
  }, [rows, rowKey, hierarchy, expanded, defaultExpanded]);

  const matchesFilter = bodyRowMatcher(
    useRowFilter(props.state.filter, fields, resolveOperatorSet),
  );
  const filterScope = props.state.filterScope ?? "rows";
  const visibleProjected = useMemo(() => {
    if (!matchesFilter) return projected;
    return scopeFilterRows(projected, filterScope, {
      key: (p) => p.id,
      parentOf: (p) => p.parentId,
      matches: (p) => matchesFilter(p.__row),
    });
  }, [projected, matchesFilter, filterScope]);

  const rowComparator = useMemo(
    () => makeSortComparator(props.state.sort, fields),
    [props.state.sort, fields],
  );
  const sortActive = rowComparator !== null;
  const sortedProjected = useMemo(() => {
    if (!rowComparator) return visibleProjected;
    return [...visibleProjected].sort((a, b) =>
      rowComparator(a.__row, b.__row),
    );
  }, [visibleProjected, rowComparator]);

  // `state` is stable per view (`stateFor` is a ViewGetter), so the rule object
  // keeps its identity until the view's group-by changes.
  const groupBy = props.state.groupBy;
  const resolveGrouping = useGroupingRegistry().resolve;
  const { now, groupOrder } = props;
  const grouped = useMemo(() => {
    const field = groupBy
      ? fields.find((f) => f.id === groupBy.fieldId)
      : undefined;
    // Unset / unresolvable / value-less group field → ungrouped.
    if (!groupBy || !field?.value) return null;
    const sections = partitionIntoSections(
      projectedRoots(sortedProjected),
      fieldsForProjected(fields),
      groupBy,
      (p) => p.id,
      { resolveGrouping, now, order: groupOrder },
    );
    const buckets = bucketRowsByRootSection(sortedProjected, sections);
    return {
      sections,
      // Keyed by section key (all non-null here — the null-key single section
      // only exists ungrouped).
      rowsBySectionKey: new Map(sections.map((s, i) => [s.key!, buckets[i]!])),
    };
  }, [sortedProjected, fields, groupBy, resolveGrouping, now, groupOrder]);

  // The host's `searchAccessor` (when provided) drives the subtree-preserving
  // search, so a consumer can match on more than the label. Falls back to the
  // primary label.
  const primaryAccessor = useCallback(
    (row: ProjectedRow<unknown>) =>
      String(primaryField?.value?.(row.__row) ?? ""),
    [primaryField],
  );
  const propsSearchAccessor = props.searchAccessor;
  const searchAccessor = useCallback(
    (row: ProjectedRow<unknown>) =>
      propsSearchAccessor
        ? propsSearchAccessor(row.__row)
        : primaryAccessor(row),
    [propsSearchAccessor, primaryAccessor],
  );

  const chip = useMemo(
    () =>
      dragOverlay
        ? (row: ProjectedRow<unknown>) => dragOverlay(row.__row)
        : primaryAccessor,
    [dragOverlay, primaryAccessor],
  );

  const hierOnMove = hierarchy?.onMove;
  const wrappedOnMove = useCallback(
    (
      id: string,
      dest: {
        parentId: string | null;
        targetId: string | null;
        zone: "before" | "after";
      },
    ) => {
      // An alias row is a reference — it has no position of its own to move.
      if (isAliasNodeId(id)) return;
      // A `child` drop onto an alias reparents into the REAL row it references.
      const parentId =
        dest.parentId === null ? null : realNodeId(dest.parentId);
      if (parentId === id) return; // child-drop onto the row's own alias
      // An alias neighbour has no real sibling position — degrade a drop beside
      // one to an append under the (real) destination parent.
      const aliasTarget =
        dest.targetId !== null && isAliasNodeId(dest.targetId);
      return hierOnMove?.(id, {
        ...dest,
        parentId,
        targetId: aliasTarget ? null : dest.targetId,
        zone: aliasTarget ? "after" : dest.zone,
      });
    },
    [hierOnMove],
  );
  const hierOnCreate = hierarchy?.onCreate;
  const wrappedOnCreate = useCallback(
    async (createArgs: { parentId: string | null; afterId?: string }) => {
      // Add-child on an alias creates under the REAL row it references; an
      // alias `afterId` has no real sibling position — drop it (the consumer's
      // default position, normally an append).
      const parentId =
        createArgs.parentId === null ? null : realNodeId(createArgs.parentId);
      const afterId =
        createArgs.afterId !== undefined && isAliasNodeId(createArgs.afterId)
          ? undefined
          : createArgs.afterId;
      return hierOnCreate?.(
        afterId === undefined ? { parentId } : { parentId, afterId },
      );
    },
    [hierOnCreate],
  );

  // Activating a row means running the consumer's activation for THAT row, so
  // it needs the row object — which a just-created row does not have yet: the
  // create path hands back an id, and the row only arrives with the next
  // live-state push. Dropping the activation in that window is what left "add
  // child" creating a page nobody was taken to. So an unresolvable id is held
  // and activated the moment its row shows up.
  const pendingActivationRef = useRef<string | null>(null);
  const activateById = useEventCallback((id: string): boolean => {
    const original = originalById.get(id);
    if (original === undefined) return false;
    const activation = props.rowActivation?.(original);
    if (activation !== undefined) runActivation(activation);
    return true;
  });
  useEffect(() => {
    const pending = pendingActivationRef.current;
    if (pending === null) return;
    if (activateById(pending)) pendingActivationRef.current = null;
  }, [originalById, activateById]);
  const onSelect = useCallback(
    (id: string) => {
      // A row created from the tree ("add child" / "add below") is activated
      // by the id `onCreate` returned, one live-state round-trip BEFORE the
      // row itself lands — so it is normal for the lookup to miss here. Hold
      // the id and let the effect above activate it on arrival; anything that
      // does resolve now supersedes a held one.
      pendingActivationRef.current = activateById(id) ? null : id;
    },
    [activateById],
  );
  // A row whose activation is a link is a link row: its ⌘/middle-click opens
  // the link's URL in a browser tab (resolved at click time).
  const selectHref = useEventCallback((id: string) => {
    const original = originalById.get(id);
    if (original === undefined) return undefined;
    return activationHref(props.rowActivation?.(original));
  });

  // Unwraps the projection for the consumer's row-level predicates. An ALIAS
  // row never toggles or opens on click: it is a read-only reference leaf whose
  // subtree lives at its canonical place.
  const wrappedExpandOnActivate = useCallback(
    (p: ProjectedRow<unknown>) => !p.alias && !!expandOnActivate?.(p.__row),
    [expandOnActivate],
  );
  const wrappedOpenOnActivate = useCallback(
    (p: ProjectedRow<unknown>) => !p.alias && !!openOnActivate?.(p.__row),
    [openOnActivate],
  );

  // Lazy children, over the projection: an ALIAS node is never lazy (its row's
  // listing belongs to its canonical node).
  const hierLazy = hierarchy?.lazyChildren;
  const lazyChildren = useMemo<LazyChildren<ProjectedRow<unknown>> | undefined>(
    () =>
      hierLazy
        ? {
            hasChildren: (p) => !p.alias && hierLazy.hasChildren(p.__row),
            state: (p) => hierLazy.state(p.__row),
            load: (p) => hierLazy.load(p.__row),
            ...(hierLazy.onOpenChange
              ? {
                  onOpenChange: (open: readonly ProjectedRow<unknown>[]) =>
                    hierLazy.onOpenChange?.(
                      open.filter((p) => !p.alias).map((p) => p.__row),
                    ),
                }
              : {}),
          }
        : undefined,
    [hierLazy],
  );

  // The open gesture (double-click / Enter) resolves the REAL row — an alias
  // opens the row it references, as its activation does.
  const propsOnRowOpen = props.onRowOpen;
  const onOpen = useMemo(
    () =>
      propsOnRowOpen
        ? (id: string) => {
            const original = originalById.get(realNodeId(id));
            if (original !== undefined) propsOnRowOpen(original);
          }
        : undefined,
    [propsOnRowOpen, originalById],
  );

  return {
    rows: sortedProjected,
    search: { accessor: searchAccessor, query: props.state.query },
    sortActive,
    grouped,
    treeArgs: {
      selectedId: props.selectedRowId,
      revealSelected: props.revealSelection,
      onSelect,
      selectHref: props.rowActivation ? selectHref : undefined,
      setExpanded,
      // A field sort overrides the manual (rank) order, so drag-to-reorder
      // would move a row with no visible effect — no DnD while sorted (drop
      // back to manual to reorder), mirroring Notion. `onCreate` stays.
      onMove: sortActive || !hierOnMove ? undefined : wrappedOnMove,
      onCreate: hierOnCreate ? wrappedOnCreate : undefined,
      canCreate: !!hierOnCreate,
      dragOverlay: chip,
      expandOnActivate: expandOnActivate ? wrappedExpandOnActivate : undefined,
      openOnActivate: openOnActivate ? wrappedOpenOnActivate : undefined,
      lazyChildren,
      onOpen,
    },
  };
}
