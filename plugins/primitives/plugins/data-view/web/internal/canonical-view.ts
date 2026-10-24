import type { VariantValue } from "@plugins/fields/plugins/variant/core";

/**
 * A view's `view` value as the drafts engine compares it (view-core's
 * `ViewModelOptions.canonical`): the filter trees (`filter`, `fold.keep`)
 * without their node ids. A node's id is minted whenever a rule or group is
 * (re)built, so a filter edited back to what it was carries fresh ids — the
 * same view, which must not stay "unsaved".
 */
export function canonicalViewValue(view: VariantValue): unknown {
  const fold = view.fold as { keep?: unknown } | undefined;
  return {
    ...view,
    filter: withoutNodeIds(view.filter),
    fold:
      fold !== null && typeof fold === "object"
        ? { ...fold, keep: withoutNodeIds(fold.keep) }
        : fold,
  };
}

/** A filter tree with every node's `id` removed; anything else as it is. */
function withoutNodeIds(node: unknown): unknown {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    return node;
  }
  const { kind } = node as { kind?: unknown };
  if (kind !== "rule" && kind !== "group") return node;
  const copy: Record<string, unknown> = { ...(node as object) };
  delete copy.id;
  if (Array.isArray(copy.children)) {
    copy.children = copy.children.map(withoutNodeIds);
  }
  return copy;
}
