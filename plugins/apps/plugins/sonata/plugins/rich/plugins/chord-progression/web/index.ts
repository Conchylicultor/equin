import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { useHasChords } from "@plugins/apps/plugins/sonata/plugins/document/web";
import { Sonata } from "@plugins/apps/plugins/sonata/plugins/shell/web";
import { ChordLabelModeAction } from "@plugins/apps/plugins/sonata/plugins/rich/plugins/chord-label/web";
import { ChordProgression } from "./components/chord-progression";
import { sonataIcons } from "@plugins/apps/plugins/sonata/plugins/primitives/plugins/icons/core";

export default {
  description:
    "Sonata Section: a rhythm-aware chord-progression strip of chips, laid out bar-by-bar and sized by duration, highlighting the chord under the playhead and seeking on click.",
  contributions: [
    Sonata.Section({
      id: "chord-progression",
      label: "Progression",
      icon: sonataIcons.icon("progression"),
      component: ChordProgression,
      actions: ChordLabelModeAction,
      area: "player",
      useAvailable: useHasChords,
    }),
  ],
} satisfies PluginDefinition;
