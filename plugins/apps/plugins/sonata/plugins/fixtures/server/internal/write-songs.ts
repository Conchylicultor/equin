import { songIdKind } from "@plugins/apps/plugins/sonata/plugins/library/core";
import {
  beatToSeconds,
  scoreEndBeat,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { compile } from "@plugins/apps/plugins/sonata/plugins/sources/plugins/chord-grid/core";
import { createChordGridSongRow } from "@plugins/apps/plugins/sonata/plugins/sources/plugins/chord-grid/server";
import type { SongFixture } from "../../core";

/**
 * Write `songs` into the library through each source's real write path — the
 * same write the source's create route makes. A chord grid's length is
 * measured the way the editor measures it before creating one (its compiled
 * score's end beat, at the score's tempo).
 */
export async function writeSongFixtures(
  songs: readonly SongFixture[],
): Promise<void> {
  for (const song of songs) {
    const score = compile({ text: song.chordText });
    const endBeat = scoreEndBeat(score);
    await createChordGridSongRow({
      id: songIdKind.parse(song.id),
      title: song.title,
      composer: song.composer,
      chordText: song.chordText,
      durationSec: beatToSeconds(score, endBeat),
      endBeat,
    });
  }
}
