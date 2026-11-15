import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ThemeCustomizer } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { tokenGroupMatchesSearch } from "@plugins/ui/plugins/theme-engine/core";
import { ShapeSection } from "./components/shape-section";
import { shapeGroup } from "@plugins/ui/plugins/tokens/plugins/shape/core";

export default {
  description:
    'Customizer section for the shape token group, with "Fill from…" shortcuts.',
  contributions: [
    ThemeCustomizer.Section({
      companion: true,
      id: "shape",
      label: "Shape",
      component: ShapeSection,
      // No token in this group answers the search box ⇒ no card, rather
      // than a titled bar over a filtered-to-empty list.
      useAvailable: ({ search }) => tokenGroupMatchesSearch(shapeGroup, search),
    }),
  ],
} satisfies PluginDefinition;
