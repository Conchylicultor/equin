/**
 * Per-hand voicing: how ONE hand of a groove places and sounds its tones,
 * orthogonal to its rhythm (the *when*) and its figuration (the *what*).
 *
 *  - `enabled` — whether the hand plays at all. Off silences the hand, so a
 *    groove can be left-hand-only or right-hand-only.
 *  - `octave` — the register the hand's tones are placed in (C4 = middle C).
 *  - `voiceLead` — keep the hand close to where it just was: the chord hand
 *    moves each chord to the inversion nearest the previous one; the bass hand
 *    moves each chord's tones by whole octaves so its root lands nearest the
 *    previous root (staying within an octave of its home register).
 *  - `doubleOctave` — every struck pitch also sounds an octave above (a bass C1
 *    plays C1 + C2), whatever the figuration.
 *
 * Pure data: the engine (`voicing.ts`) reads it on the groove path only; the
 * block-chord path keeps the global `voicingConfig`.
 */
export interface HandVoicing {
  enabled: boolean;
  octave: number;
  voiceLead: boolean;
  doubleOctave: boolean;
}

/** Octave range a hand may be placed in (C1 … C7). */
export const MIN_HAND_OCTAVE = 1;
export const MAX_HAND_OCTAVE = 7;

/**
 * The right hand's default: today's groove sound — chords at C4, voice-led
 * (the global config's defaults).
 */
export const DEFAULT_CHORD_VOICING: HandVoicing = {
  enabled: true,
  octave: 4,
  voiceLead: true,
  doubleOctave: false,
};

/**
 * The left hand's default: today's groove sound — a root-position bass at C2,
 * not voice-led.
 */
export const DEFAULT_BASS_VOICING: HandVoicing = {
  enabled: true,
  octave: 2,
  voiceLead: false,
  doubleOctave: false,
};

/** Whether two hand voicings sound the same. */
export function handVoicingEquals(a: HandVoicing, b: HandVoicing): boolean {
  return (
    a.enabled === b.enabled &&
    a.octave === b.octave &&
    a.voiceLead === b.voiceLead &&
    a.doubleOctave === b.doubleOctave
  );
}
