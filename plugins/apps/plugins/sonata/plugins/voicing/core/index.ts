/**
 * `@plugins/apps/plugins/sonata/plugins/voicing/core` — Sonata's chord-voicing
 * primitives.
 *
 * Pure, framework-free barrel. Owns the voicing engine (`voiceChords`) that turns
 * timed chord events into performed notes, and the per-hand {@link Figuration}
 * registry (the tone-order axis) it walks against a rhythm necklace. Every
 * chord-authoring source feeds its `ChordEvent[]` here, so the chord → notes
 * direction has exactly one home. Imports `score/core` (for `Note`) and
 * `theory/core` (for `chordPitches`), keeping the DAG acyclic.
 */

export type { ChordEvent, VoicingOptions } from "./voicing";
export { voiceChords } from "./voicing";
export type {
  Figuration,
  HandRole,
  Register,
  StruckTone,
  FigurationContext,
  Degree,
} from "./figuration";
export {
  FIGURATIONS,
  findFiguration,
  figurationsForHand,
  DEFAULT_BASS_FIGURATION_ID,
  DEFAULT_CHORD_FIGURATION_ID,
} from "./figuration";
export { voicingConfig } from "./config";
export type { HandVoicing } from "./hand-voicing";
export {
  DEFAULT_BASS_VOICING,
  DEFAULT_CHORD_VOICING,
  handVoicingEquals,
  MAX_HAND_OCTAVE,
  MIN_HAND_OCTAVE,
} from "./hand-voicing";
export type { ReVoiceInclude, ReVoiceOptions } from "./revoice";
export { reVoiceChords, CHORD_TRACK, CHORD_BASS_TRACK } from "./revoice";
