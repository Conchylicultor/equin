import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DataViewSlots } from "@plugins/primitives/plugins/data-view/web";
import { DateEditor } from "./components/date-editor";

export default {
  description:
    "Date field type: data-view inline cell editor (native date input editor).",
  contributions: [
    DataViewSlots.CellEditor({
      match: "date",
      companion: true,
      component: DateEditor,
    }),
  ],
} satisfies PluginDefinition;
