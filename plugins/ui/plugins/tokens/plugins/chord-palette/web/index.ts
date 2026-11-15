import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { chordPaletteGroup } from "../core";

export default {
  description:
    "Chord colour token group: --chord-1…7 (one colour per Roman numeral's number, I … VII, ♭VII sharing VII's) and --chord-outside (a chord with no key). Its customizer section is the `customizer` child.",
  contributions: [
    ThemeEngine.TokenGroup({
      id: "chord-palette",
      label: "Chord colours",
      descriptor: chordPaletteGroup,
    }),
  ],
} satisfies PluginDefinition;
