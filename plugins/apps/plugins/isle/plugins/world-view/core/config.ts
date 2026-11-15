import { defineConfig, defineConfigMigration } from "@plugins/config_v2/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { enumField } from "@plugins/fields/plugins/enum/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import {
  AMBIENT_MOODS,
  AMBIENT_MOOD_LABELS,
} from "@plugins/music/plugins/ambient/core";

/**
 * Isle's world and options. The seed picks the archipelago (each seed keeps
 * its own plots, so going back to a seed brings its town back). `time`
 * overrides the clock's time of day. `music` and `mood` (a station: `auto`
 * plays the time of day's mood, `PHASE_MOOD`) drive the ambient engine
 * (`music/ambient`) the island plays once Start is pressed; the radio chip
 * writes both.
 */
/**
 * `mood: "lofi"` saved before stations existed was the old default (no
 * picker could choose it), so it becomes `auto`: the time of day's mood —
 * which keeps a saved override in step with the new origin instead of
 * parking it in a conflict.
 */
const lofiDefaultToAuto = defineConfigMigration({
  id: "mood-lofi-default-to-auto",
  apply: (doc) =>
    typeof doc === "object" &&
    doc !== null &&
    !Array.isArray(doc) &&
    doc.mood === "lofi"
      ? { ...doc, mood: "auto" }
      : doc,
});

export const isleConfig = defineConfig({
  name: "isle",
  migrations: [lofiDefaultToAuto],
  fields: {
    seed: intField({
      label: "World seed",
      description:
        "Which archipelago the apps are placed on. Each seed keeps its own town.",
      default: 1,
      min: 1,
    }),
    time: enumField({
      label: "Time of day",
      description: "Follow the clock, or hold the island at one time of day.",
      options: [
        { value: "auto", label: "Follow the clock" },
        { value: "day", label: "Day" },
        { value: "dusk", label: "Dusk" },
        { value: "night", label: "Night" },
      ],
      default: "auto",
    }),
    music: boolField({
      label: "Music",
      description: "Play generative music while you walk the island.",
      default: true,
    }),
    mood: enumField({
      label: "Music mood",
      description:
        "The kind of music the island plays: one that matches the time of day (a lo-fi afternoon, a bossa at golden hour, a nocturne at night), or always the same.",
      options: [
        { value: "auto", label: "Match the time of day" },
        ...AMBIENT_MOODS.map((value) => ({
          value,
          label: AMBIENT_MOOD_LABELS[value],
        })),
      ],
      default: "auto",
    }),
  },
});
