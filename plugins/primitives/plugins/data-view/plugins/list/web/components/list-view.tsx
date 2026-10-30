import { memo, useMemo, type ReactNode } from "react";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { clipClasses } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { TreeRowChrome } from "@plugins/primitives/plugins/tree/web";
import { FoldMotion } from "@plugins/primitives/plugins/collapsible/web";
import {
  CoverFrame,
  DROP_TARGET_RING,
  DropBackground,
  DropInsertLine,
  FieldCell,
  attachExpandKey,
  attachedChildrenOpen,
  FieldPresentationProvider,
  GroupedSections,
  PrimaryOverThumbnail,
  SectionBody,
  SubtitleRun,
  drawnSubtitleTerms,
  isElidedRead,
  drawnFields,
  leadingSlot,
  resolveCover,
  readFallback,
  rowToneClass,
  useDataViewSections,
  useFieldPresentation,
  useIsChipField,
  useItemActionZones,
  usePlacement,
  wearsTimeInk,
  useResolveCell,
  useResolveCellEditor,
  useResolveOperatorSet,
  useRowDropState,
  useRowDnd,
  type CoverContent,
  type DataViewAggregateConfig,
  type DataViewAttachConfig,
  type DataViewRowEntry,
  type DataViewRenderProps,
  type DataViewSection,
  type FieldDef,
  type FieldPresentation,
  type ItemActionArms,
  type ItemActionRender,
  type ItemActionsDescriptor,
  type ManualOrderConfig,
  type Placement,
  type RowDnd,
  type RowDndSequence,
  type ViewRowDropConfig,
} from "@plugins/primitives/plugins/data-view/web";
import {
  RankReorderProvider,
  useRankSortableItem,
  type RankReorderItem,
} from "@plugins/primitives/plugins/rank-reorder/web";
import type { Rank } from "@plugins/primitives/plugins/rank/core";
import { VirtualRows } from "@plugins/primitives/plugins/virtual-rows/web";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import {
  activationHref,
  runActivation,
} from "@plugins/primitives/plugins/link-gesture/core";
import type { ClassName } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import type { ViewSlots } from "@plugins/primitives/plugins/data-view/core";
import type { ListViewOptions } from "../../core";
import { slotWidthVar, useSlotWidths, type SlotRef } from "./use-slot-widths";

/**
 * Wraps one list row with its sortable drag wiring: the whole row is the drag
 * source (Notion-style, no grip), follows the pointer while dragged, and slides
 * out of the way while another row of its section is dragged past it. Only
 * mounted in manual-order mode, in both the windowed and the plain branch.
 *
 * `group` is the row's section key: unless the config declared `onReseat`, a
 * drag only slides and lands among its own section's rows.
 *
 * It re-renders whenever dnd-kit's context does (every droppable registering
 * once after mount, every frame of a drag), so it stays a thin shell: its
 * `children` is the row element `ListEntry` built, which React skips when it
 * is the same element — the row content never re-renders with it.
 */
function ManualOrderRow({
  id,
  rank,
  group,
  children,
}: {
  id: string;
  rank: Rank;
  group: string | null;
  children: ReactNode;
}): ReactNode {
  // Destructured so render never reads a member off the hook output
  // (react-hooks/refs flags member access on it, not destructuring).
  const { ref, listeners, style } = useRankSortableItem(id, rank, group);
  return (
    <div ref={ref} style={style} data-row-key={id} {...listeners}>
      {children}
    </div>
  );
}

/** `Row`'s own hover paint (`bg-hover-fill`, the scrim the actions pin
 *  paints), held while the row is the surface's hovered row. */
const ROW_HOVERED_CLASS = "bg-hover-fill [--scrim:var(--hover-fill)]";

/** The pointer enter/leave pair reporting a row's hover, or nothing. */
function hoverProps(
  onHover: ((id: string, hovered: boolean) => void) | null,
  key: string,
): {
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
} {
  if (onHover === null) return {};
  return {
    onPointerEnter: () => onHover(key, true),
    onPointerLeave: () => onHover(key, false),
  };
}

const expandIcon = symbol("expand-more");
const collapseIcon = symbol("expand-less");

/** Above this row count the list windows its rows (VirtualRows finds the nearest
 *  scroll ancestor); smaller lists keep the plain `.map` — no absolute
 *  positioning / measurement overhead, exact byte-for-byte legacy markup. */
const VIRTUALIZE_THRESHOLD = 100;

const NO_ITEMS: readonly RankReorderItem[] = [];

/**
 * The slots a list row draws: a glyph lead (`Row.icon`), the title with its
 * marks after it, the subtitle run (beside the title on one line, under it on
 * two), the aligned trailing slots and the faint edge at the far right.
 */
export const LIST_SLOTS: ViewSlots = {
  lead: { capacity: 1, form: "glyph" },
  title: { capacity: 1 },
  afterTitle: {},
  line2: {},
  trail: {},
  edge: { capacity: 1 },
};

/**
 * Everything a row is drawn from that is the SAME for every row of one render:
 * the field layout, the resolvers, the view's options and the host's per-row
 * accessors. `ListView` memoizes it on exactly those inputs, so it keeps its
 * identity while none of them changes — which is what lets `ListEntry` be a
 * memo boundary: a row re-renders when its own data or its per-row state
 * (selected, open, …) changes, or when this does, never because a sibling did.
 */
interface ListRowConfig {
  /** The field placed in the row's lead (`usePlacement`). */
  leadingField: FieldDef<unknown> | undefined;
  /** The row's cover thumbnail, when the lead is the cover's (see
   *  {@link resolveListLeading}); `null` when a field holds the lead. */
  thumbnail: ((row: unknown) => CoverContent | null) | null;
  /** The primary action's arms, drawn over the thumbnail; `null` without a
   *  thumbnail (the primary then sits in the hover cluster) or a primary. */
  primary: ItemActionArms<unknown> | null;
  titleField: FieldDef<unknown> | undefined;
  /** The marks drawn right after the title (the `afterTitle` slot). */
  afterTitleFields: FieldDef<unknown>[];
  /** The subtitle run (the `line2` slot). */
  subtitleFields: FieldDef<unknown>[];
  /** The trailing fields, each in its aligned slot (see {@link useSlotWidths}):
   *  the `trail` slot, then the `edge` field — the row's far right. */
  trailingFields: FieldDef<unknown>[];
  /** Per trailing field: its slot's ref (measuring it for the column width),
   *  whether it presents as a chip (a chip starts its slot, anything else ends
   *  it), and whether it wears the faint time ink (`wearsTimeInk`). */
  trailingSlots: { ref: SlotRef; chip: boolean; timeInk: boolean }[];
  /** Which terms of the row's run are chips (resolved once, per schema). */
  titleIsChip: boolean;
  subtitleIsChip: boolean[];
  resolveCell: ReturnType<typeof useResolveCell>;
  resolveEditor: ReturnType<typeof useResolveCellEditor>;
  lines: 1 | 2;
  rowSize: "sm" | "md";
  rowChrome: ListViewOptions<unknown>["rowChrome"];
  renderRow: ListViewOptions<unknown>["renderRow"];
  labelClassName: ((row: unknown) => ClassName | undefined) | undefined;
  detail: ListViewOptions<unknown>["detail"];
  rowActivation: DataViewRenderProps<unknown>["rowActivation"];
  rowTone: DataViewRenderProps<unknown>["rowTone"];
  revealed: ItemActionRender<unknown> | null;
  setExpanded: DataViewRenderProps<unknown>["setExpanded"];
  /** Native drop targets (`rowDrop`): `null` when the view takes none. */
  dnd: RowDnd<unknown> | null;
  /** Reports the row under the pointer (`onRowHoverChange`), stable for the
   *  view's life; `null` when nobody listens. */
  onHover: ((id: string, hovered: boolean) => void) | null;
}

/** One row's props: the shared config plus what is this row's own. Each is a
 *  value that keeps its identity while the row is unchanged (the row object
 *  itself, its key, booleans), so the `memo` comparison is meaningful. */
interface ListEntryProps {
  config: ListRowConfig;
  row: unknown;
  rowKey: string;
  aggregateCount: number | undefined;
  selected: boolean;
  /** The row is the surface's hovered row (`hoveredRowId`) — under the
   *  pointer here, or on another surface showing the same rows. */
  hovered: boolean;
  hasChildren: boolean;
  /** The row's detail is expanded (always `false` without `detail`). */
  open: boolean;
  /** How many entries are attached beneath this one (`attach`); 0 ⇒ none,
   *  and the row draws no disclosure for them. */
  childCount: number;
  /** Its attached entries are drawn (always `false` without any). */
  childrenOpen: boolean;
  /** An attached entry: drawn beneath its parent — never a manual-order drag
   *  source or drop target, nor a native drop target. */
  attached: boolean;
  /** Manual order: the row's rank — `null` when the row is not orderable (or
   *  no order is active), so it renders plain. */
  rank: Rank | null;
  /** The row's section key, the drag's collision scope. */
  group: string | null;
}

/**
 * One list entry, and the list's memo boundary. In manual-order mode the row is
 * wrapped in its drag affordances — except when its rank is null, which marks
 * the row non-orderable: it renders plain, so the `useRankSortableItem` hook
 * (inside ManualOrderRow) is never mounted for it. This is an element-type
 * choice, not a conditional hook.
 */
const ListEntry = memo(function ListEntry(props: ListEntryProps): ReactNode {
  // The view's presentation (quiet terms, the elided common values): a
  // context, so it changes only when the elision does.
  const presentation = useFieldPresentation();
  const row = listRowNode(props, presentation);
  const { dnd } = props.config;
  const node =
    dnd && !props.attached ? (
      <DropRow dnd={dnd} rowKey={props.rowKey} row={props.row}>
        {row}
      </DropRow>
    ) : (
      row
    );
  if (props.rank == null) return node;
  return (
    <ManualOrderRow id={props.rowKey} rank={props.rank} group={props.group}>
      {node}
    </ManualOrderRow>
  );
});

/**
 * A row as a native drop target (`rowDrop`): its box takes the drop when the
 * row accepts it — highlighted while it would, with the drop-into ring, or
 * under `placement: "between"` the insertion line on the edge the drop goes
 * in at — and lets it fall through to its section's empty space otherwise. A
 * box of its own around the row, so it serves `Row` and the tree chrome alike.
 */
function DropRow({
  dnd,
  rowKey,
  row,
  children,
}: {
  dnd: RowDnd<unknown>;
  rowKey: string;
  row: unknown;
  children: ReactNode;
}): ReactNode {
  const over = useRowDropState(dnd, rowKey);
  return (
    <div
      {...dnd.rowProps(rowKey, row)}
      className={cn("relative rounded-md", over === "into" && DROP_TARGET_RING)}
    >
      {children}
      {over === "before" || over === "after" ? (
        <DropInsertLine at={over} />
      ) : null}
    </div>
  );
}

/**
 * List view: a compact, single-row-per-item dense list. Composes the `Row`
 * primitive and draws the view's placement (`usePlacement`): lead → the row's
 * icon, title + its marks, line 2 → the subtitle run, trail + edge → the
 * aligned trailing slots.
 *
 * Renders against `useDataViewSections`: ungrouped → one implicit section
 * rendered headerless (byte-for-byte the legacy markup); grouped → one
 * collapsible section per group key with a header + count. Windowing still
 * applies WITHIN a section's rows.
 *
 * Each row is a `ListEntry` — a memo boundary fed the row object and a shared
 * {@link ListRowConfig} — so a re-render of the list (a new row elsewhere, a
 * selection change, the host re-rendering) re-renders only the rows whose own
 * data or state changed.
 *
 * `rows`/`fields` arrive type-erased as `unknown`; this is the documented re-cast
 * boundary for the view child.
 */
export function ListView(props: DataViewRenderProps<unknown>): ReactNode {
  const resolveCell = useResolveCell();
  // "Does this field render as a chip?", asked of the SAME registry `resolveCell`
  // consults — so the subtitle's separators follow the field types' own
  // declarations and this view names none of them.
  const isChipField = useIsChipField();
  const resolveEditor = useResolveCellEditor();
  const resolveOperatorSet = useResolveOperatorSet();
  // Manual order arrives type-erased; present only when the host activated it.
  const manualOrder = props.manualOrder as
    ManualOrderConfig<unknown> | undefined;
  // Cross-section capability: present ⇒ a drop into another section is offered
  // and reported; absent ⇒ the primitive refuses those drops visibly.
  const hasReseat = manualOrder?.onReseat != null;
  // Aggregate arrives type-erased; present only when the consumer supplied it.
  const aggregate = props.aggregate as
    DataViewAggregateConfig<unknown> | undefined;
  // Attach arrives type-erased; present only while the view's Sub-items
  // setting draws attached rows under their parent.
  const attach = props.attach as DataViewAttachConfig<unknown> | undefined;
  const sections = useDataViewSections(
    props.rows,
    props.fields,
    props.state,
    resolveOperatorSet,
    props.searchAccessor,
    {
      rowKey: props.rowKey,
      manualRank: manualOrder?.getRank,
      aggregate,
      attach,
      now: props.now,
      groupOrder: props.groupOrder,
      rowsComplete: props.rowsComplete,
      sectioning: props.sectioning,
      openFolds: props.foldLines?.open,
      selectedRowId: props.selectedRowId,
    },
  );
  const options = (props.options ?? {}) as ListViewOptions<unknown>;
  // Density is the SURFACE's declaration, not the view's: a compact surface gets
  // the tighter row unless this view instance pinned a size of its own.
  const rowSize = options.size ?? (props.density === "compact" ? "sm" : "md");
  // Documented cast boundary: itemActions arrives type-erased.
  const itemActions = props.itemActions as
    ItemActionsDescriptor<unknown> | undefined;
  const { properties } = props.state;
  const { fields, rowActivation, rowTone, cover } = props;
  const { rowChrome, renderRow, labelClassName } = options;
  // Where every field goes (the surface's recipe and pins, the user's
  // Properties); the section pipeline above keeps using the full
  // `props.fields` for sort/filter/search.
  const placement = usePlacement(
    fields,
    properties,
    props.placement,
    LIST_SLOTS,
  );
  // What the leading slot holds, decided once per schema: the lead field,
  // else the cover thumbnail.
  const layout = useMemo(
    () => resolveListLeading(placement, cover, rowChrome),
    [placement, cover, rowChrome],
  );
  // A list row has no permanent trailing region (a reserved one would take width
  // from the title in the app's narrowest surfaces), so EVERY cluster action —
  // persistent zone included — renders in the one hover cluster. The primary
  // action has a slot only over a thumbnail; without one it joins that cluster.
  // Resolved unconditionally (hooks rules) BEFORE the early empty-state return.
  const {
    cluster: { revealed },
    primary,
  } = useItemActionZones(itemActions, {
    hasPersistentSlot: false,
    hasPrimarySlot: layout.thumbnail !== null,
  });
  // Row detail (`options.detail`): which rows are open is the view's expand
  // map — the one home for per-row disclosure state.
  const detail = options.detail;
  if (detail && options.rowChrome === "tree") {
    throw new Error(
      "data-view list: `detail` needs the default row chrome — a tree-chrome row is one label line",
    );
  }
  if (attach && options.rowChrome === "tree") {
    throw new Error(
      "data-view list: `attach` needs the default row chrome — a tree-chrome row draws no disclosure for its attached rows",
    );
  }
  // The host hands a fresh `setExpanded` closure each render; only a click
  // calls it, so a stable identity keeps it out of the rows' memo key.
  const setExpanded = useEventCallback(props.setExpanded);
  // The rows as painted, per section: a `"between"` drop's gap is spelled by
  // the row above it, so the gap between two rows is one target and one line.
  const sequence = useMemo<RowDndSequence<unknown>>(
    () => paintedSequence(sections),
    [sections],
  );
  // Rows and each section's empty space as native drop targets. A list row is
  // no native drag source: its drag is the manual order's reorder.
  const dnd = useRowDnd<unknown>({
    rowDrag: undefined,
    rowDrop: props.rowDrop as ViewRowDropConfig<unknown> | undefined,
    dragRows: () => [],
    // A drop in a gap inserts there in the manual order, when one is active.
    order: manualOrder,
    sequence,
  });

  // The hover report, stable whatever the host hands down (a fresh closure
  // per render would bust the row config, and every row with it).
  const hoverChange = props.onRowHoverChange;
  const reportHover = useEventCallback((id: string, hovered: boolean) =>
    hoverChange?.(id, hovered),
  );
  const onHover = hoverChange === undefined ? null : reportHover;
  // The row's terms, split once per schema: the title, the subtitle run and
  // the trailing slots.
  const terms = useMemo(() => {
    const { slots } = layout;
    const titleField = slots.title[0];
    const subtitleFields = [...slots.line2];
    const trailingFields = [...slots.trail, ...slots.edge];
    return {
      titleField,
      afterTitleFields: [...slots.afterTitle],
      subtitleFields,
      trailingFields,
      trailingTimeInk: trailingFields.map((f) =>
        wearsTimeInk(f, slots.edge.includes(f) ? "edge" : "trail", placement),
      ),
      // What the view's presentation may elide: the row's terms, never its
      // title, its marks or its lead (the row's identity).
      elisionFields: [...subtitleFields, ...trailingFields],
    };
  }, [layout, placement]);
  // A row is two lines when its placement puts anything on line 2 (prose, an
  // identifier under a record's title), one otherwise; a surface may pin
  // either (`ListViewOptions.lines`).
  const lines = options.lines ?? (terms.subtitleFields.length > 0 ? 2 : 1);
  // The trailing slots' shared widths, as CSS variables on the list root.
  const { rootRef: slotRootRef, slotRef } = useSlotWidths(
    terms.trailingFields.map((f) => f.id).join("\u0000"),
    terms.trailingFields.length,
  );
  const trailingSlots = useMemo(
    () =>
      terms.trailingFields.map((f, i) => ({
        ref: slotRef(i),
        chip: isChipField(f),
        timeInk: terms.trailingTimeInk[i]!,
      })),
    [terms, slotRef, isChipField],
  );
  const config = useMemo<ListRowConfig>(() => {
    const { leadingField, thumbnail } = layout;
    const { titleField, afterTitleFields, subtitleFields, trailingFields } =
      terms;
    return {
      leadingField,
      thumbnail,
      primary,
      titleField,
      afterTitleFields,
      subtitleFields,
      trailingFields,
      trailingSlots,
      // Which terms of the row's run are chips. Resolved once per schema, so a
      // long list pays one lookup per field.
      titleIsChip: titleField != null && isChipField(titleField),
      subtitleIsChip: subtitleFields.map((f) => isChipField(f)),
      resolveCell,
      resolveEditor,
      lines,
      rowSize,
      rowChrome,
      renderRow,
      labelClassName,
      detail,
      rowActivation,
      rowTone,
      revealed,
      setExpanded,
      dnd,
      onHover,
    };
  }, [
    layout,
    terms,
    trailingSlots,
    primary,
    isChipField,
    resolveCell,
    resolveEditor,
    lines,
    rowSize,
    rowChrome,
    renderRow,
    labelClassName,
    detail,
    rowActivation,
    rowTone,
    revealed,
    setExpanded,
    dnd,
    onHover,
  ]);

  // The rank-reorder host's item list (id + rank + group); the provider keys
  // its sortable context on the ids and groups, not on this array's identity.
  const getRank = manualOrder?.getRank;
  const manualItems = useMemo(
    () => (getRank ? manualOrderItems(sections, getRank) : NO_ITEMS),
    [sections, getRank],
  );
  // The drop handlers only run at drop time; stable identities keep the
  // provider (and so every sortable row) from re-rendering on their account.
  const onMove = useEventCallback(
    (
      id: string,
      dest: { rank: Rank; targetId: string; zone: "before" | "after" },
    ) =>
      manualOrder?.onMove(id, {
        rank: dest.rank,
        targetId: dest.targetId,
        zone: dest.zone,
      }),
  );
  const onReseat = useEventCallback(
    (
      id: string,
      dest: {
        group: string | null;
        targetId: string;
        zone: "before" | "after";
      },
    ) =>
      manualOrder?.onReseat?.(id, {
        groupKey: dest.group,
        targetId: dest.targetId,
        zone: dest.zone,
      }),
  );

  // The host owns the loading→empty precedence: it renders the skeleton and
  // skips this view while loading, so an empty section set always means empty.
  const totalCount = sections.reduce((sum, s) => sum + s.count.n, 0);
  if (totalCount === 0) {
    return (
      <DropBackground dnd={dnd} group={null} firstKey={null} lastKey={null}>
        <Center axis="both" className="py-xl">
          <Text as="div" variant="body" className="text-muted-foreground">
            {props.emptyState}
          </Text>
        </Center>
      </DropBackground>
    );
  }

  // One entry's element, shared by both branches. Every prop is either the
  // shared `config` or a per-row value that keeps its identity while the row is
  // unchanged — never a closure minted here.
  // Whether an entry's attached rows are drawn (the expand map, the source's
  // default, the selected row).
  const rowKeyOf = props.rowKey;
  const childrenOpen = (entry: DataViewRowEntry<unknown>): boolean =>
    attach != null &&
    attachedChildrenOpen(entry, {
      attach,
      expanded: props.expanded,
      selectedRowId: props.selectedRowId,
      rowKey: (row) => rowKeyOf(row, 0),
    });
  const renderEntry = (
    entry: DataViewRowEntry<unknown>,
    group: string | null,
    attached = false,
  ): ReactNode => {
    const open = childrenOpen(entry);
    const node = (
      <ListEntry
        key={entry.key}
        config={config}
        row={entry.row}
        rowKey={entry.key}
        aggregateCount={entry.aggregateCount}
        selected={entry.key === props.selectedRowId}
        hovered={entry.key === props.hoveredRowId}
        hasChildren={props.hasChildren?.(entry.key) ?? false}
        open={detail ? props.expanded?.[entry.key] === true : false}
        childCount={entry.children?.length ?? 0}
        childrenOpen={open}
        attached={attached}
        rank={manualOrder && !attached ? manualOrder.getRank(entry.row) : null}
        group={group}
      />
    );
    if (!entry.children) return node;
    // The attached rows are the entry's siblings, indented under it — outside
    // its drag wrapper, so dragging the parent never drags them, and outside
    // the section's rank order, so they are never drop targets.
    return (
      <Stack key={entry.key} gap="none">
        {node}
        <FoldMotion open={open}>
          <Inset l="lg">
            <Stack gap="none">
              {entry.children.map((child) => renderEntry(child, group, true))}
            </Stack>
          </Inset>
        </FoldMotion>
      </Stack>
    );
  };

  // Window the render once a section is long enough to matter; otherwise keep the
  // plain `.map`. VirtualRows discovers the scroll ancestor itself. Manual order
  // composes with windowing: `activeId` (from the RankReorderProvider render-prop)
  // pins the drag source so it stays mounted when it scrolls out of the window —
  // it renders at its true measured offset, so it is invisible and harmless —
  // and raises its wrapper so the dragged row paints over the rows it crosses.
  // Both dimensions of the row's height: its text density, and whether the
  // subtitle is a second line. `VirtualRows` measures every mounted row anyway,
  // so this only has to be close enough that the scrollbar doesn't jump — but a
  // single-line row is roughly a caption-line shorter than the stacked one it
  // replaced, and keeping the old estimate would size the sizer ~35% long.
  // A thumbnail row is as tall as its thumbnail (`--cover-thumb-h`, 34 px by
  // default) plus the row's padding, whatever its text density.
  const estimateSize =
    config.thumbnail !== null
      ? 46
      : lines === 2
        ? rowSize === "sm"
          ? 36
          : 44
        : rowSize === "sm"
          ? 28
          : 32;
  // One section's body: its rows — windowed past the threshold, else a plain
  // `.map` — inside the section's `SectionBody` band, which pays the rail and
  // ends in the fold line, so the line's caption sits on the rows' own column.
  const renderSection = (
    section: DataViewSection<unknown>,
    activeId: string | null,
  ): ReactNode => {
    const { entries, key: group } = section;
    const windowed = entries.length > VIRTUALIZE_THRESHOLD;
    return (
      <DropBackground
        dnd={dnd}
        group={group}
        firstKey={entries[0]?.key ?? null}
        lastKey={entries.at(-1)?.key ?? null}
      >
        <SectionBody
          section={section}
          foldLines={props.foldLines}
          // Tree-chrome rows keep the tree view's rhythm: no band padding, the
          // rows sit flush under the header like a tree's do. The padding never
          // depends on `windowed`: a read growing past the threshold would drop
          // it, and every row on screen would jump by it (`VirtualRows` measures
          // its own offset inside the band, so it needs no special case).
          className={
            options.rowChrome === "tree"
              ? undefined
              : // The top gap is the theme's (density `sectionBodyPadTop`,
                // default the `sm` step of the bottom one) — except under a
                // group header, which reads as a caption over its rows: the
                // body starts right under it, the header row's own padding the
                // only gap.
                cn("pt-section-body pb-sm", group !== null && "pt-none")
          }
        >
          {/* A section whose rows are all folded draws no rows — its header and
            fold line say everything. */}
          {entries.length === 0 ? null : windowed ? (
            <VirtualRows<DataViewRowEntry<unknown>>
              items={entries}
              estimateSize={estimateSize}
              getKey={(entry) => entry.key}
              keepMounted={activeId ? [activeId] : undefined}
              raisedKey={activeId ?? undefined}
            >
              {(entry) => renderEntry(entry, group)}
            </VirtualRows>
          ) : (
            <Stack gap="none">
              {entries.map((entry) => renderEntry(entry, group))}
            </Stack>
          )}
        </SectionBody>
      </DropBackground>
    );
  };

  const renderBody = (activeId: string | null): ReactNode =>
    // Ungrouped: the single implicit section renders headerless.
    sections.length === 1 && sections[0]!.key === null ? (
      renderSection(sections[0]!, activeId)
    ) : (
      // Grouped: the shared pinned/stacking group-header chrome. GroupedSections
      // follows the ambient rail too, so header and body sit on one rail.
      <GroupedSections
        sections={sections}
        collapsedSections={props.collapsedSections}
        setSectionCollapsed={props.setSectionCollapsed}
      >
        {(section) => renderSection(section, activeId)}
      </GroupedSections>
    );

  // Every row's cells present quiet and leave out the value most rows share
  // (`FieldPresentationProvider` — never the title or the leading visual); the
  // root carries the trailing slots' widths as CSS variables. `display:
  // contents`: the root draws no box, so the sticky group headers and the
  // bands sit exactly where they did.
  const firstRow = sections.find((s) => s.entries.length > 0)?.entries[0]?.row;
  const wrap = (body: ReactNode): ReactNode => (
    <FieldPresentationProvider
      rows={props.rows}
      fields={terms.elisionFields}
      rowsComplete={props.rowsComplete}
    >
      <div ref={slotRootRef} className="contents">
        {options.columnCaptions === true && options.rowChrome !== "tree" ? (
          <ListCaptions config={config} firstRow={firstRow} />
        ) : null}
        {body}
      </div>
    </FieldPresentationProvider>
  );

  // Manual order: wrap the rendered sections in a single sortable rank-reorder
  // host covering every section. In-section drags reorder; a drop into ANOTHER
  // section is a group write plus a reorder, so it is offered only when the
  // config supplies `onReseat` — otherwise the primitive limits the drag to its
  // own section.
  if (manualOrder) {
    // Any windowed section ⇒ rows mount/unmount mid-drag as autoscroll runs, so
    // the shell must re-measure droppables every frame.
    const anyWindowed = sections.some(
      (s) => s.entries.length > VIRTUALIZE_THRESHOLD,
    );
    return (
      <RankReorderProvider
        items={manualItems}
        measuringAlways={anyWindowed}
        onMove={onMove}
        onReseat={hasReseat ? onReseat : undefined}
      >
        {(activeId) => wrap(renderBody(activeId))}
      </RankReorderProvider>
    );
  }
  return wrap(renderBody(null));
}

/**
 * The list's caption row (`columnCaptions`): the title field's label where the
 * rows' titles start (behind an invisible copy of the first row's leading
 * visual, so it lands on their text column), and each trailing field's label
 * in that field's slot — the same measured slot, so a label wider than its
 * values widens the column, and every label sits over its values.
 */
function ListCaptions({
  config,
  firstRow,
}: {
  config: ListRowConfig;
  firstRow: unknown;
}): ReactNode {
  const leading = config.thumbnail ? (
    <CoverFrame size="thumb" content={null} className={rigidClass()} />
  ) : firstRow === undefined ? undefined : (
    leadingSlot({
      field: config.leadingField,
      row: firstRow,
      resolveCell: config.resolveCell,
      resolveEditor: config.resolveEditor,
      form: "glyph",
      own: undefined,
    })
  );
  return (
    <div className="rail-follow" data-list-captions="">
      <Row
        size={config.rowSize}
        icon={
          leading === undefined ? undefined : (
            <span aria-hidden inert className="invisible">
              {leading}
            </span>
          )
        }
      >
        <Text variant="caption" className="text-faint-foreground">
          {config.titleField?.label ?? ""}
        </Text>
        {config.trailingFields.length > 0 ? (
          <>
            <Fill />
            <TrailingSlots config={config}>
              {(field) => (
                <Text variant="caption" className="text-faint-foreground">
                  {field.label}
                </Text>
              )}
            </TrailingSlots>
          </>
        ) : null}
      </Row>
    </div>
  );
}

/**
 * The trailing fields, each in its aligned slot: `min-width` is the widest
 * that slot has been on any row (`useSlotWidths`, a CSS variable on the list
 * root), so the columns line up down the list though a list has no columns. A
 * chip starts its slot, any other value ends it; the edge field (the row's
 * far right, always last) and every time wear the `listTimeInk`
 * (`wearsTimeInk`). An elided value draws
 * nothing and its slot keeps its width.
 */
function TrailingSlots({
  config,
  children,
}: {
  config: ListRowConfig;
  children: (field: FieldDef<unknown>) => ReactNode;
}): ReactNode {
  return config.trailingFields.map((field, i) => {
    const slot = config.trailingSlots[i]!;
    return (
      <Stack
        key={field.id}
        as="span"
        ref={slot.ref}
        direction="row"
        gap="none"
        align="center"
        justify={slot.chip ? "start" : "end"}
        data-list-slot={field.id}
        className={cn(rigidClass(), slot.timeInk && "text-list-time-ink")}
        style={{ minWidth: `var(${slotWidthVar(i)})` }}
      >
        {children(field)}
      </Stack>
    );
  });
}

/**
 * What the leading slot holds, for every row of one schema — one answer per
 * surface, so every row has the same shape:
 *
 * 1. the field placed in the lead (an avatar, a state's glyph, a log's time);
 * 2. else the row's cover (`resolveCover`: the surface's `cover` accessor →
 *    `FieldDef.cover` → the first `media` field) as a thumbnail, when the
 *    surface is covered — a coverless row gets the blank frame, so the rows
 *    stay one height. The cover field it is drawn from leaves the body.
 *
 * The tree chrome has no thumbnail: its row matches a tree row of the same
 * records, whose icon box is a glyph.
 */
function resolveListLeading(
  placement: Placement<unknown>,
  cover: DataViewRenderProps<unknown>["cover"],
  rowChrome: ListViewOptions<unknown>["rowChrome"],
): {
  leadingField: FieldDef<unknown> | undefined;
  thumbnail: ((row: unknown) => CoverContent | null) | null;
  slots: Placement<unknown>["slots"];
} {
  const leadingField = placement.slots.lead[0];
  const { slots } = placement;
  if (leadingField || rowChrome === "tree") {
    return { leadingField, thumbnail: null, slots };
  }
  const resolved = resolveCover(drawnFields(placement), cover);
  if (!resolved.hasCovers) return { leadingField, thumbnail: null, slots };
  const without = (list: readonly FieldDef<unknown>[]) =>
    list.filter((f) => f !== resolved.field);
  return {
    leadingField,
    thumbnail: resolved.coverOf,
    slots: {
      ...slots,
      title: without(slots.title),
      afterTitle: without(slots.afterTitle),
      line2: without(slots.line2),
      trail: without(slots.trail),
      edge: without(slots.edge),
    },
  };
}

// The trailing cell — the trail and edge fields plus the aggregate `×N` badge —
// is identical in both row shapes, so it is written once. It is a rigid leaf:
// it renders what it renders and never gives width back to the title. Only
// its flush-right MECHANIC differs, which is why the class comes in from the
// caller: the single-line shape puts an empty `<Fill>` ahead of it, the
// stacked one keeps the `ml-auto` it has always used.
function hasTrailing(
  config: ListRowConfig,
  aggregateCount: number | undefined,
): boolean {
  return (
    config.trailingFields.length > 0 ||
    (aggregateCount != null && aggregateCount > 1)
  );
}

function renderTrailing(
  config: ListRowConfig,
  row: unknown,
  aggregateCount: number | undefined,
  className?: string,
): ReactNode {
  return (
    <Stack
      direction="row"
      gap="none"
      align="center"
      className={cn(className, "gap-list-slot", rigidClass())}
    >
      <TrailingSlots config={config}>
        {(field) => (
          <FieldCell
            field={field}
            row={row}
            resolveCell={config.resolveCell}
            resolveEditor={config.resolveEditor}
            display="block"
          />
        )}
      </TrailingSlots>
      {aggregateCount && aggregateCount > 1 ? (
        <Badge variant="muted">{`×${aggregateCount}`}</Badge>
      ) : null}
    </Stack>
  );
}

function renderMarks(
  config: ListRowConfig,
  row: unknown,
  presentation: FieldPresentation,
): ReactNode {
  const drawn = config.afterTitleFields.filter(
    (f) => !isElidedRead(presentation, f, row),
  );
  if (drawn.length === 0) return null;
  return drawn.map((field) => (
    <span key={field.id} className={rigidClass()} data-list-mark={field.id}>
      <FieldCell
        field={field}
        row={row}
        resolveCell={config.resolveCell}
        resolveEditor={config.resolveEditor}
        display="inline"
      />
    </span>
  ));
}

// The title's READ rendering, on the precedence `FieldCell` and the tree
// view's primary label both apply (field `cell` → contributed cell →
// `readFallback`). Never the click-to-edit `EditableCell`: a tree row's
// label is a navigation target (its click activates the row) and one label
// line tall, and the inline editor's hover affordance would make the row
// taller than the tree row it must match.
function titleRead(config: ListRowConfig, row: unknown): ReactNode {
  const { titleField } = config;
  if (!titleField) return null;
  if (titleField.cell) return titleField.cell(row);
  const value = titleField.value?.(row);
  return (
    config.resolveCell(titleField, value, row, titleField.values?.(row)) ??
    readFallback(titleField, value)
  );
}

// The `rowChrome: "tree"` row: the tree primitive's own row chrome at depth
// 0, so the row matches a tree row of the same records by construction. One
// label line — the title truncates; every other body field is a rigid inline
// cell after it, the way the tree view draws its secondary fields.
function renderTreeChromeRow(
  props: ListEntryProps,
  labelClass: string,
  presentation: FieldPresentation,
): ReactNode {
  const { config, row, rowKey: key, aggregateCount } = props;
  // An elided value is no cell at all here (no gap left for it).
  const cellFields = [
    ...config.afterTitleFields,
    ...config.subtitleFields,
    ...config.trailingFields,
  ].filter((f) => !isElidedRead(presentation, f, row));
  const hasCells =
    cellFields.length > 0 || (aggregateCount != null && aggregateCount > 1);
  const activation = config.rowActivation?.(row);
  return (
    <TreeRowChrome
      rowKey={key}
      depth={0}
      hasChildren={false}
      isOpen={false}
      selected={props.selected}
      // `undefined` stays `undefined`: a non-activating row is no button.
      onSelect={
        activation === undefined ? undefined : () => runActivation(activation)
      }
      selectHref={activationHref(activation)}
      icon={leadingSlot({
        field: config.leadingField,
        row,
        resolveCell: config.resolveCell,
        resolveEditor: config.resolveEditor,
        form: "glyph",
        own: undefined,
      })}
      actions={config.revealed?.({ row, hasChildren: props.hasChildren })}
    >
      {/* eslint-disable-next-line layout/no-adhoc-layout -- flexible truncating label, a row-level flex child of TreeRowChrome's flex row (it owns the row layout), as in the tree view */}
      <span className={cn("min-w-0 flex-1 truncate", labelClass)}>
        {config.titleField ? titleRead(config, row) : key}
      </span>
      {hasCells ? (
        // eslint-disable-next-line layout/no-adhoc-layout -- shrink-0 rigid trailing cluster beside the flexible label, the tree row owns its flex row
        <Inline gap="xs" className="shrink-0">
          {cellFields.map((field) => (
            <span key={field.id}>
              <FieldCell
                field={field}
                row={row}
                resolveCell={config.resolveCell}
                resolveEditor={config.resolveEditor}
                display="inline"
              />
            </span>
          ))}
          {aggregateCount && aggregateCount > 1 ? (
            <Badge variant="muted">{`×${aggregateCount}`}</Badge>
          ) : null}
        </Inline>
      ) : null}
    </TreeRowChrome>
  );
}

// Single source of row markup — shared verbatim by the plain and virtualized
// branches so the two render identically.
function listRowNode(
  props: ListEntryProps,
  presentation: FieldPresentation,
): ReactNode {
  const { config, row, rowKey: key, aggregateCount, open } = props;
  const { titleField, detail, thumbnail } = config;
  const { childCount, childrenOpen } = props;
  const trailing = hasTrailing(config, aggregateCount);
  // The title's marks (the `afterTitle` slot): rigid cells right after it.
  const marks = renderMarks(config, row, presentation);
  // A term whose value is the view's common one is left out of the run,
  // separator and all — as an empty one is.
  const terms = drawnSubtitleTerms(config.subtitleFields, row).filter(
    (i) => !isElidedRead(presentation, config.subtitleFields[i]!, row),
  );
  // Per-row emphasis: composed ON TOP of the title's own `text-foreground`, so
  // a switched-off / archived / finished row reads inactive. The subtitle and
  // the trailing cell are already muted, so the title is the whole difference.
  // The consumer's own per-row class comes last: it is the escape hatch.
  const toneClass = cn(
    rowToneClass(config.rowTone?.(row)),
    config.labelClassName?.(row),
  );
  if (config.rowChrome === "tree") {
    return renderTreeChromeRow(props, toneClass, presentation);
  }
  const itemActionNodes = config.revealed?.({
    row,
    hasChildren: props.hasChildren,
  });
  const rowNode = (
    <Row
      // The row's identity on the DOM: what the DataView measures the rows
      // it has on screen by.
      data-row-key={key}
      selected={props.selected}
      // The surface's hovered row reads as hovered even when the pointer is
      // elsewhere (on its map pin): Row's own hover paint, held. A selected
      // row keeps its selection tier.
      className={
        props.hovered && !props.selected ? ROW_HOVERED_CLASS : undefined
      }
      {...hoverProps(config.onHover, key)}
      size={config.rowSize}
      // Straight through, `undefined` and all — NEVER `() => activate?.()`.
      // `Row` infers its element from `onClick`, so a closure is never null and
      // every row becomes a `<button>` that then nests whatever `renderRow`
      // put inside it. A non-activating row is a plain container, which is
      // what lets its body hold a real control. A link row also gets its
      // middle- / ⌘-click (`Row` forwards the gesture handlers).
      {...activationProps(config.rowActivation?.(row))}
      icon={
        thumbnail ? (
          // A rigid leaf: the frame keeps its size however tight the line is.
          <CoverFrame
            size="thumb"
            content={thumbnail(row)}
            className={rigidClass()}
          />
        ) : (
          leadingSlot({
            field: config.leadingField,
            row,
            resolveCell: config.resolveCell,
            resolveEditor: config.resolveEditor,
            form: "glyph",
            own: undefined,
          })
        )
      }
      actions={
        detail || childCount > 0 ? (
          <>
            {childCount > 0 ? (
              <IconButton
                icon={childrenOpen ? collapseIcon : expandIcon}
                label={
                  childrenOpen
                    ? `Hide ${childCount} attached`
                    : `Show ${childCount} attached`
                }
                aria-expanded={childrenOpen}
                onClick={() =>
                  config.setExpanded([
                    { id: attachExpandKey(key), expanded: !childrenOpen },
                  ])
                }
              />
            ) : null}
            {detail ? (
              <IconButton
                icon={open ? collapseIcon : expandIcon}
                label={open ? "Hide details" : "Show details"}
                aria-expanded={open}
                onClick={() =>
                  config.setExpanded([{ id: key, expanded: !open }])
                }
              />
            ) : null}
            {itemActionNodes}
          </>
        ) : (
          itemActionNodes
        )
      }
      // The disclosure must be findable, so a row with detail or attached
      // rows shows its cluster at rest.
      actionsAlwaysVisible={detail || childCount > 0 ? true : undefined}
    >
      {config.renderRow ? (
        config.renderRow(row)
      ) : config.lines === 2 ? (
        // TWO LINES — the opt-in stacked shape, for a subtitle that is prose.
        // `Stack` is a flow container, so it RESETS the row's single-line
        // context: each `<Text>` must ask for its own `truncate`, exactly as
        // it did when this was the only shape.
        <>
          {/* Clipping already floors this flex item's automatic minimum size at
              0, so the cell needs no min-w-0 of its own. */}
          <Stack
            gap="none"
            className={clipClasses({ axis: "both", fill: false })}
          >
            {titleField || marks ? (
              <Line className="gap-xs">
                {titleField ? (
                  <Text
                    variant="label"
                    className={cn("text-foreground", toneClass)}
                  >
                    <FieldCell
                      field={titleField}
                      row={row}
                      resolveCell={config.resolveCell}
                      resolveEditor={config.resolveEditor}
                      display="inline"
                    />
                  </Text>
                ) : null}
                {marks}
              </Line>
            ) : null}
            {terms.length > 0 ? (
              <Text
                as="div"
                variant="caption"
                className="truncate text-muted-foreground"
              >
                <SubtitleRun
                  fields={config.subtitleFields}
                  isChip={config.subtitleIsChip}
                  terms={terms}
                  seam={null}
                  row={row}
                  resolveCell={config.resolveCell}
                  resolveEditor={config.resolveEditor}
                />
              </Text>
            ) : null}
          </Stack>
          {trailing
            ? renderTrailing(config, row, aggregateCount, "ml-auto")
            : null}
        </>
      ) : (
        // ONE LINE (the default) — title and subtitle are sibling truncating
        // leaves of the row itself. `Row` composes `Line`, so this is already
        // a `region-line` + `SingleLineProvider` context: every `<Text>` here
        // ellipsizes on one line without asking, and nothing wraps.
        //
        // What gives first: both leaves shrink (CSS's default factor of 1,
        // weighted by content width), so the longer of the two yields more —
        // and the subtitle, being the muted `·`-joined metadata run, is
        // normally the longer one. That is the intent (the title identifies
        // the row) without inventing a shrink-priority primitive for it.
        <>
          {titleField ? (
            <Text variant="label" className={cn("text-foreground", toneClass)}>
              {/* `display="inline"` here, not `"block"`: a block cell asks for
                  `w-full`, which in a flex line means the whole row rather
                  than the cell it means in the stacked shape. */}
              <FieldCell
                field={titleField}
                row={row}
                resolveCell={config.resolveCell}
                resolveEditor={config.resolveEditor}
                display="inline"
              />
            </Text>
          ) : null}
          {marks}
          {terms.length > 0 ? (
            <Text variant="caption" className="text-muted-foreground">
              <SubtitleRun
                fields={config.subtitleFields}
                isChip={config.subtitleIsChip}
                terms={terms}
                // On one line the title is the run's first term.
                seam={
                  titleField == null
                    ? null
                    : config.titleIsChip
                      ? "chip"
                      : "text"
                }
                row={row}
                resolveCell={config.resolveCell}
                resolveEditor={config.resolveEditor}
              />
            </Text>
          ) : null}
          {trailing ? (
            <>
              {/* The slack lives in its own cell, so the trailing group sits
                  flush right in a real track (the structural replacement for
                  `ml-auto`) and the identity leaves keep their natural width. */}
              <Fill />
              {renderTrailing(config, row, aggregateCount)}
            </>
          ) : null}
        </>
      )}
    </Row>
  );
  const withPrimary =
    thumbnail && config.primary ? (
      <PrimaryOverThumbnail
        primary={config.primary}
        row={row}
        hasChildren={props.hasChildren}
      >
        {rowNode}
      </PrimaryOverThumbnail>
    ) : (
      rowNode
    );
  if (!detail) return withPrimary;
  // The detail is the row's SIBLING, so it may hold controls of its own
  // whatever the row's activation is. It folds in and out under the row.
  return (
    <Stack gap="none">
      {withPrimary}
      <FoldMotion open={open}>
        <Inset x="sm" b="sm">
          {detail(row)}
        </Inset>
      </FoldMotion>
    </Stack>
  );
}

/** Flatten the sections into the rank-reorder item list (id + rank + group).
 *  Null-rank entries are non-orderable, so they are neither reorder-scope
 *  members nor drop targets — filter them out before mapping. */
function manualOrderItems(
  sections: DataViewSection<unknown>[],
  getRank: (row: unknown) => Rank | null,
): RankReorderItem[] {
  return sections.flatMap((section) =>
    section.entries.flatMap((entry) => {
      const rank = getRank(entry.row);
      return rank != null ? [{ id: entry.key, rank, group: section.key }] : [];
    }),
  );
}

/** Each painted row's neighbour above it in its section, and its row. */
function paintedSequence(
  sections: readonly DataViewSection<unknown>[],
): RowDndSequence<unknown> {
  const above = new Map<string, string | null>();
  const rows = new Map<string, unknown>();
  for (const section of sections) {
    let prev: string | null = null;
    for (const entry of section.entries) {
      above.set(entry.key, prev);
      rows.set(entry.key, entry.row);
      prev = entry.key;
    }
  }
  return {
    above: (key) => above.get(key) ?? null,
    rowOf: (key) => rows.get(key),
  };
}
