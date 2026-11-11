/**
 * Some songs, in Sonata's own terms — what a demo or a test puts in a library.
 * Ids are the caller's (a `song-…` id the caller mints, e.g. one carrying
 * `demo`), so the caller can open or assert a song by id.
 *
 * One arm per source a fixture can author: a chord grid is the authored text
 * itself (the chord-grid mini-language), exactly what a user types; a MIDI or
 * MusicXML song is the file's bytes, exactly what a user imports.
 */
export type SongFixture =
  ChordGridSongFixture | MidiSongFixture | MusicXmlSongFixture;

interface SongFixtureBase {
  readonly id: string;
  readonly title: string;
  readonly composer: string | null;
}

export interface ChordGridSongFixture extends SongFixtureBase {
  readonly kind: "chord-grid";
  /** The grid, in the chord-grid mini-language (`apps/sonata/sources/chord-grid`). */
  readonly chordText: string;
}

export interface MidiSongFixture extends SongFixtureBase {
  readonly kind: "midi";
  /** The stored attachment's file name (`….mid`). */
  readonly fileName: string;
  /** The `.mid` file's bytes. */
  readonly bytes: Uint8Array;
}

export interface MusicXmlSongFixture extends SongFixtureBase {
  readonly kind: "musicxml";
  /** The stored attachment's file name (`….musicxml`). */
  readonly fileName: string;
  /** The score-partwise document's text. */
  readonly xml: string;
}
