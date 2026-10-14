import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import {
  createAttachment,
  getAttachment,
} from "@plugins/infra/plugins/attachments/server";
import {
  _songs,
  createSongRow,
  songAttachments,
  updateSongMeta,
} from "@plugins/apps/plugins/sonata/plugins/library/server";
import {
  songIdKind,
  type SongId,
} from "@plugins/apps/plugins/sonata/plugins/library/core";
import { MUSICXML_MIME, MUSICXML_SOURCE_ID } from "../../shared/constants";
import {
  deriveMusicXmlSongMeta,
  titleFromFileName,
  type MusicXmlSongMeta,
} from "../../shared/parse";
import { songMusicXml, _songMusicXmlExt } from "./tables";

/** SHA-256 (hex) of the document's bytes — the content-dedup key. */
function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Link a stored document to a song: the extension row, the attachment link
 * (`.set`, so a replaced document leaves no orphan behind), and the library
 * row's metadata. Title and composer are written only when given, so a
 * document naming neither keeps the song's own.
 */
async function writeMusicXmlSong(
  id: SongId,
  attachmentId: string,
  contentHash: string,
  meta: MusicXmlSongMeta,
): Promise<void> {
  await songMusicXml.upsert(id, { attachmentId, contentHash });
  await songAttachments.set(id, [attachmentId]);
  await updateSongMeta({
    id,
    ...(meta.title !== null ? { title: meta.title } : {}),
    ...(meta.composer !== null ? { composer: meta.composer } : {}),
    durationSec: meta.durationSec,
    endBeat: meta.endBeat,
  });
}

export interface ImportMusicXmlForSongInput {
  /** An EXISTING `sonata_songs` row created with the `musicxml` source. */
  songId: string;
  /** The MusicXML document text. */
  xml: string;
  /** The stored attachment's file name. */
  fileName: string;
}

/**
 * Fill an existing MusicXML song with a document: parse it (a
 * `MusicXmlParseError` propagates before anything is written), store it as an
 * attachment, write the `sonata_songs_ext_musicxml` row (replacing a previous
 * document) and sync the song's title / composer (when the document names
 * them), duration and end beat. For a caller that created the song row itself —
 * the transcription flow, which creates the song before the score exists.
 *
 * Throws when the song does not exist or was created by another source.
 */
export async function importMusicXmlForSong({
  songId,
  xml,
  fileName,
}: ImportMusicXmlForSongInput): Promise<void> {
  const meta = deriveMusicXmlSongMeta(xml);
  const id = songIdKind.key(songId);
  const [song] = await db
    .select({ source: _songs.source })
    .from(_songs)
    .where(eq(_songs.id, id))
    .limit(1);
  if (!song) throw new Error(`[musicxml] song not found: ${songId}`);
  if (song.source !== MUSICXML_SOURCE_ID) {
    throw new Error(
      `[musicxml] song ${songId} belongs to the "${song.source}" source, not "${MUSICXML_SOURCE_ID}"`,
    );
  }
  const bytes = new TextEncoder().encode(xml);
  const att = await createAttachment(bytes, fileName, MUSICXML_MIME);
  await writeMusicXmlSong(id, att.id, hashBytes(bytes), meta);
}

/**
 * Create a song from an already-uploaded MusicXML attachment (the library's
 * import). The server reads the document back, so parsing, metadata and the
 * content hash are all server-authoritative. A document already in the library
 * answers that song's id instead of creating a duplicate.
 */
export async function createMusicXmlSongFromAttachment(
  attachmentId: string,
): Promise<{ id: string; title: string }> {
  const att = await getAttachment(attachmentId);
  if (!att) throw new Error(`[musicxml] attachment not found: ${attachmentId}`);
  const bytes = await Bun.file(att.diskPath).bytes();
  const xml = new TextDecoder().decode(bytes);
  const meta = deriveMusicXmlSongMeta(xml);
  const contentHash = hashBytes(bytes);

  const [dup] = await db
    .select({ songId: _songMusicXmlExt.songId })
    .from(_songMusicXmlExt)
    .where(eq(_songMusicXmlExt.contentHash, contentHash))
    .limit(1);
  const title = meta.title ?? titleFromFileName(att.filename);
  if (dup) return { id: dup.songId, title };

  const id = await createSongRow({
    title,
    composer: meta.composer,
    durationSec: meta.durationSec,
    endBeat: meta.endBeat,
    source: MUSICXML_SOURCE_ID,
  });
  await writeMusicXmlSong(id, attachmentId, contentHash, { ...meta, title });
  return { id, title };
}
