import {
  parseChordToken,
  type ChordToken,
} from "@plugins/apps/plugins/chord/plugins/song-index/core";
import {
  rootReading,
  type ScaleDegree,
} from "@plugins/music/plugins/chord-box/core";

// ── How a chord's root reads against the tonic ───────────────────────────────
//
// Tokens are relative to the tonic, so the reading comes straight off the
// root: no key is needed (the tonic is pitch class 0). It is the one reading
// every chord surface uses (`music/chord-box`'s rootReading): the major scale
// in every mode, so a token has one numeral and one colour in a major song and
// a minor one alike.

export type ChordFunction = "tonic" | "subdominant" | "dominant";

/**
 * The function family of each degree, as the mockup groups them: I, iii, vi
 * are tonic; ii, IV subdominant; V, vii° dominant.
 */
const FUNCTION_OF_DEGREE: readonly ChordFunction[] = [
  "tonic",
  "subdominant",
  "tonic",
  "subdominant",
  "dominant",
  "tonic",
  "dominant",
];

/** The numeral's number, 0 (I) to 6 (VII) — what paints the chord: ♭VII is VII's colour. Every token has one. */
export function chordDegree(token: ChordToken): ScaleDegree {
  return rootReading(parseChordToken(token).root, 0).degree;
}

/** The degree's function family; `null` for a chromatic root (♭VII, ♭III, ♯IV, …), whose function the family table does not say. */
export function chordFunction(token: ChordToken): ChordFunction | null {
  const { degree, accidental } = rootReading(parseChordToken(token).root, 0);
  if (accidental !== 0) return null;
  const fn = FUNCTION_OF_DEGREE[degree];
  if (fn === undefined) throw new Error(`No function for degree ${degree}`);
  return fn;
}
