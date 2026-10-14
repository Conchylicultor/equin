/**
 * The unrolled A–B loop — a display's view of "what comes next" when the loop
 * is shown ahead of the cursor instead of the song past B.
 *
 * {@link unrollLoop} lays the transport's own cycle (`LoopCycle`) out on one
 * monotonic AXIS: the song as written up to B, then copy after copy of
 * `[rest][A, B)`. It returns an ordinary `Score` over that axis (the loop's
 * notes, annotations, pedal, tempo and meter copied into every iteration) plus
 * the {@link AxisTimeline} mapping play positions to axis beats and back — so a
 * display that already draws "a score scrolled to a cursor beat" draws the
 * unrolled loop by being handed the axis score and the cursor's AXIS beat, with
 * no special case in any renderer.
 *
 * The cursor: on the song's own pass its axis beat is its score beat; on a
 * repeat it sits in the FIRST copy (`[B, B + cycle)`), its rest included — so
 * the axis advances continuously from the first pass into the first repeat,
 * and every later wrap jumps back exactly one cycle onto identical content.
 * Below the cursor on a repeat is the previous copy, never the song before A.
 *
 * The axis carries enough copies for any lookahead the roll can show: at least
 * the song's own span (the deepest zoom-out fits the whole song) and
 * {@link UNROLL_MIN_AHEAD_BEATS} beyond the first copy, capped at
 * {@link UNROLL_MAX_COPIES}.
 */
import { pedalSpans } from "./pedal";
import { bars, scoreEndBeat, scoreStartBeat } from "./helpers";
import { cycleBeats, cycleStart, songPosition } from "./loop-cycle";
import type {
  Annotation,
  AxisTimeline,
  LoopCycle,
  Note,
  PedalEvent,
  PlayPosition,
  Score,
  TempoEvent,
  TimeSigEvent,
} from "./types";

/** Beats of loop copies drawn beyond the first, at the least. */
export const UNROLL_MIN_AHEAD_BEATS = 128;
/** Upper bound on the drawn copies, so a tiny loop on a long song stays bounded. */
export const UNROLL_MAX_COPIES = 512;

/**
 * A bar line on the axis. `index` is the bar's index in `bars(score)` (a
 * copy's bars keep the loop's own numbers), or `null` for the line opening a
 * loop rest, which is no bar of the song.
 */
export interface AxisBar {
  index: number | null;
  startBeat: number;
}

/** A score laid out on a display axis, with the mapping that placed it. */
export interface AxisScore {
  /** The score over AXIS beats — draw it as any score. */
  score: Score;
  timeline: AxisTimeline;
  /** The axis's bar lines (the song's own up to B, then each copy's). */
  bars: readonly AxisBar[];
}

/** The identity timeline: the axis IS the song. */
export const IDENTITY_TIMELINE: AxisTimeline = {
  axisBeat: (position) => position.beat,
  at: (axisBeat) => songPosition(axisBeat),
  loop: null,
};

/** The song as written, as an {@link AxisScore}. */
export function songAxis(score: Score): AxisScore {
  return { score, timeline: IDENTITY_TIMELINE, bars: bars(score) };
}

/** The timeline of `cycle` unrolled after B with `copies` copies. */
export function loopTimeline(cycle: LoopCycle, copies: number): AxisTimeline {
  const a = cycle.start;
  const b = cycle.end;
  const cs = cycleStart(cycle);
  const len = cycleBeats(cycle);
  const shifts = Array.from({ length: copies }, (_, k) => b + k * len - cs);
  return {
    axisBeat(position: PlayPosition): number {
      if (!position.repeat) return position.beat;
      const at = position.beat - position.rest;
      // A repeat position outside the cycle (bounds moved under it, before the
      // transport re-anchored) reads as its song beat.
      if (at < cs || at >= b) return position.beat;
      return at - cs + b;
    },
    at(axisBeat: number): PlayPosition {
      if (axisBeat < b) return songPosition(axisBeat);
      const into = (axisBeat - b) % len;
      const beat = cs + into;
      return beat < a
        ? { beat: a, rest: a - beat, repeat: true }
        : { beat, rest: 0, repeat: true };
    },
    loop: { cycle, shifts },
  };
}

/** How many copies {@link unrollLoop} draws for `cycle` over `score`. */
function copiesFor(score: Score, cycle: LoopCycle): number {
  const span = Math.max(
    scoreEndBeat(score) - scoreStartBeat(score),
    UNROLL_MIN_AHEAD_BEATS,
  );
  // One for the copy the cursor sits in on a repeat, the span beyond it, and
  // one more so a partly visible copy is always whole.
  const n = Math.ceil(span / cycleBeats(cycle)) + 2;
  return Math.min(UNROLL_MAX_COPIES, Math.max(1, n));
}

/** The bpm in force at `beat` on a sorted, non-empty tempo map. */
function bpmAt(map: readonly TempoEvent[], beat: number): number {
  let bpm = map[0]!.bpm;
  for (const e of map) {
    if (e.beat > beat) break;
    bpm = e.bpm;
  }
  return bpm;
}

/** The meter in force at `beat` (4/4 when none is declared). */
function meterAt(
  map: readonly TimeSigEvent[],
  beat: number,
): { numerator: number; denominator: number } {
  let meter = { numerator: 4, denominator: 4 };
  for (const e of map) {
    if (e.beat > beat) break;
    meter = { numerator: e.numerator, denominator: e.denominator };
  }
  return meter;
}

/** A copy's id for an item of the loop body (stable per copy). */
function copyId(id: string, k: number): string {
  return `${id}~loop${k + 1}`;
}

/**
 * Lay `score` out with `cycle` unrolled after B (see the file header). The
 * song's own content is kept up to B — notes that START before B (one ringing
 * past B is drawn as it sounds), annotations clipped to end by B — and every
 * copy carries the loop body's notes, its annotations clipped to `[A, B)`, its
 * pedal spans clipped likewise, and the body's tempo and meter, opened by the
 * rest timed at the tempo in force at its start and metered like A. Annotation
 * `data` is copied verbatim: a beat inside a payload (a lyric line's chord
 * beats) stays a score beat.
 */
export function unrollLoop(score: Score, cycle: LoopCycle): AxisScore {
  const a = cycle.start;
  const b = cycle.end;
  const cs = cycleStart(cycle);
  const timeline = loopTimeline(cycle, copiesFor(score, cycle));
  const shifts = timeline.loop!.shifts;

  // --- notes ---------------------------------------------------------------
  const body = score.notes.filter((n) => n.start >= a && n.start < b);
  const notes: Note[] = score.notes.filter((n) => n.start < b);
  shifts.forEach((shift, k) => {
    for (const n of body) {
      notes.push({ ...n, id: copyId(n.id, k), start: n.start + shift });
    }
  });

  // --- annotations ---------------------------------------------------------
  const annotations: Annotation[] = [];
  for (const an of score.annotations) {
    if (an.start < b) annotations.push({ ...an, end: Math.min(an.end, b) });
  }
  const bodyAnnotations = score.annotations.filter(
    (an) => an.start < b && an.end > a,
  );
  shifts.forEach((shift, k) => {
    for (const an of bodyAnnotations) {
      const target = an.target?.noteIds
        ? {
            ...an.target,
            noteIds: an.target.noteIds.map((id) => copyId(id, k)),
          }
        : an.target;
      annotations.push({
        ...an,
        start: Math.max(an.start, a) + shift,
        end: Math.min(an.end, b) + shift,
        ...(target ? { target } : {}),
      });
    }
  });

  // --- pedal ---------------------------------------------------------------
  const pedalEvents: PedalEvent[] = [];
  const spans = pedalSpans(score.pedalEvents);
  for (const sp of spans) {
    if (sp.downBeat >= b) continue;
    pedalEvents.push({ track: sp.track, beat: sp.downBeat, down: true });
    pedalEvents.push({
      track: sp.track,
      beat: Math.min(sp.upBeat ?? b, b),
      down: false,
    });
  }
  for (const shift of shifts) {
    for (const sp of spans) {
      const up = sp.upBeat ?? b;
      if (sp.downBeat >= b || up <= a) continue;
      pedalEvents.push({
        track: sp.track,
        beat: Math.max(sp.downBeat, a) + shift,
        down: true,
      });
      pedalEvents.push({
        track: sp.track,
        beat: Math.min(up, b) + shift,
        down: false,
      });
    }
  }
  pedalEvents.sort((x, y) => x.beat - y.beat);

  // --- tempo + meter -------------------------------------------------------
  // An empty tempo map is one constant tempo everywhere: nothing to copy.
  const tempoMap: TempoEvent[] = score.tempoMap.filter((e) => e.beat < b);
  const timeSigMap: TimeSigEvent[] = score.timeSigMap.filter((e) => e.beat < b);
  const restBpm = score.tempoMap.length > 0 ? bpmAt(score.tempoMap, cs) : 0;
  const meterOfA = meterAt(score.timeSigMap, a);
  for (const shift of shifts) {
    if (score.tempoMap.length > 0) {
      tempoMap.push({ beat: cs + shift, bpm: restBpm });
      for (const e of score.tempoMap) {
        if (e.beat > cs && e.beat < b) {
          tempoMap.push({ beat: e.beat + shift, bpm: e.bpm });
        }
      }
    }
    timeSigMap.push({ beat: cs + shift, ...meterOfA });
    for (const e of score.timeSigMap) {
      if (e.beat > a && e.beat < b) {
        timeSigMap.push({ ...e, beat: e.beat + shift });
      }
    }
  }

  // --- bar lines -----------------------------------------------------------
  const songBars = bars(score);
  const axisBars: AxisBar[] = songBars.filter((x) => x.startBeat < b);
  const bodyBars = songBars.filter((x) => x.startBeat >= a && x.startBeat < b);
  for (const shift of shifts) {
    if (cycle.rest > 0) axisBars.push({ index: null, startBeat: cs + shift });
    for (const x of bodyBars) {
      axisBars.push({ index: x.index, startBeat: x.startBeat + shift });
    }
  }
  // Close the last copy.
  axisBars.push({ index: null, startBeat: b + shifts.at(-1)! });

  return {
    score: {
      ...score,
      notes,
      annotations,
      pedalEvents,
      tempoMap,
      timeSigMap,
    },
    timeline,
    bars: axisBars,
  };
}
