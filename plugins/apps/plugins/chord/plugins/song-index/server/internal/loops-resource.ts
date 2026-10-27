import { serveValue } from "@plugins/network/plugins/live/server";
import {
  checkFindLoops,
  chordLoops,
  type ChordLoopsAnswer,
  type FindLoops,
} from "../../core";
import { findLoopWindows } from "./find";
import { loadIndexStatus } from "./state";

/**
 * The loop find. External and fixed per tuple: the answer is a random sample
 * of the windows, read once per round — nothing changes it afterwards, and the
 * trainer's next refill asks a new round. The windows are a bulk-loaded cache
 * out of the change feed; the video-status fill `findLoopWindows` runs
 * (`ensureVideoStatus`) is an idempotent cache of oEmbed answers, not a change
 * to the sample.
 *
 * `not-ready` with the status unless the index is `ready`: an empty list
 * before the load would read as "no song fits these chords". That answer is
 * fixed too — the trainer's retry asks a new round.
 */
export const chordLoopsServed = serveValue(chordLoops, {
  source: "external",
  changes: {
    fixed: {
      reason: "a random sample of loop windows; a new round is a new question",
    },
  },
  loader: async ({ round: _round, ...find }) => {
    checkFindLoops(find);
    return answerLoopFind(find);
  },
});

/**
 * One find's answer, for a consistent find (its caller has refused one whose
 * fields disagree — `checkFindLoops`, or the asker's own rule): `not-ready`
 * with the status unless the index is `ready`, then the random windows. What
 * `chord.loops` serves, and what another server plugin's loop value (the
 * curriculum's, over the learner's stored selection) answers with in process.
 */
export async function answerLoopFind(
  find: FindLoops,
): Promise<ChordLoopsAnswer> {
  const status = await loadIndexStatus();
  if (status.kind !== "ready") return { kind: "not-ready", status };
  return { kind: "ready", candidates: await findLoopWindows(find) };
}
