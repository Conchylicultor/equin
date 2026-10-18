import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { BoolEditor } from "./components/bool-editor";

export default {
  description:
    "Boolean field type: data-view inline cell editor (immediate-commit toggle).",
  contributions: [
    DataViewSlots.CellEditor({
      match: "bool",
      companion: true,
      component: BoolEditor,
    }),
  ],
} satisfies PluginDefinition;
