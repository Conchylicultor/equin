import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeCustomizer } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { tokenGroupMatchesSearch } from "@plugins/ui/plugins/theme-engine/core";
import { CategoricalSection } from "./components/categorical-section";
import { categoricalGroup } from "@plugins/ui/plugins/tokens/plugins/categorical/core";

export default {
  description:
    "Customizer section for the categorical palette token group (categorical-1…10).",
  contributions: [
    ThemeCustomizer.Section({
      companion: true,
      id: "categorical",
      label: "Categorical",
      component: CategoricalSection,
      // No token in this group answers the search box ⇒ no card. The body
      // does not filter itself, so without this the section stayed put
      // (full) under a query that matched nothing in it.
      useAvailable: ({ search }) =>
        tokenGroupMatchesSearch(categoricalGroup, search),
    }),
  ],
} satisfies PluginDefinition;
