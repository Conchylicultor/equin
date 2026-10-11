import {
  hookpadKeyAt,
  hookpadTonicPc,
  type HookpadKey,
  type HookpadMeter,
  type HookpadMode,
  type HookpadTempo,
} from "@plugins/integrations/plugins/hooktheory/core";
import { CHORD_FEATURES, type ChordFeature } from "./features";
import type { IndexedChord } from "./indexed-chord";
import { repeatPeriod, type LoopChord } from "./repeat";
import type { ChordToken } from "./token";

// ── Loop shapes: which spans of a section the trainer can loop ───────────────
//
// A closed list of plain data plus a pure enumerator. A new shape ("bars-2")
// is a new entry here and an `INDEX_DERIVATION_VERSION` bump; the tables need
// no change.
//
// - `bars-4` — every 4-bar window, as cut: the raw grid.
// - `phrase` — the loops worth training on: per bar start, 4 bars when they
//   hold a real progression (`rich`), else 8 bars when those do and still
//   loop in `PHRASE_MAX_SECONDS` (a fast song), else the 4 bars as they are —
//   unless nothing changes in them (one chord held or repeated throughout),
//   which is left out.

export const LOOP_SHAPE_IDS = ["bars-4", "phrase"] as const;
export type LoopShapeId = (typeof LOOP_SHAPE_IDS)[number];

/** The shape a read uses when the caller names none — the one the trainer plays. */
export const DEFAULT_LOOP_SHAPE: LoopShapeId = "phrase";

/** A rich window holds at least this many different chords… */
export const RICH_MIN_CHORDS = 3;
/** …and at least this many chord changes (four chords in a row, at least). */
export const RICH_MIN_CHANGES = 3;

/**
 * Whether a window holds a real progression rather than a vamp or a
 * back-and-forth between two chords (I–V–I–V). The ONE rule: windows store
 * its answer (`rich`), and `find` serves rich windows first.
 */
export function isRichLoop(window: {
  chordTokens: readonly ChordToken[];
  changeCount: number;
}): boolean {
  return (
    window.chordTokens.length >= RICH_MIN_CHORDS &&
    window.changeCount >= RICH_MIN_CHANGES
  );
}

/** The bars a `phrase` tries, shortest first. */
const PHRASE_BARS = [4, 8] as const;
/** The longest a stretched `phrase` may loop for, at the document's tempo: past it the loop is too long to hold in the ear. */
export const PHRASE_MAX_SECONDS = 20;
/** The most chords a stretched `phrase` may hold: one answer box each. */
export const PHRASE_MAX_CHORDS = 8;

/** What a loop shape reads of a section. Beats are Hookpad's, 1-based. */
export type LoopSectionInput = {
  chords: readonly IndexedChord[];
  keys: readonly HookpadKey[];
  meters: readonly HookpadMeter[];
  /** The document's tempos: how long a stretched `phrase` lasts. */
  tempos: readonly HookpadTempo[];
  endBeat: number;
};

/** One loopable span, with what the trainer filters and ranks on. */
export type LoopWindow = {
  shape: LoopShapeId;
  /** First beat of the loop (a bar start), inclusive. */
  startBeat: number;
  /** Beat the loop ends on, exclusive. */
  endBeat: number;
  bars: number;
  beatsPerBar: number;
  beatUnit: number;
  /** The one key the whole window is in, as spelled by the document's key. */
  keyTonic: string;
  keyMode: HookpadMode;
  /** The distinct tokens sounding in the window, in order of first appearance. */
  chordTokens: ChordToken[];
  /** The union of the sounding chords' spelling features, in `CHORD_FEATURES` order. */
  features: ChordFeature[];
  /** Sounding chords overlapping the window (one that started before it and rings into it counts). */
  chordCount: number;
  /** Chord changes inside the window: sounding chords starting after its first beat with a token different from the previous sounding chord's. Rests are ignored. */
  changeCount: number;
  /** Whether the harmony is silent anywhere in the window: a rest, or a gap no chord covers. */
  hasRest: boolean;
  /** Whether a sounding chord starts exactly on the window's first beat. */
  startsOnChange: boolean;
  /** `isRichLoop`: a real progression, served first. */
  rich: boolean;
};

export type LoopShape = {
  id: LoopShapeId;
  enumerate(section: LoopSectionInput): LoopWindow[];
};

/** Tolerance for comparing beats: absorbs floating-point drift in old documents. */
const BEAT_EPS = 1e-6;

/**
 * Whether a chord sounding from `beat` for `duration` is inside the window
 * `[start, end)` — the ONE overlap rule of the index.
 *
 * A window's `chordTokens`, `features`, `chordCount` and `changeCount` are
 * derived from it, and a read hands back the section's chords it keeps. Both
 * sides call this, because a rule spelled twice (here with the tolerance, there
 * without) lets a read return a chord the window never counted — a token the
 * window's `chord_tokens` does not list, which is what "every chord of the
 * window is unlocked" rests on.
 */
export function chordOverlapsWindow(
  chord: { beat: number; duration: number },
  start: number,
  end: number,
): boolean {
  return (
    chord.beat < end - BEAT_EPS &&
    chord.beat + chord.duration > start + BEAT_EPS
  );
}

/** `hookpadKeyAt`'s tolerance, used for a key change inside a window. */
const KEY_EPS = 1e-3;

function sameKey(a: HookpadKey, b: HookpadKey): boolean {
  return (
    a.scale === b.scale && hookpadTonicPc(a.tonic) === hookpadTonicPc(b.tonic)
  );
}

/** One bar a window may start on, with the meter it lies in and where that meter ends. */
type BarStart = { meter: HookpadMeter; start: number; meterEnd: number };

/**
 * Every bar start of the section, meter by meter. A window lies inside one
 * meter (a meter change cuts the bars) and fully inside the section.
 */
function barStarts(section: LoopSectionInput): BarStart[] {
  const starts: BarStart[] = [];
  section.meters.forEach((meter, i) => {
    if (!(meter.numBeats > 0)) {
      throw new Error(
        `A meter of ${meter.numBeats} beats per bar (at beat ${meter.beat}) cannot be cut into bars`,
      );
    }
    const next = section.meters[i + 1];
    if (next !== undefined && next.beat <= meter.beat) {
      throw new Error(
        `Meters out of beat order: beat ${next.beat} listed after beat ${meter.beat}`,
      );
    }
    const meterEnd = Math.min(next?.beat ?? section.endBeat, section.endBeat);
    for (
      let start = meter.beat;
      start + meter.numBeats <= meterEnd + BEAT_EPS;
      start += meter.numBeats
    ) {
      starts.push({ meter, start, meterEnd });
    }
  });
  return starts;
}

/**
 * The window of `bars` whole bars from a bar start, or `undefined` when it
 * runs past its meter or breaks a rule of `barsWindow`.
 */
function windowAt(
  shape: LoopShapeId,
  bars: number,
  { meter, start, meterEnd }: BarStart,
  chordsByBeat: readonly IndexedChord[],
  keys: readonly HookpadKey[],
): LoopWindow | undefined {
  const end = start + bars * meter.numBeats;
  if (end > meterEnd + BEAT_EPS) return undefined;
  return barsWindow(shape, bars, meter, start, end, chordsByBeat, keys);
}

const byBeat = (section: LoopSectionInput): IndexedChord[] =>
  [...section.chords].sort((a, b) => a.chord.beat - b.chord.beat);

/**
 * The windows of `bars` whole bars, one per bar start. A window lies inside
 * one meter, inside one key (no change to a different key strictly inside it,
 * and every chord sounding in it is read in that key), and fully inside the
 * section. A window where nothing sounds is left out: no query could ever
 * match it.
 */
function enumerateBars(
  shape: LoopShapeId,
  bars: number,
  section: LoopSectionInput,
): LoopWindow[] {
  const chords = byBeat(section);
  return barStarts(section).flatMap((at) => {
    const window = windowAt(shape, bars, at, chords, section.keys);
    return window === undefined ? [] : [window];
  });
}

/**
 * The `phrase` windows: one per bar start, the shortest of `PHRASE_BARS` that
 * is `rich` — a longer one only while it loops within `PHRASE_MAX_SECONDS`
 * and holds at most `PHRASE_MAX_CHORDS` chords, so a fast song stretches to 8
 * bars and a slow one does not, and never to a replay of the shorter one (8
 * bars that are the same 4 twice hold nothing more to hear). With no rich length, the 4 bars as they are,
 * unless no chord changes in them (a vamp), which no one learns from.
 */
function enumeratePhrases(section: LoopSectionInput): LoopWindow[] {
  const chords = byBeat(section);
  const [shortest, ...longer] = PHRASE_BARS;
  const windows: LoopWindow[] = [];
  for (const at of barStarts(section)) {
    const short = windowAt("phrase", shortest, at, chords, section.keys);
    if (short === undefined) continue;
    const pick = short.rich
      ? short
      : longer
          .map((bars) => windowAt("phrase", bars, at, chords, section.keys))
          .find(
            (w) =>
              w !== undefined &&
              w.rich &&
              w.chordCount <= PHRASE_MAX_CHORDS &&
              fitsSeconds(section.tempos, w, PHRASE_MAX_SECONDS) &&
              repeatPeriod(windowChords(chords, w), w.endBeat - w.startBeat) >
                short.endBeat - short.startBeat + BEAT_EPS,
          );
    if (pick !== undefined) windows.push(pick);
    else if (short.changeCount > 0) windows.push(short);
  }
  return windows;
}

/** The window's sounding chords, clipped to it, in beats from its start. */
function windowChords(
  chordsByBeat: readonly IndexedChord[],
  window: { startBeat: number; endBeat: number },
): LoopChord[] {
  return chordsByBeat.flatMap((c) =>
    c.reading.kind === "sound" &&
    chordOverlapsWindow(c.chord, window.startBeat, window.endBeat)
      ? [
          {
            start: Math.max(c.chord.beat, window.startBeat) - window.startBeat,
            end:
              Math.min(c.chord.beat + c.chord.duration, window.endBeat) -
              window.startBeat,
            token: c.reading.token,
          },
        ]
      : [],
  );
}

/**
 * Whether the window lasts at most `max` seconds at the document's tempos (a
 * tempo holds from its beat on; the first one also covers the beats before
 * it). No tempo, or a missing bpm in the window, cannot be measured: `false`,
 * so the window is never stretched on a guess.
 */
function fitsSeconds(
  tempos: readonly HookpadTempo[],
  window: { startBeat: number; endBeat: number },
  max: number,
): boolean {
  const sorted = [...tempos].sort((a, b) => a.beat - b.beat);
  if (sorted.length === 0) return false;
  let seconds = 0;
  for (const [i, tempo] of sorted.entries()) {
    const from =
      i === 0 ? window.startBeat : Math.max(tempo.beat, window.startBeat);
    const to = Math.min(sorted[i + 1]?.beat ?? window.endBeat, window.endBeat);
    if (to <= from + BEAT_EPS) continue;
    if (tempo.bpm === null || !(tempo.bpm > 0)) return false;
    seconds += ((to - from) * 60) / tempo.bpm;
  }
  return seconds <= max;
}

/** One candidate window, or `undefined` when it breaks a rule of the shape (a different key inside, nothing sounding). */
function barsWindow(
  shape: LoopShapeId,
  bars: number,
  meter: HookpadMeter,
  start: number,
  end: number,
  chordsByBeat: readonly IndexedChord[],
  keys: readonly HookpadKey[],
): LoopWindow | undefined {
  const keyAtStart = hookpadKeyAt(keys, start);
  if (keyAtStart.kind === "before-first-key") return undefined;
  const key = keyAtStart.key;
  const keyChangesInside = keys.filter(
    (k) => k.beat >= start + KEY_EPS && k.beat < end - KEY_EPS,
  );
  if (!keyChangesInside.every((k) => sameKey(k, key))) return undefined;

  const overlapping = chordsByBeat.filter((c) =>
    chordOverlapsWindow(c.chord, start, end),
  );
  const sounding = overlapping.flatMap((c) =>
    c.reading.kind === "sound" ? [{ ...c, reading: c.reading }] : [],
  );
  if (sounding.length === 0) return undefined;
  if (!sounding.every((c) => sameKey(c.key, key))) return undefined;

  const tokens: ChordToken[] = [];
  const features = new Set<ChordFeature>();
  let changeCount = 0;
  let previous: ChordToken | undefined;
  for (const c of sounding) {
    if (!tokens.includes(c.reading.token)) tokens.push(c.reading.token);
    for (const f of c.reading.features) features.add(f);
    if (
      previous !== undefined &&
      c.chord.beat > start + BEAT_EPS &&
      c.reading.token !== previous
    ) {
      changeCount++;
    }
    previous = c.reading.token;
  }

  const window = {
    shape,
    startBeat: start,
    endBeat: end,
    bars,
    beatsPerBar: meter.numBeats,
    beatUnit: meter.beatUnit,
    keyTonic: key.tonic,
    keyMode: key.scale,
    chordTokens: tokens,
    features: CHORD_FEATURES.filter((f) => features.has(f)),
    chordCount: sounding.length,
    changeCount,
    hasRest: harmonyIsSilentSomewhere(overlapping, start, end),
    startsOnChange: sounding.some(
      (c) => Math.abs(c.chord.beat - start) <= BEAT_EPS,
    ),
  };
  return { ...window, rich: isRichLoop(window) };
}

/** A rest overlaps the span, or some part of it is covered by no chord at all. */
function harmonyIsSilentSomewhere(
  overlappingByBeat: readonly IndexedChord[],
  start: number,
  end: number,
): boolean {
  if (overlappingByBeat.some((c) => c.reading.kind === "rest")) return true;
  let coveredUntil = start;
  for (const { chord } of overlappingByBeat) {
    if (chord.beat > coveredUntil + BEAT_EPS) return true;
    coveredUntil = Math.max(coveredUntil, chord.beat + chord.duration);
  }
  return coveredUntil < end - BEAT_EPS;
}

export const LOOP_SHAPES: Readonly<Record<LoopShapeId, LoopShape>> = {
  "bars-4": {
    id: "bars-4",
    enumerate: (section) => enumerateBars("bars-4", 4, section),
  },
  phrase: {
    id: "phrase",
    enumerate: enumeratePhrases,
  },
};
