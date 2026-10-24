import { useCallback, useState } from "react";
import { nextLinkedHover, type LinkedHoverChange } from "../../core";

/**
 * One linked hover shared by every surface that reports it (`MapView`'s
 * `onHoverChange`, a DataView's `onRowHoverChange`, a card's enter / leave):
 * the hovered id, and the stable report every surface calls — a leave
 * releases only its own id (`nextLinkedHover`).
 */
export function useLinkedHover(): {
  hoveredId: string | null;
  onHoverChange: LinkedHoverChange;
} {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const onHoverChange = useCallback<LinkedHoverChange>(
    (id, hovered) => setHoveredId((cur) => nextLinkedHover(cur, id, hovered)),
    [],
  );
  return { hoveredId, onHoverChange };
}
