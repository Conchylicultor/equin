/** One drawn onset: a tickable's start beat and its notehead's x. */
export interface OnsetPoint {
  beat: number;
  x: number;
}

/**
 * The playhead's beat→x path through one system, from every drawn onset plus
 * the system's end (its last barline at the beat the next system starts).
 *
 * Voices and staves sharing a beat do not share an x (a second voice's
 * notehead is displaced, a grace group pushes its principal right), so the raw
 * onsets, sorted by beat, would step the playhead back and forth. Each beat
 * keeps its leftmost x, and x never decreases along the path: interpolating
 * between consecutive points then moves the playhead forward only, ending
 * on the barline instead of stopping on the last note.
 */
export function playheadPath(
  onsets: readonly OnsetPoint[],
  end: OnsetPoint,
): OnsetPoint[] {
  const byBeat = new Map<number, number>();
  for (const { beat, x } of onsets) {
    if (beat >= end.beat) continue;
    const prev = byBeat.get(beat);
    byBeat.set(beat, prev === undefined ? x : Math.min(prev, x));
  }
  const path: OnsetPoint[] = [...byBeat]
    .sort(([a], [b]) => a - b)
    .map(([beat, x]) => ({ beat, x }));
  path.push(end);
  for (let i = 1; i < path.length; i++) {
    if (path[i]!.x < path[i - 1]!.x)
      path[i] = { ...path[i]!, x: path[i - 1]!.x };
  }
  return path;
}
