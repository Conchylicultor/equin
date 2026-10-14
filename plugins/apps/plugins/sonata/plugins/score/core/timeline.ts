import { cycleBeats, cycleStart, songPosition } from "./loop-cycle";
import type { TempoIndex } from "./tempo-index";
import type { LoopCycle, PlayPosition } from "./types";

/**
 * The beat sequence a playback walks, starting at score beat `origin`: the
 * **head** `[origin, cycle.end)` (or everything from `origin` with no cycle),
 * then the cycle's iteration `[A − rest, B)` repeated forever. Tempo-invariant
 * — a tempo change keeps the path, a seek or a loop edit replaces it.
 *
 * `repeat` says the head is itself a repeat pass (a playback resumed inside a
 * rest or a repeat of the loop): its beats before A are the rest, not the
 * song. Otherwise the head is the song's own pass, which plays the real bar
 * the rest replaces on a repeat.
 */
export interface PlaybackPath {
  readonly origin: number;
  readonly repeat: boolean;
  readonly cycle: LoopCycle | null;
}

/**
 * THE mapping between clock time and the music, shared by everything that
 * follows playback: the visual cursor reads `positionAt(now)`, every audio
 * scheduler places a note at `timeAt(c)`. Because there is one mapping, the
 * cursor and the sound cannot disagree.
 *
 * Positions are a **path coordinate** `c`: beats walked along the path since
 * its origin, increasing forever (head beats, then cycle iterations laid end
 * to end, each rest included as real time). `c` is tempo-invariant, so a
 * note's identity on the path survives a tempo change; only `timeAt` moves.
 *
 * Immutable: a change (tempo, resync, clock swap) derives a new timeline from
 * this one at an instant, so the position at that instant is carried over
 * exactly — never re-read from something sampled earlier.
 */
export interface PlaybackTimeline {
  readonly path: PlaybackPath;
  /** The playing (tempo-scaled) beat↔seconds index. */
  readonly tempo: TempoIndex;
  /** Path length of the head, in beats (`Infinity` with no cycle). */
  readonly headBeats: number;
  /** Path length of one cycle iteration (rest + body), in beats (0 with no cycle). */
  readonly loopBeats: number;
  /** Clock seconds at which path coordinate `c` sounds. */
  timeAt(c: number): number;
  /** Path coordinate sounding at clock seconds `t` (inverse of `timeAt`). */
  cAt(t: number): number;
  /** Score beat walked at path coordinate `c`, iterations folded (a rest's beats read as the bar before A). */
  beatOf(c: number): number;
  /** The play position at path coordinate `c` (a rest reads as A with the rest still to go). */
  positionOf(c: number): PlayPosition;
  /** The play position at clock seconds `t`. */
  positionAt(t: number): PlayPosition;
  /** 0 in the head, then the 1-based cycle iteration `c` is in. */
  iterationOf(c: number): number;
  /** Path coordinate of score beat `beat` (in `[A − rest, B)`) in iteration `iter` (≥ 1). */
  loopC(iter: number, beat: number): number;
}

/**
 * Start playback at `from` at clock time `t`. A repeat position the cycle
 * holds resumes inside that repeat (a rest keeps its remaining silence); any
 * other position plays the song from its beat. A start at or past B begins a
 * repeat (its rest first), since the loop wraps at once.
 */
export function startTimeline(
  from: PlayPosition,
  cycle: LoopCycle | null,
  tempo: TempoIndex,
  t: number,
): PlaybackTimeline {
  return makeTimeline(pathFrom(from, cycle), tempo, t, 0);
}

function pathFrom(from: PlayPosition, cycle: LoopCycle | null): PlaybackPath {
  if (!cycle) return { origin: from.beat, repeat: false, cycle };
  if (from.repeat) {
    const at = from.beat - from.rest;
    if (at >= cycleStart(cycle) && at < cycle.end) {
      return { origin: at, repeat: true, cycle };
    }
  }
  if (from.beat >= cycle.end) {
    return { origin: cycleStart(cycle), repeat: true, cycle };
  }
  return { origin: from.beat, repeat: false, cycle };
}

/**
 * The same path under a new tempo from clock time `t` on: what sounds at `t`
 * keeps sounding at `t`, everything after it is re-timed.
 */
export function retempoTimeline(
  tl: PlaybackTimeline,
  tempo: TempoIndex,
  t: number,
): PlaybackTimeline {
  return makeTimeline(tl.path, tempo, t, tl.cAt(t));
}

/**
 * The same path and tempo, re-anchored so score `beat` sounds at clock time
 * `t` — a position correction (an external medium the playback follows
 * slipped). Inside the cycle, `beat` lands in the iteration nearest the
 * current one.
 */
export function resyncTimeline(
  tl: PlaybackTimeline,
  beat: number,
  t: number,
): PlaybackTimeline {
  return makeTimeline(tl.path, tl.tempo, t, nearestC(tl, beat, tl.cAt(t)));
}

/**
 * The same timeline on another clock: what sounds at `oldNow` on the old clock
 * sounds at `newNow` on the new one.
 */
export function rebaseTimeline(
  tl: PlaybackTimeline,
  oldNow: number,
  newNow: number,
): PlaybackTimeline {
  return makeTimeline(tl.path, tl.tempo, newNow, tl.cAt(oldNow));
}

function makeTimeline(
  path: PlaybackPath,
  tempo: TempoIndex,
  anchorT: number,
  anchorC: number,
): PlaybackTimeline {
  const { origin, cycle } = path;
  const loopFrom = cycle ? cycleStart(cycle) : 0;
  const headBeats = cycle ? cycle.end - origin : Infinity;
  const loopBeats = cycle ? cycleBeats(cycle) : 0;
  const originSec = tempo.beatToSeconds(origin);
  const headSec = cycle ? tempo.beatToSeconds(cycle.end) - originSec : Infinity;
  const loopFromSec = tempo.beatToSeconds(loopFrom);
  const loopSec = cycle ? tempo.beatToSeconds(cycle.end) - loopFromSec : 0;

  // Seconds along the played path up to `c`: a plain beat→seconds span in the
  // head, then whole iterations plus the partial last one — exact under a
  // tempo map that varies inside the loop. A rest is timed by the tempo map
  // over the bar it replaces.
  const pathSec = (c: number): number => {
    if (!cycle || c < headBeats) {
      return tempo.beatToSeconds(origin + c) - originSec;
    }
    const r = c - headBeats;
    const full = Math.floor(r / loopBeats);
    const rem = r - full * loopBeats;
    return (
      headSec +
      full * loopSec +
      tempo.beatToSeconds(loopFrom + rem) -
      loopFromSec
    );
  };

  const pathSecInverse = (sec: number): number => {
    if (!cycle || sec < headSec) {
      return tempo.secondsToBeat(originSec + sec) - origin;
    }
    const r = sec - headSec;
    const full = Math.floor(r / loopSec);
    const rem = r - full * loopSec;
    return (
      headBeats +
      full * loopBeats +
      tempo.secondsToBeat(loopFromSec + rem) -
      loopFrom
    );
  };

  const anchorSec = pathSec(anchorC);
  const cAt = (t: number): number => pathSecInverse(t - anchorT + anchorSec);
  const iterationOf = (c: number): number =>
    !cycle || c < headBeats ? 0 : 1 + Math.floor((c - headBeats) / loopBeats);
  const beatOf = (c: number): number => {
    if (!cycle || c < headBeats) return origin + c;
    return loopFrom + ((c - headBeats) % loopBeats);
  };
  const positionOf = (c: number): PlayPosition => {
    const beat = beatOf(c);
    if (!cycle) return songPosition(beat);
    const repeat = path.repeat || c >= headBeats;
    if (repeat && beat < cycle.start) {
      return { beat: cycle.start, rest: cycle.start - beat, repeat };
    }
    return { beat, rest: 0, repeat };
  };

  return {
    path,
    tempo,
    headBeats,
    loopBeats,
    timeAt: (c) => anchorT + pathSec(c) - anchorSec,
    cAt,
    beatOf,
    positionOf,
    positionAt: (t) => positionOf(cAt(t)),
    iterationOf,
    loopC: (iter, beat) =>
      headBeats + (iter - 1) * loopBeats + (beat - loopFrom),
  };
}

/** The path coordinate of `beat` nearest `near`: the head, or the cycle iteration closest to it. */
function nearestC(tl: PlaybackTimeline, beat: number, near: number): number {
  const { origin, cycle } = tl.path;
  if (!cycle || beat < cycleStart(cycle) || beat >= cycle.end) {
    return beat - origin;
  }
  const candidates: number[] = beat >= origin ? [beat - origin] : [];
  const iter = Math.max(1, tl.iterationOf(near));
  for (const k of [iter - 1, iter, iter + 1]) {
    if (k >= 1) candidates.push(tl.loopC(k, beat));
  }
  return candidates.reduce((best, c) =>
    Math.abs(c - near) < Math.abs(best - near) ? c : best,
  );
}
