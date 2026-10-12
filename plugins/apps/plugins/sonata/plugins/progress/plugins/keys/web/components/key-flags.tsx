import { Layer } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { collectKeyEntries } from "@plugins/apps/plugins/sonata/plugins/score/core";
import type { Score } from "@plugins/apps/plugins/sonata/plugins/score/core";
import { railBand } from "@plugins/apps/plugins/sonata/plugins/progress/plugins/scrubber/web";
import {
  pct,
  Placed,
} from "@plugins/primitives/plugins/css/plugins/coords/web";
import { keyChanges } from "../key-names";
import { KEY_TONE } from "../key-tone";

/**
 * Key-change lines along the progression bar.
 *
 * A song's tonal centre is meaning layered on top of the notes: the *starting*
 * key (`score.meta.key`) plus any mid-song key changes, which the IR models as
 * `type:"key"` annotations. `collectKeyEntries` reconciles both into a sorted
 * list of "key established at beat X" entries. Only the CHANGES are drawn: the
 * starting key has no boundary to mark, and its name already sits in the
 * label lane.
 *
 * Each change is a thin key-coloured line standing a few px proud of the hot
 * rail (`railBand(3)`) — no glow, no chip; the name lives in the label lane and
 * the hover preview (which snaps onto the line and reads "Key change → …").
 * So the layer is purely decorative: no hit box, every press falls through to
 * the scrubber's seek track.
 */

/** Width of a key-change line, in px. */
const LINE_PX = 1.5;

export function KeyFlags({
  score,
  beatToFraction,
}: {
  score: Score;
  /** beat → [0,1] position along the track. */
  beatToFraction: (beat: number) => number;
}) {
  const changes = keyChanges(collectKeyEntries(score));

  // Common case: a single key (or none) → nothing to mark.
  if (changes.length === 0) return null;

  return (
    <Layer decorative>
      {changes.map((e) => (
        <Placed
          key={e.beat}
          x={{ center: pct(beatToFraction(e.beat)), size: LINE_PX }}
          y={railBand(3)}
          className={`rounded-full ${KEY_TONE.line}`}
        />
      ))}
    </Layer>
  );
}
