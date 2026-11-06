import type { SongFixture } from "@plugins/apps/plugins/sonata/plugins/fixtures/core";

// The demo's Sonata library on top of what a fresh install has (the MIDI
// starters, which the MIDI source seeds itself): two chord grids Demo
// practises — the songs the practice-timer story counts. The format and its
// writer are Sonata's (`apps/sonata/fixtures`); which songs the demo shows is
// the demo's.

/** A seeded song id: stamped and carrying `demo`, like every demo id. */
const songId = (n: number) =>
  `song-1792900000-demo${String(n).padStart(2, "0")}`;

export const DEMO_SONGS: readonly SongFixture[] = [
  {
    kind: "chord-grid",
    id: songId(1),
    title: "ii–V–I warm-up",
    composer: "Demo",
    chordText:
      "key: C\n; C major\nDm7 G7 Cmaj7 Cmaj7\n; F major\nGm7 C7 Fmaj7 Fmaj7\n; Bb major\nCm7 F7 Bbmaj7 Bbmaj7\n; Back home\nDm7 G7 Cmaj7 .",
  },
  {
    kind: "chord-grid",
    id: songId(2),
    title: "My first waltz",
    composer: "Demo",
    chordText: "key: G\n; A\nG D Em C\nG D C D7\n; B\nEm Bm C G\nAm7 D7 G .",
  },
];

/** The song the demo opens in Sonata. */
export const DEMO_SONG_ID = songId(1);
