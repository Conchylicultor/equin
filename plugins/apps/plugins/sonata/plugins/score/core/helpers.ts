/**
 * Pure `Score` helpers — so no plugin re-implements time math, bar derivation,
 * or merging. All functions are pure: they never mutate their inputs.
 */
import type { Annotation, Score } from "./types";

/** The bpm assumed when a Score declares no tempo map (mirrors `beatToSeconds`). */
const DEFAULT_BPM = 120;

/**
 * Scale playback tempo by `factor` (1 = unchanged, 2 = twice as fast, 0.5 = half
 * speed). Multiplies every tempo segment's bpm, so only the beat↔seconds mapping
 * changes — note onsets/durations and every annotation stay put in beat space.
 * An empty tempoMap materializes the default-bpm segment so scaling still bites.
 * `meta.recording` is kept: the recording still names the timebase, and a
 * consumer maps media seconds = score seconds × `factor`.
 * Pure: returns a new Score, never mutates the input.
 */
export function scaleTempo(score: Score, factor: number): Score {
  if (factor === 1) return score;
  const base =
    score.tempoMap.length > 0
      ? score.tempoMap
      : [{ beat: 0, bpm: DEFAULT_BPM }];
  return {
    ...score,
    tempoMap: base.map((e) => ({ ...e, bpm: e.bpm * factor })),
  };
}

/**
 * The largest beat the score references — the transport stops here and the
 * progression bar spans `[0, scoreEndBeat]`. The max over every note's end
 * (`start + duration`) and every annotation's `end`. Pure; never mutates.
 */
export function scoreEndBeat(score: Score): number {
  let end = 0;
  for (const n of score.notes) end = Math.max(end, n.start + n.duration);
  for (const a of score.annotations) end = Math.max(end, a.end);
  return end;
}

/**
 * Length in quarter-note beats of the song's OPENING bar — the one-bar lead-in
 * the transport parks before beat 0 so the piano roll's first notes have room to
 * fall toward the strike line (a Synthesia-style pre-roll) instead of starting
 * pinned to it. Derived from the first time signature (`n × 4/d`, mirroring
 * {@link bars}), defaulting to a 4/4 bar. Guards a degenerate non-positive meter
 * back to 4 beats so the lead-in is always a real, finite bar. Pure.
 */
export function leadInBeats(score: Score): number {
  const first =
    score.timeSigMap.length > 0
      ? [...score.timeSigMap].sort((a, b) => a.beat - b.beat)[0]!
      : { beat: 0, numerator: 4, denominator: 4 };
  const len = first.numerator * (4 / first.denominator);
  return len > 0 ? len : 4;
}

/**
 * The lowest beat the transport parks/starts at — the mirror of
 * {@link scoreEndBeat}. A non-empty score opens on a one-bar lead-in pre-roll at
 * NEGATIVE beats `[-leadIn, 0)` (see {@link leadInBeats}) so the piano roll's
 * first notes fall toward the strike line, so the seekable/navigable span is
 * `[scoreStartBeat, scoreEndBeat]` — NOT `[0, scoreEndBeat]`. This is THE single
 * source of truth for the timeline's lower bound: the transport parks here on
 * load, rewind/scrub bottom out here, and `seekTo` clamps to it, so every path
 * agrees on where "the start" is (the empty lead-in bar, not the first note).
 * Zero for an empty score (nothing to lead into). Pure; never mutates.
 */
export function scoreStartBeat(score: Score): number {
  return scoreEndBeat(score) > 0 ? -leadInBeats(score) : 0;
}

/**
 * The epsilon that keeps a "strict" line lookup from sticking on the line it
 * just landed on (sub-millibeat — well below any musical grid spacing).
 */
const LINE_EPS = 1e-3;

/**
 * Generic grid-line lookups over a sorted-ascending list of lines (any
 * `{ startBeat }[]` — `bars()`, `beatGrid()`, or a {@link subdivideBars} seek
 * grid). The seek transport drives every motion — forward step, the half-unit
 * backward pivot, and the hold-scrub — through these three, so the line math
 * lives here once rather than being re-derived per grid. All pure; never mutate.
 *
 * The backward lookups take a `min` clamp (default 0) — symmetric to
 * {@link nextLine}'s `end` upper bound — so they bottom out at the caller's
 * timeline origin ({@link scoreStartBeat}, i.e. the lead-in pre-roll) rather
 * than a hardcoded 0. A grid needn't carry a line at `min`; the clamp itself is
 * the backward-most stop.
 *
 * `prevLine` — the line strictly before `beat` (or `min` when there is none).
 */
export function prevLine(
  lines: { startBeat: number }[],
  beat: number,
  min = 0,
): number {
  let best = min;
  for (const l of lines) {
    if (l.startBeat < beat - LINE_EPS && l.startBeat > best) best = l.startBeat;
  }
  return best;
}

/**
 * The line strictly after `beat`, or `end` when there is none (the caller's
 * upper bound — `scoreEndBeat` for the seek transport, so a forward step lands
 * on the song end). `lines` is ascending, so the first match is the nearest.
 */
export function nextLine(
  lines: { startBeat: number }[],
  beat: number,
  end: number,
): number {
  for (const l of lines) {
    if (l.startBeat > beat + LINE_EPS) return l.startBeat;
  }
  return end;
}

/**
 * The line at or before `beat` (or `min`, default 0, before the first). Unlike
 * {@link prevLine} it is *inclusive*, so a `beat` sitting exactly on a line
 * returns that same line — the start of the unit `beat` falls in. `min` is the
 * backward clamp (see {@link prevLine}).
 */
export function currentLine(
  lines: { startBeat: number }[],
  beat: number,
  min = 0,
): number {
  let best = min;
  for (const l of lines) {
    if (l.startBeat <= beat + LINE_EPS && l.startBeat > best)
      best = l.startBeat;
  }
  return best;
}

/**
 * Subdivide every bar into `n` equal parts — the seek grid. `n = 1` returns the
 * bar lines unchanged (today's whole-measure unit); `n = 2` adds a mid-bar line,
 * `n = 4` quarter-bar lines, etc. Each bar's span is `[start, nextStart)` (the
 * final bar runs to `scoreEndBeat`), so subdivisions stay even across
 * time-signature changes and variable bar lengths. The seek transport picks `n`
 * from the tempo (finer the slower you practice). Pure; never mutates.
 */
export function subdivideBars(
  score: Score,
  n: number,
): { startBeat: number }[] {
  const barList = bars(score);
  if (n <= 1) return barList;
  const end = scoreEndBeat(score);
  const out: { startBeat: number }[] = [];
  for (let i = 0; i < barList.length; i++) {
    const start = barList[i]!.startBeat;
    const next = i + 1 < barList.length ? barList[i + 1]!.startBeat : end;
    const span = next - start;
    if (span <= 0) {
      out.push({ startBeat: start });
      continue;
    }
    for (let k = 0; k < n; k++) {
      out.push({ startBeat: start + (span * k) / n });
    }
  }
  return out;
}

/** An empty Score — the shell's default before any source loads. */
export function emptyScore(): Score {
  return {
    meta: {},
    tracks: [],
    tempoMap: [],
    timeSigMap: [],
    notes: [],
    annotations: [],
    pedalEvents: [],
  };
}

/**
 * Convert a beat position to wall-clock seconds, integrating the piecewise-
 * constant `tempoMap`. Each tempo segment spans from its `beat` until the next
 * event's `beat` (or +∞). Beats before the first event use the first segment's
 * bpm (or a 120 bpm default when the map is empty).
 *
 * seconds(beat) = Σ over segments of (Δbeats in segment) × (60 / bpm).
 */
export function beatToSeconds(score: Score, beat: number): number {
  const map = score.tempoMap;
  if (map.length === 0) {
    return (beat * 60) / DEFAULT_BPM;
  }

  // `map` is already ascending by beat (the documented Score.tempoMap
  // invariant), so iterate it directly — no clone, no sort.
  const events = map;

  const firstBeat = events[0]!.beat;
  const firstBpm = events[0]!.bpm;

  // Beats at or before the first event run at the first segment's bpm
  // (extrapolated backwards relative to that event's anchor).
  if (beat <= firstBeat) {
    return ((beat - firstBeat) * 60) / firstBpm;
  }

  let seconds = 0;
  let prevBeat = firstBeat;
  let prevBpm = firstBpm;

  for (let i = 1; i < events.length; i++) {
    const segEnd = events[i]!.beat;
    if (beat <= segEnd) {
      seconds += ((beat - prevBeat) * 60) / prevBpm;
      return seconds;
    }
    seconds += ((segEnd - prevBeat) * 60) / prevBpm;
    prevBeat = segEnd;
    prevBpm = events[i]!.bpm;
  }

  // Past the last event: extend the final segment's bpm to +∞.
  seconds += ((beat - prevBeat) * 60) / prevBpm;
  return seconds;
}

/**
 * The tempo in effect at `beat`, in BPM. Derived from `beatToSeconds` (the same
 * source of truth the audio scheduler uses) rather than reading `tempoMap`
 * directly — so it is correct for sources that author no tempo (the 120-BPM
 * default) and for a score whose map `scaleTempo` folded a playback speed into:
 * on the session's scaled score this is the *live* BPM, halving at 50% and
 * tracking any tempo change within the song.
 */
export function bpmAtBeat(score: Score, beat: number): number {
  const EPS = 0.001;
  const secondsPerBeat =
    (beatToSeconds(score, beat + EPS) - beatToSeconds(score, beat)) / EPS;
  return 60 / secondsPerBeat;
}

/**
 * Derive bar boundaries from `timeSigMap` and `meta.pickupBeats`. Bars are never
 * stored on notes (that desyncs); always derive them. Returns the start beat of
 * each bar covering the span of the score's notes/annotations.
 *
 * Bar length (in quarter-note beats) for a time signature n/d is
 * `n × (4 / d)` (e.g. 6/8 → 6 × 0.5 = 3 quarter-note beats).
 */
export function bars(score: Score): { index: number; startBeat: number }[] {
  // Span to cover: from the origin to the latest content end.
  let maxBeat = 0;
  for (const n of score.notes)
    maxBeat = Math.max(maxBeat, n.start + n.duration);
  for (const a of score.annotations) maxBeat = Math.max(maxBeat, a.end);

  const pickup = score.meta.pickupBeats ?? 0;

  // Default to 4/4 if no time signatures are declared.
  const sigs =
    score.timeSigMap.length > 0
      ? [...score.timeSigMap].sort((a, b) => a.beat - b.beat)
      : [{ beat: 0, numerator: 4, denominator: 4 }];

  const result: { index: number; startBeat: number }[] = [];
  let beat = 0;
  let index = 0;

  // A pickup (anacrusis) is bar 0; the first full bar begins at the pickup's end.
  if (pickup > 0) {
    result.push({ index, startBeat: 0 });
    index++;
    beat = pickup;
  }

  let sigIdx = 0;
  // Guard against a runaway loop on degenerate (non-positive) bar lengths.
  let guard = 0;
  const GUARD_MAX = 1_000_000;
  while (beat <= maxBeat && guard++ < GUARD_MAX) {
    // Advance to the time signature active at `beat`.
    while (sigIdx + 1 < sigs.length && sigs[sigIdx + 1]!.beat <= beat) sigIdx++;
    const sig = sigs[sigIdx]!;
    const barLen = sig.numerator * (4 / sig.denominator);
    if (barLen <= 0) break;
    result.push({ index, startBeat: beat });
    index++;
    beat += barLen;
  }

  return result;
}

/**
 * Derive a beat grid from `timeSigMap` and `meta.pickupBeats` — the start beat
 * of each grid cell from the origin to the latest content end. Like `bars()`,
 * but one entry per *beat* (cell) rather than per bar, so chord detection can
 * segment on a fixed musical pulse instead of on raw note onsets/offsets (which
 * fragment arpeggios into a window per note).
 *
 * Cell length (in quarter-note beats) is `(4 / denominator) / subdivisions`:
 * one quarter-note beat by default; `subdivisions = 2` halves it to an eighth
 * grid, etc. In 6/8 the beat is `4/8 = 0.5` quarter-note beats, so the default
 * grid pulses every eighth note — the felt beat of 6/8.
 *
 * Pure; never mutates. A pickup (anacrusis) is cell 0, mirroring `bars()`.
 */
export function beatGrid(
  score: Score,
  subdivisions = 1,
): { index: number; startBeat: number }[] {
  const div = subdivisions > 0 ? subdivisions : 1;

  const maxBeat = scoreEndBeat(score);
  const pickup = score.meta.pickupBeats ?? 0;

  // Default to 4/4 if no time signatures are declared.
  const sigs =
    score.timeSigMap.length > 0
      ? [...score.timeSigMap].sort((a, b) => a.beat - b.beat)
      : [{ beat: 0, numerator: 4, denominator: 4 }];

  const result: { index: number; startBeat: number }[] = [];
  let beat = 0;
  let index = 0;

  // A pickup (anacrusis) is cell 0; the grid then proceeds from the pickup's end.
  if (pickup > 0) {
    result.push({ index, startBeat: 0 });
    index++;
    beat = pickup;
  }

  let sigIdx = 0;
  // Guard against a runaway loop on degenerate (non-positive) cell lengths.
  let guard = 0;
  const GUARD_MAX = 1_000_000;
  while (beat <= maxBeat && guard++ < GUARD_MAX) {
    // Advance to the time signature active at `beat`.
    while (sigIdx + 1 < sigs.length && sigs[sigIdx + 1]!.beat <= beat) sigIdx++;
    const sig = sigs[sigIdx]!;
    const cellLen = 4 / sig.denominator / div;
    if (cellLen <= 0) break;
    result.push({ index, startBeat: beat });
    index++;
    beat += cellLen;
  }

  return result;
}

/**
 * Merge several Scores into one, namespacing each layer's track and note ids by
 * its layer index so identities never collide, and unioning annotations (with
 * their targets remapped to the namespaced note ids). Sources stay independent
 * and pure — none knows about merging. The Score is what's mergeable, not the
 * sources.
 */
export function mergeScores(scores: Score[]): Score {
  if (scores.length === 0) return emptyScore();
  if (scores.length === 1) return scores[0]!;

  const out = emptyScore();
  // Take title/key/pickup/swing from the first score that declares each.
  for (const s of scores) {
    if (out.meta.title === undefined && s.meta.title !== undefined)
      out.meta.title = s.meta.title;
    if (out.meta.key === undefined && s.meta.key !== undefined)
      out.meta.key = s.meta.key;
    if (out.meta.pickupBeats === undefined && s.meta.pickupBeats !== undefined)
      out.meta.pickupBeats = s.meta.pickupBeats;
    if (out.meta.swing === undefined && s.meta.swing !== undefined)
      out.meta.swing = s.meta.swing;
  }
  // Tempo / time-sig maps come from the first score that has them — overlaying
  // independent tempo maps is ill-defined, so we don't guess. The recording
  // travels WITH the tempo map: it says "these score seconds are that video's
  // seconds", which is true only of the tempo map it was measured for.
  for (const s of scores) {
    if (out.tempoMap.length === 0 && s.tempoMap.length > 0) {
      out.tempoMap = [...s.tempoMap];
      if (s.meta.recording !== undefined) out.meta.recording = s.meta.recording;
    }
    if (out.timeSigMap.length === 0 && s.timeSigMap.length > 0)
      out.timeSigMap = [...s.timeSigMap];
  }

  scores.forEach((s, layer) => {
    const ns = (id: string) => `L${layer}:${id}`;
    for (const t of s.tracks) out.tracks.push({ ...t, id: ns(t.id) });
    for (const n of s.notes)
      out.notes.push({ ...n, id: ns(n.id), track: ns(n.track) });
    for (const p of s.pedalEvents)
      out.pedalEvents.push({ ...p, track: ns(p.track) });
    for (const a of s.annotations) {
      const target = a.target
        ? {
            ...a.target,
            noteIds: a.target.noteIds?.map(ns),
            track:
              a.target.track !== undefined ? ns(a.target.track) : undefined,
          }
        : undefined;
      out.annotations.push({ ...a, target });
    }
  });

  return out;
}

/**
 * Append analyzer-derived annotations to a Score without ever clobbering
 * authored truth. Returns a new Score; the base is left untouched. Derived
 * annotations are appended after authored ones.
 */
export function mergeAnnotations(base: Score, derived: Annotation[]): Score {
  if (derived.length === 0) return base;
  return {
    ...base,
    annotations: [...base.annotations, ...derived],
  };
}
