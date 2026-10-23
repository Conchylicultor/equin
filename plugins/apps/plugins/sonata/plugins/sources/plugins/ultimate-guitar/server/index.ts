import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { LiveColumns } from "@plugins/network/plugins/live/server";
import {
  fetchUgTab,
  searchUgTabs,
  createUltimateGuitarSong,
  getSongUltimateGuitar,
  updateUltimateGuitarSong,
} from "../shared/endpoints";
import {
  handleFetchUgTab,
  handleSearchUgTabs,
  handleCreateUltimateGuitarSong,
  handleGetSongUltimateGuitar,
  handleUpdateUltimateGuitarSong,
} from "./internal/routes";
import { songUltimateGuitar } from "./internal/tables";
import { ugTabSaved } from "./internal/tables-tab-saved";

export { fetchUgTabContent } from "./internal/ug-client";
export { songUltimateGuitar } from "./internal/tables";
export { ugTabSaved } from "./internal/tables-tab-saved";
export type { UgTabSavedPayload } from "./internal/tables-tab-saved";

export default {
  description:
    "Ultimate Guitar source server: fetches raw tabs from UG's private mobile API (fails loudly), and owns the sonata_songs_ext_ultimate_guitar side-table — creating UG-backed songs from a fetched tab and persisting edits (syncing the parent song's title/duration), exposing the tab's key to every list of songs (LiveColumns.Expose), announcing sonata.ug.tabSaved when a song's sheet content changes.",
  register: [ugTabSaved],
  contributions: [LiveColumns.Expose(songUltimateGuitar)],
  httpRoutes: {
    [fetchUgTab.route]: handleFetchUgTab,
    [searchUgTabs.route]: handleSearchUgTabs,
    [createUltimateGuitarSong.route]: handleCreateUltimateGuitarSong,
    [getSongUltimateGuitar.route]: handleGetSongUltimateGuitar,
    [updateUltimateGuitarSong.route]: handleUpdateUltimateGuitarSong,
  },
} satisfies ServerPluginDefinition;
