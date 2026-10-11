import type { ChordToken } from "./token";

// ── Repeats: a loop that replays itself ──────────────────────────────────────

/** One chord of a loop: where it sounds, in beats from the loop's start, and what. */
export type LoopChord = { start: number; end: number; token: ChordToken };

/** Tolerance for comparing beats: absorbs floating-point drift in old documents. */
const BEAT_EPS = 1e-6;

/**
 * The span a loop of `length` beats repeats with: the shortest `length / k`
 * (k ≥ 2 passes) such that every pass replays the first — the same chords, at
 * the same offsets, for the same beats. `length` itself when the loop never
 * repeats. `chords` must be in beat order.
 *
 * I–V–vi–IV played twice has period `length / 2`; one held chord, which
 * never restarts, has period `length`.
 */
export function repeatPeriod(
  chords: readonly LoopChord[],
  length: number,
): number {
  for (let passes = chords.length; passes >= 2; passes--) {
    if (chords.length % passes !== 0) continue;
    const period = length / passes;
    const perPass = chords.length / passes;
    const replays = chords.every((chord, i) => {
      const echo = chords[i + perPass];
      return (
        echo === undefined ||
        (echo.token === chord.token &&
          Math.abs(echo.start - chord.start - period) <= BEAT_EPS &&
          Math.abs(echo.end - chord.end - period) <= BEAT_EPS)
      );
    });
    if (replays) return period;
  }
  return length;
}
