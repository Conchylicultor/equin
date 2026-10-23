import {
  bars as barStarts,
  leadInBeats,
  type Score,
} from "@plugins/apps/plugins/sonata/plugins/score/core";

/**
 * The slice of a song a cover draws: a beat range and the pitch range shown
 * across it.
 *
 * `lowPitch` is always a C and `highPitch` always a B, at least two octaves
 * apart — whole octaves, so the keyboard strip under a roll cover starts and
 * ends flush on a natural and its C/F rules fall where a pianist expects.
 */
export interface CoverWindow {
  /** First beat shown (inclusive), in quarter-note beats. */
  startBeat: number;
  /** Last beat shown (exclusive). */
  endBeat: number;
  /** Lowest MIDI pitch shown — a C. */
  lowPitch: number;
  /** Highest MIDI pitch shown — a B. */
  highPitch: number;
}

/** Fewest octaves a window shows, so a one-note melody is not drawn as a wall. */
const MIN_OCTAVES = 2;

/** The octave a score with no notes is centred on: C3..B4, around middle C. */
const EMPTY_LOW = 48;

/**
 * The `bars`-long stretch of `score` where the most notes START — the busiest
 * passage, which is what reads as "this song" on a small cover (an intro of
 * held chords or a bar of silence would not).
 *
 * The bar length is the song's OPENING bar (its first time signature,
 * `leadInBeats`), and candidate windows start on every bar line `bars(score)`
 * derives, so the window never begins mid-bar. Ties go to the earliest window.
 * The pitch range covers every note sounding in the window (not just the ones
 * starting there), padded out to whole octaves, at least {@link MIN_OCTAVES}.
 *
 * Pure and deterministic. A score with no notes gets the first `bars` bars
 * over two octaves around middle C — an honest empty window, not a guess.
 */
export function busiestWindow(score: Score, bars = 4): CoverWindow {
  const length = leadInBeats(score) * bars;
  const starts = score.notes.map((n) => n.start).sort((a, b) => a - b);

  let startBeat = 0;
  if (starts.length > 0) {
    // Two pointers over the sorted note starts: for each candidate bar line,
    // count the starts in [bar, bar + length).
    const candidates = barStarts(score).map((b) => b.startBeat);
    if (candidates.length === 0) candidates.push(0);
    let best = -1;
    let lo = 0;
    let hi = 0;
    for (const s of candidates) {
      while (lo < starts.length && starts[lo]! < s) lo++;
      if (hi < lo) hi = lo;
      while (hi < starts.length && starts[hi]! < s + length) hi++;
      const count = hi - lo;
      if (count > best) {
        best = count;
        startBeat = s;
      }
    }
  }
  const endBeat = startBeat + length;

  let low = Infinity;
  let high = -Infinity;
  for (const n of score.notes) {
    if (n.start >= endBeat || n.start + n.duration <= startBeat) continue;
    low = Math.min(low, n.pitch);
    high = Math.max(high, n.pitch);
  }
  if (low > high) {
    low = EMPTY_LOW;
    high = EMPTY_LOW + 12 * MIN_OCTAVES - 1;
  }

  let lowPitch = Math.floor(low / 12) * 12;
  let highPitch = Math.floor(high / 12) * 12 + 11;
  // Widen to the minimum, alternating above then below so the music stays
  // centred, clamped to the MIDI range.
  let above = true;
  while ((highPitch + 1 - lowPitch) / 12 < MIN_OCTAVES) {
    if (above && highPitch + 12 <= 127) highPitch += 12;
    else if (lowPitch - 12 >= 0) lowPitch -= 12;
    else highPitch += 12;
    above = !above;
  }
  return { startBeat, endBeat, lowPitch, highPitch };
}
