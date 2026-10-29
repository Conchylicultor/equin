import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { patchRow, removeRow } from "@plugins/network/plugins/live/core";
import { songsEntityRef } from "./schemas";

/**
 * Delete a song. Generic and source-agnostic: the FK CASCADE on `sonata_songs`
 * drops every source's extension row (e.g. `sonata_songs_ext_midi`) and the
 * attachment link; the now-unlinked attachment is reclaimed by the orphan sweep.
 *
 * There is intentionally **no** generic `createSong` endpoint: a song is always
 * created *by a source* (which has both the generic metadata and its own raw to
 * persist). Sources call the server-side `createSongRow` helper from one of
 * their own endpoints (see e.g. the MIDI source's `createMidiSong`).
 */
export const deleteSong = defineEndpoint({
  route: "DELETE /api/sonata/songs/:id",
  // The song leaves every read at once. The extension rows the FK cascade
  // drops (playback, transpose, …) are the song's own; they follow by push.
  effect: (on) => removeRow(on, songsEntityRef, ({ params }) => params.id),
});

/**
 * Patch a song's user-editable, source-agnostic metadata (title, composer).
 * Backs inline cell editing in the library table view. Only the generic,
 * human-authored fields are exposed here — derived metrics (`durationSec`,
 * `endBeat`) are owned by each source's compile step and synced through the
 * server-side `updateSongMeta` helper, never edited by hand. `composer` is
 * nullable: clearing the cell stores `null`.
 */
export const UpdateSongBodySchema = z.object({
  title: z.string().optional(),
  composer: z.string().nullable().optional(),
});
export type UpdateSongBody = z.infer<typeof UpdateSongBodySchema>;

export const updateSong = defineEndpoint({
  route: "PATCH /api/sonata/songs/:id",
  body: UpdateSongBodySchema,
  // Only the fields the request carries; `sourcesChangedAt` (a write stamp the
  // player keys hydration on) arrives by push.
  effect: (on) =>
    patchRow(
      on,
      songsEntityRef,
      ({ params }) => params.id,
      ({ body }) => ({
        set: {
          ...(body.title !== undefined && { title: body.title }),
          ...(body.composer !== undefined && { composer: body.composer }),
        },
      }),
    ),
});
