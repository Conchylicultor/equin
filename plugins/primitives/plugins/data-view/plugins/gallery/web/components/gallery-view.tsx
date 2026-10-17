import { type ReactNode } from "react";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { VirtualRows } from "@plugins/primitives/plugins/virtual-rows/web";
import { RowActions } from "@plugins/primitives/plugins/row-actions/web";
import {
  FieldCell,
  GroupedSections,
  SectionBody,
  leadingSlot,
  pickLeadingField,
  pickPrimaryField,
  resolveBodyFields,
  rowToneClass,
  useDataViewSections,
  useItemActionZones,
  useResolveCell,
  useResolveCellEditor,
  useResolveOperatorSet,
  useGridPhase,
  type CreateOption,
  type DataViewAggregateConfig,
  type DataViewRenderProps,
  type DataViewSection,
  type FieldDef,
  type GridLine,
  type ItemActionsDescriptor,
} from "@plugins/primitives/plugins/data-view/web";
import type { DataViewPagePlaceholders } from "@plugins/primitives/plugins/data-view/core";
import type { CoverContent, GalleryViewOptions } from "../../core";
import { DataCard } from "./data-card";
import { useGridColumns } from "./use-grid-columns";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const addIcon = symbol("add");

/** Above this card count the gallery windows its grid (lane-aware: each windowed
 *  row holds one measured row of `columns` cards). Smaller galleries keep the
 *  plain auto-fill `.map`. */
const VIRTUALIZE_THRESHOLD = 60;

/** One grid cell: a data row (carrying its precomputed key) or the trailing
 *  dashed "+" create card. */
type GalleryCell =
  | { kind: "row"; row: unknown; key: string; aggregateCount?: number }
  | { kind: "create" };

/**
 * Pick the cover field: explicit `coverField` id wins, else the field marked
 * `cover: true`, else the first `media` field. Undefined → no media region.
 */
function pickCoverField<TRow>(
  fields: FieldDef<TRow>[],
  coverField: string | undefined,
): FieldDef<TRow> | undefined {
  if (coverField) {
    return fields.find((f) => f.id === coverField);
  }
  return (
    fields.find((f) => f.cover === true) ??
    fields.find((f) => f.type === "media")
  );
}

/** Paint a structured cover descriptor into a uniform `aspect-video` frame. */
function renderCover(cover: CoverContent): ReactNode {
  switch (cover.kind) {
    case "image":
      return (
        <img
          src={cover.src}
          alt=""
          className="aspect-video w-full rounded-md object-cover"
        />
      );
    case "icon":
      return (
        <Center className="aspect-video w-full rounded-md bg-primary/10 text-primary-text">
          {cover.icon}
        </Center>
      );
    case "node":
      return (
        <Clip className="aspect-video w-full rounded-md border border-border bg-muted/40">
          {cover.node}
        </Clip>
      );
  }
}

function renderMedia<TRow>(
  options: GalleryViewOptions<TRow>,
  coverFieldDef: FieldDef<TRow> | undefined,
  row: TRow,
): ReactNode {
  // The structured cover producer wins — the sanctioned icon/node/image path.
  if (options.cover) {
    const cover = options.cover(row);
    return cover ? renderCover(cover) : null;
  }
  // Else fall back to the field-driven image cover.
  if (!coverFieldDef) return null;
  const raw = coverFieldDef.value?.(row);
  if (typeof raw === "string" && raw.length > 0) {
    return renderCover({ kind: "image", src: raw });
  }
  // Non-URL media (or custom cell) falls back to the field's renderer.
  return coverFieldDef.cell ? <div>{coverFieldDef.cell(row)}</div> : null;
}

/**
 * Gallery view: a responsive card grid. Renders against `useDataViewSections`:
 * ungrouped → the legacy single grid (byte-for-byte); grouped → one collapsible
 * grid per section. Windowing still applies WITHIN a section's cells.
 *
 * `rows`/`fields` arrive type-erased as `unknown`; this is the documented re-cast
 * boundary for the view child.
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
  // Body fields follow the view's Properties (visible-fields) policy; sort/filter/
  // search above keep using the full `props.fields`. `null` → identity, so the
  // cover/title/body picks are byte-for-byte the legacy schema-order behavior.
  const vis = resolveBodyFields(props.fields, props.state.properties);
  const options = (props.options ?? {}) as GalleryViewOptions<unknown>;
  const minCardWidth = options.minCardWidth ?? 200;
  // Documented cast boundary: itemActions arrives type-erased.
  const itemActions = props.itemActions as
    ItemActionsDescriptor<unknown> | undefined;
  // The card HAS a permanent per-row region (its footer), so persistent-zone
  // actions stay painted at rest there and the rest live in the hover cluster.
  // Resolved unconditionally (hooks rules) BEFORE the early empty-state return.
  const { persistent, revealed } = useItemActionZones(itemActions, {
    hasPersistentSlot: true,
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

  const coverField = pickCoverField(vis, options.coverField);
  // The leading field (the card's avatar) renders beside the body in
  // `DataCard`'s leading block, so it is out of the title pick and the property
  // rows. The cover pick above is untouched: the cover stays media.
  const leadingField = pickLeadingField(vis);
  const titleField = pickPrimaryField(vis.filter((f) => f !== leadingField));

  // Single source of cell markup — shared by the plain and windowed branches.
  const renderCell = (cell: GalleryCell): ReactNode => {
    if (cell.kind === "create") {
      return (
        <Button
          variant="ghost"
          onClick={() => creators![0]!.onSelect()}
          className="focus-ring aspect-video rounded-lg border border-dashed border-border text-muted-foreground transition-colors hover:border-primary hover:bg-muted/40 hover:text-foreground"
        >
          <Stack gap="xs" align="center" justify="center" className="size-full">
            <Icon icon={addIcon} className="size-5" />
            <Text variant="label">{creators![0]!.label}</Text>
          </Stack>
        </Button>
      );
    }

    const { row, key } = cell;

    const media = renderMedia(options, coverField, row);
    const bodyFields = vis.filter(
      (f) =>
        f.id !== titleField?.id &&
        f.id !== coverField?.id &&
        f.id !== leadingField?.id,
    );
    const actionProps = {
      row,
      hasChildren: props.hasChildren?.(key) ?? false,
    };
    // Per-row emphasis, composed on top of the card title's own foreground: the
    // property rows below are already muted, so the title carries the whole
    // difference between an active card and an inactive one.
    const toneClass = rowToneClass(props.rowTone?.(row));

    // Aggregate representative → a persistent `×N` corner badge. Pinned top-left
    // so it never collides with the hover-revealed actions Pin (top-right).
    const aggregateCount = cell.aggregateCount;
    // ONE card construction site: a custom body replaces the title + property
    // rows and nothing else, so every declared affordance is wired either way.
    const card = (
      <DataCard
        rowKey={key}
        size={options.size}
        selected={key === props.selectedRowId}
        onActivate={props.rowActivation?.(row)}
        media={media}
        leading={leadingSlot({
          field: leadingField,
          row,
          resolveCell,
          resolveEditor,
          own: options.leading?.(row),
        })}
        actions={revealed?.(actionProps)}
        footer={
          persistent ? (
            // In flow at the card's foot, so the cluster needs no pin and no
            // scrim — and `alwaysVisible` is what "persistent" means. The
            // `justify="end"` row puts it on the trailing edge like every other
            // action cluster; left-aligned, a lone icon under the body reads as
            // stray content rather than an affordance.
            <Stack direction="row" gap="none" justify="end">
              <RowActions pin={null} alwaysVisible>
                {persistent(actionProps)}
              </RowActions>
            </Stack>
          ) : undefined
        }
      >
        {options.renderBody ? (
          options.renderBody(row)
        ) : (
          <>
            {titleField ? (
              <Text
                as="div"
                variant="label"
                className={cn(
                  "truncate font-semibold text-foreground",
                  toneClass,
                )}
              >
                <FieldCell
                  field={titleField}
                  row={row}
                  resolveCell={resolveCell}
                  resolveEditor={resolveEditor}
                />
              </Text>
            ) : null}
            {bodyFields.length > 0 ? (
              // eslint-disable-next-line spacing/no-adhoc-spacing -- top offset separating the body block from the card title
              <Stack gap="2xs" className="mt-1">
                {bodyFields.map((field) => (
                  <Text
                    as="div"
                    key={field.id}
                    variant="caption"
                    className="truncate text-muted-foreground"
                  >
                    <FieldCell
                      field={field}
                      row={row}
                      resolveCell={resolveCell}
                      resolveEditor={resolveEditor}
                    />
                  </Text>
                ))}
              </Stack>
            ) : null}
          </>
        )}
      </DataCard>
    );
    if (!aggregateCount || aggregateCount <= 1) return card;
    return (
      <div className="relative">
        {card}
        <Pin to="top-left" offset="sm">
          <Badge variant="muted">{`×${aggregateCount}`}</Badge>
        </Pin>
      </div>
    );
  };

  const estimateRowHeight = options.cover || coverField ? 240 : 132;

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
          minCardWidth={minCardWidth}
          estimateRowHeight={estimateRowHeight}
          renderCell={renderCell}
        />
      )}
    </SectionBody>
  );

  // Ungrouped: the single implicit section renders as the legacy single grid,
  // with the trailing "+" create card appended.
  if (sections.length === 1 && sections[0]!.key === null) {
    const cells: GalleryCell[] = sections[0]!.entries.map((e) => ({
      kind: "row",
      row: e.row,
      key: e.key,
      aggregateCount: e.aggregateCount,
    }));
    if (options.showCreateCard && creators?.length === 1) {
      cells.push({ kind: "create" });
    }
    return renderSection(sections[0]!, cells);
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
      {(section) =>
        renderSection(
          section,
          section.entries.map((e) => ({
            kind: "row",
            row: e.row,
            key: e.key,
            aggregateCount: e.aggregateCount,
          })),
        )
      }
    </GroupedSections>
  );
}

const cellKey = (cell: GalleryCell): string =>
  cell.kind === "create" ? "::create" : cell.key;

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
  minCardWidth,
  estimateRowHeight,
  renderCell,
}: {
  section: DataViewSection<unknown>;
  placeholders: DataViewPagePlaceholders | undefined;
  cells: GalleryCell[];
  minCardWidth: number;
  estimateRowHeight: number;
  renderCell: (cell: GalleryCell) => ReactNode;
}): ReactNode {
  const phase = useGridPhase(section, placeholders, cells.map(cellKey));
  // Live column count (measured off the probe grid below) — in both branches
  // when the band pages, so the pad is right in the render a release happens in.
  const { probeRef, columns } = useGridColumns(minCardWidth);
  const windowed = cells.length > VIRTUALIZE_THRESHOLD;
  const probe =
    windowed || phase.paged ? (
      <Grid
        ref={probeRef}
        aria-hidden
        minCellWidth={`${minCardWidth}px`}
        gap="lg"
        className="h-0"
      />
    ) : null;
  if (!windowed) {
    const pad = phase.pad(columns);
    return (
      <>
        {probe}
        <Grid minCellWidth={`${minCardWidth}px`} gap="lg">
          {Array.from({ length: pad }, (_, i) => (
            <div key={`::pad:${i}`} aria-hidden data-grid-pad="" />
          ))}
          {cells.map((cell) => (
            <div key={cellKey(cell)} className="contents">
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
          estimateSize={estimateRowHeight}
          getKey={(line) => line.key}
        >
          {(line) => (
            <Grid cols={columns} gap="lg" className="pb-lg">
              {line.cells.map((cell, i) =>
                cell === null ? (
                  <div key={`::pad:${i}`} aria-hidden data-grid-pad="" />
                ) : (
                  <div key={cellKey(cell)} className="contents">
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
