import { useMemo } from "react";
import type { Projection } from "@plugins/apps/plugins/sonata/plugins/score/core";
import {
  useCursorSelector,
  useSession,
} from "@plugins/apps/plugins/sonata/plugins/session/web";
import { useLaneInsets } from "@plugins/apps/plugins/sonata/plugins/shell/web";
import { loopOccurrences } from "./loop-occurrences";

/** Which loop boundary an edge indicator stands for: A = start, B = end. */
export type LoopEdgeLetter = "A" | "B";

/**
 * The off-screen loop boundaries, bucketed by which lane edge they've scrolled
 * past. A boundary on-screen appears in NEITHER list (its content-space label
 * shows instead). Each list is ORDERED so the chip nearest the visible area
 * reads first: `top` is sorted by descending screen-Y (closest to the top edge
 * last-to-leave first), `bottom` by ascending screen-Y (closest to the now-line
 * first).
 */
export interface LoopEdgeBuckets {
  top: LoopEdgeLetter[];
  bottom: LoopEdgeLetter[];
}

/** Value-equality over the ordered bucket arrays, so the cursor selector bails
 *  out every frame the bucketing is unchanged (it builds a fresh object). */
function isEqualBuckets(a: LoopEdgeBuckets, b: LoopEdgeBuckets): boolean {
  return (
    a.top.join("") === b.top.join("") && a.bottom.join("") === b.bottom.join("")
  );
}

/**
 * Classifies each A–B loop boundary against the lane's on-screen window, given
 * the live cursor: a boundary is "top" if it has scrolled above the lookahead
 * (including under the HUD-reserved `topInset`), "bottom" if it's past the
 * now-line, else on-screen (skipped). View-only — derives purely from the
 * published projection + transport loop state.
 *
 * Re-render discipline: the cursor advances ~60fps, so this selects the COARSE
 * bucket result via {@link useCursorSelector} (value-compared with
 * {@link isEqualBuckets}) — it re-renders the caller only when a boundary
 * crosses an edge, never per frame. The edge chips themselves sit at a FIXED
 * lane edge, so no per-frame position update is needed.
 *
 * On-screen Y of an axis beat: `beatToY(beat) - beatToY(cursorAxis) + H` (see
 * the piano-roll geometry; `beatToY` is content-space and negative for future
 * beats, so subtracting the cursor's content-Y and adding the lane height `H`
 * maps the now-line to the lane bottom). The cursor's axis beat comes from the
 * projection's timeline, and when the display unrolls the loop ahead each
 * boundary occurs once per drawn copy ({@link loopOccurrences}): a boundary is
 * on-screen when ANY occurrence is, else it is bucketed by its occurrence
 * nearest the visible window.
 */
export function useLoopEdgeBuckets(projection: Projection): LoopEdgeBuckets {
  const { loop } = useSession();
  const { top: topInset } = useLaneInsets();
  const { beatToY, timeline } = projection;
  const H = projection.viewport.height;
  const shifts = useMemo(() => loopOccurrences(projection), [projection]);

  return useCursorSelector<LoopEdgeBuckets>(
    (_beat, position) => {
      if (!loop || !beatToY || !timeline) return { top: [], bottom: [] };
      const cursorY = beatToY(timeline.axisBeat(position));
      const boundaries = [
        { letter: "A" as const, beat: loop.start },
        { letter: "B" as const, beat: loop.end },
      ];
      const top: { letter: LoopEdgeLetter; s: number }[] = [];
      const bottom: { letter: LoopEdgeLetter; s: number }[] = [];
      for (const { letter, beat } of boundaries) {
        // Screen Y of every occurrence; on-screen if any is.
        const ys = shifts.map((shift) => beatToY(beat + shift) - cursorY + H);
        if (ys.some((y) => y >= topInset && y <= H)) continue;
        const above = ys.filter((y) => y < topInset);
        const below = ys.filter((y) => y > H);
        // The occurrence nearest the window decides the edge.
        const nearAbove = above.length > 0 ? Math.max(...above) : null;
        const nearBelow = below.length > 0 ? Math.min(...below) : null;
        if (
          nearAbove !== null &&
          (nearBelow === null || topInset - nearAbove <= nearBelow - H)
        ) {
          top.push({ letter, s: nearAbove });
        } else if (nearBelow !== null) {
          bottom.push({ letter, s: nearBelow });
        }
      }
      // Order each cluster so the chip nearest the visible area reads first.
      top.sort((a, b) => b.s - a.s);
      bottom.sort((a, b) => a.s - b.s);
      return {
        top: top.map((x) => x.letter),
        bottom: bottom.map((x) => x.letter),
      };
    },
    [loop, beatToY, timeline, shifts, topInset, H],
    isEqualBuckets,
  );
}
