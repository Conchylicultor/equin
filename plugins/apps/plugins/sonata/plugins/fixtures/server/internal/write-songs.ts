import {
  createSongRow,
  updateSongMeta,
} from "@plugins/apps/plugins/sonata/plugins/library/server";
import {
  songIdKind,
  type SongId,
} from "@plugins/apps/plugins/sonata/plugins/library/core";
import {
  beatToSeconds,
  scoreEndBeat,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { compile } from "@plugins/apps/plugins/sonata/plugins/sources/plugins/chord-grid/core";
import { createChordGridSongRow } from "@plugins/apps/plugins/sonata/plugins/sources/plugins/chord-grid/server";
import {
  importMidiSong,
  MIDI_SOURCE_ID,
} from "@plugins/apps/plugins/sonata/plugins/sources/plugins/midi/server";
import {
  importMusicXmlForSong,
  MUSICXML_SOURCE_ID,
} from "@plugins/apps/plugins/sonata/plugins/sources/plugins/musicxml/server";
import type {
  ChordGridSongFixture,
  MidiSongFixture,
  MusicXmlSongFixture,
  SongFixture,
} from "../../core";

/**
 * Write `songs` into the library through each source's real write path — the
 * same write the source's create or import makes. Each song keeps the
 * fixture's id, title and composer: a file-backed song's row is created under
 * that id first, then filled the way the source fills an existing song (its
 * re-import), then named as the fixture names it.
 */
export async function writeSongFixtures(
  songs: readonly SongFixture[],
): Promise<void> {
  for (const song of songs) {
    switch (song.kind) {
      case "chord-grid":
        await writeChordGrid(song);
        break;
      case "midi":
        await writeMidi(song);
        break;
      case "musicxml":
        await writeMusicXml(song);
        break;
    }
  }
}

/** A chord grid's length is measured the way the editor measures it before creating one. */
async function writeChordGrid(song: ChordGridSongFixture): Promise<void> {
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

/** An empty song row of `source` under the fixture's id, for the source to fill. */
async function createEmptySong(
  song: SongFixture,
  source: string,
): Promise<SongId> {
  return createSongRow({
    id: songIdKind.parse(song.id),
    title: song.title,
    composer: song.composer,
    durationSec: 0,
    endBeat: 0,
    source,
  });
}

async function writeMidi(song: MidiSongFixture): Promise<void> {
  const id = await createEmptySong(song, MIDI_SOURCE_ID);
  await importMidiSong({
    bytes: song.bytes,
    filename: song.fileName,
    existingSongId: id,
  });
  await updateSongMeta({ id, title: song.title, composer: song.composer });
}

async function writeMusicXml(song: MusicXmlSongFixture): Promise<void> {
  const id = await createEmptySong(song, MUSICXML_SOURCE_ID);
  await importMusicXmlForSong({
    songId: id,
    xml: song.xml,
    fileName: song.fileName,
  });
  await updateSongMeta({ id, title: song.title, composer: song.composer });
}
