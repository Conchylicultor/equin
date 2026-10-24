// A typed tag path ("app / website / homepage"): how the picker previews
// "Create a / b / c" and how the server's createPath walks the tree. One
// implementation for both, so the preview names exactly what the server makes.

import { flattenTagTree, type NamedTagNode } from "./tree";

/** The segments of a typed path: split on "/", each trimmed, empties dropped. */
export function parseTagPath(input: string): string[] {
  return input
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** One segment of {@link resolveTagPath}: the existing tag it names, or `null` — to create. */
export interface ResolvedTagSegment {
  readonly name: string;
  readonly tagId: string | null;
}

/**
 * Walks `segments` from the root: each names a child of the previous one
 * (case-insensitive, the first in rank order on a tie). A segment no child
 * matches is `null` — to create — and so is every one after it.
 */
export function resolveTagPath(
  segments: readonly string[],
  tags: readonly NamedTagNode[],
): ResolvedTagSegment[] {
  // Flatten order lists siblings in rank order and treats an orphan as a root,
  // so the children of a parent here are exactly the tree's.
  const childrenOf = new Map<string | null, NamedTagNode[]>();
  const ids = new Set(tags.map((t) => t.id));
  for (const { tag } of flattenTagTree(tags)) {
    const parent =
      tag.parentId !== null && ids.has(tag.parentId) ? tag.parentId : null;
    const list = childrenOf.get(parent) ?? [];
    list.push(tag);
    childrenOf.set(parent, list);
  }
  const out: ResolvedTagSegment[] = [];
  let parentId: string | null = null;
  let missing = false;
  for (const name of segments) {
    const lower = name.toLowerCase();
    const match: NamedTagNode | undefined = missing
      ? undefined
      : (childrenOf.get(parentId) ?? []).find(
          (t) => t.name.toLowerCase() === lower,
        );
    if (match === undefined) {
      missing = true;
      out.push({ name, tagId: null });
    } else {
      parentId = match.id;
      out.push({ name, tagId: match.id });
    }
  }
  return out;
}
