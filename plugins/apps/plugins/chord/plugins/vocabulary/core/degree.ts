import {
  parseChordToken,
  type ChordToken,
} from "@plugins/apps/plugins/chord/plugins/song-index/core";
import {
  scaleDegree,
  type ScaleDegree,
} from "@plugins/music/plugins/chord-box/core";

// ── Where a chord's root sits in the major scale ─────────────────────────────
//
// Tokens are relative to the tonic, so the degree is read straight off the
// root: no key is needed (the tonic is pitch class 0). A token carries no
// mode — one token is one chord you know, in a major song or a minor one — so
// it is always read against the major scale: ♭III, ♭VI and ♭VII stay outside
// it here, where Sonata (which knows each song's mode) reads a minor key's own
// scale.

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

/** The root's major-scale degree, 0 (I) to 6 (vii); `null` for a root outside the scale (♭VII, ♭III, …). */
export function chordDegree(token: ChordToken): ScaleDegree | null {
  return scaleDegree(parseChordToken(token).root, 0, "major");
}

/** The degree's function family; `null` for a root outside the major scale. */
export function chordFunction(token: ChordToken): ChordFunction | null {
  const degree = chordDegree(token);
  if (degree === null) return null;
  const fn = FUNCTION_OF_DEGREE[degree];
  if (fn === undefined) throw new Error(`No function for degree ${degree}`);
  return fn;
}
