import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { fileTypePaletteGroup } from "../core";

export default {
  description:
    "File-type colour token group: the closed --file-<tone> tints file-type glyphs are drawn in (Seti's palette on dark, darkened on light) and the --folder tint. Its customizer section is the `customizer` child.",
  contributions: [
    ThemeEngine.TokenGroup({
      id: "file-type-palette",
      label: "File types",
      descriptor: fileTypePaletteGroup,
    }),
  ],
} satisfies PluginDefinition;
