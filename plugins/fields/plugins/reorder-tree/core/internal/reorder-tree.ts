import { defineFieldType, defineFieldIdentity } from "@plugins/fields/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const reorderIcon = symbol("reorder");

/**
 * A node in a reorder tree. A bare string is the terse form of `{ item }`.
 * Normalize via `normalizeNode` (config/core) before reading.
 *
 * Items stay terse and core; every **extension** node uses an explicit
 * `{ type }` shape. The core format reserves **only** the structural fields the
 * generic catalog-walker must understand:
 * - `type` — registry dispatch (selects the node type).
 * - `id` — generic addressing for in-app patch/remove.
 * - `items` — child-list recursion point for container node types.
 *
 * Every other key is **opaque per-type payload owned by the node type** (e.g. a
 * `header`'s `label`/`collapsed`), validated by that type's own schema — the
 * core format never names them.
 */
export type ReorderNode =
  | string
  | { item: string; hidden?: boolean }
  | {
      type: string;
      id?: string;
      items?: ReorderNode[];
      [payload: string]: unknown;
    };

export type ReorderTree = ReorderNode[];

export const reorderTreeFieldType =
  defineFieldType<ReorderTree>("reorder-tree");

export const reorderTreeIdentity = defineFieldIdentity<ReorderTree>({
  type: reorderTreeFieldType,
  kind: "label",
  label: "Reorder Tree",
  icon: reorderIcon,
  // no coerce — not a sortable/filterable scalar (like string-list).
});
