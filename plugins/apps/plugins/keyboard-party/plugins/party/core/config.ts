import { defineConfig } from "@plugins/config_v2/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { enumField } from "@plugins/fields/plugins/enum/plugins/config/core";

/**
 * The parent's knobs for the party. The stage is deliberately theme-independent
 * (a toy, not a document): `scene` picks one of its own fixed backdrops.
 */
export const partyConfig = defineConfig({
  fields: {
    scene: enumField({
      label: "Scene",
      description: "The backdrop the keys play over.",
      options: [
        { value: "night", label: "Night sky" },
        { value: "sunny", label: "Sunny meadow" },
        { value: "paper", label: "Paper" },
      ],
      default: "night",
    }),
    motion: enumField({
      label: "Motion",
      description: "Calm plays slower, with fewer particles.",
      options: [
        { value: "lively", label: "Lively" },
        { value: "calm", label: "Calm" },
      ],
      default: "lively",
    }),
    voice: enumField({
      label: "Voice",
      description: "What is said aloud after a letter.",
      options: [
        { value: "word", label: "Letter and word" },
        { value: "letter", label: "Letter only" },
        { value: "off", label: "Silent" },
      ],
      default: "word",
    }),
    trail: boolField({
      label: "Key trail",
      description: "Show the last keys pressed as beads along the bottom.",
      default: true,
    }),
  },
});
