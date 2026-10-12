import { defineConfig } from "@plugins/config_v2/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { listField } from "@plugins/fields/plugins/list/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import {
  defaultBassPattern,
  defaultChordPattern,
  patternFromPreset,
  type RhythmPattern,
} from "@plugins/apps/plugins/sonata/plugins/rhythm/core";
import {
  DEFAULT_BASS_FIGURATION_ID,
  DEFAULT_BASS_VOICING,
  DEFAULT_CHORD_FIGURATION_ID,
  DEFAULT_CHORD_VOICING,
  type HandVoicing,
} from "@plugins/apps/plugins/sonata/plugins/voicing/core";
import { HandVoicingSchema, RhythmPatternSchema } from "./resources";

/** Both hands at today's voicing — what every two-hand seed plays. */
const BOTH_HANDS = {
  chordVoicing: DEFAULT_CHORD_VOICING,
  bassVoicing: DEFAULT_BASS_VOICING,
};

/**
 * The code-authored starting set of groove presets. Each row carries an
 * explicit stable `id` (the list is `stableIdentity`: a song's
 * `groovePresetId` is a durable key into it). Patterns are built from the real
 * `RHYTHMS` table and figuration ids from the real `FIGURATIONS` registry, so a
 * renamed rhythm or figuration fails here at module load, not as a silent
 * "unknown preset" later.
 */
const SEED_GROOVE_PRESETS = [
  {
    id: "default",
    name: "Default",
    chord: defaultChordPattern(),
    bass: defaultBassPattern(),
    chordFigurationId: DEFAULT_CHORD_FIGURATION_ID,
    bassFigurationId: DEFAULT_BASS_FIGURATION_ID,
    ...BOTH_HANDS,
  },
  {
    id: "bossa-nova",
    name: "Bossa nova",
    chord: patternFromPreset("bossa-nova"),
    bass: patternFromPreset("basic-2"),
    chordFigurationId: "block",
    bassFigurationId: "root-fifth",
    ...BOTH_HANDS,
  },
  {
    id: "pop-ballad",
    name: "Pop ballad",
    chord: patternFromPreset("basic-4"),
    bass: patternFromPreset("basic-1"),
    chordFigurationId: "arpeggio-up",
    bassFigurationId: "root",
    ...BOTH_HANDS,
  },
  {
    id: "son-clave",
    name: "Son clave",
    chord: patternFromPreset("son"),
    bass: patternFromPreset("tresillo"),
    chordFigurationId: "block",
    bassFigurationId: "root-fifth",
    ...BOTH_HANDS,
  },
  {
    id: "stride",
    name: "Stride",
    chord: patternFromPreset("basic-2"),
    bass: patternFromPreset("basic-4"),
    chordFigurationId: "block",
    bassFigurationId: "stride",
    ...BOTH_HANDS,
  },
  {
    id: "waltz",
    name: "Waltz",
    chord: patternFromPreset("basic-1"),
    bass: patternFromPreset("basic-3"),
    chordFigurationId: "block",
    bassFigurationId: "waltz",
    ...BOTH_HANDS,
  },
  {
    id: "walking-bass",
    name: "Walking bass",
    chord: patternFromPreset("basic-2"),
    bass: patternFromPreset("basic-4"),
    chordFigurationId: "block",
    bassFigurationId: "walking",
    chordVoicing: { ...DEFAULT_CHORD_VOICING, enabled: false },
    bassVoicing: DEFAULT_BASS_VOICING,
  },
  {
    id: "harp",
    name: "Harp",
    chord: patternFromPreset("basic-1"),
    bass: patternFromPreset("basic-2"),
    chordFigurationId: "harp-roll",
    bassFigurationId: DEFAULT_BASS_FIGURATION_ID,
    chordVoicing: DEFAULT_CHORD_VOICING,
    bassVoicing: { ...DEFAULT_BASS_VOICING, enabled: false },
  },
];

/**
 * Global (not per-song) saved grooves: a name plus both hands' rhythm
 * necklaces, figuration ids and voicings (a hand that is off makes a
 * one-hand groove) — everything `GrooveFields` holds except the
 * provenance. Applying one writes its content into the open song's groove and
 * records its id as the song's `groovePresetId`; "edited" is then derived by
 * comparing the song's groove against the preset (`grooveEquals`), never stored.
 *
 * Each pattern is an opaque `jsonField` validated by the SAME
 * `RhythmPatternSchema` the per-song row and the write endpoint use.
 */
export const groovePresetsConfig = defineConfig({
  name: "groove-presets",
  fields: {
    presets: listField({
      label: "Groove presets",
      description:
        "Saved grooves offered by the Rhythm section's preset menu: both hands' rhythm patterns, figurations and voicings.",
      stableIdentity: true,
      itemFields: {
        name: textField({ label: "Name" }),
        chord: jsonField<RhythmPattern>({
          label: "Right hand (chords) rhythm",
          schema: RhythmPatternSchema,
          default: defaultChordPattern(),
        }),
        bass: jsonField<RhythmPattern>({
          label: "Left hand (bass) rhythm",
          schema: RhythmPatternSchema,
          default: defaultBassPattern(),
        }),
        chordFigurationId: textField({
          label: "Right hand figuration",
          default: DEFAULT_CHORD_FIGURATION_ID,
        }),
        bassFigurationId: textField({
          label: "Left hand figuration",
          default: DEFAULT_BASS_FIGURATION_ID,
        }),
        chordVoicing: jsonField<HandVoicing>({
          label: "Right hand voicing",
          schema: HandVoicingSchema,
          default: DEFAULT_CHORD_VOICING,
        }),
        bassVoicing: jsonField<HandVoicing>({
          label: "Left hand voicing",
          schema: HandVoicingSchema,
          default: DEFAULT_BASS_VOICING,
        }),
      },
      default: SEED_GROOVE_PRESETS,
    }),
  },
});

/** One saved groove preset, as stored (its list `id` is stable). */
export type GroovePreset =
  (typeof groovePresetsConfig.defaults)["presets"][number];

/**
 * The built-in preset a saved row started as — by its stable id — or `null`
 * for one the user created. What "Reset" restores after the row was saved over.
 */
export function seedGroovePreset(id: string) {
  return SEED_GROOVE_PRESETS.find((p) => p.id === id) ?? null;
}
