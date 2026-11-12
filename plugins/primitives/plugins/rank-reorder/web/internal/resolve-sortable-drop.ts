import {
  Rank,
  computeFlatReorder,
} from "@plugins/primitives/plugins/rank/core";
import { beforeInReadingOrder } from "./drag-preview";

/** One reorderable item: a stable id, its sort `Rank`, and an optional
 *  section/group key. A drop onto another group's row is a *reseat*, reported
 *  through `onReseat` — and only offered when the host supplies it. */
export interface RankReorderItem {
  id: string;
  rank: Rank;
  /** Section key; `null`/omitted = the single implicit group. */
  group?: string | null;
}

/** How the items are laid out: one column, or a wrapping 2-D grid. */
export type RankSortableLayout = "vertical" | "grid";

/** A client rect, as dnd-kit measures it. */
export interface DropRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** What a sortable drop means for the ranks. */
export type SortableDrop =
  /** Nothing moved (dropped back on its own slot, or no rank fits). */
  | { kind: "none" }
  /** A reorder within the dragged item's own group, with its new rank. */
  | {
      kind: "move";
      rank: Rank;
      group: string | null;
      targetId: string;
      zone: "before" | "after";
    }
  /** A drop into another group: anchor only, no rank. */
  | {
      kind: "reseat";
      group: string | null;
      targetId: string;
      zone: "before" | "after";
    };

const groupOf = (item: RankReorderItem): string | null => item.group ?? null;

/**
 * The display order the sortable context walks: groups in the order the caller
 * first lists them, rank-sorted within each group. Items of one group are
 * therefore contiguous, so a drag only ever slides its own group's rows.
 */
export function sortableOrder(
  items: readonly RankReorderItem[],
): RankReorderItem[] {
  const groups = new Map<string | null, RankReorderItem[]>();
  for (const item of items) {
    const g = groupOf(item);
    const bucket = groups.get(g);
    if (bucket) bucket.push(item);
    else groups.set(g, [item]);
  }
  return [...groups.values()].flatMap((bucket) =>
    [...bucket].sort((a, b) => Rank.compare(a.rank, b.rank)),
  );
}

/**
 * Resolve a sortable drop (`active` released over `over`) against the items in
 * `sortableOrder`.
 *
 * - **Same group**: the sortable strategy has already slid the rows so the
 *   dragged one sits in `over`'s slot — after it when moving down, before it
 *   when moving up. The rank comes from `computeFlatReorder` over that group;
 *   an unchanged rank is a no-op.
 * - **Other group** (only reachable when the host offers `onReseat`): the rows
 *   do not slide across groups, so the side is read from geometry — the dragged
 *   box's translated centre against `over`'s centre, in reading order for a
 *   grid.
 */
export function resolveSortableDrop(
  ordered: readonly RankReorderItem[],
  activeId: string,
  overId: string,
  geometry: {
    layout: RankSortableLayout;
    dragged: DropRect | null;
    over: DropRect;
  },
): SortableDrop {
  if (activeId === overId) return { kind: "none" };
  const activeIndex = ordered.findIndex((i) => i.id === activeId);
  const overIndex = ordered.findIndex((i) => i.id === overId);
  if (activeIndex === -1 || overIndex === -1) {
    throw new Error(
      `rank-reorder: drop between unknown items (${activeId} → ${overId}); every sortable row must be listed in the provider's items.`,
    );
  }
  const active = ordered[activeIndex]!;
  const group = groupOf(ordered[overIndex]!);

  if (groupOf(active) !== group) {
    if (!geometry.dragged) {
      throw new Error(
        `rank-reorder: cross-group drop of ${activeId} with no measured drag rect.`,
      );
    }
    const zone = beforeInReadingOrder(
      geometry.layout,
      geometry.dragged,
      geometry.over,
    )
      ? "before"
      : "after";
    return { kind: "reseat", group, targetId: overId, zone };
  }

  const zone = overIndex > activeIndex ? "after" : "before";
  const scope = ordered.filter((i) => groupOf(i) === group);
  const rank = computeFlatReorder(scope, activeId, zone, overId);
  if (rank === null || Rank.equals(active.rank, rank)) return { kind: "none" };
  return { kind: "move", rank, group, targetId: overId, zone };
}
