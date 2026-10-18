/** One drawn onset: a tickable's start beat and its notehead's x. */
export interface OnsetPoint {
  beat: number;
  x: number;
}

/** One drawn measure: its beat span and the x span its notes are laid out in. */
export interface MeasureSpan {
  startBeat: number;
  endBeat: number;
  startX: number;
  endX: number;
}

/**
 * How far the playhead is pulled onto the noteheads (1 = exactly on each
 * onset), the rest toward a constant speed across the measure. Engraving does
 * not space notes by time — a half note gets far less room than four
 * sixteenths — so a playhead pinned to every notehead crawls through long notes
 * and dashes through short ones: go, stop, go. At one half its speed never
 * drops below half the measure's average, and it is still within half a gap of
 * the note it reaches.
 */
export const NOTE_PULL = 0.5;

const EPS = 1e-6;

/**
 * The playhead's beat→x path through one system's measures (in order), for
 * linear interpolation between consecutive points.
 *
 * Each onset beat keeps its leftmost x (voices and staves sharing a beat do
 * not share an x: a second voice's notehead is displaced, a grace group pushes
 * its principal right), clamped so x never goes back, then blended with the
 * measure's constant-speed position by {@link NOTE_PULL}. The path is strictly
 * increasing within a measure and ends at the last measure's end, so the
 * playhead always moves forward and glides to the system's closing barline.
 */
export function playheadPath(
  onsets: readonly OnsetPoint[],
  measures: readonly MeasureSpan[],
): OnsetPoint[] {
  const path: OnsetPoint[] = [];
  let floor = -Infinity;
  for (const m of measures) {
    const leftmost = new Map<number, number>();
    for (const { beat, x } of onsets) {
      if (beat < m.startBeat - EPS || beat >= m.endBeat - EPS) continue;
      const key = Math.abs(beat - m.startBeat) < EPS ? m.startBeat : beat;
      const prev = leftmost.get(key);
      leftmost.set(key, prev === undefined ? x : Math.min(prev, x));
    }
    // A measure always starts somewhere: at its first note area's edge when
    // nothing is drawn on its first beat.
    if (!leftmost.has(m.startBeat)) leftmost.set(m.startBeat, m.startX);
    const span = m.endBeat - m.startBeat;
    const steady = (beat: number) =>
      m.startX + ((m.endX - m.startX) * (beat - m.startBeat)) / span;
    for (const [beat, x] of [...leftmost].sort(([a], [b]) => a - b)) {
      floor = Math.max(floor, x);
      path.push({
        beat,
        x: NOTE_PULL * floor + (1 - NOTE_PULL) * steady(beat),
      });
    }
  }
  const last = measures.at(-1);
  if (last) path.push({ beat: last.endBeat, x: last.endX });
  return path;
}
