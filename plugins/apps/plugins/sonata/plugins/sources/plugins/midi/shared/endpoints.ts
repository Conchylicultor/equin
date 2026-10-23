import { z } from "zod";
import {
  blob,
  defineEndpoint,
  endpointPath,
} from "@plugins/infra/plugins/endpoints/core";

/**
 * Create a song from an already-uploaded MIDI attachment. The client uploads the
 * MIDI first (gets an attachment id) and parses it for metadata, then POSTs.
 * The handler writes the generic `sonata_songs` row (via the library's
 * `createSongRow` helper) and this source's `sonata_songs_ext_midi` row, and
 * links the attachment. Returns enough to open the song immediately.
 */
export const CreateMidiSongBodySchema = z.object({
  title: z.string(),
  composer: z.string().nullable(),
  attachmentId: z.string(),
  durationSec: z.number(),
  endBeat: z.number(),
  trackCount: z.number(),
});
export type CreateMidiSongBody = z.infer<typeof CreateMidiSongBodySchema>;

export const createMidiSong = defineEndpoint({
  route: "POST /api/sonata/songs/midi",
  body: CreateMidiSongBodySchema,
  response: z.object({ id: z.string(), title: z.string() }),
});

/**
 * Fetch one song's MIDI data (or `null` if this song carries no MIDI). Used by
 * the source's `hydrate` to resolve the attachment to fetch — a one-shot read in
 * a non-hook context (the library rows carry only the `midi` columns it lists).
 */
export const getSongMidi = defineEndpoint({
  route: "GET /api/sonata/songs/:id/midi",
  response: z
    .object({ attachmentId: z.string(), trackCount: z.number() })
    .nullable(),
});

/**
 * One song's cover: a falling-notes SVG of its busiest bars, drawn on the
 * server from the song's own MIDI (`covers` renders and caches it). Raw — it
 * answers SVG bytes. The last segment is `<version>.svg`, the version the row's
 * `sourcesChangedAt` (epoch ms) as the card building the URL knew it: the
 * response is `immutable` while it is current, `no-store` once stale. One
 * whole-segment param, because the router matches whole segments only.
 */
export const getSongMidiCover = defineEndpoint({
  route: "GET /api/sonata/songs/:id/midi/cover/:file",
  response: blob(),
});

/** The URL of a song's MIDI cover, versioned by its `sourcesChangedAt`. */
export function midiCoverUrl(id: string, sourcesChangedAt: Date): string {
  return endpointPath(getSongMidiCover, {
    id,
    file: `${sourcesChangedAt.getTime()}.svg`,
  });
}
