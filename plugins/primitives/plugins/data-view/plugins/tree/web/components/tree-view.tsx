import { useCallback, useMemo, type ReactNode } from "react";
import {
  FieldCell,
  GroupedSections,
  leadingSlot,
  pickLeadingField,
  pickPrimaryField,
  readFallback,
  resolveBodyFields,
  rowToneClass,
  useHierarchyTree,
  useItemActionZones,
  useResolveCell,
  useResolveCellEditor,
  type DataViewRenderProps,
  type FieldDef,
  type HierarchyConfig,
  type ItemActionProps,
  type ItemActionsDescriptor,
  type ProjectedRow,
  type RowTone,
} from "@plugins/primitives/plugins/data-view/web";
import type {
  ExpandChange,
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
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Sticky } from "@plugins/primitives/plugins/css/plugins/sticky/web";
import type { TreeViewOptions } from "../internal/types";
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
  node: TreeNode<ProjectedRow<TRow>>;
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
  rows: readonly ProjectedRow<unknown>[],
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
 * Tree view: a thin adapter that renders the shared hierarchy pipeline
 * (`useHierarchyTree` — projection, filter scope, sibling sort, alias-aware
 * callbacks) through the `tree` primitive's `TreeList`. No reimplementation —
 * `buildTree`, `filterTree` search, DnD `resolveDropParent`, and `RowChrome`
 * all come from the tree primitive; the primary label's inline edit reuses the
 * shared cell-editor capability via `EditableTreeLabel`.
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
  const { setExpanded, rowTone } = props;

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

  // The hierarchy pipeline (shared with the table's nested mode): projection,
  // the view's filter under its `filterScope`, the sibling sort, group-by over
  // the roots, and the alias-aware callbacks. Under a sort `onMove` is absent.
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
  const {
    rows: sortedProjected,
    grouped,
    search,
    treeArgs: listArgs,
  } = useHierarchyTree({ props, primaryField, options });

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

  const Row = useCallback(
    (rowProps: { node: TreeNode<ProjectedRow<unknown>>; depth: number }) => {
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

  const listSearch = { ...search, hideInput: true };
  // One TreeList render, shared by both paths. `sectioned` = a per-section list
  // inside the grouped chrome: it suppresses the list's own toolbar and root-Add
  // footer (both render exactly ONCE for the whole view, hoisted below) while
  // keeping the hidden-input search threaded in — it drives each list's
  // subtree-preserving filter.
  const renderTreeList = (
    treeRows: readonly ProjectedRow<unknown>[],
    sectioned: boolean,
  ) => (
    <TreeList<ProjectedRow<unknown>>
      {...listArgs}
      rows={treeRows}
      rootId={options.rootId}
      Row={Row}
      addLabel={sectioned ? null : addLabel}
      guides={options.guides}
      multiSelect={
        props.selection ? { actions: props.selection.bulkActions } : undefined
      }
      toolbar={
        sectioned
          ? { search: listSearch }
          : {
              search: listSearch,
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
    const onCreate = listArgs.onCreate;
    const showRootAdd = !options.rootId && addLabel != null && !!onCreate;
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
              grouped.rowsBySectionKey.get(section.key!)!,
              setExpanded,
            )
          }
        >
          {(section) => (
            <div className="rail-follow">
              {renderTreeList(
                grouped.rowsBySectionKey.get(section.key!)!,
                true,
              )}
            </div>
          )}
        </GroupedSections>
        {showRootAdd && (
          <div className="rail-follow">
            <Button
              variant="ghost"
              onClick={() => void onCreate({ parentId: null })}
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
