import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  DndContext,
  MeasuringStrategy,
  closestCenter,
  getClientRect,
  useSensors,
  type ClientRect,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type MeasuringConfiguration,
  type PointerSensorOptions,
} from "@dnd-kit/core";
import { useChromePointerSensor } from "@plugins/primitives/plugins/sortable-list/web";
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
import {
  nextPreview,
  previewDropDest,
  previewOrder,
  resolveGroupDrop,
  type PreviewOver,
  type RankDragPreview,
  type RankReseatDest,
} from "./drag-preview";
import { useNewGroupAutoScroll } from "./new-group-auto-scroll";
import {
  RankDragContext,
  groupSortId,
  nodeKind,
  type RankDragState,
} from "./rank-drag-context";

/** The groups a provider lets the user reorder as whole blocks. */
export interface RankSortableGroups {
  /** The movable groups' keys, in display order (a group not listed stays
   *  where it is, and is no drop slot for a moving one). */
  keys: readonly string[];
  /** Persist a group move: `key` lands `zone` of `targetKey`. */
  onMove: (
    key: string,
    dest: { targetKey: string; zone: "before" | "after" },
  ) => void | Promise<void>;
}

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
   * neighbour, or no neighbour for a drop on the group itself (its header or
   * empty band, `useRankGroupDropTarget`): the host keeps the row's rank.
   * Anchor-only: the primitive does not mint a rank in a group whose
   * membership the host is about to change.
   *
   * Its **presence is the capability**: absent, collision detection only
   * considers the dragged item's own group, so a drag can neither slide nor
   * land anywhere else — the refusal is visible during the gesture rather than
   * a silent no-op at drop time.
   */
  onReseat?: (id: string, dest: RankReseatDest) => void | Promise<void>;
  /**
   * Which groups take a row from another group (default: every one). A group
   * it refuses is neither a slide nor a drop target for a row from elsewhere:
   * its rows and its header / empty band are left out of the row drag's
   * collision, so the row stays previewed where it last was. Its own rows
   * still reorder among themselves.
   */
  reseatInto?: (group: string) => boolean;
  /**
   * The host lays the dragged row out in the group it is dragged into (it
   * applies the render-prop's `preview` to its rows), so that group's rows
   * slide around it as its own rows would. Without it a cross-group drag
   * slides nothing and the side is read from geometry at drop time.
   */
  slideAcrossGroups?: boolean;
  /** Persist a drop on the new-group target (`useRankNewGroupTarget`). Its
   *  presence is the capability: the target is offered only with it. */
  onReseatNew?: (id: string) => void | Promise<void>;
  /** Whole groups the user may reorder (`useRankSortableGroup` per group):
   *  their blocks slide in a second sortable context under the same drag. */
  groups?: RankSortableGroups;
  /** Re-measure droppables every frame (windowed lists). */
  measuringAlways?: boolean;
  /** Children. A render-prop receives the active drag id, which a windowed
   *  consumer forwards as `keepMounted` so the drag source stays in the DOM when
   *  it scrolls out of the window, and — under `slideAcrossGroups` — the
   *  cross-group preview the host lays its rows out by; a plain node ignores
   *  both. */
  children:
    | ReactNode
    | ((activeId: string | null, preview: RankDragPreview | null) => ReactNode);
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
 * primitive's); without it collision is limited to the dragged item's own
 * group. Under `slideAcrossGroups` the row is previewed in the group it is
 * dragged over (the multi-container pattern); otherwise nothing slides there.
 */
export function RankReorderProvider({
  items,
  layout = "vertical",
  onMove,
  onReseat,
  reseatInto,
  slideAcrossGroups = false,
  onReseatNew,
  groups,
  measuringAlways,
  children,
}: RankReorderProviderProps) {
  // Module-level sensor options: `useSensor` memoizes on the options object, so
  // an inline literal would mint new sensors — and so new activator listeners
  // on every sortable row — on every render.
  const sensors = useSensors(useChromePointerSensor(POINTER_SENSOR_OPTIONS));
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeKind, setActiveKind] = useState<"row" | "group" | null>(null);
  const [preview, setPreview] = useState<RankDragPreview | null>(null);
  // The targets laid over the rows (headers, empty bands, the new-group
  // card), listed in the sortable context after the rows and the group
  // blocks — see `RankDragState.addTarget`.
  const [targetIds, setTargetIds] = useState<readonly string[]>([]);
  const addTarget = useCallback((id: string) => {
    setTargetIds((ids) => (ids.includes(id) ? ids : [...ids, id].sort()));
    return () => setTargetIds((ids) => ids.filter((t) => t !== id));
  }, []);
  const autoScroll = useNewGroupAutoScroll(activeId !== null);
  const crossGroup = onReseat != null;
  const livePreview = crossGroup && slideAcrossGroups;
  const shownPreview = livePreview ? preview : null;
  const ordered = useMemo(() => sortableOrder(items), [items]);
  const previewed = useMemo(
    () => previewOrder(ordered, shownPreview),
    [ordered, shownPreview],
  );
  // The sortable context and the slide strategy are keyed on what they read —
  // the ids in display order, and each one's group — not on the `items`
  // array, which a host rebuilds whenever any row changes. A new context value
  // re-renders EVERY sortable row, so an unchanged order must keep it.
  const idsKey = JSON.stringify(previewed.map((i) => i.id));
  const ids = useMemo(() => JSON.parse(idsKey) as string[], [idsKey]);
  const groupsKey = JSON.stringify(previewed.map((i) => i.group ?? null));
  const groupKeysKey = JSON.stringify(groups?.keys ?? []);
  const groupIds = useMemo(
    () => (JSON.parse(groupKeysKey) as string[]).map(groupSortId),
    [groupKeysKey],
  );

  const [spans] = useState(
    () => new WeakMap<Element, () => HTMLElement | null>(),
  );
  const dragState = useMemo<RankDragState>(
    () => ({
      activeKind,
      reseat: crossGroup,
      reseatNew: onReseatNew != null,
      reseatInto: reseatInto ?? null,
      spans,
      addTarget,
      setNewGroupNode: autoScroll.setNewGroupNode,
    }),
    [
      activeKind,
      crossGroup,
      onReseatNew,
      reseatInto,
      spans,
      addTarget,
      autoScroll.setNewGroupNode,
    ],
  );

  // A group block is measured as its header united with its body (see
  // `useRankSortableGroup`); every other node as itself.
  const measuring = useMemo<MeasuringConfiguration>(() => {
    const measure = (el: HTMLElement): ClientRect => {
      const rect = getClientRect(el, { ignoreTransform: true });
      const body = spans.get(el)?.();
      if (!body) return rect;
      return unite(rect, getClientRect(body, { ignoreTransform: true }));
    };
    return {
      draggable: { measure },
      droppable: {
        measure,
        ...(measuringAlways ? { strategy: MeasuringStrategy.Always } : {}),
      },
    };
  }, [spans, measuringAlways]);

  const collisionDetection = useCallback<CollisionDetection>(
    (args) => {
      const of = (kind: string) =>
        args.droppableContainers.filter(
          (c) => nodeKind(c.data.current) === kind,
        );
      if (nodeKind(args.active.data.current) === "group-sort") {
        return closestCenter({
          ...args,
          droppableContainers: of("group-sort").filter((c) =>
            groupIds.includes(String(c.id)),
          ),
        });
      }
      // A row: the targets laid over the rows win while the pointer is on
      // them — the new-group target, then a group's header or empty band.
      if (onReseatNew) {
        const hit = pointerOnLive(args, of("new-group"));
        if (hit.length > 0) return hit;
      }
      const group = sortableDataGroup(args.active.data.current);
      if (crossGroup) {
        // A group that refuses rows from elsewhere is out of the collision:
        // its rows here (its header / band disable themselves, and are
        // filtered too so the rule reads in one place).
        const takes = (g: string | null) =>
          g === group || g === null || !reseatInto || reseatInto(g);
        const hit = pointerOnLive(
          args,
          of("group-drop").filter((c) => takes(String(c.data.current?.group))),
        );
        if (hit.length > 0) return hit;
        return closestCenter({
          ...args,
          droppableContainers: of("row").filter((c) =>
            takes(sortableDataGroup(c.data.current)),
          ),
        });
      }
      return closestCenter({
        ...args,
        droppableContainers: of("row").filter(
          (c) => sortableDataGroup(c.data.current) === group,
        ),
      });
    },
    [crossGroup, onReseatNew, groupIds, reseatInto],
  );

  // Rows only slide within the dragged item's (shown) group: over another
  // group without a live preview (a reseat), nothing moves but the dragged
  // row itself.
  const rowStrategy = useMemo<SortingStrategy>(() => {
    const base =
      layout === "grid" ? rectSortingStrategy : verticalListSortingStrategy;
    if (!crossGroup) return base;
    const shownGroups = JSON.parse(groupsKey) as (string | null)[];
    return (args) =>
      shownGroups[args.activeIndex] === shownGroups[args.overIndex]
        ? base(args)
        : null;
  }, [layout, crossGroup, groupsKey]);
  // ONE sortable context holds the rows, then the group blocks, then the
  // targets laid over the rows. Never two nested contexts: `useSortable`
  // reads the NEAREST one, so every row under a nested group context would
  // find itself in no list — no row would follow the pointer or slide. Each
  // kind slides only among its own kind, over its own slice of the rects (so
  // a neighbour's gap is its own kind's); over a target nothing slides, but
  // the dragged row — over a listed node — still follows the pointer.
  const sortableItems = useMemo(
    () =>
      groupIds.length === 0 && targetIds.length === 0
        ? ids
        : [...ids, ...groupIds, ...targetIds],
    [ids, groupIds, targetIds],
  );
  const strategy = useMemo<SortingStrategy>(() => {
    const rowCount = ids.length;
    const blockEnd = rowCount + groupIds.length;
    if (sortableItems.length === rowCount) return rowStrategy;
    const kindAt = (i: number) =>
      i < rowCount ? "row" : i < blockEnd ? "group" : "target";
    return (args) => {
      const kind = kindAt(args.activeIndex);
      if (kindAt(args.overIndex) !== kind) return null;
      if (kindAt(args.index) !== kind) return null;
      if (kind === "row")
        return rowStrategy({ ...args, rects: args.rects.slice(0, rowCount) });
      if (kind === "target") return null;
      return verticalListSortingStrategy({
        ...args,
        rects: args.rects.slice(rowCount, blockEnd),
        activeIndex: args.activeIndex - rowCount,
        overIndex: args.overIndex - rowCount,
        index: args.index - rowCount,
      });
    };
  }, [ids.length, groupIds.length, sortableItems.length, rowStrategy]);

  const endDrag = useCallback(() => {
    setActiveId(null);
    setActiveKind(null);
    setPreview(null);
  }, []);

  const onDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id));
    setActiveKind(
      nodeKind(event.active.data.current) === "group-sort" ? "group" : "row",
    );
    setPreview(null);
  }, []);

  const onDragOver = useCallback(
    (event: DragOverEvent) => {
      if (!livePreview) return;
      const { active, over } = event;
      if (nodeKind(active.data.current) !== "row") return;
      const id = String(active.id);
      const origin = ordered.find((i) => i.id === id)?.group ?? null;
      setPreview((current) => {
        const step = nextPreview(id, origin, current, previewOver(over), {
          layout,
          dragged: active.rect.current.translated,
          over: over?.rect ?? null,
        });
        return step.kind === "keep" ? current : step.preview;
      });
    },
    [livePreview, ordered, layout],
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const dropPreview = shownPreview;
      endDrag();
      const { active, over } = event;
      const id = String(active.id);
      const activeData = active.data.current;
      if (nodeKind(activeData) === "group-sort") {
        if (!over || !groups) return;
        const key = String(activeData?.key);
        const overKey = over.data.current?.key;
        if (typeof overKey !== "string") return;
        const dest = resolveGroupDrop(groups.keys, key, overKey);
        if (dest) void groups.onMove(key, dest);
        return;
      }
      const overKind = over ? nodeKind(over.data.current) : null;
      if (overKind === "new-group") {
        if (!onReseatNew) {
          throw new Error(
            `rank-reorder: drop on the new-group target with no onReseatNew (${id}).`,
          );
        }
        void onReseatNew(id);
        return;
      }
      if (overKind === "group-drop") {
        const group = String(over!.data.current?.group);
        const origin = ordered.find((i) => i.id === id)?.group ?? null;
        if (group === origin) return;
        void requireReseat(onReseat, id, group)(id, { group });
        return;
      }
      if (dropPreview !== null) {
        const dest = previewDropDest(
          previewed,
          id,
          over ? String(over.id) : null,
        );
        void requireReseat(onReseat, id, dest.group)(id, dest);
        return;
      }
      if (!over) return;
      const drop = resolveSortableDrop(ordered, id, String(over.id), {
        layout,
        dragged: active.rect.current.translated,
        over: over.rect,
      });
      if (drop.kind === "none") return;
      if (drop.kind === "reseat") {
        const { group, targetId, zone } = drop;
        void requireReseat(onReseat, id, group)(id, { group, targetId, zone });
        return;
      }
      const { rank, group, targetId, zone } = drop;
      void onMove(id, { rank, group, targetId, zone });
    },
    [
      shownPreview,
      endDrag,
      groups,
      onReseatNew,
      ordered,
      onReseat,
      previewed,
      layout,
      onMove,
    ],
  );

  const body =
    typeof children === "function"
      ? children(activeId, shownPreview)
      : children;
  return (
    <RankDragContext.Provider value={dragState}>
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        measuring={measuring}
        autoScroll={autoScroll.options}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={endDrag}
      >
        <SortableContext items={sortableItems} strategy={strategy}>
          {body}
        </SortableContext>
      </DndContext>
    </RankDragContext.Provider>
  );
}

/** What `over` is, for the preview. */
function previewOver(over: DragOverEvent["over"]): PreviewOver {
  if (!over) return null;
  const data = over.data.current;
  switch (nodeKind(data)) {
    case "row":
      return {
        kind: "row",
        id: String(over.id),
        group: sortableDataGroup(data),
      };
    case "group-drop":
      return {
        kind: "group",
        group: String(data?.group),
        preview: data?.preview === true,
      };
    case "new-group":
    case "group-sort":
      return { kind: "other" };
  }
}

/** `onReseat`, which a cross-group drop needs. Loud when absent: without it
 *  collision only sees the dragged item's group, so reaching here means a
 *  consumer passed grouped `items` but withheld the group from
 *  `useRankSortableItem`. */
function requireReseat(
  onReseat: RankReorderProviderProps["onReseat"],
  id: string,
  group: string | null,
): NonNullable<RankReorderProviderProps["onReseat"]> {
  if (!onReseat) {
    throw new Error(
      `rank-reorder: cross-group drop with no onReseat (${id} → group ${String(group)}). Pass each row's group to useRankSortableItem.`,
    );
  }
  return onReseat;
}

/** The smallest rect holding both. */
function unite(a: ClientRect, b: ClientRect): ClientRect {
  const top = Math.min(a.top, b.top);
  const left = Math.min(a.left, b.left);
  const bottom = Math.max(a.bottom, b.bottom);
  const right = Math.max(a.right, b.right);
  return {
    top,
    left,
    bottom,
    right,
    width: right - left,
    height: bottom - top,
  };
}

/** 4px before a press becomes a drag, so a click on a row still activates it. */
const POINTER_SENSOR_OPTIONS: PointerSensorOptions = {
  activationConstraint: { distance: 4 },
};

/**
 * The targets laid over the rows (the new-group card, group headers, empty
 * bands) under the pointer, hit-tested against where they are NOW. They are
 * sticky — pinned to the scroller's edge while the rows scroll under them — but
 * dnd-kit's measured rects follow every scroll of their ancestors (its `Rect`
 * adds the scroll delta since it measured), so after any scroll a measured
 * sticky target sits where it is not, and the pointer on it misses. A handful
 * of nodes, read live on each move.
 */
function pointerOnLive(
  args: Parameters<CollisionDetection>[0],
  containers: Parameters<CollisionDetection>[0]["droppableContainers"],
): ReturnType<CollisionDetection> {
  const p = args.pointerCoordinates;
  if (!p) return [];
  const hits: ReturnType<CollisionDetection> = [];
  for (const c of containers) {
    const node = c.node.current;
    if (!node) continue;
    const r = node.getBoundingClientRect();
    if (p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom)
      hits.push({ id: c.id, data: { droppableContainer: c, value: 0 } });
  }
  return hits;
}
