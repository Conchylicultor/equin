import { useState, type KeyboardEvent, type ReactNode } from "react";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { runActivation } from "@plugins/primitives/plugins/link-gesture/core";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import {
  Avatar,
  AvatarPresentationProvider,
} from "@plugins/primitives/plugins/avatar/web";
import { VirtualRows } from "@plugins/primitives/plugins/virtual-rows/web";
import {
  RankReorderProvider,
  useRankSortableItem,
} from "@plugins/primitives/plugins/rank-reorder/web";
import type { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  FieldCell,
  GroupedSections,
  SectionBody,
  leadingSlot,
  pickLeadingField,
  pickPrimaryField,
  resolveBodyFields,
  useDataViewSections,
  useResolveCell,
  useResolveCellEditor,
  useResolveOperatorSet,
  useGridPhase,
  type DataViewRenderProps,
  type DataViewRowEntry,
  type DataViewDensity,
  type DataViewSection,
  type FieldDef,
  type GridLine,
  type ManualOrderConfig,
} from "@plugins/primitives/plugins/data-view/web";
import type { DataViewPagePlaceholders } from "@plugins/primitives/plugins/data-view/core";
import { useIconColumns } from "./use-icon-columns";

/** Above this tile count a section windows its grid, one measured lane per
 *  windowed row. Smaller launchers keep the plain grid. */
const VIRTUALIZE_THRESHOLD = 120;

/**
 * The grid's geometry per density, on every grid (and the probe) rather than
 * the view root: a container query styles the container's DESCENDANTS, never
 * the container. The view starts flush: space above the first row belongs to
 * whatever sits there (a toolbar arrangement's `spaceBelow`).
 *
 * - comfortable (a page): 116px columns, 72px tiles, `lg` column gap; under
 *   760px of view width 92px columns, 60px tiles, `sm` column gap. Rows `2xl`
 *   apart.
 * - compact (a popover): 72px columns, 36px tiles, `2xs` column gap, rows `xs`
 *   apart, at any width — four columns fit a `picker` popover.
 *
 * `gap` is the grid's own (row) gap; `gap-x-*` in `classes` refines only the
 * column axis. `tileGap` / `tilePad` space the tile and its caption.
 */
const GEOMETRY = {
  comfortable: {
    classes: cn(
      "gap-x-lg [--icons-cell:116px] [--icons-tile:72px]",
      "@max-[760px]/icons:gap-x-sm @max-[760px]/icons:[--icons-cell:92px] @max-[760px]/icons:[--icons-tile:60px]",
    ),
    gap: "2xl",
    tileGap: "md",
    tilePad: "rounded-xl px-xs pt-md pb-sm",
    laneEstimate: 152,
    lanePad: "pb-2xl",
  },
  compact: {
    classes: "gap-x-2xs [--icons-cell:72px] [--icons-tile:36px]",
    gap: "xs",
    tileGap: "xs",
    tilePad: "rounded-lg px-2xs py-sm",
    laneEstimate: 84,
    lanePad: "pb-xs",
  },
} as const satisfies Record<
  DataViewDensity,
  {
    classes: string;
    gap: "2xl" | "xs";
    tileGap: "md" | "xs";
    tilePad: string;
    laneEstimate: number;
    /** A windowed lane's bottom padding — the row gap between lanes. */
    lanePad: string;
  }
>;
const CELL_WIDTH = "var(--icons-cell)";

/** The tiles a keyboard user moves between: activating tiles, in render order. */
const TILE_SELECTOR = '[data-row-key][role="button"]';

/**
 * Where an arrow key moves focus from `at`: Left/Right to the previous/next
 * tile in render order; Up/Down to the tile in the previous/next VISUAL row
 * whose centre is closest horizontally — read from the laid-out boxes, so it
 * holds for any auto-fill column count and across group sections; Home/End to
 * the ends. `undefined` for any other key, or when there is nowhere to go.
 */
function nextTile(
  tiles: HTMLElement[],
  at: number,
  key: string,
): HTMLElement | undefined {
  if (key === "ArrowLeft") return tiles[at - 1];
  if (key === "ArrowRight") return tiles[at + 1];
  if (key === "Home") return tiles[0];
  if (key === "End") return tiles[tiles.length - 1];
  if (key !== "ArrowUp" && key !== "ArrowDown") return undefined;
  const from = tiles[at]!.getBoundingClientRect();
  const fromX = from.left + from.width / 2;
  const down = key === "ArrowDown";
  // The nearest row in that direction: the closest top past this tile's.
  let rowTop: number | undefined;
  for (const t of tiles) {
    const top = t.getBoundingClientRect().top;
    const past = down ? top > from.top + 1 : top < from.top - 1;
    if (!past) continue;
    if (rowTop === undefined || (down ? top < rowTop : top > rowTop))
      rowTop = top;
  }
  if (rowTop === undefined) return undefined;
  let best: HTMLElement | undefined;
  let bestDx = Infinity;
  for (const t of tiles) {
    const r = t.getBoundingClientRect();
    if (Math.abs(r.top - rowTop) > 1) continue;
    const dx = Math.abs(r.left + r.width / 2 - fromX);
    if (dx < bestDx) {
      best = t;
      bestDx = dx;
    }
  }
  return best;
}

/**
 * Wraps one tile with its sortable drag wiring: the tile follows the pointer
 * while dragged and the others of its section reflow around it (the grid
 * strategy moves each tile to the slot it will take). Only mounted in
 * manual-order mode.
 */
function ManualOrderTile({
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
  // (react-hooks/refs), mirroring the list view.
  const { ref, listeners, style } = useRankSortableItem(id, rank, group);
  return (
    <div ref={ref} style={style} {...listeners}>
      {children}
    </div>
  );
}

/**
 * Icons view: a launcher grid — fixed-width cells centred in the view, each a
 * coloured tile with the row's name underneath (a phone home screen).
 *
 * The tile is the schema's leading field (`FieldDef.leading`) drawn inside
 * `<AvatarPresentationProvider value="tile">`, so an avatar cell fills it
 * flat; a schema with no leading field gets a derived-colour letter tile, so
 * switching any DataView to icons still draws something. The name is the
 * primary field. Item actions, selection and aggregation are not rendered — a
 * launcher has none.
 *
 * `rows`/`fields` arrive type-erased as `unknown`; this is the documented
 * re-cast boundary for the view child.
 */
export function IconsView(props: DataViewRenderProps<unknown>): ReactNode {
  const resolveCell = useResolveCell();
  const resolveEditor = useResolveCellEditor();
  const resolveOperatorSet = useResolveOperatorSet();
  // Manual order arrives type-erased; present only when the host activated it.
  const manualOrder = props.manualOrder as
    ManualOrderConfig<unknown> | undefined;
  const onReseat = manualOrder?.onReseat;
  const sections = useDataViewSections(
    props.rows,
    props.fields,
    props.state,
    resolveOperatorSet,
    props.searchAccessor,
    {
      rowKey: props.rowKey,
      manualRank: manualOrder?.getRank,
      now: props.now,
      groupOrder: props.groupOrder,
      rowsComplete: props.rowsComplete,
      sectioning: props.sectioning,
      openFolds: props.foldLines?.open,
      selectedRowId: props.selectedRowId,
    },
  );
  // The roving tab stop: the tile the keyboard user last focused. Absent (or no
  // longer an activating tile) → the selected row's tile, else the first.
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const vis = resolveBodyFields(props.fields, props.state.visibleFields);
  const geometry = GEOMETRY[props.density ?? "comfortable"];

  const totalCount = sections.reduce((sum, s) => sum + s.count.n, 0);
  if (totalCount === 0) {
    return (
      <Center axis="both" className="py-xl">
        <Text as="div" variant="body" className="text-muted-foreground">
          {props.emptyState}
        </Text>
      </Center>
    );
  }

  const activatingKeys = sections.flatMap((s) =>
    s.entries
      .filter((e) => props.rowActivation?.(e.row) !== undefined)
      .map((e) => e.key),
  );
  const tabStop =
    [focusedKey, props.selectedRowId].find(
      (k) => k != null && activatingKeys.includes(k),
    ) ?? activatingKeys[0];

  const leadingField = pickLeadingField(vis);
  const titleField = pickPrimaryField(vis.filter((f) => f !== leadingField));

  const renderName = (row: unknown): ReactNode =>
    titleField ? (
      <FieldCell
        field={titleField}
        row={row}
        resolveCell={resolveCell}
        resolveEditor={resolveEditor}
        display="inline"
      />
    ) : null;

  const renderTile = (row: unknown, key: string): ReactNode => {
    const activate = props.rowActivation?.(row);
    const selected = key === props.selectedRowId;
    return (
      <Stack
        gap={geometry.tileGap}
        align="center"
        role={activate ? "button" : undefined}
        // Roving focus: one tile is the grid's tab stop, the arrow keys move
        // between the rest (the root's onKeyDown).
        tabIndex={activate ? (key === tabStop ? 0 : -1) : undefined}
        aria-current={selected ? "true" : undefined}
        onFocus={activate ? () => setFocusedKey(key) : undefined}
        // Straight through, `undefined` and all: a non-activating tile is a
        // plain container, not a button that does nothing.
        // A link tile also gets its middle- / ⌘-click.
        {...activationProps(activate)}
        onKeyDown={
          activate
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  runActivation(activate);
                }
              }
            : undefined
        }
        data-row-key={key}
        className={cn(
          "group/icon focus-ring relative",
          geometry.tilePad,
          activate && "cursor-pointer",
        )}
      >
        <Center
          className={cn(
            "size-[var(--icons-tile)]",
            // The mock's press/lift: lift on hover or keyboard focus, sink on
            // press, on a slightly overshooting curve.
            "transition-transform duration-200 ease-[cubic-bezier(.3,.7,.4,1.3)]",
            "group-hover/icon:-translate-y-0.5 group-focus-visible/icon:-translate-y-0.5",
            "group-active/icon:translate-y-0 group-active/icon:scale-[.96]",
          )}
        >
          <AvatarPresentationProvider value="tile">
            {leadingSlot({
              field: leadingField,
              row,
              resolveCell,
              resolveEditor,
              // A launcher tile has no per-view leading option to add.
              own: undefined,
            }) ?? (
              <Avatar
                shape="squircle"
                fallbackKey={key}
                fallbackGlyph={initialOf(titleField, row, key)}
              />
            )}
          </AvatarPresentationProvider>
        </Center>
        <Text
          as="div"
          variant="caption"
          className={cn(
            "max-w-full truncate text-center transition-colors group-hover/icon:text-foreground group-focus-visible/icon:text-foreground",
            selected ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {renderName(row)}
        </Text>
        {/* The selected row (a launcher's current app): a dot under its name. */}
        {selected && (
          <Pin to="bottom" offset="2xs" decorative>
            <span className="block size-1 rounded-full bg-foreground" />
          </Pin>
        )}
      </Stack>
    );
  };

  // One entry's node: in manual-order mode wrapped in its drag affordances,
  // except a null-rank (non-orderable) entry, which renders plain.
  const renderEntry = (
    entry: DataViewRowEntry<unknown>,
    group: string | null,
  ): ReactNode => {
    const tile = renderTile(entry.row, entry.key);
    const rank = manualOrder?.getRank(entry.row);
    if (rank == null) return <div key={entry.key}>{tile}</div>;
    return (
      <ManualOrderTile key={entry.key} id={entry.key} rank={rank} group={group}>
        {tile}
      </ManualOrderTile>
    );
  };

  // One section's body: its grid inside the section's `SectionBody` band, which
  // pays the rail and ends in the fold line.
  const renderSection = (
    section: DataViewSection<unknown>,
    activeId: string | null,
  ): ReactNode => (
    <SectionBody
      section={section}
      foldLines={props.foldLines}
      className="pb-sm"
    >
      {/* A section whose tiles are all folded draws no grid — its header and
          fold line say everything. */}
      {section.entries.length === 0 ? null : (
        <IconsGrid
          section={section}
          placeholders={props.placeholders}
          geometry={geometry}
          activeId={activeId}
          renderEntry={renderEntry}
        />
      )}
    </SectionBody>
  );

  const renderBody = (activeId: string | null): ReactNode =>
    sections.length === 1 && sections[0]!.key === null ? (
      renderSection(sections[0]!, activeId)
    ) : (
      <GroupedSections
        sections={sections}
        collapsedSections={props.collapsedSections}
        setSectionCollapsed={props.setSectionCollapsed}
        headerStyle={props.groupHeaders}
      >
        {(section) => renderSection(section, activeId)}
      </GroupedSections>
    );

  // The container the grid geometry's queries read: the view's own width, not
  // the viewport's, so a narrow pane gets the compact tiles too. It also owns
  // the arrow keys, reading the tiles off its own DOM in render order.
  // (A windowed section only has its mounted lanes to move between.)
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const tiles = Array.from(
      e.currentTarget.querySelectorAll<HTMLElement>(TILE_SELECTOR),
    );
    const at = tiles.findIndex((t) => t === document.activeElement);
    if (at < 0) return;
    const next = nextTile(tiles, at, e.key);
    if (!next) return;
    e.preventDefault();
    next.focus();
  };
  const root = (activeId: string | null): ReactNode => (
    <div className="@container/icons" onKeyDown={onKeyDown}>
      {renderBody(activeId)}
    </div>
  );

  if (!manualOrder) return root(null);
  const anyWindowed = sections.some(
    (s) => s.entries.length > VIRTUALIZE_THRESHOLD,
  );
  return (
    <RankReorderProvider
      items={manualOrderItems(sections, manualOrder)}
      layout="grid"
      measuringAlways={anyWindowed}
      onMove={(id, dest) =>
        manualOrder.onMove(id, {
          rank: dest.rank,
          targetId: dest.targetId,
          zone: dest.zone,
        })
      }
      onReseat={
        onReseat
          ? (id, dest) =>
              onReseat(id, {
                groupKey: dest.group,
                targetId: dest.targetId,
                zone: dest.zone,
              })
          : undefined
      }
    >
      {(activeId) => root(activeId)}
    </RankReorderProvider>
  );
}

/**
 * One section's tile grid: the plain grid up to the threshold, one measured
 * lane per windowed row above it. Its own component, so each band measures its
 * own column count and records its own phase (`useGridPhase`): while the
 * read's pages above it are placeholders, the band starts with as many empty
 * spacer cells as keep every tile in the column it was drawn in — a release or
 * a landing never reflows the tiles below it. The spacers carry no
 * `data-row-key` (nor a role), so the viewport, anchoring, the arrow keys and
 * drag never see them.
 */
function IconsGrid({
  section,
  placeholders,
  geometry,
  activeId,
  renderEntry,
}: {
  section: DataViewSection<unknown>;
  placeholders: DataViewPagePlaceholders | undefined;
  geometry: (typeof GEOMETRY)[DataViewDensity];
  activeId: string | null;
  renderEntry: (
    entry: DataViewRowEntry<unknown>,
    group: string | null,
  ) => ReactNode;
}): ReactNode {
  const entries = section.entries;
  const phase = useGridPhase(
    section,
    placeholders,
    entries.map((e) => e.key),
  );
  // Live column count — in both branches when the band pages, so the pad is
  // right in the render a release happens in.
  const { probeRef, columns } = useIconColumns();
  const windowed = entries.length > VIRTUALIZE_THRESHOLD;
  const probe =
    windowed || phase.paged ? (
      <Grid
        ref={probeRef}
        aria-hidden
        cellWidth={CELL_WIDTH}
        gap={geometry.gap}
        className={cn(geometry.classes, "h-0")}
      />
    ) : null;
  const spacer = (i: number) => (
    <div key={`::pad:${i}`} aria-hidden data-grid-pad="" />
  );
  if (!windowed) {
    return (
      <>
        {probe}
        <Grid
          cellWidth={CELL_WIDTH}
          gap={geometry.gap}
          className={geometry.classes}
        >
          {Array.from({ length: phase.pad(columns) }, (_, i) => spacer(i))}
          {entries.map((entry) => renderEntry(entry, section.key))}
        </Grid>
      </>
    );
  }
  const lanes = phase.lines(entries, columns);
  // Pin the lane holding the drag source, so scrolling it out of the window
  // does not unmount its draggable and cancel the drop — and raise it, so the
  // dragged tile paints over the lanes it crosses. Keyed like every lane, by
  // its absolute line.
  const activeLane = activeId
    ? lanes.find((lane) => lane.cells.some((e) => e?.key === activeId))
    : undefined;
  return (
    <>
      {probe}
      {columns > 0 ? (
        <VirtualRows<GridLine<DataViewRowEntry<unknown>>>
          items={lanes}
          estimateSize={geometry.laneEstimate}
          getKey={(lane) => lane.key}
          keepMounted={activeLane ? [activeLane.key] : undefined}
          raisedKey={activeLane?.key}
        >
          {(lane) => (
            <Grid
              cellWidth={CELL_WIDTH}
              gap={geometry.gap}
              className={cn(geometry.classes, geometry.lanePad)}
            >
              {lane.cells.map((entry, i) =>
                entry === null ? spacer(i) : renderEntry(entry, section.key),
              )}
            </Grid>
          )}
        </VirtualRows>
      ) : null}
    </>
  );
}

/** The fallback tile's letter: the name's first character, else the row key's. */
function initialOf(
  titleField: FieldDef<unknown> | undefined,
  row: unknown,
  key: string,
): string {
  const raw = titleField?.value?.(row);
  const text = typeof raw === "string" && raw.length > 0 ? raw : key;
  return text.charAt(0);
}

/** Flatten the sections into the rank-reorder item list. Null-rank entries are
 *  non-orderable, so they are neither scope members nor drop targets. */
function manualOrderItems(
  sections: DataViewSection<unknown>[],
  manualOrder: ManualOrderConfig<unknown>,
) {
  return sections.flatMap((section) =>
    section.entries.flatMap((entry) => {
      const rank = manualOrder.getRank(entry.row);
      return rank != null ? [{ id: entry.key, rank, group: section.key }] : [];
    }),
  );
}
