import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";
import {
  useAdoptCatalogTheme,
  useCatalogEntries,
} from "./internal/catalog-source";

export default {
  description:
    "The tweakcn community catalog as a browsable theme source (picking a theme saves it as a saved theme). Its import-by-URL customizer section is the `customizer` child.",
  contributions: [
    ThemeEngine.ThemeSource({
      kind: "browse",
      id: "community",
      useEntries: useCatalogEntries,
      useAdopt: useAdoptCatalogTheme,
    }),
  ],
} satisfies PluginDefinition;
