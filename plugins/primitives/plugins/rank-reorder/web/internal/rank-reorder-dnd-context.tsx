import { useCallback, useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
  type PointerSensorOptions,
} from "@dnd-kit/core";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";

export interface RankReorderDndContextProps {
  /** Resolve + persist a drop. Receives the raw dnd-kit event; the active drag
   *  data carries `{ id, rank }`, the over droppable carries `{ zone, targetId }`
   *  (zone ∈ before|after, plus any tree-local zone like `child`). */
  onDragEnd: (event: DragEndEvent) => void;
  /** Floating drag-chip content for the active id (wrapped in the standard chip
   *  shell). Omit → no overlay. */
  dragOverlay?: (id: string) => ReactNode;
  /**
   * Re-measure droppables every frame so rows that mount mid-drag (windowed
   * lists, dnd-kit autoscroll bringing an off-screen target into view) become
   * valid drop targets. Pass the consumer's own windowed flag.
   */
  measuringAlways?: boolean;
  /** Children. A render-prop receives the active drag id (for windowed
   *  `keepMounted`); a plain node ignores it. */
  children: ReactNode | ((activeId: string | null) => ReactNode);
}

/**
 * The indicator-line DnD shell the tree mounts: owns the `DndContext`, the
 * `PointerSensor` (4px activation), `pointerWithin` collision, the active-id
 * lifecycle, the `MeasuringStrategy.Always` toggle for windowed lists, and the
 * `DragOverlay` chip. Rows stay put and a line marks the drop point; the drop
 * *resolution* is injected via `onDragEnd` (the tree's `computeDrop`-based
 * handler, which keeps its `child`-zone reparent logic). Flat surfaces use the
 * sortable `RankReorderProvider` instead.
 */
export function RankReorderDndContext({
  onDragEnd,
  dragOverlay,
  measuringAlways,
  children,
}: RankReorderDndContextProps) {
  // Module-level options: `useSensor` memoizes on the object, so an inline
  // literal would mint new sensors (and row listeners) on every render.
  const sensors = useSensors(useSensor(PointerSensor, POINTER_SENSOR_OPTIONS));
  const [activeId, setActiveId] = useState<string | null>(null);

  const overlayNode = activeId && dragOverlay ? dragOverlay(activeId) : null;

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveId(null);
      onDragEnd(event);
    },
    [onDragEnd],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      measuring={
        measuringAlways
          ? { droppable: { strategy: MeasuringStrategy.Always } }
          : undefined
      }
      onDragStart={(event) =>
        setActiveId(
          (event.active.data.current?.id as string | undefined) ?? null,
        )
      }
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      {typeof children === "function" ? children(activeId) : children}
      <DragOverlay dropAnimation={null}>
        {overlayNode != null ? (
          <Text
            as="div"
            variant="body"
            className="bg-background/90 border-accent rounded-md border px-sm py-xs shadow"
          >
            {overlayNode}
          </Text>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

/** 4px before a press becomes a drag, so a click on a row still selects it. */
const POINTER_SENSOR_OPTIONS: PointerSensorOptions = {
  activationConstraint: { distance: 4 },
};
