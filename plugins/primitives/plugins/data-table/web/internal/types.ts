import type { CSSProperties, ReactNode } from "react";
import type { ControlSize } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { SortState } from "./use-data-table";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import type { Activation } from "@plugins/primitives/plugins/link-gesture/core";

export interface ColumnDef<TRow> {
  id: string;
  /**
   * The column's header text. Absent or `""` ⇒ an UNLABELLED column: its header
   * cell renders empty (still sortable on click when the column has a `value`).
   * Under `columnHeader="first-group"`, the first labelled column is where the
   * first group's label stops spanning — see {@link DataTableColumnHeader}.
   */
  header?: string;
  /**
   * CSS grid track size for this column. Default `"auto"` (content-sized to the
   * widest cell, like a real table). e.g. `"12rem"` (fixed), `"minmax(0,1fr)"`
   * (absorbs leftover space + truncates), `"minmax(120px,200px)"`.
   * Header and body share one grid via subgrid, so alignment is automatic — no
   * `shrink-0` / `min-w-0` needed.
   */
  width?: string;
  /** Text alignment within the column (applies to header + cells). Default `"start"`. */
  align?: "start" | "end" | "center";
  value?: (row: TRow) => string | number | undefined;
  /**
   * Whether the header toggles sort on this column. Default: iff `value` is
   * given (the in-memory sort reads it). A controlled table whose sort runs
   * elsewhere (a server-ordered DataView) states it, since a column may show a
   * value it cannot be ordered by.
   */
  sortable?: boolean;
  cell?: (row: TRow) => ReactNode;
}

/**
 * One group of rows for the interleaved group-header render mode. When
 * `DataTableProps.groups` is set, the table renders each group's caller-built
 * `header` as a full-span row inside the single subgrid (so columns stay aligned
 * across groups), then the group's rows when not `collapsed`. The header node is
 * fully owned by the caller (chevron, label, count, toggle) — the table stays
 * agnostic. Grouped mode is non-virtualized (targets bounded, sectioned lists).
 */
export interface DataTableGroup<TRow> {
  /** Stable key (React key for the header row). */
  key: string;
  /** Full-span header content (the caller owns the toggle + chevron + count). */
  header: ReactNode;
  /** Hide this group's rows (the header still renders, to allow re-expanding). */
  collapsed: boolean;
  rows: readonly TRow[];
  /**
   * Optional full-span row after the group's rows (hidden with them when
   * `collapsed`). Caller-owned content, like `header` — data-view draws its fold
   * line here. A group with a footer is not empty even when `rows` is.
   */
  footer?: ReactNode;
}

/**
 * Where the column labels sit.
 *
 * - **`"row"`** (default) — one sticky column-header row above the body.
 * - **`"first-group"`** — no header row: in grouped mode the FIRST group's header
 *   becomes a subgrid row of its own. The group's label spans the leading tracks
 *   up to the first labelled column, and each labelled column's header sits in
 *   its own track (same subgrid, so it aligns with the cells by construction;
 *   sort-on-click is kept). Every other group header stays full-span. The labels
 *   are shown ONCE, as a caption over the first section, for a short sectioned
 *   list where a separate header row would cost a line per surface.
 *
 *   Falls back to `"row"` when there is nothing to put the labels on: ungrouped,
 *   or when the first column is itself labelled (the label would have no
 *   leading track to span).
 */
export type DataTableColumnHeader = "row" | "first-group";

/**
 * Row rhythm. `"comfortable"` (default) pads each row's block axis with the row
 * density token (`py-row`); `"compact"` reads the compact rung (`py-row-compact`,
 * the `padRowCompactY` density token) — for a dense surface such as a popover
 * list. The control density is a separate axis ({@link DataTableProps.controlSize}).
 */
export type DataTableDensity = "comfortable" | "compact";

export interface DataTableProps<TRow> {
  data: readonly TRow[];
  columns: ColumnDef<TRow>[];
  /**
   * Optional grouped render: interleave caller-built full-span section headers
   * with their rows inside the single subgrid. When set, `data` is ignored for
   * body rows (the rows come from each group) and virtualization is disabled.
   */
  groups?: DataTableGroup<TRow>[];
  filter?: string;
  /**
   * Optional full-span row after the ungrouped body (the grouped twin is
   * `DataTableGroup.footer`). A table with a footer never shows `emptyLabel`:
   * the footer is content, and saying "No results" above it would be false.
   */
  footer?: ReactNode;
  rowKey: (row: TRow, index: number) => string;
  emptyLabel?: string;
  /**
   * Host-controlled sort. When provided (alongside `onToggleSort`), the table
   * reflects this sort state instead of owning it internally.
   */
  sortState?: SortState | null;
  /** Host-controlled sort toggle; pairs with `sortState`. */
  onToggleSort?: (columnId: string) => void;
  /**
   * What activating a row does — click, Enter or Space. A `LinkTarget` (an
   * opener's result, `openPane.to(…)`) makes the row a LINK: ⌘/Ctrl- and
   * middle-click open its `href()` in a new browser tab; a plain action only
   * runs on the plain gestures; `undefined` leaves that row inert. Present →
   * rows are clickable and focusable.
   */
  rowActivation?: (row: TRow) => Activation | undefined;
  /**
   * The open gesture: double-click a row, or Enter on a focused row (Space then
   * still runs `rowActivation`). Distinct from the click — a file browser's
   * "click selects, double-click opens". Present → rows are focusable.
   */
  onRowOpen?: (row: TRow) => void;
  /**
   * Row key of the active/selected row. The matching row gets a persistent
   * `bg-accent` highlight. Compared against `rowKey(row, index)`.
   */
  selectedRowId?: string;
  /** Trailing per-row actions, hover-revealed in their own column. */
  rowActions?: (row: TRow, index: number) => ReactNode;
  /**
   * Trailing per-row actions that stay painted **at rest** (never revealed),
   * sharing the same reserved trailing track as {@link rowActions} and sitting
   * immediately before it. For an affordance important enough to be visible
   * without hovering (a Play button). The track is reserved whenever either is
   * present.
   */
  rowPersistentActions?: (row: TRow, index: number) => ReactNode;
  /**
   * CSS length the table's own sticky rows pin at, measured from the top of the
   * scroll viewport. Defaults to `"0px"` (flush to the top). Set this when a
   * sticky element sits ABOVE the table in the SAME scroll container (e.g. a
   * DataView's sticky toolbar) so the sticky column-header row stacks directly
   * below it instead of hiding behind it; group headers then stack below the
   * column header (offset by its measured height). Accepts any CSS length,
   * including a `var(...)` / `calc(...)` expression.
   */
  stickyHeaderOffset?: string;
  /**
   * Per-row decoration HOOK, called once per rendered row INSIDE the row
   * component (so the consumer may call hooks — e.g. `useRankSortableItem` for
   * drag reorder). Returns a ref + props spread + classes + style + in-row
   * overlay for the row element. Composes with windowing: a decorated row is still measured
   * and windowed. Inert when absent. The name must start with `use` (it is
   * invoked as a hook). Stable per mount.
   */
  useRowDecoration?: Hook<
    (row: TRow, index: number) => DataTableRowDecoration | undefined
  >;
  /**
   * Row keys that must stay mounted when scrolled out of the window — an
   * in-flight drag source, whose `useDraggable` would otherwise unregister
   * mid-gesture and cancel the drop. Pass the active drag id while a drag is in
   * flight, nothing otherwise. Ignored in grouped (non-windowed) mode.
   */
  keepMountedRowKeys?: readonly string[];
  /** Control density for the table's controls/badges; defaults to compact (`xs`). */
  controlSize?: ControlSize;
  /** Where the column labels sit — see {@link DataTableColumnHeader}. Default `"row"`. */
  columnHeader?: DataTableColumnHeader;
  /** Row rhythm — see {@link DataTableDensity}. Default `"comfortable"`. */
  density?: DataTableDensity;
}

/**
 * Per-row decoration returned by `DataTableProps.useRowDecoration`. Applied to
 * the row element: a callback `ref` (drag source), arbitrary `props` spread
 * (drag attributes + listeners), extra `className`, inline `style` (a sortable
 * row's slide transform — a transform on a subgrid row leaves the column
 * tracks alone), and an in-row `overlay` (absolutely-positioned content — the
 * row is `relative`).
 */
export interface DataTableRowDecoration {
  ref?: (el: HTMLElement | null) => void;
  props?: Record<string, unknown>;
  className?: string;
  style?: CSSProperties;
  overlay?: ReactNode;
}
