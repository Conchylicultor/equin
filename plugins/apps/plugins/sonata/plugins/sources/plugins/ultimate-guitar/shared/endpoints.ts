import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { UgTabSchema } from "@plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/plugins/tab/core";

/**
 * Fetch the raw Ultimate Guitar tab for a pasted UG tab URL. The handler
 * resolves the URL to a numeric tab id and fetches the tab from UG's private
 * mobile API. NO persistence, NO parsing of the chord/lyric markup — the raw
 * `content` is returned verbatim. Failures map to loud HTTP statuses.
 */
export const fetchUgTab = defineEndpoint({
  route: "POST /api/sonata/sources/ultimate-guitar/fetch",
  body: z.object({ url: z.string() }),
  response: UgTabSchema,
});

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

export const createUltimateGuitarSong = defineEndpoint({
  route: "POST /api/sonata/songs/ultimate-guitar",
  body: CreateUltimateGuitarSongBodySchema,
  response: z.object({ id: z.string(), title: z.string() }),
});

/**
 * Fetch one song's persisted `UgTab` (or `null` if the song carries none). Used
 * by the source's `hydrate` to repopulate the editor + recompile on open.
 */
export const getSongUltimateGuitar = defineEndpoint({
  route: "GET /api/sonata/songs/:id/ultimate-guitar",
  response: UgTabSchema.nullable(),
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
