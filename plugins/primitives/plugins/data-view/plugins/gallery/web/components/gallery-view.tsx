import { type ReactNode } from "react";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { VirtualRows } from "@plugins/primitives/plugins/virtual-rows/web";
import {
  CardMeta,
  GroupedSections,
  SectionBody,
  leadingSlot,
  partitionCardFields,
  resolveBodyFields,
  resolveCover,
  rowToneClass,
  useDataViewSections,
  useItemActionZones,
  useResolveCell,
  useResolveCellEditor,
  useResolveOperatorSet,
  useGridPhase,
  type CardFields,
  type CreateOption,
  type DataViewAggregateConfig,
  type DataViewRenderProps,
  type DataViewSection,
  type GridLine,
  type ItemActionsDescriptor,
} from "@plugins/primitives/plugins/data-view/web";
import type {
  CoverContent,
  DataViewPagePlaceholders,
} from "@plugins/primitives/plugins/data-view/core";
import { DataCard } from "./data-card";
import { useGridColumns } from "./use-grid-columns";

/** Above this card count the gallery windows its grid (lane-aware: each windowed
 *  row holds one measured row of `columns` cards). Smaller galleries keep the
 *  plain auto-fill `.map`. */
const VIRTUALIZE_THRESHOLD = 60;

/** A windowed line's first guess, before `VirtualRows` measures a real one: a
 *  card at the default minimum width (13.75rem ≈ 220px → a 16/10 cover of
 *  ≈138px) over its three fixed text lines (≈60px), plus the row gap. Every
 *  card is that one shape, so the probe's measurement replaces it exactly. */
const LINE_ESTIMATE_PX = 230;

/** The grid's cell minimum, per surface density — one card size everywhere,
 *  a narrower rung for a compact surface. */
const CARD_MIN = {
  comfortable: "var(--gallery-card-min)",
  compact: "var(--gallery-card-min-compact)",
} as const;

/** The gallery's own gaps (density `galleryGapX/Y`), over the Grid's ramp gap. */
const GRID_GAP = "gap-x-gallery gap-y-gallery";

/** One grid cell: a data row, carrying its precomputed key. */
interface GalleryCell {
  row: unknown;
  key: string;
  aggregateCount?: number;
}

/**
 * Gallery view: a responsive grid of cover cards. Renders against
 * `useDataViewSections`: ungrouped → one grid; grouped → one collapsible grid
 * per section. Windowing applies WITHIN a section's cells.
 *
 * Every card is the one shape `DataCard` draws: the cover
 * (`resolveCover` — the surface's accessor, else the cover field), then the
 * card's three text lines (`partitionCardFields`, computed once per view, drawn
 * by `CardMeta`). A row with no cover of its own shows its leading field (the
 * avatar) in the frame, else a blank tint — every card stays the same size.
 *
 * `rows`/`fields` arrive type-erased as `unknown`; this is the documented
 * re-cast boundary for the view child.
 */
export function GalleryView(props: DataViewRenderProps<unknown>): ReactNode {
  const resolveCell = useResolveCell();
  const resolveEditor = useResolveCellEditor();
  const resolveOperatorSet = useResolveOperatorSet();
  // Aggregate arrives type-erased; present only when the consumer supplied it.
  const aggregate = props.aggregate as
    DataViewAggregateConfig<unknown> | undefined;
  const sections = useDataViewSections(
    props.rows,
    props.fields,
    props.state,
    resolveOperatorSet,
    props.searchAccessor,
    {
      rowKey: props.rowKey,
      aggregate,
      now: props.now,
      groupOrder: props.groupOrder,
      rowsComplete: props.rowsComplete,
      sectioning: props.sectioning,
      openFolds: props.foldLines?.open,
      selectedRowId: props.selectedRowId,
    },
  );
  // Documented cast boundary: itemActions arrives type-erased.
  const itemActions = props.itemActions as
    ItemActionsDescriptor<unknown> | undefined;
  // The card has both slots: an at-rest chip on the cover (the resting
  // actions) and the cover's primary button. Resolved unconditionally (hooks
  // rules) BEFORE the early empty-state return.
  const zones = useItemActionZones(itemActions, {
    hasPersistentSlot: true,
    hasPrimarySlot: true,
  });

  // Documented cast boundary: creators arrives type-erased via render props.
  const creators = props.creators as CreateOption[] | undefined;

  const totalCount = sections.reduce((sum, s) => sum + s.count.n, 0);
  if (totalCount === 0) {
    return (
      <Stack align="center" justify="center" gap="md" className="py-xl">
        <Text as="div" variant="body" className="text-muted-foreground">
          {props.emptyState}
        </Text>
        {creators?.length ? (
          <Stack align="center" gap="sm">
            {creators.map((c) => (
              <Button key={c.id} onClick={() => void c.onSelect()}>
                {c.icon}
                {c.label}
              </Button>
            ))}
          </Stack>
        ) : null}
      </Stack>
    );
  }

  // Body fields follow the view's Properties (visible-fields) policy; sort /
  // filter / search above keep using the full `props.fields`. Hiding the cover
  // field hides the covers; hiding a text field drops its line.
  const vis = resolveBodyFields(props.fields, props.state.properties);
  const covers = resolveCover(vis, props.cover);
  const cardFields: CardFields<unknown> = partitionCardFields(vis);
  const cardMin = CARD_MIN[props.density ?? "comfortable"];

  // Single source of cell markup — shared by the plain and windowed branches.
  const renderCell = ({ row, key, aggregateCount }: GalleryCell): ReactNode => {
    const target = { row, hasChildren: props.hasChildren?.(key) ?? false };
    const tone = props.rowTone?.(row);
    return (
      <DataCard
        rowKey={key}
        selected={key === props.selectedRowId}
        dimmed={tone === "muted"}
        onActivate={props.rowActivation?.(row)}
        cover={coverOf(covers.coverOf(row), cardFields, (field) =>
          leadingSlot({
            field,
            row,
            resolveCell,
            resolveEditor,
            own: undefined,
          }),
        )}
        // Aggregate representative → a `×N` corner mark, top-left, clear of
        // the action chip at top-right.
        badge={
          aggregateCount && aggregateCount > 1 ? (
            <Badge variant="muted">{`×${aggregateCount}`}</Badge>
          ) : undefined
        }
        actions={{
          atRest: zones.cluster.atRest?.(target),
          revealed: zones.cluster.revealed?.(target),
          primaryAtRest: zones.primary?.atRest?.(target),
          primaryRevealed: zones.primary?.revealed?.(target),
        }}
      >
        <CardMeta
          fields={cardFields}
          row={row}
          resolveCell={resolveCell}
          resolveEditor={resolveEditor}
          titleClassName={cn(rowToneClass(tone))}
        />
      </DataCard>
    );
  };

  // Render one section's cells: plain auto-fill grid below the threshold, else
  // the lane-aware windowed grid — inside the section's `SectionBody` band, which
  // pays the rail and ends in the fold line.
  const renderSection = (
    section: DataViewSection<unknown>,
    cells: GalleryCell[],
  ): ReactNode => (
    <SectionBody
      section={section}
      foldLines={props.foldLines}
      className="py-sm"
    >
      {/* A section whose cards are all folded draws no grid — its header and
          fold line say everything. */}
      {cells.length === 0 ? null : (
        <GalleryGrid
          section={section}
          placeholders={props.placeholders}
          cells={cells}
          cardMin={cardMin}
          renderCell={renderCell}
        />
      )}
    </SectionBody>
  );

  const cellsOf = (section: DataViewSection<unknown>): GalleryCell[] =>
    section.entries.map((e) => ({
      row: e.row,
      key: e.key,
      aggregateCount: e.aggregateCount,
    }));

  // Ungrouped: the single implicit section renders as one grid.
  if (sections.length === 1 && sections[0]!.key === null) {
    return renderSection(sections[0]!, cellsOf(sections[0]!));
  }

  // Grouped: the shared pinned/stacking group-header chrome (identical to the
  // list's — the header is the same navigational aid whether the group holds rows
  // or cards). GroupedSections follows the ambient rail too, so each header
  // sits on the same rail as the grid body (which also reads `rail-follow`).
  return (
    <GroupedSections
      sections={sections}
      collapsedSections={props.collapsedSections}
      setSectionCollapsed={props.setSectionCollapsed}
      headerStyle={props.groupHeaders}
    >
      {(section) => renderSection(section, cellsOf(section))}
    </GroupedSections>
  );
}

/**
 * What a card's frame shows: the row's cover, else — when the schema has a
 * leading field (the avatar) — that field's cell centred on the tint, else
 * nothing (the blank tinted frame). The leading field is never text.
 */
function coverOf(
  cover: CoverContent | null,
  cardFields: CardFields<unknown>,
  leading: (field: CardFields<unknown>["leading"]) => ReactNode | undefined,
): CoverContent | null {
  if (cover !== null) return cover;
  if (!cardFields.leading) return null;
  return {
    kind: "node",
    node: <Center className="size-full">{leading(cardFields.leading)}</Center>,
  };
}

/**
 * One section's card grid: the plain auto-fill grid up to the threshold, the
 * lane-aware windowed grid above it. Its own component, so each band measures
 * its own column count and records its own phase (`useGridPhase`): while the
 * read's pages above it are placeholders, the band starts with as many empty
 * spacer cells as keep every card in the column it was drawn in — a release
 * or a landing never reflows the cards below it. The spacers carry no
 * `data-row-key`, so the viewport, anchoring and selection never see them.
 */
function GalleryGrid({
  section,
  placeholders,
  cells,
  cardMin,
  renderCell,
}: {
  section: DataViewSection<unknown>;
  placeholders: DataViewPagePlaceholders | undefined;
  cells: GalleryCell[];
  cardMin: string;
  renderCell: (cell: GalleryCell) => ReactNode;
}): ReactNode {
  const phase = useGridPhase(
    section,
    placeholders,
    cells.map((c) => c.key),
  );
  // Live column count (read off the probe grid's resolved tracks) — in both
  // branches when the band pages, so the pad is right in the render a release
  // happens in.
  const { probeRef, columns } = useGridColumns();
  const windowed = cells.length > VIRTUALIZE_THRESHOLD;
  const probe =
    windowed || phase.paged ? (
      <Grid
        ref={probeRef}
        aria-hidden
        minCellWidth={cardMin}
        gap="none"
        className={cn("h-0", GRID_GAP)}
      />
    ) : null;
  if (!windowed) {
    const pad = phase.pad(columns);
    return (
      <>
        {probe}
        <Grid minCellWidth={cardMin} gap="none" className={GRID_GAP}>
          {Array.from({ length: pad }, (_, i) => (
            <div key={`::pad:${i}`} aria-hidden data-grid-pad="" />
          ))}
          {cells.map((cell) => (
            <div key={cell.key} className="contents">
              {renderCell(cell)}
            </div>
          ))}
        </Grid>
      </>
    );
  }
  return (
    <>
      {probe}
      {columns > 0 ? (
        <VirtualRows<GridLine<GalleryCell>>
          items={phase.lines(cells, columns)}
          estimateSize={LINE_ESTIMATE_PX}
          getKey={(line) => line.key}
        >
          {(line) => (
            // Each windowed line is its own one-row grid, so the row gap is
            // the line's bottom padding (`pb-gallery`, the same token).
            <Grid
              cols={columns}
              gap="none"
              className="gap-x-gallery pb-gallery"
            >
              {line.cells.map((cell, i) =>
                cell === null ? (
                  <div key={`::pad:${i}`} aria-hidden data-grid-pad="" />
                ) : (
                  <div key={cell.key} className="contents">
                    {renderCell(cell)}
                  </div>
                ),
              )}
            </Grid>
          )}
        </VirtualRows>
      ) : null}
    </>
  );
}
