import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { readAttachmentBytes } from "@plugins/infra/plugins/attachments/server";
import { _songs } from "@plugins/apps/plugins/sonata/plugins/library/server";
import { songIdKind } from "@plugins/apps/plugins/sonata/plugins/library/core";
import { serveScoreCover } from "@plugins/apps/plugins/sonata/plugins/covers/server";
import { songMidi } from "./tables";
import { hashMidiBytes } from "./import";
import { createMidiCoverHandler, type MidiCoverSong } from "./cover-handler";

/** One song's MIDI as the cover route reads it, from the DB. */
async function lookupMidiCoverSong(id: string): Promise<MidiCoverSong | null> {
  const songId = songIdKind.key(id);
  const row = await songMidi.get(songId);
  if (!row) return null;
  const [song] = await db
    .select({ sourcesChangedAt: _songs.sourcesChangedAt })
    .from(_songs)
    .where(eq(_songs.id, songId))
    .limit(1);
  if (!song) return null;
  const readBytes = () => readAttachmentBytes(row.attachmentId);
  return {
    current: String(song.sourcesChangedAt.getTime()),
    // A row imported before content hashing (not yet backfilled) is hashed
    // from its bytes here — the same hash the boot backfill stamps.
    contentHash: row.contentHash ?? hashMidiBytes(await readBytes()),
    readBytes,
  };
}

/** `GET /api/sonata/songs/:id/midi/cover/:file` — the song's roll cover. */
export const handleMidiCover = createMidiCoverHandler({
  lookup: lookupMidiCoverSong,
  serve: serveScoreCover,
});
