/**
 * The A–B loop cycle's pure geometry — the one place the playback timeline
 * (`timeline.ts`) and the displays get "what plays after B" from. The types
 * (`LoopCycle`, `PlayPosition`) live in `types.ts` beside the contracts that
 * carry them.
 */
import type { LoopCycle, PlayPosition, Score } from "./types";

/** A plain position on the song's own pass at `beat` (no rest, no repeat). */
export function songPosition(beat: number): PlayPosition {
  return { beat, rest: 0, repeat: false };
}

/** Value equality of two positions. */
export function samePosition(a: PlayPosition, b: PlayPosition): boolean {
  return a.beat === b.beat && a.rest === b.rest && a.repeat === b.repeat;
}

/** The first beat of a repeat iteration: the rest's start (`A - rest`). */
export function cycleStart(cycle: LoopCycle): number {
  return cycle.start - cycle.rest;
}

/** One iteration's length in beats: rest + body. */
export function cycleBeats(cycle: LoopCycle): number {
  return cycle.end - cycleStart(cycle);
}

/**
 * Length in quarter-note beats of the bar in force at `beat` (`n × 4/d` of the
 * time signature active there; 4/4 when none is declared). A degenerate
 * non-positive meter reads as a 4-beat bar so a caller always gets a real,
 * finite bar. The loop's rest is one such bar at A.
 */
export function barBeatsAt(score: Score, beat: number): number {
  let numerator = 4;
  let denominator = 4;
  for (const sig of score.timeSigMap) {
    if (sig.beat > beat) break;
    numerator = sig.numerator;
    denominator = sig.denominator;
  }
  const len = numerator * (4 / denominator);
  return len > 0 ? len : 4;
}
