import type { BeatSpan } from "./slots";

/**
 * The scrubber's pure geometry: how chapters become rail segments, how label
 * items fold into same-beat groups, and where a hover snaps. No React, no DOM —
 * the component reads these and paints; the tests pin them down.
 */

/** Two beats closer than this are the same position (float noise). */
const SAME_BEAT = 1e-6;

/** One rail segment ("chapter"): a beat span and its fractions of the track. */
export type RailSegment = BeatSpan & {
  /** [0,1] position of `start` / `end` along the track. */
  from: number;
  to: number;
  /** Whether a gap separates this segment from a neighbour on that side —
   *  never at the outer ends of the rail. */
  gapBefore: boolean;
  gapAfter: boolean;
};

/**
 * Split `[0, endBeat]` into rail segments from a contributor's chapters:
 * clamped to the song, sorted, empty spans dropped. No usable chapter → one
 * segment spanning the whole song, so the rail always exists.
 */
export function railSegments(
  chapters: readonly BeatSpan[],
  endBeat: number,
): RailSegment[] {
  const spans = chapters
    .map((c) => ({
      start: Math.max(0, Math.min(endBeat, c.start)),
      end: Math.max(0, Math.min(endBeat, c.end)),
    }))
    .filter((c) => c.end - c.start > SAME_BEAT)
    .sort((a, b) => a.start - b.start);
  const used = spans.length > 0 ? spans : [{ start: 0, end: endBeat }];
  const frac = (b: number) => (endBeat > 0 ? b / endBeat : 0);
  return used.map((s, i) => ({
    ...s,
    from: frac(s.start),
    to: frac(s.end),
    gapBefore: i > 0,
    gapAfter: i < used.length - 1,
  }));
}

/** How far through `seg` the playhead at `beat` is, in [0,1] — its fill. */
export function segmentFill(seg: BeatSpan, beat: number): number {
  const len = seg.end - seg.start;
  if (len <= 0) return beat >= seg.end ? 1 : 0;
  return Math.max(0, Math.min(1, (beat - seg.start) / len));
}

/** Index of the segment containing `beat` (the last one holds `endBeat`
 *  itself), or -1 when it falls in none (e.g. between sparse chapters). */
export function segmentAt(segs: readonly BeatSpan[], beat: number): number {
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    const last = i === segs.length - 1;
    if (beat >= s.start && (beat < s.end || (last && beat <= s.end))) return i;
  }
  return -1;
}

/** One item fed to the label lane: its anchor, its contributor's `order`, and
 *  whatever the renderer needs (opaque here). */
export type LaneEntry<T> = { beat: number; order: number; item: T };

/** A same-beat group of the label lane, laid out over `[beat, end)`. */
export type LaneGroup<T> = { beat: number; end: number; items: T[] };

/**
 * Fold label items into same-beat groups: sorted by beat, then contributor
 * `order`, then input order (stable) — so a section's name and a key that
 * changes on its downbeat land in one group, name first. Each group spans up
 * to the next group's beat; the last runs to `endBeat`. Items outside
 * `[0, endBeat)` are dropped (they would have no room on the lane).
 */
export function groupLabels<T>(
  entries: readonly LaneEntry<T>[],
  endBeat: number,
): LaneGroup<T>[] {
  const sorted = entries
    .map((e, i) => ({ ...e, i }))
    .filter((e) => e.beat >= 0 && e.beat < endBeat)
    .sort((a, b) => a.beat - b.beat || a.order - b.order || a.i - b.i);
  const groups: LaneGroup<T>[] = [];
  for (const e of sorted) {
    const prev = groups.at(-1);
    if (prev && e.beat - prev.beat < SAME_BEAT) prev.items.push(e.item);
    else groups.push({ beat: e.beat, end: endBeat, items: [e.item] });
  }
  for (let i = 0; i < groups.length - 1; i++) {
    groups[i]!.end = groups[i + 1]!.beat;
  }
  return groups;
}

/** Hover snap radius, in CSS px. */
export const SNAP_PX = 7;

/**
 * The hover position, snapped onto the nearest of `snapBeats` when it lies
 * within `SNAP_PX` on screen (`pxPerBeat` converts). Preview only — a seek is
 * never snapped.
 */
export function snapBeat(
  beat: number,
  snapBeats: readonly number[],
  pxPerBeat: number,
): { beat: number; snapped: boolean } {
  let best: number | null = null;
  let bestPx = SNAP_PX;
  for (const s of snapBeats) {
    const px = Math.abs(s - beat) * pxPerBeat;
    if (px < bestPx) {
      bestPx = px;
      best = s;
    }
  }
  return best === null
    ? { beat, snapped: false }
    : { beat: best, snapped: true };
}
