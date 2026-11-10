import type { SongFixture } from "@plugins/apps/plugins/sonata/plugins/fixtures/core";

// The demo's Sonata library on top of what a fresh install has (the MIDI
// starters, which the MIDI source seeds itself): the chord grids Demo is
// learning — two songs with a verse and a chorus, and the ii–V–I warm-up the
// practice-timer agent checks its timer on (its transcript links the song by
// id, `./transcripts`). The format and its writer are Sonata's
// (`apps/sonata/fixtures`); which songs the demo shows is the demo's.

/** A seeded song id: stamped and carrying `demo`, like every demo id. */
const songId = (n: number) =>
  `song-1792900000-demo${String(n).padStart(2, "0")}`;

/** The warm-up the practice-timer conversation links (and the song the demo opens in Sonata). */
export const DEMO_SONG_ID = songId(1);

export const DEMO_SONGS: readonly SongFixture[] = [
  {
    kind: "chord-grid",
    id: DEMO_SONG_ID,
    title: "ii–V–I warm-up",
    composer: "Demo",
    chordText:
      "key: C\n; C major\nDm7 G7 Cmaj7 Cmaj7\n; F major\nGm7 C7 Fmaj7 Fmaj7\n; Bb major\nCm7 F7 Bbmaj7 Bbmaj7\n; Back home\nDm7 G7 Cmaj7 .",
  },
  {
    kind: "chord-grid",
    id: songId(2),
    title: "Late night",
    composer: "Demo",
    chordText:
      "key: C\n; Verse\nCmaj7 Am7 Fmaj7 G\nCmaj7 Am7 Dm7 G7\n; Chorus\nFmaj7 G Em7 Am7\nDm7 G7 Cmaj7 .",
  },
  {
    kind: "chord-grid",
    id: songId(3),
    title: "Rain on the window",
    composer: "Demo",
    chordText:
      "key: Am\n; Verse\nAm9 Fmaj7 C G\nAm9 Fmaj7 (Dm7 E7) Am\n; Chorus\nF G Em Am\nDm7 G Cmaj7 E7",
  },
];
