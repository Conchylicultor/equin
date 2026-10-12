// Pure helpers over the tag tree. Tags form ONE nested tree; a tag's colour is
// its own, else its nearest ancestor's. The status branch is ordinary tags too —
// found by ROLE, never by id: the `status` tag and its `todo` / `done` leaves,
// one of which every place carries.

/** The roles the status logic finds its tags by; at most one tag holds each. */
export const TAG_ROLES = ["status", "todo", "done"] as const;
export type TagRole = (typeof TAG_ROLES)[number];

/** A place's status — a semantic value, resolved to a tag through its role. */
export const PLACE_STATUSES = ["todo", "done"] as const;
export type PlaceStatus = (typeof PLACE_STATUSES)[number];

/** The pin colour of a place none of whose tags has a colour. */
export const NEUTRAL_PLACE_COLOR = "#94a3b8";

/** The part of a tag the tree helpers read. */
export interface TagNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly color: string | null;
  readonly rank: number;
  readonly googleTypes: readonly string[];
  readonly role: TagRole | null;
}

interface TagIndex {
  byId: ReadonlyMap<string, TagNode>;
  byRole: ReadonlyMap<TagRole, TagNode>;
  children: ReadonlyMap<string | null, readonly TagNode[]>;
}

// One index per tags array: a live read hands every caller the same array, so
// a render that asks for many places' colours builds the index once.
const indexes = new WeakMap<readonly TagNode[], TagIndex>();

function indexOf(tags: readonly TagNode[]): TagIndex {
  const cached = indexes.get(tags);
  if (cached) return cached;
  const byId = new Map(tags.map((t) => [t.id, t]));
  const children = new Map<string | null, TagNode[]>();
  for (const t of tags) {
    // A parent that is not in the set is treated as the root, so an orphan
    // still shows up in the tree.
    const parent =
      t.parentId !== null && byId.has(t.parentId) ? t.parentId : null;
    const list = children.get(parent) ?? [];
    list.push(t);
    children.set(parent, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.rank - b.rank);
  const byRole = new Map<TagRole, TagNode>();
  for (const t of tags) if (t.role !== null) byRole.set(t.role, t);
  const index = { byId, byRole, children };
  indexes.set(tags, index);
  return index;
}

/** The tag and its ancestors, nearest first; stops on an unknown id or a cycle. */
function selfAndAncestors(tagId: string, index: TagIndex): TagNode[] {
  const out: TagNode[] = [];
  const seen = new Set<string>();
  let tag = index.byId.get(tagId);
  while (tag && !seen.has(tag.id)) {
    out.push(tag);
    seen.add(tag.id);
    tag = tag.parentId === null ? undefined : index.byId.get(tag.parentId);
  }
  return out;
}

/** A tag's colour: its own, else its nearest ancestor's; null when none has one. */
export function tagColor(
  tagId: string,
  tags: readonly TagNode[],
): string | null {
  for (const tag of selfAndAncestors(tagId, indexOf(tags))) {
    if (tag.color !== null) return tag.color;
  }
  return null;
}

/** The path from the root to the tag, as tags (root first). Empty for an unknown id. */
export function tagPath<T extends TagNode>(
  tagId: string,
  tags: readonly T[],
): T[] {
  return (selfAndAncestors(tagId, indexOf(tags)) as T[]).reverse();
}

/** Every descendant of the tag (not the tag itself), depth-first in rank order. */
export function tagDescendants<T extends TagNode>(
  tagId: string,
  tags: readonly T[],
): T[] {
  const { children } = indexOf(tags);
  const out: T[] = [];
  const seen = new Set<string>([tagId]);
  const walk = (id: string) => {
    for (const child of children.get(id) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child as T);
      walk(child.id);
    }
  };
  walk(tagId);
  return out;
}

/** One tag of {@link flattenTagTree}: the tag and its depth (roots at 0). */
export interface TagTreeEntry<T extends TagNode> {
  readonly tag: T;
  readonly depth: number;
}

/**
 * The whole tree, depth-first in rank order, each tag with its depth — the
 * order every tree surface (the sidebar, the tag manager, a tag picker) lists
 * tags in. An orphan (its parent is not in the set) is listed as a root.
 */
export function flattenTagTree<T extends TagNode>(
  tags: readonly T[],
): TagTreeEntry<T>[] {
  const { children } = indexOf(tags);
  const out: TagTreeEntry<T>[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push({ tag: child as T, depth });
      walk(child.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/**
 * How many of `places` carry each tag or anything nested under it — a tag's
 * count in the sidebar and the tag manager. A place counts once per tag even
 * when several of its tags sit under it; a tag no place reaches is absent
 * (read it as 0).
 */
export function tagPlaceCounts(
  places: readonly { readonly tags: readonly string[] }[],
  tags: readonly TagNode[],
): Map<string, number> {
  const index = indexOf(tags);
  const counts = new Map<string, number>();
  for (const place of places) {
    const reached = new Set<string>();
    for (const tagId of place.tags) {
      for (const t of selfAndAncestors(tagId, index)) reached.add(t.id);
    }
    for (const id of reached) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** Whether `tagId` is `ancestorId` or sits under it. */
export function isTagUnder(
  tagId: string,
  ancestorId: string,
  tags: readonly TagNode[],
): boolean {
  return selfAndAncestors(tagId, indexOf(tags)).some(
    (t) => t.id === ancestorId,
  );
}

/** The id of the tag holding `role`, or undefined when no tag does. */
export function tagIdByRole(
  tags: readonly TagNode[],
  role: TagRole,
): string | undefined {
  return indexOf(tags).byRole.get(role)?.id;
}

/**
 * The `todo` and `done` tag ids. Throws when either role is missing: the seed
 * creates both and neither can be deleted, so a tree without them is broken.
 */
export function statusTagIds(tags: readonly TagNode[]): {
  todo: string;
  done: string;
} {
  const todo = tagIdByRole(tags, "todo");
  const done = tagIdByRole(tags, "done");
  if (todo === undefined || done === undefined) {
    throw new Error("The place tag tree has no todo / done tag");
  }
  return { todo, done };
}

/** Whether a tag belongs to the status branch: a role tag, or under `status`. */
export function isStatusTag(tagId: string, tags: readonly TagNode[]): boolean {
  const index = indexOf(tags);
  const role = index.byId.get(tagId)?.role;
  if (role !== undefined && role !== null) return true;
  const status = index.byRole.get("status");
  return status !== undefined && isTagUnder(tagId, status.id, tags);
}

/** A place's status: `done` when it carries the done-role tag, else `todo`. */
export function placeStatus(
  place: { readonly tags: readonly string[] },
  tags: readonly TagNode[],
): PlaceStatus {
  const done = tagIdByRole(tags, "done");
  return done !== undefined && place.tags.includes(done) ? "done" : "todo";
}

/** A place's tag ids with its status swapped to `status` (the other removed). */
export function withPlaceStatus(
  placeTags: readonly string[],
  status: PlaceStatus,
  tags: readonly TagNode[],
): string[] {
  const ids = statusTagIds(tags);
  return [
    ...placeTags.filter((t) => t !== ids.todo && t !== ids.done),
    ids[status],
  ];
}

/**
 * The distinct colours of a place's non-status tags, in the order the place
 * holds its tags — the slices of its pin. Empty when none has a colour (the pin
 * then wears {@link NEUTRAL_PLACE_COLOR}, see {@link mainColor}). Status is
 * drawn separately (the done check), never as a slice.
 */
export function ringColors(
  place: { readonly tags: readonly string[] },
  tags: readonly TagNode[],
): string[] {
  const out: string[] = [];
  for (const tagId of place.tags) {
    if (isStatusTag(tagId, tags)) continue;
    const color = tagColor(tagId, tags);
    if (color !== null && !out.includes(color)) out.push(color);
  }
  return out;
}

/** A place's one colour (legend, cluster share): its first ring colour, else neutral. */
export function mainColor(
  place: { readonly tags: readonly string[] },
  tags: readonly TagNode[],
): string {
  return ringColors(place, tags)[0] ?? NEUTRAL_PLACE_COLOR;
}

/**
 * The tags a place of these Google types gets automatically: every tag one of
 * whose `googleTypes` the place has, in tree order.
 */
export function autoTagsFor(
  types: readonly string[],
  tags: readonly TagNode[],
): string[] {
  const have = new Set(types);
  const ordered = [
    ...(indexOf(tags).children.get(null) ?? []).flatMap((root) => [
      root,
      ...tagDescendants(root.id, tags),
    ]),
  ];
  return ordered
    .filter((t) => t.googleTypes.some((g) => have.has(g)))
    .map((t) => t.id);
}

/** Whether moving `tagId` under `parentId` would make it its own ancestor. */
export function wouldCycle(
  tagId: string,
  parentId: string | null,
  tags: readonly TagNode[],
): boolean {
  return parentId !== null && isTagUnder(parentId, tagId, tags);
}
