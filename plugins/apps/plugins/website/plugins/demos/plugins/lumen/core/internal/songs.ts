import type { SongFixture } from "@plugins/apps/plugins/sonata/plugins/fixtures/core";

// The demo's Sonata library on top of what a fresh install has (the MIDI
// starters, which the MIDI source seeds itself): two chord grids the Lumen
// team wrote. The format and its writer are Sonata's
// (`apps/sonata/fixtures`); which songs the demo shows is the demo's.

/** A seeded song id: stamped and carrying `demo`, like every demo id. */
const songId = (n: number) =>
  `song-1792900000-demo${String(n).padStart(2, "0")}`;

export const DEMO_SONGS: readonly SongFixture[] = [
  {
    kind: "chord-grid",
    id: songId(1),
    title: "Lumen theme",
    composer: "The Lumen team",
    chordText:
      "; Verse\nCmaj7 Am7 Fmaj7 G\nCmaj7 Am7 Dm7 G7\n; Chorus\nFmaj7 G Em7 Am7\nDm7 G7 Cmaj7 .",
  },
  {
    kind: "chord-grid",
    id: songId(2),
    title: "Night mode",
    composer: "The Lumen team",
    chordText: "key: Am\n; Verse\nAm9 Fmaj7 C G\nAm9 Fmaj7 (Dm7 E7) Am",
  },
];

/** The song the demo opens in Sonata. */
export const DEMO_SONG_ID = songId(1);
