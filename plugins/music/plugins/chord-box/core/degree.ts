// ── Where a chord's root sits in its key's scale ─────────────────────────────

/** A key's mode: which scale its degrees are read from. */
export type KeyMode = "major" | "minor";

/**
 * Semitones above the tonic of each scale degree, 1 to 7: the major scale, and
 * the natural minor for a minor key (so a minor key's III, VI and VII are
 * diatonic, not outside the scale).
 */
const SCALE: Record<KeyMode, readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
};

/** A scale degree: 0 (the tonic) to 6 (the seventh). */
export type ScaleDegree = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * The scale degree of `rootPc` in the `mode` key whose tonic is `tonicPc` (both
 * pitch classes, any integer — read mod 12): 0 (the tonic) to 6, or `null` for
 * a root outside the scale (♭VII in major, ♯IV, …). The tonic is degree 0 in
 * either mode, so home always wears the same colour.
 */
export function scaleDegree(
  rootPc: number,
  tonicPc: number,
  mode: KeyMode,
): ScaleDegree | null {
  const interval = (((rootPc - tonicPc) % 12) + 12) % 12;
  const degree = SCALE[mode].indexOf(interval);
  return degree === -1 ? null : (degree as ScaleDegree);
}
