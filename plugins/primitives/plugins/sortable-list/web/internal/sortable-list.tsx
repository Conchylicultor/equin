import { useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  horizontalListSortingStrategy,
  type SortingStrategy,
} from "@dnd-kit/sortable";
import { useChromePointerSensor } from "./chrome-pointer-sensor";

export interface SortableListProps {
  items: string[];
  onMove: (activeId: string, overId: string, event: DragEndEvent) => void;
  overlay?: (activeId: string) => ReactNode;
  disabled?: boolean;
  collisionDetection?: CollisionDetection;
  orientation?: "horizontal" | "vertical";
  /**
   * Explicit dnd-kit sorting strategy. When omitted, falls back to the
   * `orientation` mapping (horizontal/vertical list strategy). An explicit
   * strategy (e.g. `rectSortingStrategy` for 2-D wrap layouts) wins.
   */
  strategy?: SortingStrategy;
  /**
   * Opt-in "tear-off" gesture (default undefined → zero behavior change). When
   * provided, a drag that releases *beyond the list's cross-axis extent* (past a
   * margin below a horizontal strip, or beside a vertical one) fires `onDragOut`
   * with the released item id and the drop point, INSTEAD of `onMove`. Used by
   * the app tab bar to tear a chip into a floating window, Chrome-style.
   */
  onDragOut?: (id: string, point: { x: number; y: number }) => void;
  /**
   * Opt-in keyboard reordering: a focused activator (the handle, or the item
   * itself) picks up with Space/Enter, moves with the arrow keys, drops with
   * Space/Enter. Off by default because without a `handle` the item wrapper is
   * the activator, and it would swallow Space/Enter bubbling up from buttons
   * inside the item.
   */
  keyboard?: boolean;
  /** Fires with the dragged id when a drag starts, and `null` when it ends or is cancelled. */
  onActiveChange?: (activeId: string | null) => void;
  children: ReactNode;
}

/** 4px before a press becomes a drag, so a click on an item still clicks. */
const POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: 4 } };

/** Cross-axis margin (px) a release must clear past the strip to count as a tear-off. */
const TEAR_OFF_MARGIN = 24;

export function SortableList({
  items,
  onMove,
  overlay,
  disabled,
  collisionDetection,
  orientation,
  strategy,
  onDragOut,
  keyboard,
  onActiveChange,
  children,
}: SortableListProps) {
  const resolvedStrategy =
    strategy ??
    (orientation === "horizontal"
      ? horizontalListSortingStrategy
      : verticalListSortingStrategy);
  const pointerSensor = useChromePointerSensor(POINTER_SENSOR_OPTIONS);
  const keyboardSensor = useSensor(KeyboardSensor, {
    coordinateGetter: sortableKeyboardCoordinates,
  });
  const sensors = useSensors(pointerSensor, keyboard ? keyboardSensor : null);
  const [activeId, setActiveIdState] = useState<string | null>(null);
  const setActiveId = (id: string | null) => {
    setActiveIdState(id);
    onActiveChange?.(id);
  };
  const [optimisticItems, setOptimisticItems] = useState<string[] | null>(null);

  // Clear optimistic state when canonical items update (server roundtrip
  // complete). The previous-items watermark is held in state, not a ref, so the
  // compare + reset happens cleanly during render (React's "adjusting state
  // when a prop changes" pattern) without reading/writing a ref mid-render.
  const [prevItems, setPrevItems] = useState(items);
  if (prevItems !== items) {
    setPrevItems(items);
    if (optimisticItems) setOptimisticItems(null);
  }

  const effectiveItems = optimisticItems ?? items;

  return (
    <DndContext
      sensors={disabled ? [] : sensors}
      collisionDetection={collisionDetection ?? closestCenter}
      onDragStart={(e) => setActiveId(String(e.active.id))}
      onDragEnd={(e: DragEndEvent) => {
        setActiveId(null);
        // Tear-off check (opt-in): if the dragged box was released beyond the
        // strip's cross-axis extent by a margin, fire onDragOut and skip the
        // reorder entirely. `initial` is the strip-aligned start box; `translated`
        // is the live dragged box at release.
        if (onDragOut) {
          const initial = e.active.rect.current.initial;
          const dragged = e.active.rect.current.translated;
          if (initial && dragged) {
            const horizontal = orientation === "horizontal";
            const draggedCenter = horizontal
              ? dragged.top + dragged.height / 2
              : dragged.left + dragged.width / 2;
            const lo = horizontal ? initial.top : initial.left;
            const hi = horizontal
              ? initial.top + initial.height
              : initial.left + initial.width;
            if (
              draggedCenter > hi + TEAR_OFF_MARGIN ||
              draggedCenter < lo - TEAR_OFF_MARGIN
            ) {
              onDragOut(String(e.active.id), {
                x: dragged.left + dragged.width / 2,
                y: dragged.top + dragged.height / 2,
              });
              return;
            }
          }
        }
        if (e.over && String(e.active.id) !== String(e.over.id)) {
          const oldIdx = effectiveItems.indexOf(String(e.active.id));
          const overIdx = effectiveItems.indexOf(String(e.over.id));
          if (oldIdx >= 0 && overIdx >= 0) {
            setOptimisticItems(arrayMove(effectiveItems, oldIdx, overIdx));
          }
          onMove(String(e.active.id), String(e.over.id), e);
        }
      }}
      onDragCancel={() => setActiveId(null)}
    >
      <SortableContext items={effectiveItems} strategy={resolvedStrategy}>
        {children}
      </SortableContext>
      {overlay && <DragOverlayWrapper activeId={activeId} overlay={overlay} />}
    </DndContext>
  );
}

function DragOverlayWrapper({
  activeId,
  overlay,
}: {
  activeId: string | null;
  overlay: (activeId: string) => ReactNode;
}) {
  return (
    <DragOverlay dropAnimation={null}>
      {activeId ? overlay(activeId) : null}
    </DragOverlay>
  );
}
