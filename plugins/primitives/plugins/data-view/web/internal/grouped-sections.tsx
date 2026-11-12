import { type CSSProperties, type ReactNode } from "react";
import {
  useRankDragState,
  useRankGroupDropTarget,
  useRankSortableGroup,
  type RankSortableGroupControls,
} from "@plugins/primitives/plugins/rank-reorder/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  StickyStack,
  StickyStackBranch,
  StickyStackItem,
} from "@plugins/primitives/plugins/css/plugins/sticky/plugins/stack/web";
import {
  CollapsibleProvider,
  CollapsibleContent,
} from "@plugins/primitives/plugins/collapsible/web";
import {
  DATA_VIEW_HEADER_OFFSET_VAR,
  visibleSections,
  dataPart,
  type DataViewSection,
  type GroupEditConfig,
} from "@plugins/primitives/plugins/data-view/core";
import { DataViewGroupHeader } from "./group-header";
import { DROP_TARGET_RING, DROP_TARGET_WASH } from "./row-dnd";
import { NestedSectionIndent } from "./nested-section-indent";

export interface GroupedSectionsProps {
  /** The grouped sections — every `key` non-null. The ungrouped single implicit
   *  section (`key === null`) is the view's own headerless fast-path and never
   *  reaches here. */
  sections: DataViewSection<unknown>[];
  collapsedSections?: ReadonlySet<string>;
  setSectionCollapsed?: (key: string, collapsed: boolean) => void;
  /**
   * An affordance scoped to ONE section, rendered in that section's header's
   * trailing cluster (before the fold chevron) — the tree's fold-this-group toggle today, and the seam
   * anything else section-scoped goes through tomorrow. Return `null` for a
   * section that has nothing to offer; the wrapper is then not rendered either,
   * so a header without an action keeps the exact node it has always had.
   *
   * The count and the action want opposite treatments, which is why they sit
   * apart: the count is information and reads at rest (in the label's run),
   * while an action is something you reach for, so it appears on hover. `RowActions` already
   * separates `pin` (positioning) from `alwaysVisible` (reveal), so an inline
   * cluster that still reveals costs nothing new in `Row`, `SectionHeaderRow` or
   * `row-actions` — it rides the row's own `group/row-actions`, published
   * unconditionally by `rowActionsAnchor` in `Row`'s chrome class.
   *
   * The header is itself the section's collapse trigger, and an action sitting
   * on it must not collapse the section it folds. Nothing here guards that:
   * `RowActions`' button `Stack` already stops `onClick` AND `onPointerDown`,
   * for exactly this reason.
   *
   * This is deliberately NOT the `hover-reveal` primitive. That plugin's own
   * CLAUDE.md says in as many words that a cluster of row actions belongs to
   * `row-actions`; using both would put two competing reveal systems — one CSS
   * group, one JS state — on a single row.
   */
  headerActions?: (section: DataViewSection<unknown>) => ReactNode;
  /**
   * Editable section headers (`DataViewProps.groupEdit`): an editable
   * section's header renames inline and, under a `RankReorderProvider` given
   * the editable keys as `groups`, drags its whole section (header and body
   * slide as one block, `useRankSortableGroup`). Absent ⇒ read-only headers.
   */
  groupEdit?: GroupEditConfig;
  /**
   * The section whose body holds the row being dragged (manual order: the
   * section it is laid out in — its own, or the one a cross-section drag
   * previews it in), `null` / absent while no row drags. That body box is
   * lifted onto the `drag` layer for the drag: it seals its rows' stacking
   * (`isolate`), so the row's own `z-drag` orders it only among its
   * neighbours — the box itself must out-stack the pinned headers (`raised`),
   * the toolbar band (`nav`) and the other bodies, or the row slides UNDER a
   * header it crosses (z-layers CLAUDE.md, "`z-drag`").
   */
  draggedSection?: string | null;
  /** This section's body — rendered inside the collapsible content, so
   *  collapsing the group hides it. A flat view returns its `SectionBody` here,
   *  which carries the section's fold line. */
  children: (section: DataViewSection<unknown>) => ReactNode;
}

/**
 * The group-header chrome shared by every flat view child's grouped branch — the
 * render-side twin of `useDataViewSections`. The pipeline that *computes* the
 * sections and the chrome that *presents* them live side by side on purpose: when
 * each view hand-rolled this, they silently drifted (the gallery's headers never
 * pinned at all, while list's and table's stacked). One home makes that
 * divergence unrepresentable for the next view child.
 *
 * Group headers accumulate: with few enough groups every header stays pinned, each
 * below the last (StickyStack sums their measured heights), so you can see every
 * group you scrolled past. Past the stack's cap it degrades to the swap hand-off —
 * each arriving header covers the pinned one — because N pinned headers would eat
 * the viewport.
 *
 * The whole set shares THIS `<Stack>` as its sticky containing block, which is what
 * makes stacking possible: a per-group wrapper would re-bound each header to its
 * own group and un-pin it as the group scrolls away. Hence `<CollapsibleProvider>`
 * (no DOM) rather than `<Collapsible>`, and hence the header/content landing as
 * direct children of the Stack — a flex column with `gap="none"`, so each view's
 * arrangement is unchanged.
 *
 * `base` stacks the first header BELOW the DataView toolbar by reading the
 * host-published `--dv-header-offset` (its measured height). `mask` keeps rows from
 * showing through; `raised` sits above the (relative, in manual-order) rows while
 * the toolbar's `nav` keeps the headers sliding under it at the hand-off.
 *
 * The header's horizontal inset is the ambient **rail** (`rail-follow`),
 * the same rail every view body reads, paid by the sticky BAND while the header
 * row keeps its own `p-row` inside it — so the label lands on the rows' TEXT
 * column (rail + row pad), a caption over the rows, and there is no per-view
 * `headerClassName` axis to keep in sync with each body's padding. A nested
 * header pays the rail inside its indent instead, so the indent (and its
 * guides) sit outside the rail like the body's.
 *
 * **The `table` view is the documented exception** and composes `StickyStack`
 * itself (inside `data-table`) under this same policy: its headers are
 * `col-span-full` rows of the subgrid, so the chrome cannot own a `<Stack>` without
 * displacing them out of the grid and breaking column alignment. The header NODE
 * is still the same one: both render `DataViewGroupHeader`, so a table's group
 * header draws exactly like a list's (the theme's `groupHeaderStyle` included).
 *
 * **Nested sections** (`section.nesting`, a forest-shaped grouping) render
 * flat, in tree order, through the same stack: a collapsed section hides its
 * descendants (`visibleSections`) as well as its own body, so each level folds
 * independently; a nested section's header and body are indented `depth` tree
 * steps with a guide per ancestor level (`NestedSectionIndent`); and a section
 * holding no rows of its own (an ancestor of rows only) draws its header alone.
 * Each section with sub-sections is a `StickyStackBranch`, so past the stack's
 * cap the full parent chain stays pinned: a nested header pins below its
 * ancestors' headers, and a finished branch takes its headers away with it.
 */
export function GroupedSections({
  sections,
  collapsedSections,
  setSectionCollapsed,
  headerActions,
  groupEdit,
  draggedSection = null,
  children,
}: GroupedSectionsProps): ReactNode {
  // Under a manual order that moves rows across sections, every header is
  // also an "into this section" drop target (an element-type choice per
  // section, below — no hook runs where there is no drag).
  const { canReseat } = useRankDragState();
  const shown = visibleSections(sections, collapsedSections);
  // The sections under each parent, in tree order (a parent precedes its
  // descendants, so each branch draws after its own header and body).
  const childrenOf = new Map<string | null, DataViewSection<unknown>[]>();
  const shownKeys = new Set(shown.map((section) => section.key));
  for (const section of shown) {
    const parentKey = section.nesting?.parentKey ?? null;
    if (parentKey !== null && !shownKeys.has(parentKey))
      throw new Error(
        `Section "${section.key}" names parent "${parentKey}", which is not drawn`,
      );
    const siblings = childrenOf.get(parentKey);
    if (siblings) siblings.push(section);
    else childrenOf.set(parentKey, [section]);
  }
  const renderSection = (section: DataViewSection<unknown>): ReactNode => {
    const key = section.key!;
    const subSections = childrenOf.get(key);
    const frame: SectionFrameProps = {
      section,
      first: section === shown[0],
      collapsed: collapsedSections?.has(key) ?? false,
      setSectionCollapsed,
      action: headerActions?.(section),
      groupEdit,
      drop: canReseat,
      holdsDrag: key === draggedSection,
      body: children,
    };
    const own = groupEdit ? (
      <SortableSectionFrame
        key={key}
        {...frame}
        sortable={groupEdit.editable(key)}
      />
    ) : (
      <SectionFrame key={key} {...frame} sort={null} />
    );
    // A section with sub-sections heads a branch: its header, its body, then
    // its sub-sections, so past the cap they pin below it and leave with it.
    return subSections ? (
      <StickyStackBranch key={key} itemKey={key}>
        {own}
        {subSections.map(renderSection)}
      </StickyStackBranch>
    ) : (
      own
    );
  };
  return (
    <Stack gap="none">
      <StickyStack
        keys={shown.map((section) => section.key!)}
        base={`var(${DATA_VIEW_HEADER_OFFSET_VAR}, 0px)`}
      >
        {(childrenOf.get(null) ?? []).map(renderSection)}
      </StickyStack>
    </Stack>
  );
}

/** The `groupGap` token as the margin above a non-first group's header. */
const GROUP_GAP_STYLE: CSSProperties = { marginTop: "var(--group-gap)" };

interface SectionFrameProps {
  section: DataViewSection<unknown>;
  first: boolean;
  collapsed: boolean;
  setSectionCollapsed: GroupedSectionsProps["setSectionCollapsed"];
  action: ReactNode;
  groupEdit: GroupEditConfig | undefined;
  /** The header takes a row dropped "into this section" (`onReseat`). */
  drop: boolean;
  /** The body holds the dragged row: its box is lifted to the `drag` layer. */
  holdsDrag: boolean;
  body: GroupedSectionsProps["children"];
}

/** A section whose block may drag (`groupEdit`): its sortable wiring, then
 *  the frame. Every section of an editable set mounts one — a non-editable
 *  one disabled — so the blocks slide around the fixed ones consistently. */
function SortableSectionFrame(
  props: SectionFrameProps & { sortable: boolean },
): ReactNode {
  const { sortable, ...frame } = props;
  const sort = useRankSortableGroup(frame.section.key!, sortable);
  return <SectionFrame {...frame} sort={sort} />;
}

/** One section: its pinned header, then its collapsible body. */
function SectionFrame({
  section,
  first,
  collapsed,
  setSectionCollapsed,
  action,
  groupEdit,
  drop,
  holdsDrag,
  body,
  sort,
}: SectionFrameProps & { sort: RankSortableGroupControls | null }): ReactNode {
  const key = section.key!;
  const depth = section.nesting?.depth ?? 0;
  const editable = groupEdit?.editable(key) === true;
  // Destructured so render never reads a member off the hook output
  // (react-hooks/refs flags member access on it, not destructuring).
  const {
    ref: blockRef,
    bodyRef,
    listeners: blockListeners,
    style: blockStyle,
    isDragging: blockDragging,
  } = sort ?? STATIC_BLOCK;
  const header = (
    <DataViewGroupHeader
      section={section}
      action={action}
      rename={
        editable && groupEdit
          ? {
              editing: groupEdit.renaming === key,
              onStart: () => groupEdit.setRenaming(key),
              onDone: (name) => {
                groupEdit.setRenaming(null);
                if (name !== null) void groupEdit.onRename(key, name);
              },
            }
          : undefined
      }
    />
  );
  // The header takes a row only where the section draws none to reach it
  // through: collapsed, or empty. A section showing rows is entered through
  // them — its header competing with its first row would throw a row dragged
  // across it to the section's head. Collapsed, the row stays where it is
  // laid out (the section draws no row); empty, it is laid out in it.
  const target = drop ? (
    <HeaderDropTarget
      group={key}
      enabled={collapsed || section.entries.length === 0}
      preview={!collapsed}
    >
      {header}
    </HeaderDropTarget>
  ) : (
    header
  );
  // An ancestor of rows only — a nested section with nothing of its own to
  // draw — is its header alone: an empty band would open a gap between it
  // and its first child.
  const ownBody =
    section.nesting === undefined ||
    section.entries.length > 0 ||
    section.fold !== undefined ||
    section.paging !== undefined;
  const content = (
    // `isolate`: the body seals whatever stacking its rows open (a card's
    // cover pins, a row's actions — `raised`, like the headers) so none of it
    // paints over a pinned header as it scrolls under it. Sealed, the row a
    // drag carries would be sealed too — so while the body holds that row it
    // is UNSEALED (`DRAG_UNSEAL`), never lifted: the dragged row's own
    // `z-drag` then orders it against the headers, the toolbar and the
    // new-section card, while the body's other rows stay below all of them
    // (lifting the body would raise every one of its rows over the card).
    // Nothing else in it opens a layer mid-drag: row actions are hidden.
    <CollapsibleContent
      className={holdsDrag ? DRAG_UNSEAL : "isolate"}
      data-holds-drag={holdsDrag && !sort ? "" : undefined}
      {...dataPart("dv.group")}
    >
      {ownBody && (
        <NestedSectionIndent depth={depth}>{body(section)}</NestedSectionIndent>
      )}
    </CollapsibleContent>
  );
  return (
    <CollapsibleProvider
      open={!collapsed}
      onOpenChange={(open) => setSectionCollapsed?.(key, !open)}
    >
      <StickyStackItem
        itemKey={key}
        mask
        layer="raised"
        // A dragging section's header is the block's drag source and its
        // measured top (`useRankSortableGroup`); its body slides with it.
        ref={blockRef}
        {...blockListeners}
        // The header pays the rail on its BAND and keeps the row's own
        // `p-row` inside it, so its label lands on the rows' TEXT column
        // (rail + row pad) — a caption over the rows. A nested header pays
        // it inside its indent instead, so the indent (and its guides) sit
        // outside the rail like the body's.
        // A dragged block is lifted: the header's band is opaque already
        // (`mask`); both halves cast the shadow.
        className={cn(depth === 0 && "rail-follow", blockDragging && LIFTED)}
        // The room between two groups (`groupGap`, default 0) opens above
        // every header but the first. A margin on the header, not a gap on
        // the Stack: header and body are both its children, and a gap would
        // also part each header from its own rows.
        style={{ ...(first ? undefined : GROUP_GAP_STYLE), ...blockStyle }}
      >
        <NestedSectionIndent depth={depth}>
          {depth > 0 ? <div className="rail-follow">{target}</div> : target}
        </NestedSectionIndent>
      </StickyStackItem>
      {sort ? (
        // The body as the rest of the block: measured with the header, and
        // sliding with it. A box of its own beside the header — never around
        // it, which would re-bound the sticky header to its own section.
        // Dragged, it is an opaque surface of the scroller's own colour
        // (`--chrome-mask`), so the sections it passes over never show
        // through it.
        <div
          ref={bodyRef}
          style={blockStyle}
          data-holds-drag={holdsDrag ? "" : undefined}
          className={cn(blockDragging && ["bg-chrome-mask", LIFTED])}
        >
          {content}
        </div>
      ) : (
        content
      )}
    </CollapsibleProvider>
  );
}

/** A section that does not drag: no block wiring at all. */
const STATIC_BLOCK: Pick<
  RankSortableGroupControls,
  "listeners" | "style" | "isDragging"
> & {
  ref: RankSortableGroupControls["ref"] | undefined;
  bodyRef: RankSortableGroupControls["bodyRef"] | undefined;
} = {
  ref: undefined,
  bodyRef: undefined,
  listeners: undefined,
  style: {},
  isDragging: false,
};

/** A body box holding the dragged row: not a stacking context, so the
 *  row's own `z-drag` reaches the list's — above every pinned header, the
 *  toolbar and the new-section card, its sibling rows staying below. */
const DRAG_UNSEAL = "isolation-auto";

/** A dragged section block's lift: the shadow both its halves cast. */
const LIFTED = "shadow-md";

/** A header as the "into this section" target of a row dragged from another
 *  section: washed and ringed while the row is over it. */
function HeaderDropTarget({
  group,
  enabled,
  preview,
  children,
}: {
  group: string;
  enabled: boolean;
  preview: boolean;
  children: ReactNode;
}): ReactNode {
  const { ref, isOver } = useRankGroupDropTarget(group, { enabled, preview });
  return (
    <div
      ref={ref}
      data-group-drop={group}
      className={cn(
        "rounded-md",
        isOver && [DROP_TARGET_WASH, DROP_TARGET_RING],
      )}
    >
      {children}
    </div>
  );
}
