import { useRef, useState } from "react";
import type { MapPadding } from "@plugins/map/core";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";

/**
 * How much of the screen the floating chrome covers, measured rather than
 * restated: the caller renders an invisible probe box inset exactly as the
 * chrome is (the same CSS lengths the cards are placed with, so density and
 * rem changes follow), and its offsets inside the container ARE the covered
 * edges the map keeps pins out of. Re-measured whenever either box resizes —
 * the probe's insets changing (a card opening) resizes it.
 */
export function useCoveredEdges(): {
  containerRef: React.RefObject<HTMLDivElement | null>;
  probeRef: React.RefObject<HTMLDivElement | null>;
  padding: MapPadding;
} {
  const containerRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  const [padding, setPadding] = useState<MapPadding>({
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  });
  useResizeObserver([containerRef, probeRef], () => {
    const container = containerRef.current?.getBoundingClientRect();
    const probe = probeRef.current?.getBoundingClientRect();
    if (container === undefined || probe === undefined) return;
    const next = {
      top: Math.round(probe.top - container.top),
      right: Math.round(container.right - probe.right),
      bottom: Math.round(container.bottom - probe.bottom),
      left: Math.round(probe.left - container.left),
    };
    setPadding((prev) =>
      prev.top === next.top &&
      prev.right === next.right &&
      prev.bottom === next.bottom &&
      prev.left === next.left
        ? prev
        : next,
    );
  });
  return { containerRef, probeRef, padding };
}
