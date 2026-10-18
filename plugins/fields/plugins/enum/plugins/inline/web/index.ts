import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { EnumEditor } from "./components/enum-editor";

export default {
  description:
    "Enum (select) field type: data-view inline cell editor (single-select chip popover).",
  contributions: [
    DataViewSlots.CellEditor({
      match: "enum",
      companion: true,
      component: EnumEditor,
    }),
  ],
} satisfies PluginDefinition;
