/**
 * How a view that CAN nest (`DataViewContribution.nestsHierarchy`, the table)
 * draws a hierarchical source — `ViewState.nesting`, Notion's per-view
 * "Sub-items" setting.
 *
 * - **`nested`** (default) — the tree: children under their parent.
 * - **`flat`** — every row, parent or child, as one top-level row; the
 *   structure stays readable through the host-derived Parent field.
 * - **`roots`** — only the top-level rows (a row whose parent is `null` or not
 *   among the rows, the tree's orphan rule), drawn flat.
 *
 * A source with no hierarchy, or a view type that never nests, ignores it.
 */
export type Nesting = "nested" | "flat" | "roots";

/** The id of the host-derived Parent field a non-nesting view gets over a
 *  hierarchical source. Reserved: a consumer field claiming it throws. */
export const PARENT_FIELD_ID = "parent";
