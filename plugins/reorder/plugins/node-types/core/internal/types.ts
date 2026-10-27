import type { ReactNode } from "react";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import type { ReorderNode } from "@plugins/fields/plugins/reorder-tree/core";

/**
 * Props handed to a node type's `render`. The `payload` is the per-type payload
 * (validated against the node type's own `schema`); structural fields (`id`,
 * `children`) and the generic write callbacks come from the host.
 */
export interface ReorderNodeRenderProps<P = unknown> {
  /** Validated per-type payload (e.g. a header's `label`/`collapsed`). */
  payload: P;
  /** Structural addressing id (lazy uuid). Leaf node types rely on it. */
  id?: string;
  /**
   * Drawn in the Config pane's layout editor (a draggable placeholder); an area
   * in the app always draws at rest.
   */
  editMode: boolean;
  /** Which way the area's items run (a divider turns its rule to it). */
  orientation: "horizontal" | "vertical";
  /** Pre-rendered members — present only for container node types. */
  children?: ReactNode;
  /** Write payload back, addressed by `id` (shallow-merged into the node). */
  onPatch: (next: Partial<P>) => void;
  /** Remove this node from the tree. */
  onRemove: () => void;
}

/**
 * A reorder node type, contributed to the `reorder.node-type` registry slot. The
 * type owns its payload schema; the core tree format only knows the structural
 * `type`/`id`/`items` fields.
 */
export interface ReorderNodeType<P = unknown> {
  /** Stable dispatch key, matched against a node's `type`. */
  type: string;
  /** True when the node holds members (`items[]`) and gets pre-rendered children. */
  container: boolean;
  /** Validates (and shapes) this type's opaque payload. */
  schema: ZodParser<P>;
  render: (props: ReorderNodeRenderProps<P>) => ReactNode;
  /** Optional in-app insert affordance (e.g. "Add Spacer"). */
  insert?: { label: string; create: () => ReorderNode };
}
