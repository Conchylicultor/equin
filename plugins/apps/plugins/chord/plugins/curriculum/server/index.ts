import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  setBlanksEndpoint,
  setChordsEndpoint,
  setExtrasEndpoint,
} from "../core";
import {
  handleSetBlanks,
  handleSetChords,
  handleSetExtras,
} from "./internal/handlers";
import { chordCatalogServed, chordCurriculumServed } from "./internal/resource";
import { chordCurriculumLoopsServed } from "./internal/loops-resource";

// For a server plugin in the same backend: whether the catalog lists a chord,
// which decides whether the Rare joker answers it (progress judges a round's
// answers with it). `loadListedChords` is the whole set, for a reader that
// needs the complement (progress pools every unlisted chord as Rare).
export { isListedChord, loadListedChords } from "./internal/catalog";
export type { ListedChordsState } from "./internal/catalog";

export default {
  description:
    "The Chord trainer's curriculum, server side: the chord_curriculum row (each chord practised, heard or off; how much of a loop is blank; how many other chords a loop may hold), the live chord.curriculum resource and its three writes — chords, blanks, extras —, the live chord.catalog: every chord of the song index in tracks and sections, built once per loaded index, and the live chord.curriculum.loops: the trainer's loop find over the stored selection.",
  httpRoutes: {
    [setChordsEndpoint.route]: handleSetChords,
    [setBlanksEndpoint.route]: handleSetBlanks,
    [setExtrasEndpoint.route]: handleSetExtras,
  },
  contributions: [
    // `chord_curriculum` is kept in forks, backups and the change feed on
    // purpose (no ExcludeFromFork / ExcludeFromBackup / ExcludeFromChangeFeed):
    // it is the learner's own choice, which nothing can rebuild, and the feed
    // is what pushes `chord.curriculum`. No growth bound: it is one row.
    ...chordCurriculumServed.declare,
    ...chordCatalogServed.declare,
    ...chordCurriculumLoopsServed.declare,
  ],
} satisfies ServerPluginDefinition;
