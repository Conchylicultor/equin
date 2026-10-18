import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { NumberEditor } from "./components/number-editor";

export default {
  description:
    "Number field type: data-view inline cell editor (compact numeric input editor).",
  contributions: [
    DataViewSlots.CellEditor({
      match: "number",
      companion: true,
      component: NumberEditor,
    }),
  ],
} satisfies PluginDefinition;
