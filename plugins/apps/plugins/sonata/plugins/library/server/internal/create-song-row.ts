import { db } from "@plugins/database/server";
import { songIdKind, type SongId } from "../../core";
import { _songs } from "./tables";

export interface CreateSongRowInput {
  /** Optional stable id (a starter's `seed-…` id). Defaults to a fresh `songIdKind.mint()`. */
  id?: SongId;
  title: string;
  composer: string | null;
  durationSec: number;
  endBeat: number;
  /**
   * Opaque id of the source creating this song (its `Library.Source` /
   * `SonataDocument.Source` id, e.g. `"midi"`). Required — every song has exactly one
   * immutable source. The library stores it verbatim without interpreting it, so
   * a new source needs no change here.
   */
  source: string;
}

/**
 * The generic, source-agnostic way to create a `sonata_songs` row. A song is
 * always created *by a source* (which also persists its own raw into its
 * extension table); this owns only the generic metadata write (the live `songs`
 * value recomputes off the change-feed), so the library never learns about any
 * source.
 *
 * Idempotent on `id` (`onConflictDoNothing`) so seeders can call it repeatedly
 * without duplicating rows. Returns the song id.
 */
export async function createSongRow(
  input: CreateSongRowInput,
): Promise<SongId> {
  const id = input.id ?? songIdKind.mint();
  await db
    .insert(_songs)
    .values({
      id,
      title: input.title,
      composer: input.composer,
      durationSec: input.durationSec,
      endBeat: input.endBeat,
      source: input.source,
    })
    .onConflictDoNothing();
  return id;
}
