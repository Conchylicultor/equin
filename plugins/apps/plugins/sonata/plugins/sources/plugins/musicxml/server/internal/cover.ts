import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import {
  AttachmentBlobs,
  getAttachment,
} from "@plugins/infra/plugins/attachments/server";
import { _songs } from "@plugins/apps/plugins/sonata/plugins/library/server";
import { songIdKind } from "@plugins/apps/plugins/sonata/plugins/library/core";
import { serveScoreCover } from "@plugins/apps/plugins/sonata/plugins/covers/server";
import { songMusicXml } from "./tables";
import {
  createMusicXmlCoverHandler,
  type MusicXmlCoverSong,
} from "./cover-handler";

/** The text a stored attachment holds; throws when it is gone. */
async function readAttachmentText(attachmentId: string): Promise<string> {
  const att = await getAttachment(attachmentId);
  if (!att) throw new Error(`[musicxml] attachment not found: ${attachmentId}`);
  const blob = await AttachmentBlobs.get().read(att.diskPath);
  if (blob === null) {
    throw new Error(`[musicxml] attachment bytes missing: ${attachmentId}`);
  }
  return blob.text();
}

/** One song's MusicXML as the cover route reads it, from the DB. */
async function lookupMusicXmlCoverSong(
  id: string,
): Promise<MusicXmlCoverSong | null> {
  const songId = songIdKind.key(id);
  const row = await songMusicXml.get(songId);
  if (!row) return null;
  const [song] = await db
    .select({ sourcesChangedAt: _songs.sourcesChangedAt })
    .from(_songs)
    .where(eq(_songs.id, songId))
    .limit(1);
  if (!song) return null;
  return {
    current: String(song.sourcesChangedAt.getTime()),
    contentHash: row.contentHash,
    readXml: () => readAttachmentText(row.attachmentId),
  };
}

/** `GET /api/sonata/songs/:id/musicxml/cover/:file` — the song's staff cover. */
export const handleMusicXmlCover = createMusicXmlCoverHandler({
  lookup: lookupMusicXmlCoverSong,
  serve: serveScoreCover,
});
