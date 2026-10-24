import {
  flattenTagTree,
  rolledUpTagCounts,
  tagColor,
  type TagNode,
} from "@plugins/tag-tree/plugins/engine/core";

// What the Places app makes of its tag tree — the generic tree helpers (paths,
// colours, descendants, counts) are the tag-tree engine's. Tags form ONE nested
// tree; "Been" and "Want to go" are ordinary root tags too — found by ROLE,
// never by id or name. They are independent: a place may carry either, both or
// neither.

/** The roles the app finds its tags by; at most one tag holds each. */
export const TAG_ROLES = ["been", "want"] as const;
export type TagRole = (typeof TAG_ROLES)[number];

/** The pin colour of a place none of whose tags has a colour. */
export const NEUTRAL_PLACE_COLOR = "#94a3b8";

/** The part of a Places tag these helpers read: a tree node plus the Places extras. */
export interface PlaceTagNode extends TagNode {
  readonly googleTypes: readonly string[];
  readonly role: TagRole | null;
}

interface RoleIndex {
  byId: ReadonlyMap<string, PlaceTagNode>;
  byRole: ReadonlyMap<TagRole, PlaceTagNode>;
}

// One index per tags array: a live read hands every caller the same array, so
// a render that asks for many places' colours builds the index once.
const indexes = new WeakMap<readonly PlaceTagNode[], RoleIndex>();

function indexOf(tags: readonly PlaceTagNode[]): RoleIndex {
  const cached = indexes.get(tags);
  if (cached) return cached;
  const byRole = new Map<TagRole, PlaceTagNode>();
  for (const t of tags) if (t.role !== null) byRole.set(t.role, t);
  const index = { byId: new Map(tags.map((t) => [t.id, t])), byRole };
  indexes.set(tags, index);
  return index;
}

/**
 * How many of `places` carry each tag or anything nested under it — a tag's
 * count in the sidebar, the tag manager and the picker. A place counts once
 * per tag even when several of its tags sit under it; a tag no place reaches
 * is absent (read it as 0).
 */
export function tagPlaceCounts(
  places: readonly { readonly tags: readonly string[] }[],
  tags: readonly TagNode[],
): Map<string, number> {
  return rolledUpTagCounts(
    places.map((p) => p.tags),
    tags,
  );
}

/** The id of the tag holding `role`, or undefined when no tag does. */
export function tagIdByRole(
  tags: readonly PlaceTagNode[],
  role: TagRole,
): string | undefined {
  return indexOf(tags).byRole.get(role)?.id;
}

/** Whether a tag holds a role (Been, Want to go) — drawn apart, never as a pin slice. */
export function isRoleTag(
  tagId: string,
  tags: readonly PlaceTagNode[],
): boolean {
  const role = indexOf(tags).byId.get(tagId)?.role;
  return role !== undefined && role !== null;
}

/**
 * Which of the two independent role tags a place carries. A role no tag holds
 * reads as not carried.
 */
export function placeFlags(
  place: { readonly tags: readonly string[] },
  tags: readonly PlaceTagNode[],
): { been: boolean; want: boolean } {
  const has = (role: TagRole) => {
    const id = tagIdByRole(tags, role);
    return id !== undefined && place.tags.includes(id);
  };
  return { been: has("been"), want: has("want") };
}

/**
 * The distinct colours of a place's non-role tags, in the order the place
 * holds its tags — the slices of its pin. Empty when none has a colour (the pin
 * then wears {@link NEUTRAL_PLACE_COLOR}, see {@link mainColor}). Been / Want
 * to go are drawn separately (Want to go = a solid pin), never as a slice.
 */
export function ringColors(
  place: { readonly tags: readonly string[] },
  tags: readonly PlaceTagNode[],
): string[] {
  const out: string[] = [];
  for (const tagId of place.tags) {
    if (isRoleTag(tagId, tags)) continue;
    const color = tagColor(tagId, tags);
    if (color !== null && !out.includes(color)) out.push(color);
  }
  return out;
}

/** A place's one colour (legend, cluster share): its first ring colour, else neutral. */
export function mainColor(
  place: { readonly tags: readonly string[] },
  tags: readonly PlaceTagNode[],
): string {
  return ringColors(place, tags)[0] ?? NEUTRAL_PLACE_COLOR;
}

/**
 * The tags a place of these Google types gets automatically: every tag one of
 * whose `googleTypes` the place has, in tree order.
 */
export function autoTagsFor(
  types: readonly string[],
  tags: readonly PlaceTagNode[],
): string[] {
  const have = new Set(types);
  return flattenTagTree(tags)
    .filter(({ tag }) => tag.googleTypes.some((g) => have.has(g)))
    .map(({ tag }) => tag.id);
}
