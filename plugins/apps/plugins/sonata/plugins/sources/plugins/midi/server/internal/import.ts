import { eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "@plugins/database/server";
import {
  AttachmentMissingError,
  createAttachment,
  readAttachmentBytes,
} from "@plugins/infra/plugins/attachments/server";
import { createSha256 } from "@plugins/packages/plugins/string-hash/core";
import {
  createSongRow,
  songAttachments,
  updateSongMeta,
} from "@plugins/apps/plugins/sonata/plugins/library/server";
import {
  songIdKind,
  type SongId,
} from "@plugins/apps/plugins/sonata/plugins/library/core";
import { MIDI_SOURCE_ID } from "../../shared/constants";
import { deriveMidiSongMeta, parseMidi } from "../../shared/parse";
import { songMidi, _songMidiExt } from "./tables";

/** SHA-256 (hex) of the raw `.mid` bytes — the content-dedup key. */
export function hashMidiBytes(bytes: Uint8Array): string {
  return createSha256().update(bytes).hex();
}

/** Generic metadata for the library `sonata_songs` row, derived from the file. */
interface MidiSongMeta {
  title: string;
  composer: string | null;
  durationSec: number;
  endBeat: number;
}

interface WriteMidiSongInput {
  /** SHA-256 of the raw bytes — looked up to collapse duplicates into one song. */
  contentHash: string;
  /** The stored attachment holding this import's bytes. */
  attachmentId: string;
  trackCount: number;
  meta: MidiSongMeta;
  /** Watched-folder path, or null for a manual import. */
  sourcePath: string | null;
  /** Folder re-import of the *same* path: reuse this song id, skip dedup. */
  existingSongId?: string;
}

/**
 * The single write+dedup chokepoint every import path funnels through (folder
 * watcher, manual upload, boot seeder). Decides which song row this import
 * belongs to, then writes the generic song row (or reuses one), the
 * `sonata_songs_ext_midi` row, and the attachment link.
 *
 * Dedup decision:
 * - `existingSongId` set → write to it (folder re-import of an edited file).
 * - else look up by content hash:
 *   - no match → fresh song row.
 *   - match that is `sourceMissing` (file moved) or manual (`sourcePath` null) →
 *     reuse it and adopt the new path, clearing `sourceMissing`. This is what
 *     makes a moved file re-attach to its original song.
 *   - match with a *live* different `sourcePath` → a redundant on-disk copy:
 *     return the existing id untouched (don't create, don't steal the live path,
 *     which would make reconcile flip-flop between the two identical files).
 *
 * Returns the resulting song id.
 */
async function writeMidiSong({
  contentHash,
  attachmentId,
  trackCount,
  meta,
  sourcePath,
  existingSongId,
}: WriteMidiSongInput): Promise<string> {
  // Ids read back from a stored row (the caller's, the extension's) are looked
  // up by, never minted: `key` brands them.
  let id: SongId | undefined =
    existingSongId === undefined ? undefined : songIdKind.key(existingSongId);
  if (!id) {
    const dup = await getSongMidiByContentHash(contentHash);
    if (dup) {
      // A redundant second on-disk copy: the same content is already backed by a
      // present file elsewhere. Leave that song alone — the new copy collapses
      // into it without disturbing its source path.
      if (
        dup.sourcePath !== null &&
        !dup.sourceMissing &&
        dup.sourcePath !== sourcePath
      ) {
        return dup.songId;
      }
      id = songIdKind.key(dup.songId);
    }
  }

  id ??= await createSongRow({
    title: meta.title,
    composer: meta.composer,
    durationSec: meta.durationSec,
    endBeat: meta.endBeat,
    source: MIDI_SOURCE_ID,
  });

  await songMidi.upsert(id, {
    attachmentId,
    trackCount,
    sourcePath,
    sourceMissing: false,
    contentHash,
  });

  // `.set` (not `.add`): replace the song's linked attachments with just the new
  // one so a re-import of an edited file leaves no orphaned previous attachment.
  await songAttachments.set(id, [attachmentId]);

  // Make the library row authoritative over the file on every re-import: the
  // reuse branches (existingSongId re-import, content-hash adopt) skip
  // createSongRow, so without this the recomputed title/duration/endBeat from an
  // edited file would never reach the generic sonata_songs row. No-op on a fresh
  // insert (createSongRow just wrote the same values); corrects a drifted row.
  await updateSongMeta({
    id,
    title: meta.title,
    composer: meta.composer,
    durationSec: meta.durationSec,
    endBeat: meta.endBeat,
  });

  return id;
}

export interface ImportMidiSongInput {
  /** Raw `.mid` file bytes. */
  bytes: Uint8Array;
  /** Original filename — drives the derived song title and the stored attachment name. */
  filename: string;
  /**
   * Absolute path of the watched-folder file this song mirrors. Null/omitted for
   * manual imports (never touched by the folder watcher); set for folder imports
   * and used as the idempotency key.
   */
  sourcePath?: string | null;
  /**
   * When re-importing an edited file, the existing song id to update in place.
   * Skips `createSongRow` and reuses this id so a re-import never spawns a
   * duplicate library row. Omit to create a fresh song.
   */
  existingSongId?: string;
}

/**
 * The reusable, server-side MIDI import path for callers that hold raw bytes
 * (the folder-watcher job). Parses the bytes, derives the metadata, copies the
 * bytes into the attachment store, and funnels through `writeMidiSong` (which
 * dedupes by content hash). The manual HTTP route uses
 * `createMidiSongFromAttachment` (bytes already uploaded); the boot seeder calls
 * the lower-level primitives directly since it synthesizes the MIDI.
 *
 * Failures (corrupt MIDI, IO) propagate loudly so the caller's job retries and
 * surfaces them — nothing is swallowed.
 *
 * Returns the song id (the freshly created one, or `existingSongId` on re-import).
 */
export async function importMidiSong({
  bytes,
  filename,
  sourcePath = null,
  existingSongId,
}: ImportMidiSongInput): Promise<string> {
  // Parse to validate the file loudly before we persist anything (`parseMidi`
  // throws on malformed input). The Score itself is recomposed client-side on
  // hydrate; here we only need it to fail fast and to derive the metadata.
  parseMidi(bytes);
  const meta = deriveMidiSongMeta(bytes, filename);
  const contentHash = hashMidiBytes(bytes);

  const att = await createAttachment(bytes, filename, "audio/midi");

  return writeMidiSong({
    contentHash,
    attachmentId: att.id,
    trackCount: meta.trackCount,
    meta: {
      title: meta.title,
      composer: null,
      durationSec: meta.durationSec,
      endBeat: meta.endBeat,
    },
    sourcePath,
    existingSongId,
  });
}

/**
 * Create a song from an already-uploaded attachment (the manual-import HTTP
 * path). The bytes already live in the attachment store, so we read them back to
 * compute the content hash — keeping the hash server-authoritative — and funnel
 * through the same dedup core. Returns the resulting song id (an existing one
 * when the upload duplicates a song already in the library).
 */
export async function createMidiSongFromAttachment(input: {
  attachmentId: string;
  trackCount: number;
  meta: MidiSongMeta;
}): Promise<string> {
  const bytes = await readAttachmentBytes(input.attachmentId);

  return writeMidiSong({
    contentHash: hashMidiBytes(bytes),
    attachmentId: input.attachmentId,
    trackCount: input.trackCount,
    meta: input.meta,
    sourcePath: null,
  });
}

/**
 * Look up the folder-imported song for a watched-file path, or null. The
 * idempotency lookup the watcher uses to decide create-vs-update.
 */
export async function getSongMidiBySourcePath(
  sourcePath: string,
): Promise<{ songId: string; sourceMissing: boolean } | null> {
  const [row] = await db
    .select()
    .from(_songMidiExt)
    .where(eq(_songMidiExt.sourcePath, sourcePath))
    .limit(1);
  if (!row) return null;
  return { songId: row.songId, sourceMissing: row.sourceMissing };
}

/**
 * Look up the song carrying a given content hash, or null. The dedup lookup
 * `writeMidiSong` uses to collapse a moved / re-imported / re-uploaded file into
 * its existing song. Returns the current `sourcePath`/`sourceMissing` so the
 * caller can decide whether to adopt the new path.
 */
export async function getSongMidiByContentHash(contentHash: string): Promise<{
  songId: string;
  sourcePath: string | null;
  sourceMissing: boolean;
} | null> {
  const [row] = await db
    .select()
    .from(_songMidiExt)
    .where(eq(_songMidiExt.contentHash, contentHash))
    .limit(1);
  if (!row) return null;
  return {
    songId: row.songId,
    sourcePath: row.sourcePath,
    sourceMissing: row.sourceMissing,
  };
}

/**
 * One-shot boot backfill: stamp `content_hash` onto MIDI songs imported before
 * content-hash dedup existed, by re-reading each backing attachment's bytes.
 * Idempotent (touches only `content_hash IS NULL` rows), so it self-heals across
 * restarts. Without it, dedup of a *pre-existing* song (e.g. moving a file that
 * was imported earlier) couldn't match and would spawn a duplicate.
 *
 * A row whose attachment file is missing is logged and skipped — an orphaned row
 * must not crash boot; it simply stays un-hashed until re-imported.
 */
export async function backfillContentHashes(): Promise<void> {
  const rows = await db
    .select()
    .from(_songMidiExt)
    .where(isNull(_songMidiExt.contentHash));
  for (const row of rows) {
    let bytes: Uint8Array;
    try {
      bytes = await readAttachmentBytes(row.attachmentId);
    } catch (err) {
      if (!(err instanceof AttachmentMissingError)) throw err;
      console.warn(
        `[midi] backfill: ${err.message} (song ${row.songId}), skipping`,
      );
      continue;
    }
    await db
      .update(_songMidiExt)
      .set({ contentHash: hashMidiBytes(bytes) })
      .where(eq(_songMidiExt.songId, row.songId));
  }
}

/**
 * Every folder-imported song (i.e. `source_path is not null`) with its current
 * `sourceMissing` flag. The watcher's reconcile uses this to detect drift the
 * other way: a song whose backing file is gone from a still-watched folder.
 * Manual imports (null `sourcePath`) are excluded and never enumerated here.
 */
export async function listFolderImportedSongs(): Promise<
  { songId: string; sourcePath: string; sourceMissing: boolean }[]
> {
  const rows = await db
    .select()
    .from(_songMidiExt)
    .where(isNotNull(_songMidiExt.sourcePath));
  return rows.map((row) => ({
    songId: row.songId,
    // Narrow: the `isNotNull` filter guarantees a non-null path here.
    sourcePath: row.sourcePath as string,
    sourceMissing: row.sourceMissing,
  }));
}

/**
 * Flip a single song's `source_missing` flag (file vanished → true, file came
 * back → false) without rewriting the other columns, then push the change to
 * clients. A trivial targeted UPDATE — used by the watcher's delete/restore path.
 */
export async function setSourceMissing(
  songId: string,
  missing: boolean,
): Promise<void> {
  await db
    .update(_songMidiExt)
    .set({ sourceMissing: missing })
    .where(eq(_songMidiExt.songId, songId));
}
