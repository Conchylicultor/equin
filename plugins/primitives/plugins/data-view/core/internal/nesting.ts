/**
 * How a view draws a source's sub-items — `ViewState.nesting`, Notion's
 * per-view "Sub-items" setting. Two kinds of source have sub-items
 * ({@link SubItemsKind}): a `hierarchy`, nested by a view declaring
 * `nestsHierarchy` (the table), and rows that `attach` beneath others, nested
 * by a view declaring `nestsAttach` (the list).
 *
 * - **`nested`** (default) — children under their parent.
 * - **`flat`** — every row, parent or child, as one top-level row; a
 *   hierarchy's structure stays readable through the host-derived Parent
 *   field, an attached row sits in its own section.
 * - **`roots`** — only the top-level rows (a hierarchy row whose parent is
 *   `null` or not among the rows, the tree's orphan rule; a row that would not
 *   attach), drawn flat.
 *
 * A source without sub-items, or a view type that never nests them, ignores it.
 */
export type Nesting = "nested" | "flat" | "roots";

/** Which kind of sub-items a source has — what its Sub-items setting switches. */
export type SubItemsKind = "hierarchy" | "attach";

/** The id of the host-derived Parent field a non-nesting view gets over a
 *  hierarchical source. Reserved: a consumer field claiming it throws. */
export const PARENT_FIELD_ID = "parent";
