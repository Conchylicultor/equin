import {
  bars,
  scoreEndBeat,
  type Score,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import type { LoopRange } from "@plugins/apps/plugins/sonata/plugins/session/web";

/**
 * Pure A–B-loop helpers shared by the toolbar toggle, the keyboard shortcuts,
 * and the draggable region — so every entry point agrees on one definition of
 * "snap", "default range", and "toggle" (one name per concept). No React here;
 * the components feed in the live `loop`/`score`.
 */

/**
 * The default loop region for a one-tap "loop": the whole song, `[0, end]`.
 * Drag A/B (or `[`/`]`) to narrow it to a passage. Returns `null` on an empty
 * score.
 */
export function defaultLoop(score: Score): LoopRange | null {
  const end = scoreEndBeat(score);
  if (end <= 0) return null;
  return { start: 0, end, enabled: true };
}

/**
 * Snap a beat to the nearest loop boundary: a bar line (`bars(score)`) or the
 * song's end. The end is a target in its own right because `bars()` lists bar
 * STARTS only — a song whose last bar is cut short (or simply ends mid-bar)
 * has no bar line at its end, so without it a loop's `B` could never reach the
 * end of the song. Callers bypass this when Alt is held, for fine off-grid
 * placement.
 */
export function snapToBars(beat: number, score: Score): number {
  const targets = [...bars(score).map((b) => b.startBeat), scoreEndBeat(score)];
  let nearest = targets[0]!;
  for (const t of targets) {
    if (Math.abs(beat - t) < Math.abs(beat - nearest)) nearest = t;
  }
  return nearest;
}

/**
 * Toggle the practice loop: if a region already exists, flip its `enabled`
 * (keeping the bounds visible either way); otherwise create the default region
 * — the whole song, which always contains the playhead, so playback carries on
 * where it is.
 */
export function toggleLoop({
  loop,
  setLoop,
  score,
}: {
  loop: LoopRange | null;
  setLoop: (next: LoopRange | null) => void;
  score: Score;
}): void {
  if (loop) {
    setLoop({ ...loop, enabled: !loop.enabled });
    return;
  }
  const next = defaultLoop(score);
  if (!next) return;
  setLoop(next);
}
