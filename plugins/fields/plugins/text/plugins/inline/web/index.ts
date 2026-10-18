import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { TextEditor } from "./components/text-editor";

export default {
  description:
    "Text field type: data-view inline cell editor (compact text input editor).",
  contributions: [
    DataViewSlots.CellEditor({
      match: "text",
      companion: true,
      component: TextEditor,
    }),
  ],
} satisfies PluginDefinition;
