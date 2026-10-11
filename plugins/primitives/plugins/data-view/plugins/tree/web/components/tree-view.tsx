import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  useRowFilter,
  FieldCell,
  GroupedSections,
  leadingSlot,
  makeSortComparator,
  partitionIntoSections,
  pickLeadingField,
  pickPrimaryField,
  readFallback,
  resolveBodyFields,
  rowToneClass,
  useItemActionZones,
  useResolveCell,
  useResolveCellEditor,
  useGroupingRegistry,
  useResolveOperatorSet,
  type DataViewRenderProps,
  type FieldDef,
  type HierarchyConfig,
  type ItemActionProps,
  type ItemActionsDescriptor,
  type RowTone,
} from "@plugins/primitives/plugins/data-view/web";
import { scopeFilterRows } from "@plugins/primitives/plugins/data-view/core";
import type {
  ExpandChange,
  LazyChildren,
  TreeNode,
} from "@plugins/primitives/plugins/tree/core";
import {
  flatExpandAll,
  RowChrome,
  TreeList,
  useFlatExpandAll,
  type RowChromeMenuHelpers,
  type RowMenuItem,
} from "@plugins/primitives/plugins/tree/web";
import { ExpandAllButton } from "@plugins/primitives/plugins/collapsible/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import {
  activationHref,
  runActivation,
} from "@plugins/primitives/plugins/link-gesture/core";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Sticky } from "@plugins/primitives/plugins/css/plugins/sticky/web";
import type { TreeViewOptions } from "../internal/types";
import {
  bucketRowsByRootSection,
  fieldsForProjected,
  projectedRoots,
} from "../internal/group-rows";
import {
  isAliasNodeId,
  projectRows,
  realNodeId,
  type Projected,
} from "../internal/project-rows";
import { EditableTreeLabel } from "./editable-tree-label";
import { AlignedCells, AlignedHeader, useAlignedFit } from "./aligned-columns";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const addIcon = symbol("add");
const linkIcon = symbol("link");
const unfoldLessIcon = symbol("unfold-less");
const unfoldMoreIcon = symbol("unfold-more");

/**
 * Default row: render the primary field through the same `data-view.cell`
 * resolution the table uses, swapping in an `EditableTreeLabel` (select-then-edit
 * over the shared `useResolveCellEditor` capability) when the primary field
 * declares `onEdit`/`onEditValues`. The remaining visible (non-primary) fields
 * render as trailing chips through the shared `FieldCell` (click-to-edit when the
 * field declares a write-back, read-only otherwise) — the tree's body now follows
 * the view's Properties (visible-fields) policy like every other view, not
 * label-only.
 */
function DefaultRow<TRow>(props: {
  node: TreeNode<Projected<TRow>>;
  depth: number;
  primaryField: FieldDef<TRow> | undefined;
  secondaryFields: FieldDef<TRow>[];
  /** The schema's leading field (the row's avatar), rendered in the icon slot
   *  ahead of `options.leadingIcon`. */
  leadingField: FieldDef<TRow> | undefined;
  options: TreeViewOptions<TRow>;
  /** Per-row emphasis, threaded from `DataViewRenderProps.rowTone`. */
  rowTone: ((row: TRow) => RowTone) | undefined;
  /** The tree's single (hover-revealed) action arm — see `useItemActionZones`. */
  revealedActions: ((p: ItemActionProps<TRow>) => ReactNode) | null;
}): ReactNode {
  const {
    node,
    depth,
    primaryField,
    secondaryFields,
    leadingField,
    options,
    rowTone,
    revealedActions,
  } = props;
  const resolveCell = useResolveCell();
  const resolveEditor = useResolveCellEditor();
  const row = node.__row;
  // Alias (reference) nodes are navigation-only: read-only label, no row
  // menu/actions, and a trailing link glyph marking them as references.
  const isAlias = node.alias;

  const primaryValue = primaryField?.value?.(row);
  // Per-row emphasis composed with the consumer's own per-row label class, which
  // stays the escape hatch and therefore wins: `rowTone` is the semantic form to
  // reach for first, not a policy imposed over a hand-written one.
  const labelClass = cn(
    rowToneClass(rowTone?.(row)),
    options.labelClassName?.(row),
  );

  // The label's read-rendering, on the SAME precedence the shared `FieldCell`
  // documents and every other view applies: consumer `field.cell` override →
  // contributed `data-view.cell` slot → `String(value)`. The override matters for
  // heterogeneous row unions, where a kind's label is a whole component (e.g. a
  // conversation row) rather than its type's generic cell.
  const primaryRead: ReactNode = primaryField
    ? primaryField.cell
      ? primaryField.cell(row)
      : (resolveCell(
          primaryField as FieldDef<unknown>,
          primaryValue ?? null,
          row,
        ) ?? readFallback(primaryField as FieldDef<unknown>, primaryValue))
    : null;

  let label: ReactNode;
  // The primary label is editable when the field declares a write-back — the same
  // `onEdit`/`onEditValues` contract the shared `FieldCell` applies to the
  // secondary chips and every flat view.
  const primaryEditable =
    primaryField != null &&
    (primaryField.onEdit != null || primaryField.onEditValues != null);
  if (primaryField && !isAlias && primaryEditable) {
    label = (
      <EditableTreeLabel
        node={node}
        row={row}
        field={primaryField as FieldDef<unknown>}
        read={primaryRead}
        className={labelClass}
      />
    );
  } else if (primaryField) {
    label = (
      // eslint-disable-next-line layout/no-adhoc-layout -- flexible truncating label, a row-level flex child of TreeRowChrome's flex row (it owns the row layout)
      <span className={cn("min-w-0 flex-1 truncate", labelClass)}>
        {primaryRead}
      </span>
    );
  } else {
    label = (
      // eslint-disable-next-line layout/no-adhoc-layout -- flexible truncating label, a row-level flex child of TreeRowChrome's flex row (it owns the row layout)
      <span className={cn("min-w-0 flex-1 truncate", labelClass)}>
        {node.id}
      </span>
    );
  }

  const menu: ((helpers: RowChromeMenuHelpers) => RowMenuItem[]) | undefined =
    options.rowMenu && !isAlias
      ? (helpers) => options.rowMenu!(helpers, row)
      : undefined;

  const leadingIcon = leadingSlot({
    field: leadingField as FieldDef<unknown> | undefined,
    row,
    resolveCell,
    resolveEditor,
    own: options.leadingIcon?.(row),
  });
  const trailing = options.trailing?.(row);
  const accent = options.rowAccent?.(row);
  const aligned = options.columns === "aligned";
  const trailingNode = isAlias ? (
    <Center as="span" axis="both">
      <Icon icon={linkIcon} className="size-3.5 text-muted-foreground" />
    </Center>
  ) : trailing != null ? (
    <Center as="span" axis="both">
      {trailing}
    </Center>
  ) : null;

  return (
    <RowChrome
      node={node}
      depth={depth}
      // The row's identity on the DOM, by which the DataView measures the
      // rows on screen: the row's key, which a real node's id is (an alias
      // is a second drawing of a row the real node already marks).
      rowKey={isAlias ? undefined : node.id}
      accent={accent}
      actions={
        revealedActions && !isAlias
          ? revealedActions({ row, hasChildren: node.children.length > 0 })
          : undefined
      }
      menu={menu}
      // Merge the icon into the chevron slot (Notion style: icon at rest,
      // chevron on hover) rather than a separate leading column.
      icon={leadingIcon ?? undefined}
    >
      {label}
      {aligned ? (
        // Aligned columns: the persistent trailing content stays beside the
        // label, and the cells come LAST so they share one right edge with
        // every other row and with the header.
        <>
          {trailingNode}
          <AlignedCells row={row} fields={secondaryFields} />
        </>
      ) : secondaryFields.length > 0 ? (
        // Secondary-field chips (the tree's body fields, in Properties order),
        // sitting between the label and any persistent `options.trailing`, each
        // rendered through the shared `FieldCell` — so a field declaring
        // `onEdit`/`onEditValues` (e.g. a custom column) is click-to-edit here,
        // exactly like the table/list, while write-back-less fields stay read-only.
        // Rigid (never shrink) so the truncating label absorbs the slack.
        // eslint-disable-next-line layout/no-adhoc-layout -- shrink-0 rigid trailing cluster beside the flexible label, the tree row owns its flex row
        <Inline gap="xs" className="shrink-0">
          {secondaryFields.map((f) => (
            <span key={f.id}>
              <FieldCell
                field={f as FieldDef<unknown>}
                row={row}
                resolveCell={resolveCell}
                resolveEditor={resolveEditor}
                display="inline"
              />
            </span>
          ))}
        </Inline>
      ) : null}
      {aligned ? null : trailingNode}
    </RowChrome>
  );
}

/**
 * The fold/unfold-this-group toggle a grouped tree hangs off its section
 * headers, handed to `GroupedSections.headerActions` — which wraps it in the
 * header's hover-revealed cluster, so the button costs the header nothing at
 * rest and cannot collapse the section it sits on.
 *
 * A section-scoped fold is well-defined because a section bucket holds whole
 * subtrees: `bucketRowsByRootSection` files every descendant under its ROOT's
 * section, so folding a group never leaves half a subtree in another one.
 *
 * The gate is `flatExpandAll`'s **pure** form, not the `useFlatExpandAll` hook,
 * which is what lets a section with nothing to fold answer `null` — a hook
 * would have to live in a child component, and a child component that renders
 * nothing still hands `GroupedSections` a non-null element to wrap, leaving an
 * empty cluster that spends the header's `gap` and pulls that section's count
 * off the edge its neighbours line up on.
 *
 * A plain `IconButton`, not `collapsible`'s `ExpandAllButton` — the same call
 * the tree's own per-row fold makes, for the same reason: the surrounding
 * `RowActions` declares the `xs` control density its children derive their box
 * from, whereas `ExpandAllButton`'s compact variant is hand-sized for a toolbar.
 * The two folds are one gesture at two scopes, so they read as one glyph.
 *
 * Deliberately NOT gated on `options.expandAll`. That option names the
 * whole-view TOOLBAR button, and a surface that keeps its chrome minimal by
 * omitting it — a narrow sidebar tree like the Pages sidebar's — is exactly
 * the surface this exists for. Gating on it would reproduce the defect
 * the per-row fold was ungated to avoid: an affordance a new tree has to
 * remember to ask for, which the trees that most need it never do.
 */
function renderSectionExpandAll(
  rows: readonly Projected<unknown>[],
  setExpanded: (changes: readonly ExpandChange[]) => void,
): ReactNode {
  const state = flatExpandAll(rows);
  if (!state.hasExpandable) return null;
  const collapse = state.allExpanded;
  return (
    <IconButton
      icon={collapse ? unfoldLessIcon : unfoldMoreIcon}
      label={collapse ? "Collapse group" : "Expand group"}
      variant="ghost"
      onClick={() => setExpanded(state.changes(!collapse))}
    />
  );
}

/**
 * Tree view: a thin adapter that projects the data-view rows + `HierarchyConfig`
 * onto the `tree` primitive's `TreeList`. No reimplementation — `buildTree`,
 * `filterTree` search, DnD `resolveDropParent`, and `RowChrome` all come from
 * the tree primitive; the primary label's inline edit reuses the shared
 * cell-editor capability via `EditableTreeLabel`.
 *
 * `rows`/`fields`/`options`/`hierarchy` arrive type-erased as `unknown`; this is
 * the documented re-cast boundary for the view child.
 */
export function TreeView(props: DataViewRenderProps<unknown>): ReactNode {
  // --- Documented cast boundary ---
  const hierarchy = props.hierarchy as HierarchyConfig<unknown> | undefined;
  const fields = props.fields as FieldDef<unknown>[];
  const itemActions = props.itemActions as
    ItemActionsDescriptor<unknown> | undefined;
  // A tree row has no permanent trailing region (a reserved one would take width
  // from the label in the app's narrowest surfaces — the Pages sidebar), so
  // EVERY action, persistent zone included, renders in the one hover cluster.
  const { revealed: revealedActions } = useItemActionZones(itemActions, {
    hasPersistentSlot: false,
  });
  // Memoized: `?? {}` would mint a fresh object every render and churn the
  // hooks below that depend on `options`.
  const options = useMemo(
    () => (props.options ?? {}) as TreeViewOptions<unknown>,
    [props.options],
  );

  // Expand has exactly ONE destination, unconditionally: this view's own
  // ViewState expand map (localStorage), keyed per (surface, view-instance,
  // row). A data source cannot redirect it — there is no consumer expand seam —
  // so collapse is never domain data and two view instances never fight over one
  // flag. `setExpanded` is required on the render props, so the host always
  // supplies it; it is passed straight through to `TreeList` (and to the grouped
  // path's hoisted expand-all) with no adapter in between.
  const { rows, rowKey, expanded, setExpanded, rowTone } = props;

  // Body fields follow the view's Properties (visible-fields) policy; sort/filter/
  // search keep using the full `fields`. `null` → identity (= `fields`), so the
  // label pick is unchanged and the secondary chips become every non-primary
  // field (the show-all default — the whole point of the fix for the tree).
  const vis = useMemo(
    () => resolveBodyFields(fields, props.state.visibleFields),
    [fields, props.state.visibleFields],
  );
  // The leading field (the row's avatar) renders in `RowChrome`'s icon slot, so
  // it is out of the label pick and the secondary chips.
  const leadingField = useMemo(() => pickLeadingField(vis), [vis]);
  const primaryField = useMemo(
    () => pickPrimaryField(vis.filter((f) => f !== leadingField)),
    [vis, leadingField],
  );
  const secondaryFields = useMemo(
    () => vis.filter((f) => f.id !== primaryField?.id && f !== leadingField),
    [vis, primaryField, leadingField],
  );
  // Aligned columns give way to the label when the tree is narrow (measured on
  // the header's label cell); chips wrap nothing and keep every field.
  const alignedFit = useAlignedFit(secondaryFields);
  const bodyFields =
    options.columns === "aligned" ? alignedFit.shown : secondaryFields;
  const resolveOperatorSet = useResolveOperatorSet();

  // Project each raw row → a TreeItem-shaped row, keeping a map back to the
  // original so TreeList callbacks recover the concrete `TRow`. The projection
  // itself is pure (`projectRows`) so its rank arithmetic is directly testable.
  const { projected, originalById } = useMemo(() => {
    if (!hierarchy) {
      return {
        projected: [] as Projected<unknown>[],
        originalById: new Map<string, unknown>(),
      };
    }
    return projectRows({
      rows,
      rowKey,
      hierarchy,
      expanded,
      defaultExpanded: options.defaultExpanded,
    });
  }, [rows, rowKey, hierarchy, expanded, options.defaultExpanded]);

  // The view's filter as a row predicate — the same `useRowFilter` lowering the
  // flat views use, so filter semantics are identical across all views. What it
  // is evaluated ON is the view's `filterScope` (the shared `scopeFilterRows`,
  // the same function the host's hide-when-empty check reads):
  //   - `rows` (default) is *subtree-preserving*, mirroring the tree's search: a
  //     node survives if it matches or has a matching descendant — matches plus
  //     the ancestor chain of every match — so filtered rows keep their
  //     hierarchical context instead of being orphaned to the root;
  //   - `roots` tests the ROOTS only, and a kept root keeps its whole subtree —
  //     the partition `groupBy` makes of the roots, as a filter, so sibling view
  //     instances over one tree (the Pages sidebar's Private / Scratch) each own
  //     whole subtrees and never pull in another's ancestor.
  const matchesFilter = useRowFilter(
    props.state.filter,
    fields,
    resolveOperatorSet,
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

  // Field sort (default: manual/rank order). Empty rules → `null` comparator →
  // the projected rows keep their incoming (rank) order, i.e. the manual sort the
  // tree ships by default and DnD reorders. When a rule resolves we reorder the
  // rows by the SAME multi-level comparator the flat views use. `buildTree`
  // preserves each parent's incoming child order, so a single stable *global*
  // sort of the flat row list lands every sibling group in comparator order
  // (stability keeps rank order as the final tie-break).
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

  // Whole-view expand-all, for the GROUPED path's hoisted toolbar only: that
  // path renders one `TreeList` per section with each list's own toolbar
  // suppressed, so the button has to live here and write every section's rows
  // in one batch. The ungrouped path leaves it to `TreeList`, which runs the
  // same hook over its own rows — which is the point of the hook: the "which
  // rows are expandable / are they all open / write only what changes"
  // decision is made once, not once per surface.
  //
  // Called unconditionally with the other hooks (it is memoized on
  // `sortedProjected`, so the ungrouped path pays one cheap pass): the grouped
  // branch sits after the `!hierarchy` and empty-state returns, and a hook
  // cannot be moved past a conditional return.
  //
  // The per-section fold below reaches for the PURE `flatExpandAll` instead, and
  // that is not an inconsistency: this is ONE call in component scope, which is
  // what a hook is for, while the per-section gate runs inside a render callback
  // — once per section, and needing to answer `null`.
  const viewExpandAll = useFlatExpandAll(sortedProjected, setExpanded);

  // Group-by (Notion-style flat sections over the tree): the ROOTS partition
  // into sections by the group-by field through the shared pure partition (the
  // field type's own bucket labels + ordinal, and the "None" bucket, for free),
  // and every
  // descendant follows its root's section regardless of its own value. Computed
  // unconditionally (a cheap no-op when not grouped) so hook order stays
  // stable; `null` = ungrouped → the fast-path below renders exactly the
  // pre-group-by output.
  // `state` is stable per view (`stateFor` is a ViewGetter), so the rule object
  // keeps its identity until the view's group-by changes.
  const groupBy = props.state.groupBy;
  const resolveGrouping = useGroupingRegistry().resolve;
  const now = props.now;
  const groupOrder = props.groupOrder;
  const grouped = useMemo(() => {
    const field = groupBy
      ? fields.find((f) => f.id === groupBy.fieldId)
      : undefined;
    // Unset / unresolvable / value-less group field → the ungrouped fast-path.
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
      // Per-section TreeList rows, keyed by section key (all keys are non-null
      // strings here — the null-key single section only exists ungrouped).
      rowsBySectionKey: new Map(sections.map((s, i) => [s.key, buckets[i]!])),
    };
  }, [sortedProjected, fields, groupBy, resolveGrouping, now, groupOrder]);

  const Row = useCallback(
    (rowProps: { node: TreeNode<Projected<unknown>>; depth: number }) => {
      if (!hierarchy) return null;
      return (
        <DefaultRow
          node={rowProps.node}
          depth={rowProps.depth}
          primaryField={primaryField}
          secondaryFields={bodyFields}
          leadingField={leadingField}
          options={options}
          rowTone={rowTone}
          revealedActions={revealedActions}
        />
      );
    },
    [
      hierarchy,
      options,
      primaryField,
      bodyFields,
      leadingField,
      rowTone,
      revealedActions,
    ],
  );

  const primaryAccessor = useCallback(
    (row: Projected<unknown>) => String(primaryField?.value?.(row.__row) ?? ""),
    [primaryField],
  );

  // The host's `searchAccessor` (when provided) drives the tree's
  // subtree-preserving filter, so a consumer can match on more than the label
  // (e.g. ancestor names, secondary fields). Falls back to the primary label.
  const propsSearchAccessor = props.searchAccessor;
  const searchAccessor = useCallback(
    (row: Projected<unknown>) =>
      propsSearchAccessor
        ? propsSearchAccessor(row.__row)
        : primaryAccessor(row),
    [propsSearchAccessor, primaryAccessor],
  );

  const dragOverlay = useMemo(() => {
    if (options.dragOverlay) {
      return (row: Projected<unknown>) => options.dragOverlay!(row.__row);
    }
    return (row: Projected<unknown>) => primaryAccessor(row);
  }, [options, primaryAccessor]);

  // Alias-aware mutation wrappers: alias node ids are a projection-internal
  // encoding, so they are translated back to real row ids before a mutation
  // reaches the consumer (which only knows real ids).
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
    async (args: { parentId: string | null; afterId?: string }) => {
      // Add-child on an alias creates under the REAL row it references; an
      // alias `afterId` has no real sibling position — drop it (the consumer's
      // default position, normally an append).
      const parentId =
        args.parentId === null ? null : realNodeId(args.parentId);
      const afterId =
        args.afterId !== undefined && isAliasNodeId(args.afterId)
          ? undefined
          : args.afterId;
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
  // A row whose activation is a link is a link row: its ⌘/middle-click opens
  // the link's URL in a browser tab (TreeList resolves this at click time).
  const selectHref = useEventCallback((id: string) => {
    const original = originalById.get(id);
    if (original === undefined) return undefined;
    return activationHref(props.rowActivation?.(original));
  });
  useEffect(() => {
    const pending = pendingActivationRef.current;
    if (pending === null) return;
    if (activateById(pending)) pendingActivationRef.current = null;
  }, [originalById, activateById]);

  // Unwraps the projection for the consumer's row-level predicate. An ALIAS row
  // never toggles: it is a read-only reference leaf whose subtree lives at its
  // canonical place, so there is nothing under it to open.
  const optExpandOnActivate = options.expandOnActivate;
  const wrappedExpandOnActivate = useCallback(
    (p: Projected<unknown>) => !p.alias && !!optExpandOnActivate?.(p.__row),
    [optExpandOnActivate],
  );

  const optOpenOnActivate = options.openOnActivate;
  const wrappedOpenOnActivate = useCallback(
    (p: Projected<unknown>) => !p.alias && !!optOpenOnActivate?.(p.__row),
    [optOpenOnActivate],
  );

  // Lazy children, over the projection: an ALIAS node is a reference leaf, so it
  // is never lazy (its row's listing belongs to its canonical node).
  const hierLazy = hierarchy?.lazyChildren;
  const lazyChildren = useMemo<LazyChildren<Projected<unknown>> | undefined>(
    () =>
      hierLazy
        ? {
            hasChildren: (p) => !p.alias && hierLazy.hasChildren(p.__row),
            state: (p) => hierLazy.state(p.__row),
            load: (p) => hierLazy.load(p.__row),
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

  const aligned = options.columns === "aligned";

  if (!hierarchy) return null;
  if (sortedProjected.length === 0) return <>{props.emptyState}</>;

  const columnHeader = aligned ? (
    <AlignedHeader
      primaryField={primaryField}
      fields={bodyFields}
      sortHeader={props.sortHeader}
      setSort={props.setSort}
      labelRef={alignedFit.labelRef}
    />
  ) : null;

  // A field sort overrides the manual (rank) order, so drag-to-reorder would
  // move a row with no visible effect — disable DnD while sorted (drop back to
  // manual to reorder), mirroring Notion. `onCreate` stays enabled.
  //
  // GROUPING does NOT suspend DnD. It used to, because a per-section TreeList
  // sees only its own section's roots — but the drop contract carries no rank
  // any more, only an anchor the server resolves against the complete sibling
  // set, so a partial view of the roots cannot mint a colliding key. Two facts
  // make the grouped path correct rather than merely harmless:
  //   - a cross-section drag is UNREPRESENTABLE: `TreeList` mounts its own
  //     `RankReorderDndContext`, so each section is a separate DnD context and
  //     no droppable from another section is ever a candidate;
  //   - `bucketRowsByRootSection` keeps every descendant in its ROOT's section,
  //     so a subtree is never split and the per-section `isDescendant` cycle
  //     guard still sees the whole chain it needs.
  const onMove = sortActive || !hierOnMove ? undefined : wrappedOnMove;

  // `onMove`/`onCreate` are optional: omitting them yields a read-only tree —
  // TreeList drops the drag source and every Add affordance (no inert handlers).
  // Respect an *explicit* `addLabel: null` (hide the root footer) — `??` would
  // swallow it and fall back to "Add". Only an absent (undefined) option falls
  // through to the onCreate-derived default.
  const addLabel =
    options.addLabel !== undefined
      ? options.addLabel
      : hierarchy.onCreate
        ? "Add"
        : null;

  const search = {
    accessor: searchAccessor,
    query: props.state.query,
    hideInput: true,
  };
  // One TreeList render, shared by both paths. `sectioned` = a per-section list
  // inside the grouped chrome: it suppresses the list's own toolbar and root-Add
  // footer (both render exactly ONCE for the whole view, hoisted below) while
  // keeping the hidden-input search threaded in — it drives each list's
  // subtree-preserving filter.
  const renderTreeList = (
    treeRows: readonly Projected<unknown>[],
    sectioned: boolean,
  ) => (
    <TreeList<Projected<unknown>>
      rows={treeRows}
      selectedId={props.selectedRowId}
      revealSelected={props.revealSelection}
      rootId={options.rootId}
      onSelect={(id) => {
        // A row created from the tree ("add child" / "add below") is activated
        // by the id `onCreate` returned, one live-state round-trip BEFORE the
        // row itself lands — so it is normal for the lookup to miss here. Hold
        // the id and let the effect above activate it on arrival; anything that
        // does resolve now supersedes a held one.
        pendingActivationRef.current = activateById(id) ? null : id;
      }}
      selectHref={props.rowActivation ? selectHref : undefined}
      setExpanded={setExpanded}
      onMove={onMove}
      onCreate={hierOnCreate ? wrappedOnCreate : undefined}
      Row={Row}
      dragOverlay={dragOverlay}
      addLabel={sectioned ? null : addLabel}
      canCreate={!!hierOnCreate}
      expandOnActivate={
        optExpandOnActivate ? wrappedExpandOnActivate : undefined
      }
      openOnActivate={optOpenOnActivate ? wrappedOpenOnActivate : undefined}
      lazyChildren={lazyChildren}
      onOpen={onOpen}
      guides={options.guides}
      multiSelect={
        props.selection ? { actions: props.selection.bulkActions } : undefined
      }
      toolbar={
        sectioned
          ? { search }
          : {
              search,
              expandAll: options.expandAll,
              start: options.toolbarStart,
            }
      }
    />
  );

  if (grouped) {
    // Hoisted once-per-view chrome, mirroring TreeList's own toolbar/footer
    // markup: expand-all runs over the FULL projected set (every section), and
    // the root Add sits after the last section (a new root lands in whatever
    // section its own field value dictates).
    const showExpandAll = !!options.expandAll && viewExpandAll.hasExpandable;
    const showToolbar = showExpandAll || !!options.toolbarStart;
    const showRootAdd = !options.rootId && addLabel != null && !!hierOnCreate;
    return (
      <>
        {showToolbar && (
          <div className="rail-follow">
            {/* eslint-disable-next-line spacing/no-adhoc-spacing -- mb separates the sticky toolbar from the sections below (mirrors TreeList's own toolbar) */}
            <Sticky mask className="mb-1">
              <Stack direction="row" gap="xs" align="center" justify="between">
                <Stack direction="row" gap="xs" align="center">
                  {options.toolbarStart}
                </Stack>
                <Stack direction="row" gap="xs" align="center">
                  {showExpandAll && (
                    <ExpandAllButton
                      allExpanded={viewExpandAll.allExpanded}
                      onToggle={viewExpandAll.toggle}
                    />
                  )}
                </Stack>
              </Stack>
            </Sticky>
          </div>
        )}
        {columnHeader && <div className="rail-follow">{columnHeader}</div>}
        <GroupedSections
          sections={grouped.sections}
          collapsedSections={props.collapsedSections}
          setSectionCollapsed={props.setSectionCollapsed}
          headerStyle={props.groupHeaders}
          headerActions={(section) =>
            renderSectionExpandAll(
              grouped.rowsBySectionKey.get(section.key)!,
              setExpanded,
            )
          }
        >
          {(section) => (
            <div className="rail-follow">
              {renderTreeList(grouped.rowsBySectionKey.get(section.key)!, true)}
            </div>
          )}
        </GroupedSections>
        {showRootAdd && (
          <div className="rail-follow">
            <Button
              variant="ghost"
              onClick={() => void wrappedOnCreate({ parentId: null })}
              // eslint-disable-next-line spacing/no-adhoc-spacing -- mt offsets the root Add button from the sections above (mirrors TreeList's own footer)
              className="text-muted-foreground mt-1 w-fit"
            >
              <Icon icon={addIcon} className="size-4" />
              {addLabel}
            </Button>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="rail-follow">
      {columnHeader}
      {renderTreeList(sortedProjected, false)}
    </div>
  );
}
