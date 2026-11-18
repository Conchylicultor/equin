import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { songIdKind } from "@plugins/apps/plugins/sonata/plugins/library/core";
import { UgTabSchema } from "@plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/plugins/tab/core";

/**
 * Create a UG-backed song. The client sends the full fetched `UgTab` plus the
 * `compile()`-derived metrics; the handler writes the generic `sonata_songs` row
 * (via the library's `createSongRow`, title ← songName / composer ← artistName)
 * and this source's `sonata_songs_ext_ultimate_guitar` row. Returns enough to
 * open the song immediately.
 */
export const CreateUltimateGuitarSongBodySchema = UgTabSchema.extend({
  durationSec: z.number(),
  endBeat: z.number(),
});
export type CreateUltimateGuitarSongBody = z.infer<
  typeof CreateUltimateGuitarSongBodySchema
>;

/**
 * The create body: the tab and its metrics, plus — for a song created from a
 * share link — the id and title it has on the library it was shared from (so
 * the link opens it here too, under the name its sharer gave it). A fresh id
 * and the tab's song name when absent.
 */
export const NewUltimateGuitarSongBodySchema =
  CreateUltimateGuitarSongBodySchema.extend({
    id: songIdKind.schema.optional(),
    title: z.string().optional(),
  });

export const createUltimateGuitarSong = defineEndpoint({
  route: "POST /api/sonata/songs/ultimate-guitar",
  body: NewUltimateGuitarSongBodySchema,
  response: z.object({ id: z.string(), title: z.string() }),
});

/**
 * Persist an edit (re-loading a different tab in-player): carries the full
 * current `UgTab` snapshot plus recomputed metrics. Idempotent — a complete
 * state, not a delta. Syncs the parent song's title (← songName) and
 * duration/endBeat via `updateSongMeta`.
 */
export const updateUltimateGuitarSong = defineEndpoint({
  route: "PUT /api/sonata/songs/:id/ultimate-guitar",
  body: CreateUltimateGuitarSongBodySchema,
  response: z.object({ ok: z.literal(true) }),
});
