// Pure helpers over a tag tree's flat rows (`parentId` links them). A tag's
// colour is its own, else a shade of a ramp parent's, else its nearest
// ancestor's. Every helper tolerates an orphan (a parent not in the set — it is
// treated as a root) and a cycle (walks stop on a repeat).
//
// Siblings sort by `rank` with a plain string compare (`a < b`), which equals
// `Rank.compare` and the DB's C collation for fractional-indexing keys.

import type { FieldOption } from "@plugins/primitives/plugins/data-view/core";
import type { ChildColorMode } from "./fields";

/** The part of a tag the tree helpers read. */
export interface TagNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly color: string | null;
  readonly childColors: ChildColorMode | null;
  readonly rank: string;
}

/** A node the label helpers read: a {@link TagNode} with its name. */
export type NamedTagNode = TagNode & { readonly name: string };

interface TagIndex {
  byId: ReadonlyMap<string, TagNode>;
  children: ReadonlyMap<string | null, readonly TagNode[]>;
}

// One index per tags array: a live read hands every caller the same array, so
// a render that asks many questions of one tree builds the index once.
const indexes = new WeakMap<readonly TagNode[], TagIndex>();

const byRank = (a: TagNode, b: TagNode) =>
  a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0;

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
  for (const list of children.values()) list.sort(byRank);
  const index = { byId, children };
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

/**
 * A tag's colour: its own; else, under a `ramp` parent, its shade of the
 * parent's colour ({@link rampShade}, by its rank among its siblings); else
 * its nearest ancestor's. Null when no colour reaches it.
 */
export function tagColor(
  tagId: string,
  tags: readonly TagNode[],
): string | null {
  const index = indexOf(tags);
  return chainColor(selfAndAncestors(tagId, index), 0, index);
}

/** The colour of `chain[from]`, where `chain` is a tag and its ancestors, nearest first. */
function chainColor(
  chain: readonly TagNode[],
  from: number,
  index: TagIndex,
): string | null {
  for (let i = from; i < chain.length; i++) {
    const tag = chain[i]!;
    if (tag.color !== null) return tag.color;
    const parent = chain[i + 1];
    if (parent?.childColors !== "ramp") continue;
    const base = chainColor(chain, i + 1, index);
    if (base === null) return null;
    const siblings = index.children.get(parent.id) ?? [];
    return rampShade(base, siblings.indexOf(tag), siblings.length);
  }
  return null;
}

/** How far the first of a ramp mixes toward white, and the last toward black. */
const RAMP_LIGHT = 0.3;
const RAMP_DEEP = 0.4;

/**
 * Shade `i` of `n` of `hex` (`#rrggbb`): the first mixed {@link RAMP_LIGHT}
 * toward white, the last {@link RAMP_DEEP} toward black, the rest evenly
 * between (through the colour itself); a lone child wears the colour as is.
 * Computed as hex, not `color-mix`: tag colours are user data painted on
 * surfaces that do not follow the theme.
 */
export function rampShade(hex: string, i: number, n: number): string {
  const rgb = parseHex(hex);
  if (n <= 1) return hex;
  const t = i / (n - 1);
  const amount = -RAMP_LIGHT + t * (RAMP_LIGHT + RAMP_DEEP);
  const target = amount < 0 ? 255 : 0;
  const k = Math.abs(amount);
  return `#${rgb
    .map((c) =>
      Math.round(c + (target - c) * k)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function parseHex(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`Not a #rrggbb colour: ${hex}`);
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}

/** The path from the root to the tag, as tags (root first). Empty for an unknown id. */
export function tagPath<T extends TagNode>(
  tagId: string,
  tags: readonly T[],
): T[] {
  return (selfAndAncestors(tagId, indexOf(tags)) as T[]).reverse();
}

/** The tag's path as one label, root first, joined by `sep` (default `" / "`). Empty for an unknown id. */
export function tagPathLabel(
  tagId: string,
  tags: readonly NamedTagNode[],
  sep = " / ",
): string {
  return tagPath(tagId, tags)
    .map((t) => t.name)
    .join(sep);
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
 * order every tree surface (a sidebar, a manager, a picker) lists tags in. An
 * orphan (its parent is not in the set) is listed as a root.
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

/** Whether moving `tagId` under `parentId` would make it its own ancestor. */
export function wouldCycle(
  tagId: string,
  parentId: string | null,
  tags: readonly TagNode[],
): boolean {
  return parentId !== null && isTagUnder(parentId, tagId, tags);
}

/**
 * How many items carry each tag or anything nested under it: each item is its
 * list of tag ids. An item counts once per tag even when several of its tags
 * sit under it; a tag no item reaches is absent (read it as 0).
 */
export function rolledUpTagCounts(
  items: Iterable<readonly string[]>,
  tags: readonly TagNode[],
): Map<string, number> {
  const index = indexOf(tags);
  const counts = new Map<string, number>();
  for (const itemTags of items) {
    const reached = new Set<string>();
    for (const tagId of itemTags) {
      for (const t of selfAndAncestors(tagId, index)) reached.add(t.id);
    }
    for (const id of reached) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/**
 * A tree as a DataView field's options, in flatten order: each option's
 * `parent` its parent tag (so the set is a forest — nested group sections,
 * "incl. nested" filters), its `swatch` the tag's colour ({@link tagColor}).
 */
export function tagFieldOptions(tags: readonly NamedTagNode[]): FieldOption[] {
  const ids = new Set(tags.map((t) => t.id));
  return flattenTagTree(tags).map(({ tag }) => {
    const swatch = tagColor(tag.id, tags);
    return {
      value: tag.id,
      label: tag.name,
      // An orphan is listed as a root: its stored parent names no option.
      ...(tag.parentId !== null && ids.has(tag.parentId)
        ? { parent: tag.parentId }
        : {}),
      ...(swatch !== null ? { swatch } : {}),
    };
  });
}

/**
 * `name`, or the first of `name 2`, `name 3`, … that no sibling under
 * `parentId` already has (case-insensitive, as the server refuses a clash) —
 * the name of a tag a "New tag" button makes before the user types one.
 */
export function freeSiblingName(
  name: string,
  parentId: string | null,
  tags: readonly NamedTagNode[],
): string {
  const taken = new Set(
    tags
      .filter((t) => t.parentId === parentId)
      .map((t) => t.name.toLowerCase()),
  );
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
    candidate = `${name} ${n}`;
  }
  return candidate;
}
