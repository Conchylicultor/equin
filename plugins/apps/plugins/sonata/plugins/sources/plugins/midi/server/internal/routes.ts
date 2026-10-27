import { implement } from "@plugins/infra/plugins/endpoints/server";
import { createMidiSong } from "../../shared/endpoints";
import { createMidiSongFromAttachment } from "./import";

/**
 * Create a MIDI-backed song from the client's already-uploaded attachment.
 * Funnels through the shared import core, which hashes the bytes and dedupes:
 * re-uploading a file already in the library returns its existing song rather
 * than a duplicate. `id` may therefore be an existing song's id — the client's
 * `openSong` opens whichever song this content belongs to.
 */
export const handleCreateMidiSong = implement(
  createMidiSong,
  async ({ body }) => {
    const id = await createMidiSongFromAttachment({
      attachmentId: body.attachmentId,
      trackCount: body.trackCount,
      meta: {
        title: body.title,
        composer: body.composer,
        durationSec: body.durationSec,
        endBeat: body.endBeat,
      },
    });
    return { id, title: body.title };
  },
);
