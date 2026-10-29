import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { patchRow } from "@plugins/network/plugins/live/core";
import { songsEntityRef } from "@plugins/apps/plugins/sonata/plugins/library/core";

/**
 * Create a chord-grid–backed song. Unlike MIDI (an imported, immutable file),
 * the chord grid is authored text, so the client sends the grid fields plus the
 * `compile()`-derived metrics. The handler writes the generic `sonata_songs`
 * row (via the library's `createSongRow`) and this source's
 * `sonata_songs_ext_chord_grid` row. Returns enough to open the song immediately.
 */
export const CreateChordGridSongBodySchema = z.object({
  title: z.string(),
  composer: z.string().nullable(),
  chordText: z.string(),
  durationSec: z.number(),
  endBeat: z.number(),
});
export type CreateChordGridSongBody = z.infer<
  typeof CreateChordGridSongBodySchema
>;

export const createChordGridSong = defineEndpoint({
  route: "POST /api/sonata/songs/chord-grid",
  body: CreateChordGridSongBodySchema,
  response: z.object({ id: z.string(), title: z.string() }),
  unpredicted: {
    reason: "server-minted-id",
    why: "the shell opens the new song by the id the server mints",
  },
});

/**
 * Persist an edit to a chord-grid song: the grid text (→ extension row) plus its
 * `compile()`-**derived** metrics `durationSec`/`endBeat` (→ parent song row via
 * `updateSongMeta`), since `compile()` runs client-side. It carries **no**
 * `title`: the title is generic, source-agnostic metadata owned by the library
 * and patched through `PATCH /api/sonata/songs/:id` — a chord-text edit
 * physically cannot carry a title. Idempotent: each save writes a complete
 * state, not a delta.
 */
export const UpdateChordGridSongBodySchema = z.object({
  chordText: z.string(),
  durationSec: z.number(),
  endBeat: z.number(),
});
export type UpdateChordGridSongBody = z.infer<
  typeof UpdateChordGridSongBodySchema
>;

export const updateChordGridSong = defineEndpoint({
  route: "PUT /api/sonata/songs/:id/chord-grid",
  body: UpdateChordGridSongBodySchema,
  response: z.object({ ok: z.literal(true) }),
  // The parent song's metrics show at once (the grid text itself is not a live
  // row — the editor already holds it).
  effect: (on) =>
    patchRow(
      on,
      songsEntityRef,
      ({ params }) => params.id,
      ({ body }) => ({
        set: { durationSec: body.durationSec, endBeat: body.endBeat },
      }),
    ),
});
