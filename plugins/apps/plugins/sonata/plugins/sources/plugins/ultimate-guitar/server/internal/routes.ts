import { songIdKind } from "@plugins/apps/plugins/sonata/plugins/library/core";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import {
  createSongRow,
  updateSongMeta,
} from "@plugins/apps/plugins/sonata/plugins/library/server";
import { UG_SOURCE_ID } from "@plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/plugins/tab/core";
import {
  createUltimateGuitarSong,
  updateUltimateGuitarSong,
} from "../../shared/endpoints";
import { songUltimateGuitar } from "./tables";
import { ugTabSaved } from "./tables-tab-saved";

/**
 * Create a UG-backed song. Writes the generic song row (library helper) then
 * this source's extension row (the full UgTab). No attachment.
 */
export const handleCreateUltimateGuitarSong = implement(
  createUltimateGuitarSong,
  async ({ body }) => {
    const { durationSec, endBeat, ...tab } = body;
    const id = await createSongRow({
      title: tab.songName,
      composer: tab.artistName || null,
      durationSec,
      endBeat,
      source: UG_SOURCE_ID,
    });
    await songUltimateGuitar.upsert(id, tab);
    await ugTabSaved.emit({ songId: id });
    return { id, title: tab.songName };
  },
);

/**
 * Persist an edit: upsert the extension row (full UgTab), then sync the parent
 * song's generic metadata (title ← songName, composer ← artistName, recomputed
 * duration/endBeat) via the library helper. Announces `ugTabSaved` only when the
 * sheet's `content` differs from the stored one.
 */
export const handleUpdateUltimateGuitarSong = implement(
  updateUltimateGuitarSong,
  async ({ params, body }) => {
    const { durationSec, endBeat, ...tab } = body;
    // `key` upgrades a pre-rewrite bare-uuid id from a stale client.
    const id = songIdKind.key(params.id);
    const before = await songUltimateGuitar.get(id);
    await songUltimateGuitar.upsert(id, tab);
    if (before?.content !== tab.content) {
      await ugTabSaved.emit({ songId: id });
    }
    await updateSongMeta({
      id,
      title: tab.songName,
      composer: tab.artistName || null,
      durationSec,
      endBeat,
    });
    return { ok: true as const };
  },
);
