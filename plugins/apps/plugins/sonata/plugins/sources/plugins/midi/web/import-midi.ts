import { uploadAttachment } from "@plugins/infra/plugins/attachments/web";
import type { FetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { deriveMidiSongMeta } from "../shared/parse";
import { createMidiSong } from "../shared/endpoints";

/** The library song a MIDI file's bytes belong to. */
export interface ImportedMidiSong {
  id: string;
  title: string;
}

/**
 * Put a MIDI file's bytes into the Sonata library: parse them for the song's
 * metadata, upload them as an attachment, and create the MIDI-backed song.
 * Idempotent by content: the server hashes the uploaded bytes and answers a
 * file already in the library with that song's id instead of a duplicate, so a
 * second import of the same file (the file preview's "Open in Sonata" pressed
 * twice) opens the song the first one made.
 *
 * Malformed MIDI throws from `deriveMidiSongMeta` before anything is uploaded.
 */
export async function importMidiBytes(
  fetchEndpoint: FetchEndpoint,
  bytes: ArrayBuffer,
  filename: string,
): Promise<ImportedMidiSong> {
  const meta = deriveMidiSongMeta(bytes, filename);
  const up = await uploadAttachment(
    fetchEndpoint,
    new Blob([bytes], { type: "audio/midi" }),
    filename,
    "audio/midi",
  );
  return fetchEndpoint(
    createMidiSong,
    {},
    {
      body: {
        title: meta.title,
        composer: null,
        attachmentId: up.id,
        durationSec: meta.durationSec,
        endBeat: meta.endBeat,
        trackCount: meta.trackCount,
      },
    },
  );
}
