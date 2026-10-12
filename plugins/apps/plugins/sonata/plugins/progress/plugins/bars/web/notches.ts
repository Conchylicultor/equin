import {
  bars,
  scoreEndBeat,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import type { Score } from "@plugins/apps/plugins/sonata/plugins/score/core";

/** One bar line cut into the rail. */
export type Notch = {
  /** `bars()` index of the bar this line opens. */
  index: number;
  beat: number;
  /** Every 4th bar (a phrase boundary) is drawn stronger. */
  strong: boolean;
};

/**
 * The bar lines to cut into the rail: every boundary from `bars()` except the
 * first (the rail's own left edge) and any at or past the song's end (its right
 * edge) — a notch there would only fray the rail's ends. An empty score (no
 * notes, no annotations) has no ruler at all: `bars()` still returns the
 * implicit bar 0, so we gate on content rather than on the list's length.
 */
export function barNotches(score: Score): Notch[] {
  if (score.notes.length === 0 && score.annotations.length === 0) return [];
  const end = scoreEndBeat(score);
  return bars(score)
    .filter(({ index, startBeat }) => index > 0 && startBeat < end)
    .map(({ index, startBeat }) => ({
      index,
      beat: startBeat,
      strong: index % 4 === 0,
    }));
}
