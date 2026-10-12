import { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import {
  defaultBassPattern,
  defaultChordPattern,
  type RhythmPattern,
} from "@plugins/apps/plugins/sonata/plugins/rhythm/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { nullable } from "@plugins/fields/core";
import {
  DEFAULT_BASS_VOICING,
  DEFAULT_CHORD_VOICING,
  MAX_HAND_OCTAVE,
  MIN_HAND_OCTAVE,
  type HandVoicing,
} from "@plugins/apps/plugins/sonata/plugins/voicing/core";

/**
 * Wire/DB shape of one hand's rhythm pattern. Mirrors `RhythmPattern` from
 * `sonata/plugins/rhythm/core` structurally (the inferred `onsets` is a plain
 * `number[]`, which the core type's `readonly number[]` accepts, so a parsed
 * value flows into the core ops and the shell store without a cast).
 *
 * The `.refine` rejects a payload whose onset falls outside `[0, subdivisions)`
 * loudly (a 4xx on the write path) rather than silently coercing it — a bad
 * onset is a bug, not an absorbable value.
 */
export const RhythmPatternSchema = z
  .object({
    presetId: z.string().nullable(),
    subdivisions: z.number().int().min(1).max(48),
    onsets: z.array(z.number().int().nonnegative()),
    rotation: z.number().int(),
  })
  .refine((p) => p.onsets.every((o) => o < p.subdivisions), {
    message: "every onset must be < subdivisions",
  });

/**
 * Wire/DB shape of one hand's voicing (`HandVoicing` from `voicing/core`): on/off,
 * octave (C1–C7), voice-leading, octave doubling. Shared by the per-song row,
 * the write endpoint and the groove presets, like `RhythmPatternSchema`.
 */
export const HandVoicingSchema = z.object({
  enabled: z.boolean(),
  octave: z.number().int().min(MIN_HAND_OCTAVE).max(MAX_HAND_OCTAVE),
  voiceLead: z.boolean(),
  doubleOctave: z.boolean(),
});

/**
 * One song's persisted rhythm groove: whether it is active plus the two hands'
 * patterns. Stored in the `sonata_songs_ext_rhythm` entity-extension table (1:1
 * per song), which `server/internal/tables.ts` builds from this shape; an absent
 * row reads as disabled (today's block-chord behavior). Both patterns are
 * remembered even while disabled, so re-enabling restores the groove rather than
 * resetting to defaults.
 */
export const rhythmShape = defineExtensionShape({
  key: "songId",
  fields: {
    enabled: boolField(),
    // Each hand's onset pattern, as jsonb decoded by `RhythmPatternSchema` — the
    // SAME schema the HTTP write boundary validates against, so an onset outside
    // `[0, subdivisions)` is impossible to store by any route, not just the
    // endpoint. Typed as the core `RhythmPattern` (`readonly onsets`).
    bass: jsonField<RhythmPattern>({
      schema: RhythmPatternSchema,
      default: defaultBassPattern(),
    }),
    chord: jsonField<RhythmPattern>({
      schema: RhythmPatternSchema,
      default: defaultChordPattern(),
    }),
    // Each hand's tone-order figuration id (the *what*, orthogonal to the rhythm
    // *when*). Kept a plain string: an unknown id throws loudly downstream in
    // `findFiguration`, not an absorbable value here.
    bassPatternId: textField(),
    chordPatternId: textField(),
    // Each hand's voicing (on/off, octave, voice-leading, octave doubling) as
    // jsonb decoded by `HandVoicingSchema`; a row stored before these columns
    // existed reads today's sound (the column defaults).
    bassVoicing: jsonField<HandVoicing>({
      schema: HandVoicingSchema,
      default: DEFAULT_BASS_VOICING,
    }),
    chordVoicing: jsonField<HandVoicing>({
      schema: HandVoicingSchema,
      default: DEFAULT_CHORD_VOICING,
    }),
    // The groove preset (`groovePresetsConfig` list id) this song's groove was
    // last applied from — provenance only; NULL when never applied from one.
    // Whether the groove still matches it ("edited") is derived by comparing
    // against the preset (`grooveEquals`), never stored. A preset deleted later
    // leaves a dangling id, which reads as "no preset".
    groovePresetId: nullable(textField()),
  },
});
export const RhythmRowSchema = rhythmShape.schema;
export type RhythmRow = z.infer<typeof RhythmRowSchema>;

/**
 * The groove of ONE song, read by the song's id: a lookup-only collection over
 * the extension table (nothing lists every song's groove), minting
 * `sonata-rhythm:rows` alone. The observer and `useGroove` read the open song's
 * row with `useLiveRow(rhythms, songId)`; `found: false` is an absent row, i.e.
 * no groove and the default patterns.
 */
export const rhythms = liveCollection("sonata-rhythm", {
  row: RhythmRowSchema,
  id: "songId",
});
