import type {
  DropRect,
  RankReorderItem,
  RankSortableLayout,
} from "./resolve-sortable-drop";

/**
 * Where a row being dragged into ANOTHER group is laid out while the drag is
 * in flight (the multi-container sortable pattern): in `group`, `zone` of
 * `targetId` — or, with no anchor, at the head of `group` (dragged over its
 * header, or over an empty group's band). The host draws the row there, so
 * that group's rows slide around it exactly as its own rows would.
 */
export interface RankDragPreview {
  id: string;
  group: string | null;
  targetId?: string;
  zone?: "before" | "after";
}

/** What a cross-group drop reports: the destination group, and the neighbour
 *  the row lands beside — absent when it was dropped into the group itself
 *  (its header, an empty group's band): the host keeps the row's rank. */
export interface RankReseatDest {
  group: string | null;
  targetId?: string;
  zone?: "before" | "after";
}

/** What the pointer is over, as the preview reads it. */
export type PreviewOver =
  | { kind: "row"; id: string; group: string | null }
  | { kind: "group"; group: string; preview: boolean }
  | { kind: "other" }
  | null;

/** The preview's next value: unchanged, or set (`null` = back home). */
export type PreviewStep =
  { kind: "keep" } | { kind: "set"; preview: RankDragPreview | null };

const groupOf = (item: RankReorderItem): string | null => item.group ?? null;

/**
 * Lay `ordered` (the provider's display order) out with `preview` applied: the
 * dragged item taken out of its group and put in the preview's group — beside
 * its anchor, else at that group's head; a group with no items yet takes it at
 * the end of the order (the host draws the group wherever it draws it; the
 * order only has to keep each group contiguous). The moved item carries its
 * new group, which is what the slide strategy compares.
 */
export function previewOrder(
  ordered: readonly RankReorderItem[],
  preview: RankDragPreview | null,
): RankReorderItem[] {
  if (preview === null) return [...ordered];
  const moved = ordered.find((i) => i.id === preview.id);
  if (!moved) return [...ordered];
  const rest = ordered.filter((i) => i.id !== preview.id);
  const item: RankReorderItem = { ...moved, group: preview.group };
  let at: number;
  if (preview.targetId !== undefined) {
    const anchor = rest.findIndex((i) => i.id === preview.targetId);
    if (anchor === -1) {
      at = groupHead(rest, preview.group);
    } else {
      at = preview.zone === "after" ? anchor + 1 : anchor;
    }
  } else {
    at = groupHead(rest, preview.group);
  }
  return [...rest.slice(0, at), item, ...rest.slice(at)];
}

/** Index of `group`'s first item, or the end of the order when it has none. */
function groupHead(
  items: readonly RankReorderItem[],
  group: string | null,
): number {
  const i = items.findIndex((item) => groupOf(item) === group);
  return i === -1 ? items.length : i;
}

/**
 * The preview step for one drag-over. `origin` is the dragged item's own
 * group, `current` the preview the drag shows now:
 *
 * - over a row (or a group header / empty band) of the group the row is
 *   ALREADY shown in → keep: the sortable slide handles it from there;
 * - over its own group → back home (no preview);
 * - over a row of another group → into that group, on the side of the row
 *   the dragged box's centre is on;
 * - over another group's target that draws the row (`preview`: an empty
 *   group's band) → into that group, unanchored;
 * - over one that does not (a collapsed group's header) → keep: the row stays
 *   laid out where it is, only the target lights;
 * - over something else (the new-group target) → back home;
 * - over nothing → keep (dnd-kit reports `null` between targets).
 */
export function nextPreview(
  activeId: string,
  origin: string | null,
  current: RankDragPreview | null,
  over: PreviewOver,
  geometry: {
    layout: RankSortableLayout;
    dragged: DropRect | null;
    over: DropRect | null;
  },
): PreviewStep {
  if (over === null) return { kind: "keep" };
  if (over.kind === "group" && !over.preview) return { kind: "keep" };
  if (over.kind === "other") {
    return current === null ? { kind: "keep" } : { kind: "set", preview: null };
  }
  const shown = current === null ? origin : current.group;
  if (over.group === shown) return { kind: "keep" };
  if (over.group === origin) return { kind: "set", preview: null };
  if (over.kind === "group") {
    return { kind: "set", preview: { id: activeId, group: over.group } };
  }
  const zone =
    geometry.dragged && geometry.over
      ? beforeInReadingOrder(geometry.layout, geometry.dragged, geometry.over)
        ? "before"
        : "after"
      : "before";
  return {
    kind: "set",
    preview: { id: activeId, group: over.group, targetId: over.id, zone },
  };
}

/**
 * Where a drop with a live preview lands: the previewed order, then the slide
 * the sortable strategy shows (the dragged item in `overId`'s slot — after it
 * moving down, before it moving up), read back as the item's neighbour in its
 * new group: after the one above it, else before the one below it, else (the
 * group holds nothing else) no anchor at all.
 */
export function previewDropDest(
  previewed: readonly RankReorderItem[],
  activeId: string,
  overId: string | null,
): RankReseatDest {
  const from = previewed.findIndex((i) => i.id === activeId);
  if (from === -1) {
    throw new Error(
      `rank-reorder: preview drop of ${activeId}, which the previewed order does not hold.`,
    );
  }
  const group = groupOf(previewed[from]!);
  const order = [...previewed];
  const to = overId === null ? -1 : order.findIndex((i) => i.id === overId);
  if (to !== -1 && to !== from && groupOf(order[to]!) === group) {
    const [item] = order.splice(from, 1);
    order.splice(to, 0, item!);
  }
  const scope = order.filter((i) => groupOf(i) === group);
  const at = scope.findIndex((i) => i.id === activeId);
  const above = scope[at - 1];
  if (above) return { group, targetId: above.id, zone: "after" };
  const below = scope[at + 1];
  if (below) return { group, targetId: below.id, zone: "before" };
  return { group };
}

/** Is the dragged box's centre ahead of `over`'s centre? A column compares y;
 *  a grid compares x within `over`'s row band and y outside it. */
export function beforeInReadingOrder(
  layout: RankSortableLayout,
  dragged: DropRect,
  over: DropRect,
): boolean {
  const dy = dragged.top + dragged.height / 2;
  const oy = over.top + over.height / 2;
  if (layout === "grid" && dy >= over.top && dy <= over.top + over.height) {
    return dragged.left + dragged.width / 2 < over.left + over.width / 2;
  }
  return dy < oy;
}

/** A section-reorder drop: `key` dragged over `overKey`, among `keys` in
 *  display order — after it moving down, before it moving up; `null` when it
 *  did not move. */
export function resolveGroupDrop(
  keys: readonly string[],
  key: string,
  overKey: string,
): { targetKey: string; zone: "before" | "after" } | null {
  if (key === overKey) return null;
  const from = keys.indexOf(key);
  const to = keys.indexOf(overKey);
  if (from === -1 || to === -1) {
    throw new Error(
      `rank-reorder: group drop between unknown groups (${key} → ${overKey}); every sortable group must be listed in the provider's groups.keys.`,
    );
  }
  return { targetKey: overKey, zone: to > from ? "after" : "before" };
}
