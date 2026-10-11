import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { tokenGroupMatchesSearch } from "@plugins/ui/plugins/theme-engine/core";
import { ThemeCustomizer } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { chordPaletteGroup } from "../core";
import { ChordPaletteSection } from "./components/chord-palette-section";

export default {
  description:
    "Chord colour token group: --chord-1…7 (one colour per scale degree, the tonic first) and --chord-outside (a root outside the scale), with their customizer section.",
  contributions: [
    ThemeEngine.TokenGroup({
      id: "chord-palette",
      label: "Chord colours",
      descriptor: chordPaletteGroup,
    }),
    ThemeCustomizer.Section({
      id: "chord-palette",
      label: "Chord colours",
      component: ChordPaletteSection,
      useAvailable: ({ search }) =>
        tokenGroupMatchesSearch(chordPaletteGroup, search),
    }),
  ],
} satisfies PluginDefinition;
