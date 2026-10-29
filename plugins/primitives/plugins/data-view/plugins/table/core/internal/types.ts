import type { ReactNode } from "react";
import type { ClassName } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import type {
  RowMenuHelpers,
  RowMenuItem,
} from "@plugins/primitives/plugins/tree/core";

/**
 * Per-view options for the table view, passed via
 * `DataViewProps.viewOptions["table"]` (a `viewOptions={{ table: { … } }}`
 * literal — never import this view child).
 *
 * The options under "Nesting" are read only when the data source has a
 * `hierarchy` (the table then nests its rows); a flat source ignores them.
 */
export interface TableViewOptions<TRow = unknown> {
  /**
   * Where the column labels sit. `"row"` (default) is the sticky column-header
   * row. `"first-group"` drops that row and puts the labels on the FIRST group
   * header instead: the group's label spans the leading unlabelled columns and
   * each labelled column's header sits in its own track (aligned with the
   * cells, sort-on-click kept). Ungrouped — or when the first column is itself
   * labelled — it falls back to `"row"`. Pairs with `FieldDef.header: false`
   * to leave the leading columns unlabelled. See `data-table`'s
   * `DataTableColumnHeader`.
   */
  columnHeader?: "row" | "first-group";
  /**
   * How the table looks. `"grid"` (default) — the column-header row and a rule
   * under every row. `"outline"` — a sidebar's look: no header, no rules, rows
   * as rounded pills tinted on hover and selection (the tree row's tokens). See
   * `data-table`'s `DataTablePresentation`. `"soft"` — borderless rows of a
   * min height with a rounded hover fill and a between-row hairline, one
   * header row, an optional frame; sized by the DataView token group's
   * `soft*` tokens.
   */
  presentation?: "grid" | "outline" | "soft";
  /**
   * A leading cover column: each row's cover (`resolveCover` — the surface's
   * `cover` accessor, a `FieldDef.cover` field, else the first `media` field)
   * as a thumbnail (`CoverFrame size="thumb"`, the soft thumb tokens). The
   * surface's primary item action then sits over the thumbnail on hover.
   * Flat table only. Default `false`.
   */
  cover?: boolean;
  /**
   * Draw the column-header row. Default: `grid` yes, `outline` no. An outline
   * that keeps its column labels over tree rows (a file listing's Name /
   * Modified / Size — the tree view's `columns: "aligned"`) passes `true`; its
   * columns then give way in a narrow box, least important first (the
   * placement's priority). See
   * `data-table`'s `DataTableProps.header`. A view's own `columnCaptions`
   * wins over it.
   */
  header?: boolean;
  /**
   * The view instance's Column captions choice (the table view-type's
   * `configSchema`, in the view's settings panel): `shown` / `hidden` draw the
   * column labels or not; `auto` (and unset) keeps `header`, else the
   * presentation's default (`grid` / `soft` yes, `outline` no) — resolved by
   * `tableHeaderOption`. A three-way choice, not a switch: a switch has no
   * "default" position, so it would read off over a table showing its labels.
   * Code passes `header`; this key is the user's.
   */
  columnCaptions?: "auto" | "shown" | "hidden";

  // --- Nesting (a hierarchical source only) ---

  /**
   * Expansion for rows the user has never toggled (no entry in the view's
   * expand map). `true` opens the whole tree on first paint while staying
   * collapsible. Default `false`.
   */
  defaultExpanded?: boolean;
  /** Indent guides: a hairline per ancestor level in the first cell's indent. */
  guides?: boolean;
  /** Scope the table to the subtree rooted at this id. */
  rootId?: string;
  /**
   * Rows whose activation (a click) toggles their expansion instead of
   * activating them — "click a folder to open it". Stateless: expand state
   * still lives in the view's expand map. Alias rows never toggle.
   */
  expandOnActivate?: (row: TRow) => boolean;
  /**
   * Rows a single click OPENS (`onRowOpen`) instead of activating — a file
   * browser's folder. Arrow keys still only activate; Enter still opens.
   */
  openOnActivate?: (row: TRow) => boolean;
  /** The floating chip's content while a row is dragged. Default: its label. */
  dragOverlay?: (row: TRow) => ReactNode;
  /**
   * Persistent content right after the first cell's label (a status badge, a
   * count) — at rest, unlike `itemActions`, which reveal on hover.
   */
  trailing?: (row: TRow) => ReactNode;
  /**
   * A full-row wash over the row (a translucent membership tint), in a
   * primitive-owned `absolute inset-0` layer that composes with the row's
   * hover / selected tints.
   */
  rowAccent?: (row: TRow) => ReactNode;
  /** The row's `⋯` menu, in its hover cluster. An alias row has none. */
  rowMenu?: (helpers: RowMenuHelpers, row: TRow) => RowMenuItem[];
  /**
   * A per-row class on the first cell's label (done / dropped strikethrough).
   * Composed after `DataViewProps.rowTone`, so it wins.
   */
  labelClassName?: (row: TRow) => ClassName | undefined;
  /**
   * The root "Add" button under the rows (a new top-level row, through
   * `hierarchy.onCreate`). `null` hides it; absent → "Add" when the hierarchy
   * can create, else none. Never under `rootId`.
   */
  addLabel?: string | null;
  /**
   * Offer the whole-table expand-all: a control in the DataView's own toolbar
   * (beside filter / sort / view settings) and Expand all / Collapse all rows
   * in its view settings — present only while some row in scope has children.
   * Absent keeps a minimal surface's chrome free of it (a group header's fold
   * stays either way).
   */
  expandAll?: boolean;
}
