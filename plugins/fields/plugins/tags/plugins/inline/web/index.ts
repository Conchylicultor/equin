import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { TagsEditor } from "./components/tags-editor";

export default {
  description:
    "Tags (multi-value) field type: data-view inline cell editor (multi-select chip popover).",
  contributions: [
    DataViewSlots.CellEditor({
      match: "tags",
      companion: true,
      component: TagsEditor,
    }),
  ],
} satisfies PluginDefinition;
