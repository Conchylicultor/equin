import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeCustomizer } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { tokenGroupMatchesSearch } from "@plugins/ui/plugins/theme-engine/core";
import { ShadowSection } from "./components/shadow-section";
import { shadowGroup } from "@plugins/ui/plugins/tokens/plugins/shadow/core";

export default {
  description:
    'Param-driven customizer section for the shadow token group, with "Fill from…" shortcuts.',
  contributions: [
    ThemeCustomizer.Section({
      companion: true,
      id: "shadow",
      label: "Shadow",
      component: ShadowSection,
      // No token in this group answers the search box ⇒ no card, rather
      // than a titled bar over a filtered-to-empty list.
      useAvailable: ({ search }) =>
        tokenGroupMatchesSearch(shadowGroup, search, [
          "shadow",
          "color",
          "opacity",
          "blur",
          "spread",
          "offset",
        ]),
    }),
  ],
} satisfies PluginDefinition;
