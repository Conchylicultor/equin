/**
 * Swing — the off-beat delay that turns straight notation into a swung
 * performance.
 *
 * Like sustain pedal (`pedal.ts`), swing is an **audio-only** transform: the
 * Score's notes stay straight (what the staff engraves and the roll draws), and
 * the playback boundary (`audio/engine`'s `startScheduling`) plays
 * `swingScore(score)` instead. One place applies it, so every scheduled sound —
 * the song's notes and the metronome's clicks alike — swings the same way.
 *
 * ## Model
 *
 * Time is cut into PAIRS of the swung unit (a quarter note for swung eighths,
 * an eighth for swung sixteenths), phased on the first full bar (after the
 * pickup). Inside each pair a piecewise-linear warp moves the straight midpoint
 * to `ratio / (1 + ratio)` of the pair, stretching the first half and squeezing
 * the second. Pair boundaries are fixed points, so on-beat onsets never move,
 * and the warp is monotonic, so note order — and every note's end — follows:
 * a straight eighth pair at ratio 2 plays as a triplet quarter + eighth.
 *
 * Everything is in beats, so it is tempo-invariant (a `retime` keeps it).
 */
import type { Score, Swing } from "./types";

/** The length in quarter-note beats of one swung pair of `unit` notes. */
function pairBeats(unit: Swing["unit"]): number {
  return unit === 8 ? 1 : 0.5;
}

/**
 * The beat at which a straight `beat` is played under `swing`, the pair grid
 * phased on `origin` (the first full bar's start beat).
 */
export function swingBeat(beat: number, swing: Swing, origin = 0): number {
  if (!(swing.ratio > 0)) {
    throw new Error(`[score] swing ratio must be positive, got ${swing.ratio}`);
  }
  const pair = pairBeats(swing.unit);
  const rel = beat - origin;
  const pairStart = Math.floor(rel / pair) * pair;
  const x = (rel - pairStart) / pair; // [0, 1) position inside the pair
  const mid = swing.ratio / (1 + swing.ratio); // where the straight 0.5 lands
  const warped = x < 0.5 ? x * 2 * mid : mid + (x - 0.5) * 2 * (1 - mid);
  return origin + pairStart + warped * pair;
}

/**
 * The Score as PERFORMED under its `meta.swing`: every note's onset and end and
 * every pedal change moved by {@link swingBeat}. Returns `score` itself (same
 * identity) when it has no swing, so a straight song costs nothing.
 */
export function swingScore(score: Score): Score {
  const swing = score.meta.swing;
  if (!swing || swing.ratio === 1) return score;
  const origin = score.meta.pickupBeats ?? 0;
  const at = (beat: number): number => swingBeat(beat, swing, origin);
  return {
    ...score,
    notes: score.notes.map((n) => {
      const start = at(n.start);
      return { ...n, start, duration: at(n.start + n.duration) - start };
    }),
    pedalEvents: score.pedalEvents.map((p) => ({ ...p, beat: at(p.beat) })),
  };
}
