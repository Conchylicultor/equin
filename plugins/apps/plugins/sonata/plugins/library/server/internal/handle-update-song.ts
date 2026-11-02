import { implement } from "@plugins/infra/plugins/endpoints/server";
import { songIdKind, updateSong } from "../../core";
import { updateSongMeta } from "./update-song-meta";

/**
 * Patch a song's generic metadata. Delegates to the source-agnostic
 * `updateSongMeta` helper (the library owns all `_songs` mutations), which writes
 * only the provided fields; the change-feed recomputes the live `songs` value so
 * the library updates without a client round-trip.
 */
export const handleUpdateSong = implement(
  updateSong,
  async ({ params, body }) => {
    await updateSongMeta({ id: songIdKind.key(params.id), ...body });
  },
);
