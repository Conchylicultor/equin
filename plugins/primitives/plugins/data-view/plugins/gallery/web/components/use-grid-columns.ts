import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { useCallback, useState } from "react";

/**
 * Measure the live column count of a responsive `auto-fill` card grid — the
 * lane count lane-aware virtualization (and the paged phase pad) chunks cards
 * by.
 *
 * The probe is a zero-height `Grid` with the real grid's track and gap
 * classes, so the browser resolves the same tracks — whatever the card
 * minimum's token resolves to (`--gallery-card-min`, a theme's override, the
 * compact rung) and whatever the column gap is. Counting the resolved
 * `grid-template-columns` tracks reads the browser's answer instead of
 * re-deriving it from token values (the icons view's probe does the same).
 *
 * Returns a callback ref to spread onto the probe element plus the live column
 * count (`0` until first measured — callers gate their windowed render on it).
 * A `ResizeObserver` re-measures on every width change.
 */
export function useGridColumns(): {
  probeRef: (el: HTMLElement | null) => void;
  columns: number;
} {
  const [columns, setColumns] = useState(0);
  const [el, setEl] = useState<HTMLElement | null>(null);
  const probeRef = useCallback((node: HTMLElement | null) => setEl(node), []);

  useResizeObserver(
    () => el,
    () => {
      if (!el) return;
      const tracks = getComputedStyle(el)
        .gridTemplateColumns.split(" ")
        .filter((t) => t.length > 0).length;
      setColumns(Math.max(1, tracks));
    },
    { deps: [el] },
  );

  return { probeRef, columns };
}
