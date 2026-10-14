import type { Projection } from "@plugins/apps/plugins/sonata/plugins/score/core";

/**
 * Where the A–B loop is drawn on a display's time axis: the axis offset of
 * every occurrence of the loop body worth drawing. `0` is the loop itself (the
 * song's own `[A, B]`); when the display unrolls the loop ahead
 * (`projection.timeline.loop`), each drawn copy follows at its own offset, so
 * the band and its A / B boundaries repeat with the notes.
 *
 * Only the copies a viewport can reach are listed. On a repeat the cursor sits
 * in the FIRST copy, and on the song's own pass it is before it, so the
 * furthest axis point ever on screen is one lane height above the first copy's
 * end — a fixed set, not a per-frame one, so the band never re-renders while
 * playing.
 */
export function loopOccurrences(projection: Projection): readonly number[] {
  const unrolled = projection.timeline?.loop;
  const { beatToY } = projection;
  if (!unrolled || !beatToY) return [0];
  const { cycle, shifts } = unrolled;
  const first = shifts[0];
  if (first === undefined) return [0];
  const farthestY = beatToY(cycle.end + first) - projection.viewport.height;
  const reach = shifts.filter(
    (shift) => beatToY(cycle.start - cycle.rest + shift) >= farthestY,
  );
  return [0, ...reach];
}
