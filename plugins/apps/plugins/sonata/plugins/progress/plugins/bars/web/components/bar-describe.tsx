import { barPositionAt } from "@plugins/apps/plugins/sonata/plugins/score/core";
import type { Score } from "@plugins/apps/plugins/sonata/plugins/score/core";

/**
 * The hover preview's bar readout (`Bar 52`), after the time. Numbered like the
 * transport (`barPositionAt`: a pickup is bar 0, the first full bar bar 1), so
 * the preview and the bar.beat counter never disagree. An empty score has no
 * bars to name.
 */
export function describeBar(score: Score, beat: number) {
  if (score.notes.length === 0 && score.annotations.length === 0) return null;
  return (
    <span className="text-muted-foreground">
      Bar {barPositionAt(score, beat).bar}
    </span>
  );
}
