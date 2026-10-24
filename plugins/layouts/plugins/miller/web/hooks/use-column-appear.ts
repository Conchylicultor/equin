import { useLayoutEffect, useRef, type RefObject } from "react";
import { prefersReducedMotion } from "@plugins/primitives/plugins/collapsible/web";
import type { MatchEntry } from "@plugins/primitives/plugins/pane/web";

/** The wrapper attribute a column is found by — its pane slot's `uuid`. */
export const COLUMN_ATTR = "data-miller-column";

const DURATION = 280;
// An ease-out gentle enough that the duration reads: an expo-style curve
// finishes 80% of the motion in the first fifth and every speed looks alike.
const EASING = "cubic-bezier(.33, 1, .68, 1)";

/**
 * Animates a column that appears on the right of an already-painted row
 * (prototype `proto-1792836852-pvwo12`, "slide"):
 *
 * - **enter** — a new kind of pane: its content slides in from 36px right while
 *   fading in. The row's widths commit at once (no width transition), so only
 *   the newcomer moves and no column re-wraps frame by frame.
 * - **swap** — the same pane showing another entity in the same position
 *   (another attempt, another task), or a new root column: nothing arrived
 *   from the side, so the content only fades in with a 4px rise.
 *
 * Keyed by the slot's `uuid`, which a back/forward or reload restores, so a
 * rebuilt route does not replay. The first paint never animates, and
 * `prefers-reduced-motion` gets the fade without the movement. The content
 * (the pane box's children) moves inside the box's own clip, so the slide
 * never widens the row's scroll area.
 */
export function useColumnAppear(
  rowRef: RefObject<HTMLElement | null>,
  panes: readonly MatchEntry[] | undefined,
): void {
  const previous = useRef<readonly MatchEntry[] | null>(null);

  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = panes ?? [];
    const row = rowRef.current;
    if (!before || !panes || !row) return;
    const seen = new Set(before.map((e) => e.uuid));
    const reduced = prefersReducedMotion();
    panes.forEach((entry, i) => {
      if (seen.has(entry.uuid)) return;
      const box = row
        .querySelector(`[${COLUMN_ATTR}="${entry.uuid}"]`)
        ?.querySelector("[data-pane-id]");
      if (!box) return; // a collapsed column has no box to move
      // The root column has nothing to its left to arrive beside, so a new
      // root (a sidebar switch) settles in place like a swap.
      const swap = i === 0 || before[i]?.pane.id === entry.pane.id;
      const from = reduced
        ? "none"
        : swap
          ? "translateY(4px)"
          : "translateX(36px)";
      for (const child of box.children) {
        child.animate(
          [
            { opacity: 0, transform: from },
            { opacity: 1, transform: "none" },
          ],
          {
            duration: DURATION,
            delay: swap ? DURATION * 0.15 : 0,
            easing: EASING,
            fill: "backwards",
          },
        );
      }
    });
  }, [rowRef, panes]);
}
