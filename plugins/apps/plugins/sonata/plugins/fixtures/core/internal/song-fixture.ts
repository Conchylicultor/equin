/**
 * Some songs, in Sonata's own terms — what a demo or a test puts in a library.
 * Ids are the caller's (a `song-…` id the caller mints, e.g. one carrying
 * `demo`), so the caller can open or assert a song by id.
 *
 * One arm per source a fixture can author; a chord grid is the authored text
 * itself (the chord-grid mini-language), exactly what a user types.
 */
export type SongFixture = {
  readonly kind: "chord-grid";
  readonly id: string;
  readonly title: string;
  readonly composer: string | null;
  /** The grid, in the chord-grid mini-language (`apps/sonata/sources/chord-grid`). */
  readonly chordText: string;
};
