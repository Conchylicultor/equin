/**
 * The A–B loop cycle's pure maths — the one place the transport's time-fold,
 * the schedulers and the displays get "what plays after B" from. The types
 * (`LoopCycle`, `PlayPosition`) live in `types.ts` beside the contracts that
 * carry them.
 */
import { foldLoopTime, type LoopWindowSec } from "./loop-fold";
import type { TempoIndex } from "./tempo-index";
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

/** The cycle's iteration window in score-seconds, for {@link foldLoopTime}. */
export function cycleWindowSec(
  cycle: LoopCycle,
  tempo: TempoIndex,
): LoopWindowSec {
  return {
    startSec: tempo.beatToSeconds(cycleStart(cycle)),
    endSec: tempo.beatToSeconds(cycle.end),
  };
}

/**
 * The play position at a monotonic elapsed score-time `rawSec` (seconds,
 * increasing forever from the transport's anchor; see {@link timeOfPosition}).
 * With no cycle this is the song position at `rawSec`. With one, the time is
 * folded into the cycle's iterations ({@link foldLoopTime}) and a folded time
 * inside the rest reads as A with the rest still to go. `iter` is the fold's
 * zero-based iteration (0 = the first pass), so a caller can flag a wrap.
 */
export function positionAtTime(
  rawSec: number,
  cycle: LoopCycle | null,
  tempo: TempoIndex,
): { position: PlayPosition; iter: number } {
  if (!cycle) {
    return { position: songPosition(tempo.secondsToBeat(rawSec)), iter: 0 };
  }
  const folded = foldLoopTime(rawSec, cycleWindowSec(cycle, tempo));
  const beat = tempo.secondsToBeat(folded.sec);
  const repeat = folded.iter >= 1;
  if (repeat && beat < cycle.start) {
    return {
      position: { beat: cycle.start, rest: cycle.start - beat, repeat },
      iter: folded.iter,
    };
  }
  return { position: { beat, rest: 0, repeat }, iter: folded.iter };
}

/**
 * The elapsed score-time a transport anchored at `position` starts from — the
 * inverse of {@link positionAtTime} for the anchor. A repeat position is placed
 * in the fold's first repeat iteration (one cycle past its song time), so a
 * transport paused mid-rest or mid-repeat resumes there instead of replaying
 * the song before A. A position the cycle cannot hold (no cycle, or one whose
 * bounds moved away from it) is a plain song position at `beat`.
 */
export function timeOfPosition(
  position: PlayPosition,
  cycle: LoopCycle | null,
  tempo: TempoIndex,
): number {
  if (!cycle || !position.repeat) return tempo.beatToSeconds(position.beat);
  const at = position.beat - position.rest;
  if (at < cycleStart(cycle) || at >= cycle.end) {
    return tempo.beatToSeconds(position.beat);
  }
  const win = cycleWindowSec(cycle, tempo);
  return tempo.beatToSeconds(at) + (win.endSec - win.startSec);
}
