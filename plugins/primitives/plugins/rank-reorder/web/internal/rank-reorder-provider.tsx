import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  DndContext,
  MeasuringStrategy,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type MeasuringConfiguration,
  type PointerSensorOptions,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  verticalListSortingStrategy,
  type SortingStrategy,
} from "@dnd-kit/sortable";
import type { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  resolveSortableDrop,
  sortableOrder,
  type RankReorderItem,
  type RankSortableLayout,
} from "./resolve-sortable-drop";
import { sortableDataGroup } from "./use-rank-sortable-item";

export interface RankReorderProviderProps {
  /** All draggable items. The provider groups them by `group` (groups in the
   *  order first listed) and orders each group by rank — the display order the
   *  rows slide through. */
  items: readonly RankReorderItem[];
  /** One column (`vertical`, the default) or a wrapping grid (`grid`): picks
   *  how the neighbours slide out of the dragged item's way. */
  layout?: RankSortableLayout;
  /**
   * Persist a reorder **within one group**. `dest.group` is that group (the drop
   * target's, which equals the dragged item's on this path). `dest.targetId` /
   * `dest.zone` are the drop neighbor's id + side, surfaced so neighbor-based
   * (endpoint) consumers can persist by neighbor instead of by `rank`. No-op
   * drops (same position) are filtered out before this fires.
   */
  onMove: (
    id: string,
    dest: {
      rank: Rank;
      group: string | null;
      targetId: string;
      zone: "before" | "after";
    },
  ) => void | Promise<void>;
  /**
   * Persist a **cross-group** move — the destination group plus the drop
   * neighbour. Anchor-only: the primitive does not mint a rank in a group whose
   * membership the host is about to change.
   *
   * Its **presence is the capability**: absent, collision detection only
   * considers the dragged item's own group, so a drag can neither slide nor
   * land anywhere else — the refusal is visible during the gesture rather than
   * a silent no-op at drop time.
   */
  onReseat?: (
    id: string,
    dest: {
      group: string | null;
      targetId: string;
      zone: "before" | "after";
    },
  ) => void | Promise<void>;
  /** Re-measure droppables every frame (windowed lists). */
  measuringAlways?: boolean;
  /** Children. A render-prop receives the active drag id, which a windowed
   *  consumer forwards as `keepMounted` so the drag source stays in the DOM when
   *  it scrolls out of the window; a plain node ignores it. */
  children: ReactNode | ((activeId: string | null) => ReactNode);
}

/**
 * High-level flat rank-reorder host, sortable style: the dragged row itself
 * follows the pointer (no floating chip) and its group's rows slide out of its
 * way. One `SortableContext` spans every item in display order; per-row wiring
 * comes from `useRankSortableItem`. A drop resolves to a destination `Rank` via
 * `resolveSortableDrop` (`computeFlatReorder` within the group), so manual
 * order composes with group-by sections.
 *
 * Cross-group drops are a **separate capability**: with `onReseat` they route
 * there (a group write plus a reorder is the host's business, not the
 * primitive's), and nothing slides while the pointer is over another group;
 * without it collision is limited to the dragged item's own group.
 */
export function RankReorderProvider({
  items,
  layout = "vertical",
  onMove,
  onReseat,
  measuringAlways,
  children,
}: RankReorderProviderProps) {
  // Module-level sensor options: `useSensor` memoizes on the options object, so
  // an inline literal would mint new sensors — and so new activator listeners
  // on every sortable row — on every render.
  const sensors = useSensors(useSensor(PointerSensor, POINTER_SENSOR_OPTIONS));
  const [activeId, setActiveId] = useState<string | null>(null);
  const ordered = useMemo(() => sortableOrder(items), [items]);
  // The sortable context and the slide strategy are keyed on what they read —
  // the ids in display order, and each one's group — not on the `items`
  // array, which a host rebuilds whenever any row changes. A new context value
  // re-renders EVERY sortable row, so an unchanged order must keep it.
  const idsKey = JSON.stringify(ordered.map((i) => i.id));
  const ids = useMemo(() => JSON.parse(idsKey) as string[], [idsKey]);
  const groupsKey = JSON.stringify(ordered.map((i) => i.group ?? null));
  const crossGroup = onReseat != null;

  const collisionDetection = useCallback<CollisionDetection>(
    (args) => {
      if (crossGroup) return closestCenter(args);
      const group = sortableDataGroup(args.active.data.current);
      return closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter(
          (c) => sortableDataGroup(c.data.current) === group,
        ),
      });
    },
    [crossGroup],
  );

  // Rows only slide within the dragged item's group: over another group (a
  // reseat), nothing moves but the dragged row itself.
  const strategy = useMemo<SortingStrategy>(() => {
    const base =
      layout === "grid" ? rectSortingStrategy : verticalListSortingStrategy;
    if (!crossGroup) return base;
    const groups = JSON.parse(groupsKey) as (string | null)[];
    return (args) =>
      groups[args.activeIndex] === groups[args.overIndex] ? base(args) : null;
  }, [layout, crossGroup, groupsKey]);

  const onDragStart = useCallback(
    (event: DragStartEvent) => setActiveId(String(event.active.id)),
    [],
  );
  const onDragCancel = useCallback(() => setActiveId(null), []);

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveId(null);
      const { active, over } = event;
      if (!over) return;
      const drop = resolveSortableDrop(
        ordered,
        String(active.id),
        String(over.id),
        { layout, dragged: active.rect.current.translated, over: over.rect },
      );
      if (drop.kind === "none") return;
      if (drop.kind === "reseat") {
        if (!onReseat) {
          // Unreachable: without `onReseat` collision only sees the dragged
          // item's group. Loud rather than silent, because reaching it means a
          // consumer passed grouped `items` but withheld the group from
          // `useRankSortableItem`.
          throw new Error(
            `rank-reorder: cross-group drop with no onReseat (${String(active.id)} → group ${String(drop.group)}). Pass each row's group to useRankSortableItem.`,
          );
        }
        const { group, targetId, zone } = drop;
        void onReseat(String(active.id), { group, targetId, zone });
        return;
      }
      const { rank, group, targetId, zone } = drop;
      void onMove(String(active.id), { rank, group, targetId, zone });
    },
    [ordered, layout, onMove, onReseat],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      measuring={measuringAlways ? MEASURE_ALWAYS : undefined}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      <SortableContext items={ids} strategy={strategy}>
        {typeof children === "function" ? children(activeId) : children}
      </SortableContext>
    </DndContext>
  );
}

/** 4px before a press becomes a drag, so a click on a row still activates it. */
const POINTER_SENSOR_OPTIONS: PointerSensorOptions = {
  activationConstraint: { distance: 4 },
};

/** Re-measure droppables every frame (windowed lists). */
const MEASURE_ALWAYS: MeasuringConfiguration = {
  droppable: { strategy: MeasuringStrategy.Always },
};
