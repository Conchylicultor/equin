import { db } from "@plugins/database/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import { answerLoopFind } from "@plugins/apps/plugins/chord/plugins/song-index/server";
import {
  chordCurriculumLoops,
  playableChords,
  practisedChords,
} from "../../core";
import { loadSelection } from "./state";

/**
 * The trainer's loop find, over the learner's stored selection: the chords a
 * loop may hold, the practised ones and the extras are read here, never sent
 * by the browser — a selection has no bound, and a question carrying it would
 * outgrow a live query. External and fixed per tuple, as song-index's
 * `chord.loops` (a random sample, read once per round).
 */
export const chordCurriculumLoopsServed = serveValue(chordCurriculumLoops, {
  source: "external",
  changes: {
    fixed: {
      reason:
        "a random sample of loop windows over the selection read when asked; a new round is a new question",
    },
  },
  loader: async ({ round: _round, ...options }) => {
    const selection = await loadSelection(db);
    const practised = practisedChords(selection);
    if (practised.length === 0) {
      throw chordCurriculumLoops.refuse(
        "invalid-query",
        "no chord is practised: a loop find needs at least one",
      );
    }
    if (options.focus !== undefined && !practised.includes(options.focus)) {
      throw chordCurriculumLoops.refuse(
        "invalid-query",
        `the focus ${options.focus} is not a practised chord`,
      );
    }
    return answerLoopFind({
      ...options,
      playable: playableChords(selection),
      practised,
      extras: selection.extras,
    });
  },
});
