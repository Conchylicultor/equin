import { db } from "@plugins/database/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import { loadListedChords } from "@plugins/apps/plugins/chord/plugins/curriculum/server";
import {
  _chordIndexRequest,
  _chordIndexState,
  _chordLoopWindows,
} from "@plugins/apps/plugins/chord/plugins/song-index/server";
import { chordProgress } from "../../core";
import { loadChordProgress } from "./progress";
import { _chordAnswers, _chordRounds } from "./tables";

// The learner's standing, pushed again when an answer is saved: the change feed
// carries each committed `chord_answers` / `chord_rounds` write here (its
// declared reads), and every subscribed (time zone, chord set)
// tuple is recomputed and pushed.
//
// The Rare pool is every chord the catalog does not list, so the loader needs
// the catalog. While the index is not loaded there is no catalog to say which
// chords are rare, and the read FAILS loudly rather than answering a pool it
// cannot know: the trainer subscribes only once `chord.catalog` is ready (it
// renders its loading state before), so a subscriber only meets this if the
// index unloads under it — and then the trainer has gone back to loading.
export const chordProgressServed = serveValue(chordProgress, {
  source: "db",
  reads: {
    tables: [_chordAnswers, _chordRounds, _chordIndexState, _chordIndexRequest],
    reason:
      "an answer or round changes the standing of any chord set; the index rows decide the catalog's Rare pool; whole-table until it reads through a collection",
    outsideFeed: {
      tables: [_chordLoopWindows],
      reason:
        "bulk-loaded index windows the catalog is built from, read only when the index identity changed",
    },
  },
  loader: async (params) => {
    const listed = await loadListedChords();
    if (listed.kind === "not-ready") {
      throw new Error(
        "chord.progress: the song index is not loaded, so no catalog says which chords are rare; subscribe once chord.catalog is ready",
      );
    }
    return loadChordProgress(db, params, listed.listed);
  },
});
