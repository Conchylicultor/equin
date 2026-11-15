import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeCustomizer } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import {
  ImportByUrlSection,
  useImportByUrlMatchesSearch,
} from "./components/import-by-url";

export default {
  description:
    "The Import from tweakcn customizer section: imports any tweakcn theme by URL.",
  contributions: [
    ThemeCustomizer.Section({
      companion: true,
      id: "import-by-url",
      label: "Import from tweakcn",
      component: ImportByUrlSection,
      // Section doesn't answer the search box ⇒ no card, rather than a bar over nothing.
      useAvailable: useImportByUrlMatchesSearch,
    }),
  ],
} satisfies PluginDefinition;
