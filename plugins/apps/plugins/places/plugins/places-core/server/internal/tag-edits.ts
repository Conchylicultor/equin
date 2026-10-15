import type { TagNode } from "../../core";

// The pure halves of the tag writes: what a place's `tags` / `autoTags` become
// under a PATCH or a tag delete. The repo functions load, call these, and write.

export type TagListEdit =
  | { ok: true; tags: string[]; autoTags: string[] }
  | { ok: false; reason: string };

/**
 * A place's tags after a PATCH. `tags` replaces the list (deduplicated, order
 * kept; every id must be a tag). Been / Want to go are ordinary tags here.
 * `autoTags` keeps only what is still in `tags`, so removing an auto tag drops
 * its AUTO mark too.
 */
export function editPlaceTags(
  current: { tags: readonly string[]; autoTags: readonly string[] },
  patch: { tags?: readonly string[] },
  allTags: readonly TagNode[],
): TagListEdit {
  const known = new Set(allTags.map((t) => t.id));
  let tags = [...current.tags];
  if (patch.tags !== undefined) {
    const next = [...new Set(patch.tags)];
    const unknown = next.filter((t) => !known.has(t));
    if (unknown.length > 0) {
      return { ok: false, reason: `Unknown tag: ${unknown.join(", ")}` };
    }
    tags = next;
  }
  return {
    ok: true,
    tags,
    autoTags: current.autoTags.filter((t) => tags.includes(t)),
  };
}

/**
 * A place's tags once `deletedId` is deleted: the tag is replaced by its parent
 * (dropped at the root, and not duplicated if the place already has the
 * parent); it leaves `autoTags`.
 */
export function replaceDeletedTag(
  place: { tags: readonly string[]; autoTags: readonly string[] },
  deletedId: string,
  parentId: string | null,
): { tags: string[]; autoTags: string[] } {
  const tags = [
    ...new Set(
      place.tags.flatMap((t) =>
        t === deletedId ? (parentId === null ? [] : [parentId]) : [t],
      ),
    ),
  ];
  return { tags, autoTags: place.autoTags.filter((t) => t !== deletedId) };
}
