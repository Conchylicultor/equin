import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import type { SongId } from "../../core/id-kind";
import { _songs } from "./tables";

export interface UpdateSongMetaInput {
  id: SongId;
  title?: string;
  composer?: string | null;
  durationSec?: number;
  endBeat?: number;
}

/**
 * The generic, source-agnostic way to update a `sonata_songs` row's metadata.
 * Companion to `createSongRow`: the library owns all `_songs` mutations, so a
 * source persisting an edit syncs the parent row through here (recomputed
 * duration/endBeat, an edited title) rather than poking the table directly.
 *
 * Only the provided fields are written (plus `sourcesChangedAt`); the change-feed recomputes the live
 * `songs` value, so the gallery (length, title) updates live.
 */
export async function updateSongMeta(
  input: UpdateSongMetaInput,
): Promise<void> {
  const patch: Partial<typeof _songs.$inferInsert> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.composer !== undefined) patch.composer = input.composer;
  if (input.durationSec !== undefined) patch.durationSec = input.durationSec;
  if (input.endBeat !== undefined) patch.endBeat = input.endBeat;
  // Every source write stamps the row, whether or not a field moved: the
  // player re-hydrates on this (see `songFields.sourcesChangedAt`).
  patch.sourcesChangedAt = new Date();

  await db.update(_songs).set(patch).where(eq(_songs.id, input.id));
}
