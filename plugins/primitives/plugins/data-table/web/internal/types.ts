import type {
  CSSProperties,
  KeyboardEvent,
  ReactNode,
  RefCallback,
} from "react";
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
  /**
   * When the table runs out of room, the order this column gives way in: lower
   * drops first, until the first column keeps its minimum. A column without one
   * never drops — whatever still does not fit scrolls sideways. The first column
   * never drops. Grid presentation only.
   */
  dropOrder?: number;
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

/**
 * How the table looks.
 *
 * - **`"grid"`** (default) — the column-header row, a hairline under every row,
 *   a faint hover tint and an accent fill on the selected row.
 * - **`"outline"`** — a sidebar's look: no header row and no row rules; each
 *   row is a rounded pill tinted on hover, the selected one in the `--selected`
 *   tier (its text `--selected-foreground`, its secondary cells
 *   `--selected-meta-foreground`) — the tree row's tokens, so a table drawn as
 *   an outline reads like the tree it replaces.
 */
export type DataTablePresentation = "grid" | "outline";

/**
 * Rows that nest. `DataTable` never builds a tree: the caller passes the
 * already-flattened visible lines as `data` (in paint order — the table keeps
 * that order and never sorts or filters it) and this prop says how a line
 * differs from a flat row. The row-level wiring (drag source, drop zones, row
 * gestures, `data-tree-*` / ARIA attributes) arrives through
 * `useRowDecoration`, the same per-row seam a flat table's drag reorder uses.
 */
export interface DataTableTree<TRow> {
  /**
   * Wraps the first column's cell in the row's tree head — indent, guides,
   * disclosure. The returned node is the grid item, so it should be a box that
   * lets the cell shrink (`min-w-0`).
   */
  leading: (row: TRow, cell: ReactNode) => ReactNode;
  /**
   * A line drawn as ONE full-span row instead of cells — an open lazy row's
   * loading / failed / empty placeholder child. `null` → an ordinary row. A
   * full-span line takes no decoration, no actions and no selection.
   */
  fullSpan?: (row: TRow) => ReactNode | null;
  /** The keyboard host's ref (`useTreeKeyboard`), attached to the grid. */
  containerRef?: RefCallback<HTMLElement>;
  /** The keyboard host's key handler, on the grid (rows are its targets). */
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
}

/**
 * Checkbox multi-select over the table's rows, through the `multi-select`
 * primitive: the table mounts its provider (the range order is the rows as
 * painted), a `SelectionBar` above the rows, and a checkbox ahead of each row's
 * first cell — inside the tree head when the rows nest.
 */
export interface DataTableSelection {
  /** Bulk-action buttons in the `SelectionBar` (rendered inside the provider,
   *  so they may call `useMultiSelect()`). */
  actions?: ReactNode;
}

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
  /**
   * The host's open disclosures the rows were flattened under, in its own key
   * space — a nested table's expanded node ids, the open fold lines. A change
   * of the rows that comes with a flip here folds (revealed rows grow in,
   * hidden ones fold out, the rows below slide — `row-fold`); so does a
   * group's `collapsed` flip, which the table tracks itself. Absent: only
   * group collapse folds.
   */
  openKeys?: ReadonlySet<string>;
  /** Control density for the table's controls/badges; defaults to compact (`xs`). */
  controlSize?: ControlSize;
  /** Where the column labels sit — see {@link DataTableColumnHeader}. Default `"row"`. */
  columnHeader?: DataTableColumnHeader;
  /** Row rhythm — see {@link DataTableDensity}. Default `"comfortable"`. */
  density?: DataTableDensity;
  /** How the table looks — see {@link DataTablePresentation}. Default `"grid"`. */
  presentation?: DataTablePresentation;
  /**
   * Rows that nest — see {@link DataTableTree}. Present → `data` (or each
   * group's `rows`) is the flattened visible tree, drawn in the order given, and
   * the grid is a `treegrid`. Absent → a flat table, unchanged.
   */
  tree?: DataTableTree<TRow>;
  /** Checkbox multi-select — see {@link DataTableSelection}. */
  selection?: DataTableSelection;
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
  /**
   * The row reads highlighted — a drop target under a drag — in the
   * presentation's own selected tint, which the sticky first cell follows.
   */
  highlighted?: boolean;
}
