import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { TreeDisclosure } from "@plugins/ui/plugins/tree-disclosure/web";
import { TreeColumnDisclosure } from "@plugins/primitives/plugins/tree/web";

export default {
  description:
    "Column tree disclosure — a dedicated chevron column ahead of the icon, present only on rows with children (Finder / VS Code style).",
  contributions: [
    TreeDisclosure.Variant({
      id: "column",
      label: "Chevron column",
      match: "column",
      component: TreeColumnDisclosure,
    }),
  ],
} satisfies PluginDefinition;
