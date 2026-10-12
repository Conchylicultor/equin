import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import type { Score } from "@plugins/apps/plugins/sonata/plugins/score/core";
import { RAIL_BAND_Y } from "@plugins/apps/plugins/sonata/plugins/progress/plugins/scrubber/web";
import {
  pct,
  Placed,
} from "@plugins/primitives/plugins/css/plugins/coords/web";
import { barNotches } from "../notches";

/**
 * Bar notches marker. The progression bar is just a beat→fraction axis; the
 * boundaries come from the score's pure `bars()` helper (via `barNotches`),
 * which already folds in `timeSigMap` and the pickup, so bar math lives in
 * exactly one place and can never desync from the roll or the chord analyzer.
 *
 * Each bar line is a 1px cut in the background colour across the rail band —
 * the marker layer paints above the fill, so the notches cut the played part
 * and the unplayed part alike, and the rail reads as a ruler with no numbering.
 * Every 4th bar (a phrase) cuts deeper. `RAIL_BAND_Y` follows the rail's hover
 * thickening, so the notches always span exactly the rail. The whole layer is
 * decorative — the scrubber owns the seek track underneath and clicks fall
 * straight through.
 */
export function BarTicks({
  score,
  beatToFraction,
}: {
  score: Score;
  beatToFraction: (beat: number) => number;
}) {
  const notches = barNotches(score);
  if (notches.length === 0) return null;

  return (
    <Layer decorative>
      {notches.map(({ index, beat, strong }) => (
        <Placed
          key={index}
          x={{ center: pct(beatToFraction(beat)), size: 1 }}
          y={RAIL_BAND_Y}
          className={strong ? "bg-background/85" : "bg-background/45"}
        />
      ))}
    </Layer>
  );
}
