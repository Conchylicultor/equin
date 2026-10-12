// ── How a chord's root reads against its tonic ───────────────────────────────
//
// ONE reading for every key and every app: the root's interval above the
// tonic, read against the MAJOR scale whatever the song's mode, with the
// conventional pop/jazz spelling of a chromatic root (♭II ♭III ♯IV ♭VI ♭VII).
// So a chord over a tonic has one numeral and one colour everywhere — a C over
// an A tonic is ♭III in a major song and in a minor one — and B minor's chords
// read i ii° ♭III iv v ♭VI ♭VII.

/** A numeral's number, 0 (I) to 6 (VII) — the chord colour's index. */
export type ScaleDegree = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** A chromatic root's accidental: -1 ♭, +1 ♯, 0 on the major scale. */
export type Accidental = -1 | 0 | 1;

/** A root read against its tonic: the numeral's number and its accidental. */
export interface RootReading {
  degree: ScaleDegree;
  accidental: Accidental;
}

/** Semitones above the tonic → its reading. */
const READINGS: readonly RootReading[] = [
  { degree: 0, accidental: 0 }, //  0  I
  { degree: 1, accidental: -1 }, //  1  ♭II
  { degree: 1, accidental: 0 }, //  2  II
  { degree: 2, accidental: -1 }, //  3  ♭III
  { degree: 2, accidental: 0 }, //  4  III
  { degree: 3, accidental: 0 }, //  5  IV
  { degree: 3, accidental: 1 }, //  6  ♯IV
  { degree: 4, accidental: 0 }, //  7  V
  { degree: 5, accidental: -1 }, //  8  ♭VI
  { degree: 5, accidental: 0 }, //  9  VI
  { degree: 6, accidental: -1 }, // 10  ♭VII
  { degree: 6, accidental: 0 }, // 11  VII
];

/** Semitones above the tonic of each major-scale degree, I to VII. */
export const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11] as const;

/**
 * How `rootPc` reads in a key whose tonic is `tonicPc` (both pitch classes,
 * any integer — read mod 12). Every root has a reading: the chord box paints
 * `degree`, and a numeral writes `accidental` before it (♭VII is VII's colour).
 */
export function rootReading(rootPc: number, tonicPc: number): RootReading {
  const interval = (((rootPc - tonicPc) % 12) + 12) % 12;
  const reading = READINGS[interval];
  if (reading === undefined) throw new Error(`No reading for ${interval}`);
  return reading;
}
