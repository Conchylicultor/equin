import type {
  HookpadChord,
  HookpadKey,
  HookpadMeter,
  HookpadTempo,
} from "@plugins/integrations/plugins/hooktheory/core";
import { beatTimesAlignment } from "./beat-time";
import type { DeriveSectionInput, DerivedSection } from "./derive";
import type { LoopShapeId, LoopWindow } from "./loop-shapes";

// Test-only builders for sections. Not exported from the barrel.

/** A chord of `duration` beats at `beat`: a root-position diatonic triad on `root` unless overridden. */
export function chord(
  beat: number,
  duration: number,
  overrides: Partial<HookpadChord> = {},
): HookpadChord {
  return {
    root: 1,
    beat,
    duration,
    type: 5,
    inversion: 0,
    applied: 0,
    adds: [],
    omits: [],
    alterations: [],
    suspensions: [],
    borrowed: null,
    isRest: false,
    pedal: null,
    alternate: "",
    ...overrides,
  };
}

export function rest(beat: number, duration: number): HookpadChord {
  return chord(beat, duration, { root: 0, isRest: true });
}

/** Consecutive chords on the given scale degrees, `each` beats long, from beat 1. */
export function progression(
  roots: readonly number[],
  each: number,
): HookpadChord[] {
  return roots.map((root, i) => chord(1 + i * each, each, { root }));
}

export const C_MAJOR: HookpadKey = { beat: 1, tonic: "C", scale: "major" };
/** 120 bpm: 8 bars of 4/4 last 16 s, inside `PHRASE_MAX_SECONDS`. */
export const MODERATO: HookpadTempo = {
  beat: 1,
  bpm: 120,
  swingFactor: 0,
  swingBeat: 0.5,
};
export const FOUR_FOUR: HookpadMeter = { beat: 1, numBeats: 4, beatUnit: 4 };

/** A section ending where its last chord ends, in C major 4/4, with a video and a two-point alignment. */
export function section(
  chords: HookpadChord[],
  overrides: Partial<DeriveSectionInput> = {},
): DeriveSectionInput {
  const last = chords.at(-1);
  const endBeat = last === undefined ? 1 : last.beat + last.duration;
  return {
    chords,
    keys: [C_MAJOR],
    meters: [FOUR_FOUR],
    tempos: [MODERATO],
    endBeat,
    videoId: "X1Fqn9du7xo",
    alignment: beatTimesAlignment([0, endBeat], [10, 10 + endBeat]),
    ...overrides,
  };
}

/** The `shape` windows of an indexed, loopable section; throws on anything else. */
export function windowsOf(
  derived: DerivedSection,
  shape: LoopShapeId,
): LoopWindow[] {
  if (derived.kind !== "indexed") {
    throw new Error(
      `expected an indexed section, got skipped: ${derived.reason} (${derived.detail})`,
    );
  }
  if (derived.loops.kind !== "windows") {
    throw new Error(
      `expected windows, got unloopable: ${derived.loops.reason}`,
    );
  }
  return derived.loops.windows.filter((w) => w.shape === shape);
}
