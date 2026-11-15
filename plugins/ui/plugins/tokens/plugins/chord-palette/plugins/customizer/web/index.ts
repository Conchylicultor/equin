import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeCustomizer } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { tokenGroupMatchesSearch } from "@plugins/ui/plugins/theme-engine/core";
import { ChordPaletteSection } from "./components/chord-palette-section";
import { chordPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/chord-palette/core";

export default {
  description:
    "Customizer section for the chord colour token group (--chord-1…7, --chord-outside).",
  contributions: [
    ThemeCustomizer.Section({
      companion: true,
      id: "chord-palette",
      label: "Chord colours",
      component: ChordPaletteSection,
      useAvailable: ({ search }) =>
        tokenGroupMatchesSearch(chordPaletteGroup, search),
    }),
  ],
} satisfies PluginDefinition;
