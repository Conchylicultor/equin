import { z } from "zod";
import { pickMeta, type FieldDef, type FieldMeta } from "@plugins/fields/core";
import {
  reorderTreeFieldType,
  type ReorderNode,
  type ReorderTree,
} from "@plugins/fields/plugins/reorder-tree/core";

const nodeSchema: z.ZodType<ReorderNode> = z.lazy(() =>
  z.union([
    z.string(),
    // `{item}` arm MUST precede the typed-node arm so item nodes are never
    // swallowed (and `hidden` is preserved).
    z.object({ item: z.string(), hidden: z.boolean().optional() }),
    z
      .object({
        type: z.string(), // REQUIRED — gates the typed-node arm
        id: z.string().optional(),
        items: z.array(nodeSchema).optional(),
      })
      // per-type payload survives passthrough; validated downstream by the
      // node type's own schema, not here.
      .passthrough(),
  ]),
);

export interface ReorderTreeFieldDef extends FieldDef<ReorderTree> {
  readonly type: typeof reorderTreeFieldType;
}

export function reorderTreeField(
  opts?: FieldMeta & { default?: ReorderTree },
): ReorderTreeFieldDef {
  return Object.freeze({
    type: reorderTreeFieldType,
    schema: z.array(nodeSchema),
    defaultValue: opts?.default ?? [],
    meta: pickMeta(opts),
  });
}

/**
 * Discriminated, normalized view of a {@link ReorderNode}. Coerces the terse
 * bare-string form to `{ kind: "item", item, hidden: false }`. Structural and
 * payload-opaque — the node type's payload is carried verbatim in `payload`
 * (own keys minus the structural `type`/`id`/`items`) and validated downstream
 * by the node type's own schema, not here.
 */
export type NormalizedNode =
  | { kind: "item"; item: string; hidden: boolean }
  | {
      kind: "node";
      type: string;
      id?: string;
      payload: Record<string, unknown>;
      members?: ReorderNode[];
    };

export function normalizeNode(node: ReorderNode): NormalizedNode {
  if (typeof node === "string") {
    return { kind: "item", item: node, hidden: false };
  }
  if ("item" in node) {
    // The typed-node arm's `[payload]: unknown` index signature defeats
    // discriminated narrowing here, so read the item-node shape explicitly.
    const itemNode = node as { item: string; hidden?: boolean };
    return {
      kind: "item",
      item: itemNode.item,
      hidden: itemNode.hidden ?? false,
    };
  }
  if ("type" in node) {
    const { type, id, items, ...payload } = node;
    return { kind: "node", type, id, payload, members: items };
  }
  // The zod schema prevents this in practice; fail loud.
  throw new Error("malformed reorder node");
}
