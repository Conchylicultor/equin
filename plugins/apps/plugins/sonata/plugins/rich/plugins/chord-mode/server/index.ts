import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { setChordModeEndpoint } from "../shared/endpoints";
import { handleSetChordMode } from "./internal/routes";
import { chordModesServed } from "./internal/resource";

export { songChordMode } from "./internal/tables";

export default {
  description:
    "Owns the sonata_songs_ext_chord_mode side-table: per-song toggle to play a song's chords (voiced onto the Chords / Bass tracks) instead of its notes. Serves it as a per-song lookup collection.",
  httpRoutes: {
    [setChordModeEndpoint.route]: handleSetChordMode,
  },
  contributions: [...chordModesServed.declare],
} satisfies ServerPluginDefinition;
