import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { LiveColumns } from "@plugins/network/plugins/live/server";
import {
  createUltimateGuitarSong,
  updateUltimateGuitarSong,
} from "../shared/endpoints";
import {
  handleCreateUltimateGuitarSong,
  handleUpdateUltimateGuitarSong,
} from "./internal/routes";
import { songUltimateGuitar } from "./internal/tables";
import { ugTabSaved } from "./internal/tables-tab-saved";
import { ugSearchServed } from "./internal/search-served";
import { ugTabServed } from "./internal/tab-served";
import { songUgRowsServed } from "./internal/song-rows-served";

export { fetchUgTabContent } from "./internal/ug-client";
export { songUltimateGuitar } from "./internal/tables";
export { ugTabSaved } from "./internal/tables-tab-saved";
export type { UgTabSavedPayload } from "./internal/tables-tab-saved";

export default {
  description:
    "Ultimate Guitar source server: serves a tab URL's raw tab from UG's private mobile API as the live sonata.ultimate-guitar.tab value (a bad URL or a missing tab refused, any other breakage loud) and its catalog search as sonata.ultimate-guitar.search, and owns the sonata_songs_ext_ultimate_guitar side-table — serving each song's row as the lookup-only live collection sonata.ultimate-guitar.songs (what the player hydrates from), creating UG-backed songs from a fetched tab and persisting edits (syncing the parent song's title/duration), exposing the tab's key to every list of songs (LiveColumns.Expose), announcing sonata.ug.tabSaved when a song's sheet content changes.",
  register: [ugTabSaved],
  contributions: [
    LiveColumns.Expose(songUltimateGuitar),
    ...ugSearchServed.declare,
    ...ugTabServed.declare,
    ...songUgRowsServed.declare,
  ],
  httpRoutes: {
    [createUltimateGuitarSong.route]: handleCreateUltimateGuitarSong,
    [updateUltimateGuitarSong.route]: handleUpdateUltimateGuitarSong,
  },
} satisfies ServerPluginDefinition;
