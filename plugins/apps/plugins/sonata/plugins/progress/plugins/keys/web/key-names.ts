import type {
  KeyEntry,
  KeySignature,
} from "@plugins/apps/plugins/sonata/plugins/score/core";

/**
 * Pure key helpers for the progress bar: naming a key and finding which key
 * is in force where, over the entries `collectKeyEntries` resolves. No React.
 */

/** A tonic with its ASCII accidentals as glyphs: `F#` → `F♯`, `Bb` → `B♭`. */
function tonicGlyphs(tonic: string): string {
  return (
    tonic.slice(0, 1) + tonic.slice(1).replace(/#/g, "♯").replace(/b/g, "♭")
  );
}

/** Compact key name for the label lane: `B`, `G♯m`, `E♭`. */
export function shortKeyName(key: KeySignature): string {
  return tonicGlyphs(key.tonic) + (key.mode === "minor" ? "m" : "");
}

/** Spelled-out key name for the hover preview: `B major`, `G♯ minor`. */
export function longKeyName(key: KeySignature): string {
  return `${tonicGlyphs(key.tonic)} ${key.mode}`;
}

/**
 * The key CHANGES: every entry after the first. The first entry is the
 * starting key — at beat 0 when the song declares one, otherwise wherever the
 * first key is established — and has nothing before it to change from.
 */
export function keyChanges(entries: readonly KeyEntry[]): KeyEntry[] {
  return entries.slice(1);
}

/**
 * The key in force at `beat`: the latest entry at or before it, falling back
 * to the starting key before the first entry (a pickup-delayed first key), so
 * a keyed song never reads as keyless. `undefined` only for no entries.
 */
export function keyAt(
  entries: readonly KeyEntry[],
  beat: number,
): KeySignature | undefined {
  let active = entries[0]?.key;
  for (const e of entries) {
    if (e.beat <= beat) active = e.key;
    else break; // ascending: no later entry can apply.
  }
  return active;
}

/** Below this a beat counts as sitting on a change (snapped positions are exact). */
const EPS = 1e-6;

/** The change landing exactly on `beat`, if any. */
export function changeAt(
  entries: readonly KeyEntry[],
  beat: number,
): KeyEntry | undefined {
  return keyChanges(entries).find((e) => Math.abs(e.beat - beat) < EPS);
}
