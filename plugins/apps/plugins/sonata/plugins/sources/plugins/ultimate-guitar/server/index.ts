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
import { songUgRowsServed } from "./internal/song-rows-served";

export { songUltimateGuitar } from "./internal/tables";
export { ugTabSaved } from "./internal/tables-tab-saved";
export type { UgTabSavedPayload } from "./internal/tables-tab-saved";

export default {
  description:
    "Ultimate Guitar source server, every host's half: owns the sonata_songs_ext_ultimate_guitar side-table — serving each song's row as the lookup-only live collection sonata.ultimate-guitar.songs (what the player hydrates from), creating UG-backed songs from a fetched tab and persisting edits (syncing the parent song's title/duration), exposing the tab's key to every list of songs (LiveColumns.Expose), announcing sonata.ug.tabSaved when a song's sheet content changes. Reading UG itself (a tab, the catalog search) is the machine/ half's.",
  register: [ugTabSaved],
  contributions: [
    LiveColumns.Expose(songUltimateGuitar),
    ...songUgRowsServed.declare,
  ],
  httpRoutes: {
    [createUltimateGuitarSong.route]: handleCreateUltimateGuitarSong,
    [updateUltimateGuitarSong.route]: handleUpdateUltimateGuitarSong,
  },
} satisfies ServerPluginDefinition;
