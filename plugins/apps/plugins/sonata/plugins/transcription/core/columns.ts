import { z } from "zod";
import { liveColumns } from "@plugins/network/plugins/live/core";
import { liveText } from "@plugins/network/plugins/live/plugins/filter/core";
import { songLibrary } from "@plugins/apps/plugins/sonata/plugins/library/core";
import { TRANSCRIPTION_STATUSES } from "./status";

/**
 * A song's transcription as columns of the song library (`sonata.songs`):
 * every library row carries them under `$columns.transcription`, so the card
 * badge, the "Transcribing" filter and the player's pending body all read the
 * same live row. Served by this plugin's server from the
 * `sonata_songs_ext_transcription` extension (`serveColumns` over
 * `songTranscription.join`). All null for a song nobody transcribed.
 *
 * - `status` — `transcribing` / `ready` / `failed`;
 * - `conversationId` — the latest conversation transcribing it;
 * - `error` — why the latest run failed.
 */
export const transcriptionColumns = liveColumns(songLibrary, "transcription", {
  row: z.object({
    status: z.enum(TRANSCRIPTION_STATUSES).nullable(),
    conversationId: z.string().nullable(),
    error: z.string().nullable(),
  }),
  filterable: { status: liveText() },
  sortable: [],
});
