import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  FieldCell,
  DATA_VIEW_HEADER_OFFSET_VAR,
  useResolveCell,
  useResolveCellEditor,
  type FieldDef,
  type SortRule,
} from "@plugins/primitives/plugins/data-view/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Sticky } from "@plugins/primitives/plugins/css/plugins/sticky/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { fitAlignedColumns } from "@plugins/primitives/plugins/data-table/core";

const arrowUpwardIcon = symbol("arrow-upward");
const arrowDownwardIcon = symbol("arrow-downward");

/** A column's width when its field declares none a row can use. */
const DEFAULT_COLUMN_WIDTH = "6rem";

/**
 * The fixed width of an aligned column, from the field's `width`.
 *
 * `FieldDef.width` is a table GRID TRACK (`"12rem"`, `"auto"`, `"minmax(0,1fr)"`).
 * A tree row is a flex line, not a grid, so only a definite length carries over;
 * a content-sized or flexible track has no meaning when each row sizes its own
 * cells, and falls back to the default — every row must agree on the width, or
 * the columns stop lining up, which is the whole point of the mode. A definite
 * length must be px or rem: the fit (`useAlignedFit`) adds the widths up.
 */
export function alignedColumnWidth(field: FieldDef<unknown>): string {
  const w = field.width?.trim();
  if (!w || /auto|minmax|content|\dfr\b/.test(w)) {
    return DEFAULT_COLUMN_WIDTH;
  }
  if (!LENGTH.test(w)) {
    throw new Error(
      `Aligned column "${field.id}": width "${w}" must be a px or rem length`,
    );
  }
  return w;
}

const LENGTH = /^(\d*\.?\d+)(px|rem)$/;

function alignedColumnPx(field: FieldDef<unknown>): number {
  const [, n, unit] = LENGTH.exec(alignedColumnWidth(field))!;
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return parseFloat(n!) * (unit === "rem" ? rem : 1);
}

/** The narrowest the row label gets before an aligned column gives way. */
const MIN_LABEL_PX = 160;

/**
 * The aligned columns that fit, given the label's measured width: attach
 * `labelRef` to the header's label cell. Columns give way (`FieldDef.dropOrder`)
 * so the label keeps `MIN_LABEL_PX` — measured on the tree itself, so a narrow
 * pane in a wide window drops them as a narrow window does. Until measured
 * (or with no header), every column shows.
 */
export function useAlignedFit<TRow>(fields: FieldDef<TRow>[]): {
  shown: FieldDef<TRow>[];
  labelRef: (el: HTMLElement | null) => void;
} {
  const [label, setLabel] = useState<HTMLElement | null>(null);
  const [room, setRoom] = useState<{ budget: number; gap: number } | null>(
    null,
  );
  const shown = useMemo(() => {
    if (!room) return fields;
    const cols = fields.map((field) => ({
      field,
      px: alignedColumnPx(field as FieldDef<unknown>),
      dropOrder: field.dropOrder,
    }));
    return fitAlignedColumns(cols, { ...room, minLabel: MIN_LABEL_PX }).map(
      (c) => c.field,
    );
  }, [fields, room]);
  const shownRef = useLatestRef(shown);
  useResizeObserver(
    () => label,
    () => {
      const row = label?.parentElement;
      // A row with no box is not laid out (hidden, or no layout engine): it
      // says nothing about the room, so every column stays.
      if (!label || !row || row.getBoundingClientRect().width === 0) return;
      // The room is the label plus every column now shown — the same total
      // whichever columns show, so the fit settles in one step.
      const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
      const columns = shownRef.current.reduce(
        (sum, f) => sum + alignedColumnPx(f as FieldDef<unknown>) + gap,
        0,
      );
      const budget = label.getBoundingClientRect().width + columns;
      setRoom((prev) =>
        prev && prev.budget === budget && prev.gap === gap
          ? prev
          : { budget, gap },
      );
    },
    { deps: [label] },
  );
  return { shown, labelRef: setLabel };
}

/** Aligned cells default to the end edge (dates, sizes, counts read right-aligned). */
function alignClass(field: FieldDef<unknown>): string {
  const align = field.align ?? "end";
  return align === "end"
    ? "text-right"
    : align === "center"
      ? "text-center"
      : "text-left";
}

function columnStyle(field: FieldDef<unknown>): CSSProperties {
  return { width: alignedColumnWidth(field) };
}

/**
 * A row's secondary fields as fixed-width, edge-aligned cells — the aligned
 * twin of the trailing chips. Rendered LAST in the row (after the flexible
 * label), so whatever the row's depth, its cells sit on the same right edge as
 * every other row's and as the header's.
 */
export function AlignedCells<TRow>({
  row,
  fields,
}: {
  row: TRow;
  fields: FieldDef<TRow>[];
}): ReactNode {
  const resolveCell = useResolveCell();
  const resolveEditor = useResolveCellEditor();
  return (
    <>
      {fields.map((f) => (
        <span
          key={f.id}
          data-aligned-cell={f.id}
          // A fixed-width cell of the tree row's flex line: it truncates
          // inside its own width, so every row's column lines up.
          className={cn(
            rigidClass(),
            // `text-row-meta`: muted, or the selected row's meta colour when
            // the row is selected and the theme sets one.
            "truncate text-caption text-row-meta",
            alignClass(f as FieldDef<unknown>),
          )}
          style={columnStyle(f as FieldDef<unknown>)}
        >
          <FieldCell
            field={f as FieldDef<unknown>}
            row={row}
            resolveCell={resolveCell}
            resolveEditor={resolveEditor}
            display="inline"
          />
        </span>
      ))}
      <AlignedEndInset />
    </>
  );
}

/**
 * The last column's end inset: the cells (and their titles) stop a step in from
 * the row's edge rather than on its padding, so the row's fill reaches past
 * them. Rigid, so it survives the label's truncation.
 */
function AlignedEndInset(): ReactNode {
  return <span aria-hidden className={cn(rigidClass(), "pl-xs")} />;
}

/**
 * One column title: a sort toggle when the field sorts (writing the view's own
 * sort, the same `setSort` the table's headers call), plain text otherwise.
 */
function HeaderCell({
  field,
  sortHeader,
  setSort,
  className,
  style,
}: {
  field: FieldDef<unknown>;
  sortHeader: { active: readonly SortRule[]; sortable: ReadonlySet<string> };
  setSort: (fieldId: string) => void;
  className?: string;
  style?: CSSProperties;
}): ReactNode {
  const title = typeof field.header === "string" ? field.header : field.label;
  const text = field.header === false ? "" : title;
  if (!sortHeader.sortable.has(field.id)) {
    return (
      <span className={className} style={style}>
        {text}
      </span>
    );
  }
  const active = sortHeader.active.find((r) => r.fieldId === field.id);
  return (
    <button
      type="button"
      onClick={() => setSort(field.id)}
      aria-label={`Sort by ${field.label}`}
      aria-sort={
        active
          ? active.direction === "asc"
            ? "ascending"
            : "descending"
          : undefined
      }
      data-aligned-header={field.id}
      className={cn(
        "hover:text-foreground",
        active && "text-foreground",
        className,
      )}
      style={style}
    >
      {text}
      {active && (
        <Icon
          icon={
            active.direction === "asc" ? arrowUpwardIcon : arrowDownwardIcon
          }
          // eslint-disable-next-line spacing/no-adhoc-spacing -- one-off inline sort-arrow offset beside the column title (mirrors the table header)
          className="ml-0.5 inline-block size-3 align-middle"
        />
      )}
    </button>
  );
}

/**
 * The aligned tree's column header: the primary field's title over the label
 * column, then one title per aligned cell, each the same width as the cells
 * beneath it. Pinned under the DataView's own toolbar (the host-published
 * header offset), so the titles stay readable while the tree scrolls.
 *
 * Geometry mirrors `TreeRowChrome` at depth 0 — the same inline padding, the
 * chevron slot's width and the same gap — so the titles sit over the label and
 * the cells by construction rather than by a measured offset.
 */
export function AlignedHeader({
  primaryField,
  fields,
  sortHeader,
  setSort,
  labelRef,
}: {
  primaryField: FieldDef<unknown> | undefined;
  fields: FieldDef<unknown>[];
  /** The label cell, measured by `useAlignedFit`. */
  labelRef?: (el: HTMLElement | null) => void;
  sortHeader: { active: readonly SortRule[]; sortable: ReadonlySet<string> };
  setSort: (fieldId: string) => void;
}): ReactNode {
  return (
    <Sticky
      mask
      data-tree-column-header
      style={{ top: `var(${DATA_VIEW_HEADER_OFFSET_VAR}, 0px)` }}
    >
      <Stack
        direction="row"
        align="center"
        gap="none"
        role="row"
        // A row tall, its rule inside; the titles in the small caption rung,
        // faint. Its cells sit `TreeRowChrome`'s gap apart.
        className="min-h-tree-row gap-tree-row border-b border-border px-xs text-caption-compact font-medium text-faint-foreground"
        // Depth 0's indent in `TreeRowChrome`: its lead inset.
        style={{ paddingLeft: "var(--tree-row-pad-start)" }}
      >
        {/* The chevron / icon slot's width, so the Name title sits on the label. */}
        <span className="size-5" aria-hidden />
        <Fill ref={labelRef}>
          {primaryField ? (
            <HeaderCell
              field={primaryField}
              sortHeader={sortHeader}
              setSort={setSort}
              className="text-left"
            />
          ) : null}
        </Fill>
        {fields.map((f) => (
          <HeaderCell
            key={f.id}
            field={f}
            sortHeader={sortHeader}
            setSort={setSort}
            className={cn(rigidClass(), alignClass(f))}
            style={columnStyle(f)}
          />
        ))}
        <AlignedEndInset />
      </Stack>
      {/* A 4px breath under the rule before the first row. */}
      <div aria-hidden className="pt-xs" />
    </Sticky>
  );
}
