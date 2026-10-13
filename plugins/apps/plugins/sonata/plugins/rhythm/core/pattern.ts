/**
 * The rhythm-pattern data model and its pure operations.
 *
 * A `RhythmPattern` is a rotating onset necklace: `subdivisions` evenly-spaced
 * pulses per bar, a set of `onsets` that strike, and a cyclic `rotation`. Every
 * operation here is *pure* — inputs are never mutated; a fresh pattern (with
 * fresh arrays) is always returned.
 *
 * `rotation` is stored separately from `onsets` so a rotated preset can still
 * name itself ("Son ⟳2") instead of collapsing to "Custom". A bead click maps
 * back through it: `rawIndex = (clicked − rotation) mod subdivisions`.
 */

import { findRhythm } from "./presets";

export interface RhythmPattern {
  /** Provenance for the label; null ⇒ "Custom" (a bead was toggled). */
  presetId: string | null;
  /** Pulses per bar, 1–48. */
  subdivisions: number;
  /** Sorted, unique, each in [0, subdivisions). */
  onsets: readonly number[];
  /** Cyclic shift, normalized to [0, subdivisions). */
  rotation: number;
}

export interface NamedRhythm {
  id: string;
  label: string;
  subdivisions: number;
  onsets: readonly number[];
}

/** The two performing hands. */
export interface RhythmHands {
  bass: RhythmPattern;
  chord: RhythmPattern;
}

/** Floored modulo — always returns a value in [0, m), even for negative x. */
function floorMod(x: number, m: number): number {
  return ((x % m) + m) % m;
}

/** Sorted, de-duplicated copy of the onset list. */
function normalizeOnsets(onsets: readonly number[]): number[] {
  return [...new Set(onsets)].sort((a, b) => a - b);
}

/**
 * Build a fresh pattern from a named preset. `rotation` starts at 0; `onsets`
 * are copied so the returned pattern shares no state with the preset table.
 */
export function patternFromPreset(id: string): RhythmPattern {
  const preset = findRhythm(id);
  return {
    presetId: preset.id,
    subdivisions: preset.subdivisions,
    onsets: normalizeOnsets(preset.onsets),
    rotation: 0,
  };
}

/**
 * The onsets with `rotation` applied, sorted ascending. This is what the
 * necklace actually strikes; the caller feeds it to the circle / emitter.
 */
export function effectiveOnsets(p: RhythmPattern): number[] {
  return normalizeOnsets(
    p.onsets.map((o) => floorMod(o + p.rotation, p.subdivisions)),
  );
}

/**
 * Cyclically shift the pattern by `delta` pulses. `rotation` is normalized into
 * [0, subdivisions); `presetId` is PRESERVED (label reads "Son ⟳2").
 */
export function rotate(p: RhythmPattern, delta: number): RhythmPattern {
  return {
    presetId: p.presetId,
    subdivisions: p.subdivisions,
    onsets: [...p.onsets],
    rotation: floorMod(p.rotation + delta, p.subdivisions),
  };
}

/**
 * Proportionally resample the pattern to `n` pulses: each onset moves to
 * `round(i · n / old)` (mod n, deduped), preserving the groove's *shape* across
 * a subdivision change. `rotation` rescales the same way. `presetId` is
 * PRESERVED (label reads "Son (adapted)"). `n` is clamped to [1, 48]; a
 * non-positive or non-integer `n` throws loudly.
 *
 * This adaptation does not exist on rhythm-circle.com (see `presets.ts`) — it is
 * ours. Selecting a preset there simply snaps the subdivision count instead.
 */
export function resample(p: RhythmPattern, n: number): RhythmPattern {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`[rhythm] resample needs a positive integer, got: ${n}`);
  }
  const target = Math.min(48, Math.max(1, n));
  const old = p.subdivisions;
  const onsets = normalizeOnsets(
    p.onsets.map((i) => Math.round((i * target) / old) % target),
  );
  return {
    presetId: p.presetId,
    subdivisions: target,
    onsets,
    rotation: Math.round((p.rotation * target) / old) % target,
  };
}

/**
 * Toggle the onset at a given *effective* index (as clicked on the rotated
 * necklace). Maps back to the raw index through `rotation`, adds or removes it,
 * keeps `onsets` sorted, and sets `presetId = null` ("Custom").
 */
export function toggleOnset(
  p: RhythmPattern,
  effectiveIndex: number,
): RhythmPattern {
  const raw = floorMod(effectiveIndex - p.rotation, p.subdivisions);
  const has = p.onsets.includes(raw);
  const onsets = has
    ? p.onsets.filter((o) => o !== raw)
    : normalizeOnsets([...p.onsets, raw]);
  return {
    presetId: null,
    subdivisions: p.subdivisions,
    onsets: [...onsets],
    rotation: p.rotation,
  };
}

/**
 * The default left-hand (bass) pattern: one strike per cycle — with the
 * default groove restarting on chord changes, the bass sounds once per chord
 * (and again at each bar line it is held across). Fresh on every call.
 */
export function defaultBassPattern(): RhythmPattern {
  return patternFromPreset("basic-1");
}

/**
 * The default right-hand (chord) pattern: one strike per cycle, like the bass —
 * a plain held chord. Fresh on every call.
 */
export function defaultChordPattern(): RhythmPattern {
  return patternFromPreset("basic-1");
}
