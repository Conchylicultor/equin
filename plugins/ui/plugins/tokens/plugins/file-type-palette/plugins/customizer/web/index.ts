import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeCustomizer } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { tokenGroupMatchesSearch } from "@plugins/ui/plugins/theme-engine/core";
import { FileTypePaletteSection } from "./components/file-type-palette-section";
import { fileTypePaletteGroup } from "@plugins/ui/plugins/tokens/plugins/file-type-palette/core";

export default {
  description:
    "Customizer section for the file-type colour token group (--file-<tone>, --folder).",
  contributions: [
    ThemeCustomizer.Section({
      companion: true,
      id: "file-type-palette",
      label: "File types",
      component: FileTypePaletteSection,
      useAvailable: ({ search }) =>
        tokenGroupMatchesSearch(fileTypePaletteGroup, search),
    }),
  ],
} satisfies PluginDefinition;
