import type { ReactNode } from "react";

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
   * `data-table`'s `DataTablePresentation`.
   */
  presentation?: "grid" | "outline";

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
  /**
   * An icon in the first cell's disclosure slot (Notion style: the icon at
   * rest, the chevron on hover), after the schema's leading field — which,
   * nested, renders there too instead of as a column.
   */
  leadingIcon?: (row: TRow) => ReactNode;
  /** The floating chip's content while a row is dragged. Default: its label. */
  dragOverlay?: (row: TRow) => ReactNode;
}
