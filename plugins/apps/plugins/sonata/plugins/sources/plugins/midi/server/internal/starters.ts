/**
 * Bundled starter songs: public-domain piano repertoire a fresh install's
 * library opens with. The boot seed (`seed.ts`) turns each into a real MIDI
 * attachment. A starter is one of two kinds:
 *
 * - **`notes`** — defined as note arrays (`StarterTrack[]`), written to a
 *   multi-track MIDI via `@tonejs/midi`. `time` and `duration` are in
 *   **seconds**; the seed sets the track tempo to `bpm` (which only affects the
 *   MIDI's beat↔seconds header, not these absolute seconds). `midi` is the MIDI
 *   note number (C4 = 60); `velocity` is optional on the canonical 0–127 scale.
 *   Each `StarterTrack` becomes its own MIDI track, so a two-hand piece
 *   (left/right tracks) engraves as a real grand staff.
 * - **`file`** — a whole public-domain `.mid`, byte for byte (`starter-files/`,
 *   base64 text so every host bundles it: the desktop server and the browser
 *   worker host). Its provenance and licence sit beside its bytes.
 */

import { buildBachPreludeTracks } from "./bach-prelude";
import { GRIEG_TROLDHAUGEN_MID } from "./starter-files/grieg-troldhaugen";
import { MENDELSSOHN_OP85_NO1_MID } from "./starter-files/mendelssohn-op85-no1";
import { SCRIABIN_OP11_NO1_MID } from "./starter-files/scriabin-op11-no1";

export interface StarterNote {
  midi: number;
  time: number;
  duration: number;
  /** Canonical MIDI velocity (0–127). Omit to use the default. */
  velocity?: number;
}

/**
 * A sustain-pedal press, in **seconds** (like `StarterNote.time`). Written to
 * the generated MIDI as CC64 down (`down`) / up (`up`) events, so it round-trips
 * through the exact same importer path as a real `.mid` — no special-casing.
 */
export interface StarterPedalSpan {
  down: number;
  up: number;
}

export interface StarterTrack {
  /** Track name, surfaced per-track (e.g. "Left hand"). */
  name?: string;
  /** General MIDI program number (0 = Acoustic Grand Piano). */
  program?: number;
  notes: StarterNote[];
  /**
   * Optional sustain-pedal (CC64) spans for this track, in seconds. Omit for an
   * unpedalled track. A two-hand piano piece pedals both hands with the same
   * spans (one physical pedal, per-track CC64 lanes).
   */
  pedal?: readonly StarterPedalSpan[];
}

interface StarterBase {
  /** A fixed natural key in the song kind's `seed` alias namespace. */
  id: `seed-${string}`;
  title: string;
  composer: string;
}

/** A starter written from note arrays. */
export interface NotesStarter extends StarterBase {
  kind: "notes";
  bpm: number;
  /** Optional time signature [numerator, denominator]; defaults to 4/4. */
  timeSig?: [numerator: number, denominator: number];
  tracks: StarterTrack[];
}

/** A starter shipped as a whole `.mid` file. */
export interface FileStarter extends StarterBase {
  kind: "file";
  /** The `.mid` bytes, base64. */
  base64: string;
}

export type Starter = NotesStarter | FileStarter;

// Tempo chosen to sit in the piece's customary performance range.
const BACH_BPM = 69;

export const STARTERS: readonly Starter[] = [
  {
    // J.S. Bach — Prelude in C major, BWV 846 (Well-Tempered Clavier, Book I).
    // Every bar is the same 16th-note broken-chord figuration over that bar's
    // harmony (see bach-prelude.ts): 32 measures of the canonical progression
    // plus a final tonic chord resolving the bar-32 dominant. Two hands →
    // grand staff.
    kind: "notes",
    id: "seed-bach-prelude-c-major",
    title: "Prelude in C major, BWV 846",
    composer: "J.S. Bach",
    bpm: BACH_BPM,
    timeSig: [4, 4],
    tracks: buildBachPreludeTracks(BACH_BPM),
  },
  {
    kind: "file",
    id: "seed-mendelssohn-op85-no1",
    title: "Song without Words, Op. 85 No. 1",
    composer: "Mendelssohn",
    base64: MENDELSSOHN_OP85_NO1_MID,
  },
  {
    kind: "file",
    id: "seed-scriabin-op11-no1",
    title: "Prelude in C major, Op. 11 No. 1",
    composer: "Scriabin",
    base64: SCRIABIN_OP11_NO1_MID,
  },
  {
    kind: "file",
    id: "seed-grieg-troldhaugen",
    title: "Wedding Day at Troldhaugen, Op. 65 No. 6",
    composer: "Grieg",
    base64: GRIEG_TROLDHAUGEN_MID,
  },
];
