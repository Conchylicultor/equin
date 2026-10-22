import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import { ThemeCustomizer } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import {
  ImportByUrlSection,
  useImportByUrlMatchesSearch,
} from "./components/import-by-url";
import {
  useAdoptCatalogTheme,
  useCatalogEntries,
} from "./internal/catalog-source";

export default {
  description:
    "The tweakcn community catalog as a browsable theme source (picking a theme saves it as a saved theme), plus a customizer section that imports any tweakcn theme by URL.",
  contributions: [
    ThemeEngine.ThemeSource({
      kind: "browse",
      id: "community",
      useEntries: useCatalogEntries,
      useAdopt: useAdoptCatalogTheme,
    }),
    ThemeCustomizer.Section({
      id: "import-by-url",
      label: "Import from tweakcn",
      component: ImportByUrlSection,
      // Section doesn't answer the search box ⇒ no card, rather than a bar over nothing.
      useAvailable: useImportByUrlMatchesSearch,
    }),
  ],
} satisfies PluginDefinition;
